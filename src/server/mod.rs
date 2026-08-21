//! WebUI server: owns the session state machine and exposes it over REST + SSE.
//!
//! The TUI's event loop has been replaced by this module as the `router_rx`
//! consumer; the business logic in `app.rs` (submit, commands, approvals,
//! session switching, provider settings) is reused unchanged. Upstream HTTP
//! commands are serialized through an `mpsc` channel into the single state
//! machine task, so concurrent browser tabs cannot interleave mutations.

mod auth;
pub mod dto;
pub mod events;

use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        IntoResponse, Response,
        sse::{Event as SseEvent, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};
use tower_http::cors::CorsLayer;

use crate::{
    agent::AgentEvent,
    app::{self, App},
    commands::{self, Command},
    config::Config,
    model::{AgentPhase, ApprovalAction, PendingApproval},
    secrets,
    session::SessionRuntime,
    storage::Storage,
};

use auth::Auth;
use dto::{AppStateDto, ApprovalDto, EventDto, SessionStateDto, TodoDto};
use events::{EventBridge, routed_to_dto};

/// Commands serialized from HTTP handlers into the single state-machine task.
enum ServerCommand {
    GetState {
        reply: oneshot::Sender<Result<AppStateDto, String>>,
    },
    GetMessages {
        session_id: String,
        reply: oneshot::Sender<Result<Vec<crate::provider::ConversationItem>, String>>,
    },
    SubmitInput {
        session_id: Option<String>,
        text: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ExecuteCommand {
        session_id: Option<String>,
        text: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Approve {
        approval_id: String,
        accept: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Cancel {
        session_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetProvider {
        preset: String,
        model: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ActivateSession {
        session_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

/// Shared server state handed to every HTTP handler.
#[derive(Clone)]
struct ServerState {
    commands: mpsc::Sender<ServerCommand>,
    bridge: Arc<EventBridge>,
    auth: Auth,
}

/// Body of `POST /api/sessions/{id}/input` and `.../commands`.
#[derive(Deserialize)]
struct InputBody {
    text: String,
}

/// Body of `POST /api/approvals/{approval_id}`.
#[derive(Deserialize)]
struct ApprovalBody {
    accept: bool,
}

/// Body of `POST /api/config/provider` (non-secret fields only).
#[derive(Deserialize)]
struct ProviderConfigBody {
    preset: String,
    model: String,
}

/// A pending approval: the frontend-facing id plus the deadline after which the
/// server auto-rejects it. The oneshot sender lives in the runtime's
/// `pending_approval`; only the id crosses the wire.
struct PendingRecord {
    session_id: String,
    deadline: Instant,
}

/// Owns the `App` state machine. Runs the router event loop and services
/// serialized commands from HTTP handlers.
struct Machine {
    app: App,
    bridge: Arc<EventBridge>,
    pending: HashMap<String, PendingRecord>,
    approval_timeout: Duration,
}

impl Machine {
    /// The pending approval with the earliest creation time across all sessions,
    /// matching the TUI's global oldest-first ordering, along with its
    /// server-side `approval_id`.
    fn oldest_pending(&self) -> Option<(String, String, &PendingApproval)> {
        let mut best: Option<(String, String, &PendingApproval)> = None;
        for (approval_id, record) in &self.pending {
            let runtime = self.app.runtime(&record.session_id)?;
            let Some(approval) = &runtime.pending_approval else {
                continue;
            };
            if best
                .as_ref()
                .is_none_or(|(_, _, current)| approval.created_at < current.created_at)
            {
                best = Some((approval_id.clone(), record.session_id.clone(), approval));
            }
        }
        best
    }

    /// Applies a routed agent event to its owning session (reusing the shared
    /// TUI logic), then forwards a DTO to the bridge. Approval events get a
    /// fresh `approval_id` and are registered in the pending table before the
    /// sender is stored in the runtime.
    fn handle_routed(&mut self, routed: crate::app::RoutedEvent) {
        let crate::app::RoutedEvent { session_id, event } = routed;

        if let AgentEvent::Approval {
            call,
            reason,
            source_session_id,
            source_title,
            ..
        } = &event
        {
            let approval_id = uuid::Uuid::new_v4().to_string();
            self.pending.insert(
                approval_id.clone(),
                PendingRecord {
                    session_id: session_id.clone(),
                    deadline: Instant::now() + self.approval_timeout,
                },
            );
            self.bridge.push(
                &session_id,
                EventDto::Approval {
                    session_id: session_id.clone(),
                    approval_id,
                    call: call.clone(),
                    reason: reason.clone(),
                    source_session_id: source_session_id.clone(),
                    source_title: source_title.clone(),
                },
            );
        } else if let Some(dto) = routed_to_dto(&session_id, &event, None) {
            self.bridge.push(&session_id, dto);
        }

        app::handle_routed_event(&mut self.app, crate::app::RoutedEvent { session_id, event });
    }

    /// Rejects every approval whose deadline has passed, sending `false` to the
    /// agent so it never hangs waiting on an unanswerable prompt.
    fn sweep_expired_approvals(&mut self) {
        let now = Instant::now();
        let expired = self
            .pending
            .iter()
            .filter(|(_, record)| record.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for approval_id in expired {
            let _ = self.resolve_approval(&approval_id, false);
        }
    }

    /// Resolves an approval: extracts the oneshot sender from the owning
    /// session's runtime and sends the decision. Shell (`!`) approvals reuse
    /// the same flow; an accepted shell command is executed through the
    /// registry just like the TUI's `ApprovalChoice::Approve`.
    fn resolve_approval(&mut self, approval_id: &str, accept: bool) -> Result<(), String> {
        let record = self
            .pending
            .remove(approval_id)
            .ok_or_else(|| format!("unknown approval {approval_id}"))?;
        let owner = record.session_id;
        let Some((actual_owner, approval)) = self.app.take_pending_approval_global() else {
            return Err("approval already resolved".into());
        };
        if actual_owner != owner {
            return Err("approval does not belong to that session".into());
        }

        let is_agent = match approval.action {
            ApprovalAction::Agent(reply) => {
                let _ = reply.send(accept);
                if let Some(runtime) = self.app.runtime_mut(&owner) {
                    runtime.agent_phase = if accept {
                        AgentPhase::Thinking
                    } else {
                        AgentPhase::Idle
                    };
                    runtime.model_phase = crate::model::ModelPhase::Idle;
                    runtime.status = if accept {
                        "已批准，开始执行工具……".into()
                    } else {
                        "已拒绝，将结果返回模型……".into()
                    };
                }
                true
            }
            ApprovalAction::Shell(command) => {
                if !accept {
                    if let Some(runtime) = self.app.runtime_mut(&owner) {
                        runtime.agent_phase = AgentPhase::Idle;
                        runtime.status = "Shell 命令已拒绝".into();
                    }
                    true
                } else {
                    let registry = self.app.registry.clone();
                    let Some(runtime) = self.app.runtime_mut(&owner) else {
                        return Ok(());
                    };
                    let events = runtime.agent_tx.clone();
                    runtime.busy = true;
                    runtime.agent_phase = AgentPhase::ToolRunning;
                    runtime.model_phase = crate::model::ModelPhase::Idle;
                    runtime.status = "正在执行 Shell 命令……".into();
                    runtime.active_task = Some(tokio::spawn(async move {
                        let result = registry
                            .execute_shell(&command)
                            .await
                            .unwrap_or_else(|error| error.to_string());
                        let _ = events
                            .send(AgentEvent::LocalCommandFinished { command, result })
                            .await;
                    }));
                    true
                }
            }
        };

        if is_agent {
            self.bridge.push(
                &owner,
                EventDto::ApprovalResolved {
                    session_id: owner.clone(),
                    approval_id: approval_id.to_owned(),
                    approved: accept,
                },
            );
        }
        Ok(())
    }
}

/// Runs the WebUI server: builds the state machine, spawns the event loop,
/// and serves the REST/SSE API plus the embedded static frontend.
pub async fn run(workspace_path: PathBuf, config: Config) -> Result<()> {
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("cannot create data directory {}", config.data_dir.display()))?;
    let storage = Storage::open(&config.data_dir.join("agent.db"))?;
    secrets::preload_environment_keys();
    // Preload only environment-backed keys. Never touch the OS keyring during
    // startup: an unauthenticated lookup can block waiting for an
    // authorization dialog, and startup does not need a key anyway (model
    // requests unlock the credential lazily in `build_app`).
    let _ = secrets::api_key_cached_only(config.provider.preset);

    let (auth, auth_enabled) = Auth::new(&config.server.bind, &config.data_dir)?;

    // Resolve the initial active session: latest session, or none (the frontend
    // home screen creates a session on first message, never eagerly).
    let active_session = storage.latest_session(&workspace_path)?;
    let placeholder = uuid::Uuid::new_v4().to_string();
    let app = app::build_app(
        workspace_path,
        config.clone(),
        storage,
        active_session.clone().unwrap_or(placeholder),
    )
    .await?;

    let bridge = Arc::new(EventBridge::new(config.server.event_buffer));
    let (command_tx, command_rx) = mpsc::channel::<ServerCommand>(64);

    let machine = Machine {
        app,
        bridge: bridge.clone(),
        pending: HashMap::new(),
        approval_timeout: Duration::from_secs(config.server.approval_timeout_seconds),
    };

    let addr = format!("{}:{}", config.server.bind, config.server.port);
    let socket: SocketAddr = addr
        .parse()
        .with_context(|| format!("invalid server bind {addr}"))?;

    let state = ServerState {
        commands: command_tx,
        bridge: bridge.clone(),
        auth,
    };

    let router = build_router(state);
    let listener = tokio::net::TcpListener::bind(socket).await?;
    tracing::info!(
        "1H-Agent WebUI listening on http://{socket}{}",
        if auth_enabled {
            " (token auth enabled)"
        } else {
            ""
        }
    );

    let machine_future = run_machine(machine, command_rx);
    tokio::select! {
        _ = machine_future => Ok(()),
        result = axum::serve(listener, router) => result.map_err(Into::into),
    }
}

/// The state-machine event loop: consumes routed agent events and serialized
/// HTTP commands, plus a periodic sweep for expired approvals.
async fn run_machine(mut machine: Machine, mut command_rx: mpsc::Receiver<ServerCommand>) {
    let mut sweep = tokio::time::interval(Duration::from_secs(5));
    sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            routed = machine.app.router_rx.recv() => {
                match routed {
                    Some(routed) => machine.handle_routed(routed),
                    None => break,
                }
            }
            command = command_rx.recv() => {
                let Some(command) = command else { break };
                handle_command(&mut machine, command).await;
            }
            _ = sweep.tick() => machine.sweep_expired_approvals(),
        }
    }
}

async fn handle_command(machine: &mut Machine, command: ServerCommand) {
    match command {
        ServerCommand::GetState { reply } => {
            let _ = reply.send(state_snapshot(machine));
        }
        ServerCommand::GetMessages { session_id, reply } => {
            let result = machine
                .app
                .storage
                .load_messages(&session_id)
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        ServerCommand::SubmitInput {
            session_id,
            text,
            reply,
        } => {
            let result = submit_input(machine, session_id.as_deref(), &text);
            let _ = reply.send(result);
        }
        ServerCommand::ExecuteCommand {
            session_id,
            text,
            reply,
        } => {
            let result = execute_command(machine, session_id.as_deref(), &text);
            let _ = reply.send(result);
        }
        ServerCommand::Approve {
            approval_id,
            accept,
            reply,
        } => {
            let result = machine.resolve_approval(&approval_id, accept);
            let _ = reply.send(result);
        }
        ServerCommand::Cancel { session_id, reply } => {
            let result = cancel_session(machine, &session_id);
            let _ = reply.send(result);
        }
        ServerCommand::SetProvider {
            preset,
            model,
            reply,
        } => {
            let result = set_provider(machine, &preset, &model);
            let _ = reply.send(result);
        }
        ServerCommand::ActivateSession { session_id, reply } => {
            let result = activate_session(machine, &session_id);
            let _ = reply.send(result);
        }
    }
}

/// Builds the `/api/state` snapshot.
fn state_snapshot(machine: &Machine) -> Result<AppStateDto, String> {
    let app = &machine.app;
    let sessions = app
        .sessions
        .iter()
        .map(|session| {
            let runtime = app.runtime(&session.id);
            SessionStateDto {
                id: session.id.clone(),
                title: session.title.clone(),
                parent_id: session.parent_id.clone(),
                busy: runtime.map(|r| r.busy).unwrap_or(false),
                phase: runtime
                    .map(|r| r.agent_phase.label().to_owned())
                    .unwrap_or_else(|| AgentPhase::Idle.label().to_owned()),
                status: runtime.map(|r| r.status.clone()).unwrap_or_default(),
            }
        })
        .collect::<Vec<_>>();
    let active_session = if app.sessions.is_empty() || app.active_session.is_empty() {
        None
    } else {
        Some(app.active_session.clone())
    };
    let approval = machine
        .oldest_pending()
        .map(|(approval_id, session_id, approval)| ApprovalDto {
            approval_id,
            session_id,
            call: approval.call.clone(),
            reason: approval.reason.clone(),
            source_session_id: approval.source_session_id.clone(),
            source_title: approval.source_title.clone(),
            created_at_ms: approval.created_at.elapsed().as_millis() as u64,
        });
    let todos = app
        .current
        .todos
        .iter()
        .map(TodoDto::from)
        .collect::<Vec<_>>();
    Ok(AppStateDto {
        active_session,
        sessions,
        provider: app.config.provider.preset.label().to_owned(),
        model: app.config.provider.model.clone(),
        mode: app.current.mode.as_str().to_owned(),
        approval,
        todos,
    })
}

/// Submits user input to a session, creating it first when `None` (the home
/// screen "first message creates a session" semantic).
fn submit_input(machine: &mut Machine, session_id: Option<&str>, text: &str) -> Result<(), String> {
    let session_id = ensure_session(machine, session_id)?;
    let app = &mut machine.app;
    app.input.set(text.to_owned());
    if text.starts_with('/') {
        if let Some(command) = commands::parse(text) {
            let is_todo = matches!(command, Command::Todo(_));
            app::execute_command(app, command).map_err(|error| error.to_string())?;
            sync_state_after_command(machine, &session_id, is_todo);
        } else {
            app.current.push_entry(crate::model::DisplayEntry {
                kind: crate::model::DisplayKind::Error,
                content: crate::model::DisplayContent::Markdown(format!(
                    "未知命令，请使用 /help 查看命令：{text}"
                )),
            });
        }
    } else if text.starts_with('!') {
        let command = text.strip_prefix('!').unwrap_or(text).trim().to_owned();
        app::request_shell_approval(app, command.clone()).map_err(|error| error.to_string())?;
        // The shell approval is created directly on the runtime (no AgentEvent
        // round trip), so register an id and broadcast it ourselves so the
        // frontend can render the approval modal.
        register_shell_approval(machine, &command);
    } else {
        app::submit_input(app).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Registers a shell (`!`) approval that was created directly on the runtime:
/// assigns an id, records the deadline, and broadcasts the approval DTO.
fn register_shell_approval(machine: &mut Machine, _command: &str) {
    let Some(approval) = &machine.app.current.pending_approval else {
        return;
    };
    let session_id = machine.app.active_session.clone();
    let approval_id = uuid::Uuid::new_v4().to_string();
    machine.pending.insert(
        approval_id.clone(),
        PendingRecord {
            session_id: session_id.clone(),
            deadline: Instant::now() + machine.approval_timeout,
        },
    );
    let dto = EventDto::Approval {
        session_id: session_id.clone(),
        approval_id,
        call: approval.call.clone(),
        reason: approval.reason.clone(),
        source_session_id: approval.source_session_id.clone(),
        source_title: approval.source_title.clone(),
    };
    machine.bridge.push(&session_id, dto);
}

/// Executes a slash command against a session.
fn execute_command(
    machine: &mut Machine,
    session_id: Option<&str>,
    text: &str,
) -> Result<(), String> {
    let session_id = ensure_session(machine, session_id)?;
    let app = &mut machine.app;
    let Some(command) = commands::parse(text) else {
        return Err(format!("unknown command: {text}"));
    };
    let is_todo = matches!(command, Command::Todo(_));
    app::execute_command(app, command).map_err(|error| error.to_string())?;
    sync_state_after_command(machine, &session_id, is_todo);
    Ok(())
}

/// Pushes the DTOs the frontend needs to stay in sync after a command that the
/// TUI logic handled entirely in-process (no `AgentEvent` round trip):
/// a `TodoUpdated` for todo mutations and a `SessionsChanged` so the browser
/// refreshes its status bar and clears the transient "发送中…" state.
fn sync_state_after_command(machine: &mut Machine, session_id: &str, todo_changed: bool) {
    if todo_changed {
        let tasks = machine
            .app
            .runtime(session_id)
            .map(|runtime| runtime.todos.clone())
            .unwrap_or_default();
        machine.bridge.push(
            session_id,
            EventDto::TodoUpdated {
                session_id: session_id.to_owned(),
                tasks,
            },
        );
    }
    machine.bridge.push(
        session_id,
        EventDto::SessionsChanged {
            session_id: session_id.to_owned(),
        },
    );
}

/// Ensures the target session exists, creating and activating it when no id is
/// given (or when the special token `"new"` is used).
fn ensure_session(machine: &mut Machine, session_id: Option<&str>) -> Result<String, String> {
    match session_id {
        Some(id) if !id.is_empty() && id != "new" => {
            if machine.app.runtime(id).is_none() {
                return Err(format!("unknown session {id}"));
            }
            Ok(id.to_owned())
        }
        _ => {
            app::create_session(&mut machine.app).map_err(|error| error.to_string())?;
            Ok(machine.app.active_session.clone())
        }
    }
}

/// Switches the server-side active session (the runtime whose events are
/// routed to the current view), mirroring the TUI's `activate_session`.
fn activate_session(machine: &mut Machine, session_id: &str) -> Result<(), String> {
    // The session must exist in storage. It may not yet have an in-memory
    // runtime (only the active session is built at startup); `app::activate_session`
    // builds one on demand, so validate against the storage-backed list.
    if !machine
        .app
        .sessions
        .iter()
        .any(|session| session.id == session_id)
    {
        return Err(format!("unknown session {session_id}"));
    }
    app::activate_session(&mut machine.app, session_id.to_owned())
        .map_err(|error| error.to_string())?;
    // Let the frontend refresh its status bar after the switch.
    machine.bridge.push(
        session_id,
        EventDto::SessionsChanged {
            session_id: session_id.to_owned(),
        },
    );
    Ok(())
}

fn cancel_session(machine: &mut Machine, session_id: &str) -> Result<(), String> {
    if session_id != machine.app.active_session {
        return Err("only the active session can be cancelled".into());
    }
    app::cancel_active_request(&mut machine.app);
    // `cancel_active_request` mutates the runtime in place without an
    // `AgentEvent` round trip, so broadcast the terminal event ourselves to
    // let the frontend tear down its live streaming state.
    machine.bridge.push(
        session_id,
        EventDto::Cancelled {
            session_id: session_id.to_owned(),
            reason: "user".into(),
        },
    );
    Ok(())
}

/// Applies non-secret provider settings: switches the preset when given and
/// sets the model. API keys are never handled here (they stay in the keyring);
/// this reuses the shared `apply_provider_choice`/`apply_model_choice` logic.
fn set_provider(machine: &mut Machine, preset: &str, model: &str) -> Result<(), String> {
    use crate::config::ProviderPreset;
    let Some(preset) = ProviderPreset::parse(preset) else {
        return Err(format!("unknown provider preset {preset}"));
    };
    let current_preset = machine.app.config.provider.preset;
    if preset != current_preset {
        app::apply_provider_choice(&mut machine.app, preset).map_err(|error| error.to_string())?;
        // `apply_provider_choice` reports an unavailable key as a status, not an
        // error. Detect an unchanged preset and refuse to apply the model so we
        // never leave an inconsistent preset/model pair.
        if machine.app.config.provider.preset != preset {
            return Err(format!(
                "{} 的 API Key 不可用",
                crate::config::ProviderPreset::ALL
                    .iter()
                    .find(|candidate| **candidate == preset)
                    .map(|preset| preset.label())
                    .unwrap_or("provider")
            ));
        }
    }
    if !model.is_empty() && model != machine.app.config.provider.model {
        app::apply_model_choice(&mut machine.app, model.to_owned())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

impl App {
    fn runtime(&self, session_id: &str) -> Option<&SessionRuntime> {
        if session_id == self.active_session {
            Some(&self.current)
        } else {
            self.background.get(session_id)
        }
    }
}

fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/api/state", get(get_state))
        .route("/api/sessions/{id}/messages", get(get_messages))
        .route("/api/sessions/{id}/input", post(post_input))
        .route("/api/sessions/{id}/commands", post(post_commands))
        .route("/api/sessions/{id}/cancel", post(post_cancel))
        .route("/api/sessions/{id}/activate", post(post_activate))
        .route("/api/approvals/{approval_id}", post(post_approval))
        .route("/api/config/provider", post(post_provider_config))
        .route("/api/events", get(sse_handler))
        .route("/", get(index_handler))
        .route("/{*path}", get(static_handler))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(CorsLayer::permissive())
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
    (StatusCode::UNAUTHORIZED, "missing or invalid bearer token").into_response()
}

async fn get_state(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let (tx, rx) = oneshot::channel();
    if state
        .commands
        .send(ServerCommand::GetState { reply: tx })
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "server shutting down").into_response();
    }
    match rx.await {
        Ok(Ok(snapshot)) => axum::Json(snapshot).into_response(),
        Ok(Err(error)) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "state unavailable").into_response(),
    }
}

async fn get_messages(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let (tx, rx) = oneshot::channel();
    if state
        .commands
        .send(ServerCommand::GetMessages {
            session_id: id,
            reply: tx,
        })
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "server shutting down").into_response();
    }
    match rx.await {
        Ok(Ok(messages)) => axum::Json(messages).into_response(),
        Ok(Err(error)) => (StatusCode::NOT_FOUND, error).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "messages unavailable").into_response(),
    }
}

/// `POST /api/sessions/{id}/input` — submit user text. `/`-prefixed text is
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
    let (tx, rx) = oneshot::channel();
    if state
        .commands
        .send(ServerCommand::SubmitInput {
            session_id: (!id.is_empty() && id != "new").then_some(id),
            text: body.0.text,
            reply: tx,
        })
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "server shutting down").into_response();
    }
    match rx.await {
        Ok(Ok(())) => StatusCode::ACCEPTED.into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, error).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "command dropped").into_response(),
    }
}

/// `POST /api/sessions/{id}/commands` — structured slash command.
async fn post_commands(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: axum::Json<InputBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let (tx, rx) = oneshot::channel();
    if state
        .commands
        .send(ServerCommand::ExecuteCommand {
            session_id: (!id.is_empty() && id != "new").then_some(id),
            text: body.0.text,
            reply: tx,
        })
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "server shutting down").into_response();
    }
    match rx.await {
        Ok(Ok(())) => StatusCode::ACCEPTED.into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, error).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "command dropped").into_response(),
    }
}

/// `POST /api/sessions/{id}/cancel` — cancel the active request.
async fn post_cancel(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let (tx, rx) = oneshot::channel();
    if state
        .commands
        .send(ServerCommand::Cancel {
            session_id: id,
            reply: tx,
        })
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "server shutting down").into_response();
    }
    match rx.await {
        Ok(Ok(())) => StatusCode::ACCEPTED.into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, error).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "command dropped").into_response(),
    }
}

/// `POST /api/sessions/{id}/activate` — switch the server-side active session.
async fn post_activate(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let (tx, rx) = oneshot::channel();
    if state
        .commands
        .send(ServerCommand::ActivateSession {
            session_id: id,
            reply: tx,
        })
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "server shutting down").into_response();
    }
    match rx.await {
        Ok(Ok(())) => StatusCode::ACCEPTED.into_response(),
        Ok(Err(error)) => (StatusCode::NOT_FOUND, error).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "command dropped").into_response(),
    }
}

/// `POST /api/approvals/{approval_id}` — `{ "accept": bool }` resolves a
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
    let (tx, rx) = oneshot::channel();
    if state
        .commands
        .send(ServerCommand::Approve {
            approval_id,
            accept: body.0.accept,
            reply: tx,
        })
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "server shutting down").into_response();
    }
    match rx.await {
        Ok(Ok(())) => StatusCode::ACCEPTED.into_response(),
        Ok(Err(error)) => (StatusCode::NOT_FOUND, error).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "command dropped").into_response(),
    }
}

/// `POST /api/config/provider` — non-secret provider settings (preset name,
/// model, base url, protocol, thinking). API keys are never accepted here;
/// they live in the OS keyring only.
async fn post_provider_config(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: axum::Json<ProviderConfigBody>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let (tx, rx) = oneshot::channel();
    if state
        .commands
        .send(ServerCommand::SetProvider {
            preset: body.0.preset,
            model: body.0.model,
            reply: tx,
        })
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "server shutting down").into_response();
    }
    match rx.await {
        Ok(Ok(())) => StatusCode::ACCEPTED.into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, error).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "command dropped").into_response(),
    }
}

/// SSE handler: replays from `Last-Event-ID` (when provided) then streams live
/// events. Optionally filtered to one session via `?session=<id>`.
async fn sse_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&state, &headers) {
        return unauthorized();
    }
    let bridge = state.bridge.clone();
    let filter = params.get("session").cloned();
    let last_id = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

    let mut receiver = bridge.subscribe();
    let replay = replay_events(bridge.clone(), filter.as_deref(), last_id);
    let stream = futures_util::stream::iter(replay).chain(async_stream::stream! {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if let Some(f) = &filter {
                        if &event.session_id != f {
                            continue;
                        }
                    }
                    yield to_sse(&event.dto, event.seq);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn to_sse(dto: &EventDto, seq: u64) -> Result<SseEvent, Infallible> {
    Ok(SseEvent::default()
        .id(seq.to_string())
        .event("message")
        .json_data(dto)
        .unwrap_or_default())
}

/// Replays buffered events for the SSE connection, honoring `Last-Event-ID`.
fn replay_events(
    bridge: Arc<EventBridge>,
    filter: Option<&str>,
    last_id: Option<u64>,
) -> Vec<Result<SseEvent, Infallible>> {
    let Some(after) = last_id else {
        return Vec::new();
    };
    bridge
        .replay(filter, after)
        .into_iter()
        .map(|event| to_sse(&event.dto, event.seq))
        .collect()
}

#[derive(rust_embed::RustEmbed)]
#[folder = "web/"]
struct Assets;

async fn index_handler() -> Response {
    match Assets::get("index.html") {
        Some(file) => {
            let body = String::from_utf8_lossy(file.data.as_ref()).into_owned();
            axum::response::Html(body).into_response()
        }
        None => (StatusCode::NOT_FOUND, "index.html not embedded").into_response(),
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
                [(axum::http::header::CONTENT_TYPE, mime.as_ref().to_owned())],
                body,
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::Config,
        model::{AgentPhase, ApprovalAction},
        provider::ToolCall,
        storage::Storage,
    };
    use tempfile::TempDir;

    /// Builds a `Machine` against a fresh temp workspace, reusing the shared
    /// `app::build_app` so the state machine is identical to production.
    async fn test_machine() -> (TempDir, Machine) {
        let temp = TempDir::new().unwrap();
        let workspace = temp.path().to_path_buf();
        let mut config = Config::default();
        config.data_dir = temp.path().join("data");
        std::fs::create_dir_all(&config.data_dir).unwrap();
        let storage = Storage::open(&config.data_dir.join("agent.db")).unwrap();
        let session_id = storage.create_session(&workspace).unwrap();
        let app = app::build_app(workspace, config, storage, session_id)
            .await
            .unwrap();
        let bridge = Arc::new(EventBridge::new(512));
        let machine = Machine {
            app,
            bridge,
            pending: HashMap::new(),
            approval_timeout: Duration::from_millis(50),
        };
        (temp, machine)
    }

    #[tokio::test]
    async fn state_snapshot_reports_sessions_and_active_id() {
        let (_temp, machine) = test_machine().await;
        let snapshot = state_snapshot(&machine).unwrap();
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(
            snapshot.active_session.as_deref(),
            Some(machine.app.active_session.as_str())
        );
        assert!(!snapshot.model.is_empty());
        assert!(!snapshot.provider.is_empty());
        assert_eq!(snapshot.mode, "build");
        assert!(snapshot.approval.is_none());
    }

    #[tokio::test]
    async fn approval_timeout_rejects_and_emits_terminal_event() {
        let (_temp, mut machine) = test_machine().await;
        let (reply_tx, answer_rx) = tokio::sync::oneshot::channel();
        // Register a pending approval with an already-expired deadline.
        let approval_id = "ap_timeout".to_owned();
        let owner = machine.app.active_session.clone();
        machine.app.current.pending_approval = Some(PendingApproval {
            call: ToolCall {
                id: "c1".into(),
                name: "file_write".into(),
                arguments: serde_json::json!({}),
            },
            reason: "timeout test".into(),
            source_session_id: None,
            source_title: None,
            action: ApprovalAction::Agent(reply_tx),
            created_at: Instant::now(),
        });
        machine.pending.insert(
            approval_id.clone(),
            PendingRecord {
                session_id: owner.clone(),
                deadline: Instant::now() - Duration::from_millis(1),
            },
        );
        let bridge = machine.bridge.clone();
        let mut events = bridge.subscribe();

        machine.sweep_expired_approvals();

        // The agent receives a rejection.
        assert_eq!(answer_rx.await, Ok(false));
        // The SSE stream observed an ApprovalResolved(false) terminal event.
        let terminal = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("timed out waiting for approval resolved event")
            .expect("stream closed");
        assert_eq!(terminal.session_id, owner);
        match &terminal.dto {
            EventDto::ApprovalResolved { approved, .. } => assert!(!approved),
            other => panic!("expected approval_resolved, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn explicit_approve_sends_true_and_resolves_state() {
        let (_temp, mut machine) = test_machine().await;
        let (reply_tx, answer_rx) = tokio::sync::oneshot::channel();
        let owner = machine.app.active_session.clone();
        machine.app.current.pending_approval = Some(PendingApproval {
            call: ToolCall {
                id: "c2".into(),
                name: "terminal_exec".into(),
                arguments: serde_json::json!({}),
            },
            reason: "approve test".into(),
            source_session_id: None,
            source_title: None,
            action: ApprovalAction::Agent(reply_tx),
            created_at: Instant::now(),
        });
        let approval_id = "ap_ok".to_owned();
        machine.pending.insert(
            approval_id.clone(),
            PendingRecord {
                session_id: owner.clone(),
                deadline: Instant::now() + Duration::from_secs(60),
            },
        );
        machine.resolve_approval(&approval_id, true).unwrap();
        assert_eq!(answer_rx.await, Ok(true));
        assert!(!machine.pending.contains_key(&approval_id));
        assert!(machine.app.current.pending_approval.is_none());
    }

    #[tokio::test]
    async fn unknown_approval_and_unknown_session_are_rejected() {
        let (_temp, mut machine) = test_machine().await;
        assert!(machine.resolve_approval("nope", true).is_err());

        // Submitting to an unknown session fails without creating anything.
        let result = submit_input(&mut machine, Some("missing-session"), "hello");
        assert!(result.is_err());
        assert_eq!(machine.app.sessions.len(), 1);
    }

    #[tokio::test]
    async fn input_creates_session_when_none_active() {
        let temp = TempDir::new().unwrap();
        let workspace = temp.path().to_path_buf();
        let mut config = Config::default();
        config.data_dir = temp.path().join("data");
        std::fs::create_dir_all(&config.data_dir).unwrap();
        let storage = Storage::open(&config.data_dir.join("agent.db")).unwrap();
        // Build with no active session (home screen state).
        let placeholder = uuid::Uuid::new_v4().to_string();
        let app = app::build_app(workspace, config, storage, placeholder.clone())
            .await
            .unwrap();
        let bridge = Arc::new(EventBridge::new(16));
        let mut machine = Machine {
            app,
            bridge,
            pending: HashMap::new(),
            approval_timeout: Duration::from_secs(300),
        };

        // No sessions yet: home screen semantic.
        assert!(machine.app.sessions.is_empty());
        let result = submit_input(&mut machine, None, "first message");
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(machine.app.sessions.len(), 1);
        assert!(machine.app.active_session != placeholder);
    }

    #[tokio::test]
    async fn cancel_rejects_active_request() {
        let (_temp, mut machine) = test_machine().await;
        let owner = machine.app.active_session.clone();
        machine.app.current.busy = true;
        machine.app.current.agent_phase = AgentPhase::Thinking;
        let mut events = machine.bridge.subscribe();
        let result = cancel_session(&mut machine, &owner);
        assert!(result.is_ok());
        assert!(!machine.app.current.busy);
        assert_eq!(machine.app.current.agent_phase, AgentPhase::Idle);

        // The cancel must broadcast a terminal Cancelled DTO so the frontend
        // tears down its live streaming state (no AgentEvent round trip here).
        let received = events.try_recv().expect("cancel broadcasts Cancelled");
        assert!(matches!(
            received.dto,
            EventDto::Cancelled { ref session_id, .. } if session_id == &owner
        ));

        // Cancelling a background session is rejected (matches Esc semantics).
        let result = cancel_session(&mut machine, "some-background");
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn state_snapshot_carries_real_approval_id() {
        let (_temp, mut machine) = test_machine().await;
        let owner = machine.app.active_session.clone();
        let (reply_tx, _answer_rx) = tokio::sync::oneshot::channel();
        machine.app.current.pending_approval = Some(PendingApproval {
            call: ToolCall {
                id: "c".into(),
                name: "file_write".into(),
                arguments: serde_json::json!({}),
            },
            reason: "state id test".into(),
            source_session_id: None,
            source_title: None,
            action: ApprovalAction::Agent(reply_tx),
            created_at: Instant::now(),
        });
        let approval_id = "ap_state_1".to_owned();
        machine.pending.insert(
            approval_id.clone(),
            PendingRecord {
                session_id: owner.clone(),
                deadline: Instant::now() + Duration::from_secs(60),
            },
        );
        let snapshot = state_snapshot(&machine).unwrap();
        let approval = snapshot.approval.expect("approval must be reported");
        assert_eq!(approval.approval_id, approval_id);
        assert_eq!(approval.session_id, owner);
    }

    #[tokio::test]
    async fn shell_approval_broadcasts_approval_dto() {
        let (_temp, mut machine) = test_machine().await;
        let bridge = machine.bridge.clone();
        let mut events = bridge.subscribe();
        let owner = machine.app.active_session.clone();
        // The `!` input path creates a shell pending approval on the runtime.
        let result = submit_input(&mut machine, Some(&owner), "!echo hello");
        assert!(result.is_ok(), "{result:?}");
        assert!(machine.app.current.pending_approval.is_some());
        let approval = events.recv().await.expect("stream closed");
        match &approval.dto {
            EventDto::Approval {
                approval_id, call, ..
            } => {
                assert_eq!(approval.session_id, owner);
                assert!(!approval_id.is_empty());
                assert_eq!(call.name, "terminal_shell");
            }
            other => panic!("expected approval dto, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn activate_session_switches_server_side_active() {
        let (_temp, mut machine) = test_machine().await;
        let first = machine.app.active_session.clone();
        // Create a second session via the shared command path.
        app::create_session(&mut machine.app).unwrap();
        let second = machine.app.active_session.clone();
        assert_ne!(first, second);
        // Switch back to the first.
        let result = activate_session(&mut machine, &first);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(machine.app.active_session, first);
        // Unknown session is rejected.
        assert!(activate_session(&mut machine, "missing").is_err());
    }

    #[tokio::test]
    async fn activate_session_accepts_persisted_session_without_live_runtime() {
        // Simulate startup: only the active session gets a runtime; a second
        // persisted session has no in-memory runtime until activated.
        let temp = TempDir::new().unwrap();
        let workspace = temp.path().to_path_buf();
        let mut config = Config::default();
        config.data_dir = temp.path().join("data");
        std::fs::create_dir_all(&config.data_dir).unwrap();
        let storage = Storage::open(&config.data_dir.join("agent.db")).unwrap();
        let active = storage.create_session(&workspace).unwrap();
        let persisted = storage.create_session(&workspace).unwrap();
        // Build with only `active` as the live runtime.
        let app = app::build_app(workspace, config, storage, active.clone())
            .await
            .unwrap();
        assert!(app.background.is_empty());
        let bridge = Arc::new(EventBridge::new(16));
        let mut machine = Machine {
            app,
            bridge,
            pending: HashMap::new(),
            approval_timeout: Duration::from_secs(300),
        };
        assert!(machine.app.runtime(&persisted).is_none());
        let result = activate_session(&mut machine, &persisted);
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(machine.app.active_session, persisted);
    }

    #[tokio::test]
    async fn todo_command_emits_sync_dtos() {
        let (_temp, mut machine) = test_machine().await;
        let bridge = machine.bridge.clone();
        let mut events = bridge.subscribe();
        let owner = machine.app.active_session.clone();
        let result = execute_command(&mut machine, Some(&owner), "/todo add write tests");
        assert!(result.is_ok(), "{result:?}");
        // First a todo_updated with the new task, then a sessions_changed.
        let first = events.recv().await.expect("stream closed");
        match &first.dto {
            EventDto::TodoUpdated { tasks, .. } => {
                assert_eq!(tasks.len(), 1);
                assert_eq!(tasks[0].title, "write tests");
            }
            other => panic!("expected todo_updated first, got {other:?}"),
        }
        let second = events.recv().await.expect("stream closed");
        assert!(matches!(second.dto, EventDto::SessionsChanged { .. }));
    }

    #[tokio::test]
    async fn provider_model_only_switch_updates_snapshot() {
        let (_temp, mut machine) = test_machine().await;
        // Same preset (OpenAI by default): the model-only path applies without
        // needing an API key.
        let result = set_provider(&mut machine, "openai", "gpt-5");
        assert!(result.is_ok(), "{result:?}");
        let snapshot = state_snapshot(&machine).unwrap();
        assert_eq!(snapshot.provider, "OpenAI");
        assert_eq!(snapshot.model, "gpt-5");
    }

    #[tokio::test]
    async fn provider_preset_switch_without_key_fails_gracefully() {
        let (_temp, mut machine) = test_machine().await;
        // Switching presets requires the target key; without one the call must
        // fail and leave the current connection untouched (no inconsistent
        // preset/model pair).
        let result = set_provider(&mut machine, "deepseek", "deepseek-v4-flash");
        assert!(result.is_err(), "expected an error without a key");
        let snapshot = state_snapshot(&machine).unwrap();
        assert_eq!(snapshot.provider, "OpenAI");
        assert_eq!(snapshot.model, "gpt-5-mini");
    }
}
