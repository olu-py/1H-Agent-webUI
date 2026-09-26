//! `1h-agent-web` HTTP/SSE adapter.
//!
//! This crate owns the Web-only concerns — Axum routes under `/api/v2`, the SSE
//! transport, loopback/token auth, and the embedded static frontend — and
//! drives the UI-independent core through
//! [`protium_core::service::AppService`]/[`AppHandle`]. No business logic lives
//! here; every handler is a thin serialization of an `AppHandle` call.
//!
//! The v2 API is a breaking protocol upgrade: there are no v1 route aliases and
//! the server is strict same-origin (no permissive CORS).

use std::{
    collections::HashMap, convert::Infallible, net::SocketAddr, path::PathBuf, sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        Html, IntoResponse, Response,
        sse::{Event as SseEvent, KeepAlive, Sse},
    },
    routing::{delete, get, patch, post},
};
use futures_util::StreamExt;
use protium_core::{
    bridge::ReplayResult,
    protocol::{ApiError, ApiErrorKind, Envelope, Event, PROTOCOL_VERSION},
    service::{AppHandle, AppService, CoreConfig},
};
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::auth::Auth;

/// Shared state handed to every HTTP handler.
#[derive(Clone)]
struct ServerState {
    handle: AppHandle,
    auth: Auth,
}

/// Body of `POST /api/v2/sessions/{id}/input` and `.../commands`.
#[derive(Deserialize)]
struct InputBody {
    text: String,
}

/// Body of `POST /api/v2/approvals/{approval_id}`.
#[derive(Deserialize)]
struct ApprovalBody {
    accept: bool,
    #[serde(default)]
    allow_session: bool,
}

/// Body of `POST /api/v2/config/provider` (the settings-screen edit).
///
/// `api_key` is optional: when present (non-empty) it is stored in the OS
/// keyring for the resolved provider id *before* the profile is applied, then
/// dropped - it is never serialized into a response, log line, or the config
/// file. All other fields are non-secret.
///
/// `id` addresses the profile being edited. Omitting it (or sending it empty)
/// with `preset = "custom"` creates a new custom provider: the core mints a
/// fresh `custom-<uuid>` id, so several named custom providers can coexist.
/// `name` is required for a new custom provider and used for display.
#[derive(Deserialize)]
struct ProviderConfigBody {
    /// Existing provider id (built-in preset key or `custom-<uuid>`); empty
    /// creates a new profile from `preset`.
    #[serde(default)]
    id: Option<String>,
    preset: String,
    /// Display name for a custom provider; ignored for built-ins.
    #[serde(default)]
    name: Option<String>,
    model: String,
    #[serde(default)]
    base_url: Option<String>,
    /// `ProviderKind` wire tag ("responses" / "chat_completions").
    #[serde(default)]
    kind: Option<String>,
    /// Optional explicit context window for models the metadata chain cannot
    /// resolve; the core clamps it to the same bounds as `Config::load`.
    #[serde(default)]
    context_window_tokens: Option<u64>,
    /// Reserved selectable-model list; persisted and echoed but not enforced.
    #[serde(default)]
    enabled_models: Option<Vec<String>>,
    #[serde(default)]
    api_key: Option<String>,
}

#[derive(Deserialize)]
struct MemoryBody {
    title: String,
    content: String,
    #[serde(default)]
    candidate: bool,
}

#[derive(Deserialize)]
struct MemoryEditBody {
    title: String,
    content: String,
}

/// Starts the WebUI server: builds the core service, binds the listener, and
/// serves the REST/SSE API plus the embedded static frontend.
pub async fn run(workspace_path: PathBuf, config: protium_core::config::Config) -> Result<()> {
    let (auth, auth_enabled) = Auth::new(&config.server.bind, &config.data_dir)?;

    let handle = AppService::start(CoreConfig {
        workspace: workspace_path,
        config: config.clone(),
        data_dir: config.data_dir.clone(),
        event_capacity: config.server.event_buffer,
        event_max_bytes: config.server.event_max_bytes,
        approval_timeout: Duration::from_secs(config.server.approval_timeout_seconds),
        message_page_size: protium_core::protocol::DEFAULT_PAGE_SIZE,
    })
    .await?;

    let addr = format!("{}:{}", config.server.bind, config.server.port);
    let socket: SocketAddr = addr
        .parse()
        .with_context(|| format!("invalid server bind {addr}"))?;

    let state = ServerState { handle, auth };
    let router = build_router(state);
    let listener = tokio::net::TcpListener::bind(socket).await?;
    tracing::info!(
        "1H-Agent Web (v{PROTOCOL_VERSION}) listening on http://{socket}{}",
        if auth_enabled {
            " (token auth enabled)"
        } else {
            ""
        }
    );

    axum::serve(listener, router).await.map_err(Into::into)
}

fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/api/v2/state", get(get_state))
        .route("/api/v2/sessions/{id}/messages", get(get_messages))
        .route("/api/v2/sessions/{id}/input", post(post_input))
        .route("/api/v2/sessions/{id}/commands", post(post_commands))
        .route("/api/v2/sessions/{id}/cancel", post(post_cancel))
        .route("/api/v2/sessions/{id}/activate", post(post_activate))
        .route("/api/v2/approvals/{approval_id}", post(post_approval))
        .route(
            "/api/v2/config/provider",
            get(get_provider_settings).post(post_provider_config),
        )
        .route("/api/v2/config/provider/models", get(get_provider_models))
        .route(
            "/api/v2/config/provider/{id}",
            delete(delete_provider_config),
        )
        .route("/api/v2/memories", get(get_memories).post(post_memory))
        .route(
            "/api/v2/memories/{id}",
            patch(patch_memory).delete(delete_memory),
        )
        .route("/api/v2/memories/{id}/confirm", post(confirm_memory))
        .route("/api/v2/events", get(sse_handler))
        .route("/", get(index_handler))
        .route("/{*path}", get(static_handler))
        // Strict same-origin: no CORS layer. Remote access is gated by token.
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
}

/// Returns `true` (and no response) when the request is authorized; otherwise
/// the caller returns the supplied `Response` (401).
fn authorized(state: &ServerState, headers: &HeaderMap) -> bool {
    if !state.auth.enabled() {
        return true;
    }
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    state.auth.check(bearer)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(serde_json::json!({
            "kind": "unauthorized",
            "message": "missing or invalid bearer token",
        })),
    )
        .into_response()
}

/// Maps a v2 [`ApiError`] to an HTTP status + JSON body.
fn api_error_response(error: ApiError) -> Response {
    let status = match error.kind {
        ApiErrorKind::BadRequest => StatusCode::BAD_REQUEST,
        ApiErrorKind::NotFound => StatusCode::NOT_FOUND,
        ApiErrorKind::Unauthorized => StatusCode::UNAUTHORIZED,
        ApiErrorKind::Conflict => StatusCode::CONFLICT,
        ApiErrorKind::ResyncRequired => StatusCode::CONFLICT,
        ApiErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&error).unwrap_or_else(|_| "{}".into()),
    )
        .into_response()
}

/// `GET /api/v2/state`
async fn get_state(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state.handle.snapshot().await {
        Ok(snapshot) => axum::Json(snapshot).into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `GET /api/v2/sessions/{id}/messages?before=<cursor>&limit=<n>` — cursor
/// pagination over the transcript along the current head chain.
async fn get_messages(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let before = params
        .get("before")
        .and_then(|value| value.parse::<i64>().ok());
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok());
    match state.handle.messages(&id, before, limit).await {
        Ok(page) => axum::Json(page).into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `POST /api/v2/sessions/{id}/input` — submit user text. `/`-prefixed text is
/// parsed as a command, `!`-prefixed text requests shell approval.
async fn post_input(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: axum::Json<InputBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let session_id = (!id.is_empty() && id != "new").then_some(id);
    match state.handle.submit(session_id, &body.0.text).await {
        Ok(_request_seq) => StatusCode::ACCEPTED.into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `POST /api/v2/sessions/{id}/commands` — structured slash command.
async fn post_commands(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: axum::Json<InputBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let session_id = (!id.is_empty() && id != "new").then_some(id);
    match state.handle.execute_command(session_id, &body.0.text).await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `POST /api/v2/sessions/{id}/cancel` — cancel the active request.
async fn post_cancel(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state.handle.cancel(&id, None).await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `POST /api/v2/sessions/{id}/activate` — switch the active session.
async fn post_activate(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state.handle.activate_session(&id).await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `POST /api/v2/approvals/{approval_id}` — `{ "accept": bool }` resolves a
/// pending approval.
async fn post_approval(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(approval_id): AxumPath<String>,
    body: axum::Json<ApprovalBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state
        .handle
        .approve(&approval_id, body.0.accept, body.0.allow_session)
        .await
    {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `GET /api/v2/config/provider` - the provider settings view: the active
/// profile, saved per-preset profiles, and the presets with a currently
/// resolvable API key. The keys themselves are never included.
async fn get_provider_settings(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state.handle.provider_settings().await {
        Ok(settings) => axum::Json(settings).into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `GET /api/v2/config/provider/models?refresh=` - the provider's model list
/// from the `model_metadata` cache (ids plus any window/output metadata the
/// endpoint reports). `refresh=true` refetches the provider's `GET /models`
/// and models.dev first, bounded by the core's metadata timeout. Metadata
/// only: the response never includes API keys.
async fn get_provider_models(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let refresh = params
        .get("refresh")
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
    match state.handle.provider_models(refresh).await {
        Ok(models) => axum::Json(models).into_response(),
        Err(error) => api_error_response(error),
    }
}

async fn get_memories(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let query = params.get("q").map(String::as_str);
    let include_deleted = params
        .get("include_deleted")
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
    match state.handle.memories(query, include_deleted).await {
        Ok(memories) => axum::Json(memories).into_response(),
        Err(error) => api_error_response(error),
    }
}

async fn post_memory(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: axum::Json<MemoryBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state
        .handle
        .save_memory(&body.0.title, &body.0.content, body.0.candidate)
        .await
    {
        Ok(memory) => (StatusCode::CREATED, axum::Json(memory)).into_response(),
        Err(error) => api_error_response(error),
    }
}

async fn confirm_memory(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state.handle.confirm_memory(id).await {
        Ok(memory) => axum::Json(memory).into_response(),
        Err(error) => api_error_response(error),
    }
}

async fn patch_memory(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
    body: axum::Json<MemoryEditBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state
        .handle
        .update_memory(id, &body.0.title, &body.0.content)
        .await
    {
        Ok(memory) => axum::Json(memory).into_response(),
        Err(error) => api_error_response(error),
    }
}

async fn delete_memory(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state.handle.delete_memory(id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `POST /api/v2/config/provider` - the settings-screen edit: applies `model`
/// plus the optional `base_url` and protocol to `preset`'s profile (a fresh
/// preset template when nothing is saved). An optional `api_key` is stored in
/// the OS keyring first so the rebuilt runner picks it up immediately; the key
/// itself never reaches the core, a response, a log, or the config file.
async fn post_provider_config(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: axum::Json<ProviderConfigBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let Some(preset) = protium_core::config::ProviderPreset::parse(&body.0.preset) else {
        return api_error_response(ApiError::bad_request(format!(
            "unknown provider preset {}",
            body.0.preset
        )));
    };
    // Empty/absent id: address the profile by its family key. For `custom`
    // the empty id is the create signal - the core mints a fresh id so
    // several named custom providers can coexist.
    let provider_id = body.0.id.as_deref().map(str::trim).unwrap_or("");
    // A brand-new custom provider needs a name up front (the core enforces it
    // too); reject here so the client gets a clean 400 without a key write.
    if provider_id.is_empty() && preset == protium_core::config::ProviderPreset::Custom {
        let name = body.0.name.as_deref().map(str::trim).unwrap_or("");
        if name.is_empty() {
            return api_error_response(ApiError::bad_request("自定义供应商名称不能为空"));
        }
    }
    let kind = match body.0.kind.as_deref() {
        None => None,
        Some(tag) => match protium_core::config::ProviderKind::parse_wire_tag(tag) {
            Some(kind) => Some(kind),
            None => {
                return api_error_response(ApiError::bad_request(format!(
                    "unknown provider kind {tag}"
                )));
            }
        },
    };
    // Store the key before applying the profile so `set_provider_profile`'s
    // secret refresh resolves it from the cache. A keyring write failure does
    // not abort the edit - `store_api_key_cached` keeps the key usable for
    // this run and the response reports the degraded persistence.
    let mut key_warning: Option<String> = None;
    if let Some(api_key) = body.0.api_key.as_deref().map(str::trim)
        && !api_key.is_empty()
    {
        // Existing id: exactly that profile's keyring entry. New custom id:
        // the id is minted inside the core, so the key is stored under the
        // family key and re-used by preset resolution for the new profile's
        // first run (`api_key_cached` falls back to the environment/family
        // entry only when the id has no entry of its own).
        let key_id = if provider_id.is_empty() {
            preset.key_id()
        } else {
            provider_id
        };
        if let Err(error) = protium_core::secrets::store_api_key_cached(preset, key_id, api_key) {
            tracing::warn!("keyring write failed for {key_id}; the key applies to this run only");
            key_warning = Some(format!(
                "密钥已生效（本次运行），但写入系统钥匙串失败：{error}"
            ));
        }
    }
    match state
        .handle
        .set_provider_profile(
            provider_id,
            preset,
            body.0.name.as_deref(),
            &body.0.model,
            body.0.base_url.as_deref(),
            kind,
            body.0.context_window_tokens,
            body.0.enabled_models.clone(),
        )
        .await
    {
        Ok(()) if key_warning.is_none() => StatusCode::ACCEPTED.into_response(),
        Ok(()) => (
            StatusCode::ACCEPTED,
            axum::Json(serde_json::json!({
                "kind": "internal",
                "message": key_warning.unwrap_or_default(),
            })),
        )
            .into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `DELETE /api/v2/config/provider/{id}` - removes a saved provider profile
/// by id. Removing the active provider switches to the next saved profile (or
/// the OpenAI default); the API key stays in the OS keyring.
async fn delete_provider_config(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state.handle.remove_provider(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `GET /api/v2/events?cursor=<u64>&session=<id>` — SSE stream.
///
/// The client subscribes from the snapshot's `event_cursor`. Buffered events
/// strictly after that cursor are replayed first (replay *before* subscribing
/// so nothing between the two is missed or duplicated), then live events
/// stream until the connection closes. When the requested cursor has been
/// evicted from the bridge ring — or the consumer lags the live channel — a
/// `resync_required` envelope is emitted so the consumer refetches the snapshot
/// and message page instead of guessing the missing state.
async fn sse_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let handle = state.handle.clone();
    let filter = params.get("session").cloned();
    let cursor = params
        .get("cursor")
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| {
            headers
                .get("last-event-id")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
        });

    // Replay first, then subscribe: replay-before-subscribe guarantees no gap
    // and no duplicate between the two.
    let replay = match cursor {
        Some(after) => handle.replay_after(after),
        None => ReplayResult::Replay(Vec::new()),
    };
    let mut receiver: broadcast::Receiver<Arc<Envelope>> = handle.subscribe();
    let replay_events: Vec<Arc<Envelope>> = match replay {
        ReplayResult::Replay(events) => events,
        ReplayResult::ResyncRequired => vec![resync_envelope(&handle)],
    };

    // Materialize the replay into owned SSE events so the returned stream does
    // not borrow local state.
    let replay_stream =
        futures_util::stream::iter(replay_events.iter().map(to_sse).collect::<Vec<_>>());
    let stream = replay_stream.chain(async_stream::stream! {
        loop {
            match receiver.recv().await {
                Ok(envelope) => {
                    if let Some(f) = &filter {
                        if &envelope.session_id != f {
                            continue;
                        }
                    }
                    yield to_sse(&envelope);
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // Too slow: tell the consumer to resync rather than leave
                    // it with a silently missing slice of history.
                    yield to_sse(&resync_envelope(&handle));
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// A synthetic envelope telling the consumer to refetch snapshot + messages.
fn resync_envelope(handle: &AppHandle) -> Arc<Envelope> {
    Arc::new(Envelope {
        cursor: handle.current_cursor(),
        session_id: String::new(),
        event: Event::ResyncRequired,
    })
}

fn to_sse(envelope: &Arc<Envelope>) -> Result<SseEvent, Infallible> {
    Ok(SseEvent::default()
        .id(envelope.cursor.to_string())
        .event("message")
        .json_data(envelope.as_ref())
        .unwrap_or_default())
}

#[derive(rust_embed::RustEmbed)]
#[folder = "../../web/dist/"]
struct Assets;

async fn index_handler() -> Response {
    match Assets::get("index.html") {
        Some(file) => {
            let body = String::from_utf8_lossy(file.data.as_ref()).into_owned();
            (
                // The shell is never cached; hashed static assets are cached by
                // the browser because their filenames change on rebuild.
                [(axum::http::header::CACHE_CONTROL, "no-store")],
                Html(body),
            )
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            "index.html not embedded (build the frontend: cd web && pnpm build)",
        )
            .into_response(),
    }
}

async fn static_handler(AxumPath(path): AxumPath<String>) -> Response {
    if path.is_empty() || path == "index.html" {
        return index_handler().await;
    }
    match Assets::get(&path) {
        Some(file) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            let body = file.data.as_ref().to_vec();
            (
                // Hashed asset filenames change on rebuild, so a long cache
                // lifetime is safe and avoids re-downloading on every visit.
                [
                    (axum::http::header::CONTENT_TYPE, mime.as_ref().to_owned()),
                    (
                        axum::http::header::CACHE_CONTROL,
                        "public, max-age=31536000, immutable".to_owned(),
                    ),
                ],
                body,
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
