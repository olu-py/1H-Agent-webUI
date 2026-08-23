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
    routing::{get, post},
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
}

/// Body of `POST /api/v2/config/provider` (non-secret fields only).
#[derive(Deserialize)]
struct ProviderConfigBody {
    preset: String,
    model: String,
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
        .route("/api/v2/config/provider", post(post_provider_config))
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
        Ok(()) => StatusCode::ACCEPTED.into_response(),
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
    match state.handle.cancel(&id).await {
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
    match state.handle.approve(&approval_id, body.0.accept).await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(error) => api_error_response(error),
    }
}

/// `POST /api/v2/config/provider` — non-secret provider settings (preset name
/// and model). API keys are never accepted here; they live in the OS keyring.
async fn post_provider_config(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: axum::Json<ProviderConfigBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    match state
        .handle
        .set_provider(&body.0.preset, &body.0.model)
        .await
    {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
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
