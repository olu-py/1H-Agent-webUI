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
    collections::HashMap,
    convert::Infallible,
    future::Future,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
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
    serve::ListenerExt,
};
use futures_util::StreamExt;
use protium_core::{
    protocol::{ApiError, ApiErrorKind, Envelope, Event, PROTOCOL_VERSION},
    service::{AppHandle, AppService, CoreConfig},
};
use serde::Deserialize;

use crate::auth::Auth;

/// Shared state handed to every HTTP handler.
#[derive(Clone)]
struct ServerState {
    handle: AppHandle,
    auth: Auth,
    shutdown: tokio::sync::watch::Receiver<bool>,
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
    run_until(workspace_path, config, shutdown_signal()).await
}

async fn run_until(
    workspace_path: PathBuf,
    config: protium_core::config::Config,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<()> {
    let socket = bind_address(&config.server.bind, config.server.port)?;
    let (auth, auth_enabled) = Auth::new(socket.ip(), &config.data_dir)?;
    // Bind before starting Core so a bad or occupied address cannot leave an
    // engine running after startup fails.
    let listener = tokio::net::TcpListener::bind(socket)
        .await
        .with_context(|| format!("cannot listen on {socket}"))?
        .tap_io(|stream| {
            if let Err(error) = stream.set_nodelay(true) {
                tracing::warn!(%error, "could not disable Nagle on HTTP connection");
            }
        });

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

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let state = ServerState {
        handle: handle.clone(),
        auth,
        shutdown: shutdown_rx,
    };
    let router = build_router(state);
    tracing::info!(
        "1H-Agent Web (v{PROTOCOL_VERSION}) listening on http://{socket}{}",
        if auth_enabled {
            " (token auth enabled)"
        } else {
            ""
        }
    );

    // Close SSE streams on shutdown so graceful HTTP drain can finish.
    let served = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            shutdown.await;
            shutdown_tx.send_replace(true);
        })
        .await
        .context("HTTP server failed");
    let stopped = handle
        .shutdown()
        .await
        .map_err(|error| anyhow::anyhow!("core shutdown failed: {}", error.message));
    drop(handle);
    served.and(stopped)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    result = tokio::signal::ctrl_c() => {
                        if let Err(error) = result { tracing::error!(%error, "cannot listen for Ctrl-C"); }
                    },
                    _ = term.recv() => {},
                }
                return;
            }
            Err(error) => tracing::warn!(%error, "cannot listen for SIGTERM"),
        }
    }
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "cannot listen for Ctrl-C");
    }
}

fn bind_address(host: &str, port: u32) -> Result<SocketAddr> {
    let host = host.trim();
    let ip = if host.eq_ignore_ascii_case("localhost") {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        host.parse::<IpAddr>().with_context(|| {
            format!("invalid server bind {host:?}: use an IP address or localhost")
        })?
    };
    let port = u16::try_from(port).context("invalid server port: expected 0..=65535")?;
    Ok(SocketAddr::new(ip, port))
}

#[cfg(test)]
mod bind_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn addresses_bind_and_authenticate_from_the_same_ip() {
        let dir = tempfile::tempdir().unwrap();
        for host in ["127.0.0.1", "localhost", "0.0.0.0"] {
            let socket = bind_address(host, 0).unwrap();
            let listener = tokio::net::TcpListener::bind(socket).await.unwrap();
            let (auth, enabled) =
                Auth::new(listener.local_addr().unwrap().ip(), dir.path()).unwrap();
            assert_eq!(enabled, host == "0.0.0.0");
            assert_eq!(auth.check(None), !enabled);
        }
        let socket = bind_address("::1", 0).unwrap();
        match tokio::net::TcpListener::bind(socket).await {
            Ok(listener) => {
                let (auth, enabled) =
                    Auth::new(listener.local_addr().unwrap().ip(), dir.path()).unwrap();
                assert!(!enabled);
                assert!(auth.check(None));
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported
                ) =>
            {
                eprintln!("IPv6 loopback unavailable: {error}");
            }
            Err(error) => panic!("IPv6 bind failed unexpectedly: {error}"),
        }
        let error = bind_address("invalid.example", 0).unwrap_err().to_string();
        assert!(error.contains("use an IP address or localhost"));
        assert!(bind_address("127.0.0.1", 65536).is_err());
    }

    #[tokio::test]
    async fn startup_rejects_bad_or_occupied_address_before_core_starts() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = protium_core::config::Config::default();
        config.data_dir = dir.path().join("data");
        config.server.bind = "invalid.example".to_owned();
        assert!(run(dir.path().to_owned(), config.clone()).await.is_err());
        assert!(!config.data_dir.join("agent.db").exists());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        config.server.bind = "127.0.0.1".to_owned();
        config.server.port = u32::from(listener.local_addr().unwrap().port());
        let error = run(dir.path().to_owned(), config.clone())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("cannot listen"));
        assert!(!config.data_dir.join("agent.db").exists());
    }

    #[test]
    fn real_server_auth_shutdown_and_restart() {
        const CHILD: &str = "WEB_TEST_ISOLATED_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child
                .arg("--exact")
                .arg("server::bind_tests::real_server_auth_shutdown_and_restart")
                .arg("--nocapture")
                .env(CHILD, "1");
            for name in [
                "OPENAI_API_KEY",
                "AGENT_API_KEY",
                "DEEPSEEK_API_KEY",
                "DASHSCOPE_API_KEY",
                "QWEN_API_KEY",
                "ARK_API_KEY",
                "VOLCANO_API_KEY",
            ] {
                child.env(name, "synthetic-provider-key");
            }
            assert!(child.status().unwrap().success());
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let mut config = protium_core::config::Config::default();
            config.data_dir = temp.path().join("data");
            config.server.bind = "0.0.0.0".into();
            let port_probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            config.server.port = u32::from(port_probe.local_addr().unwrap().port());
            drop(port_probe);
            std::fs::create_dir_all(&config.data_dir).unwrap();
            std::fs::write(config.data_dir.join("server_token"), "synthetic-token").unwrap();
            let address = format!("127.0.0.1:{}", config.server.port);
            for _ in 0..2 {
                let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
                let task = tokio::spawn(run_until(temp.path().to_path_buf(), config.clone(), async move { let _ = stop_rx.await; }));
                let connect = || async {
                    tokio::time::timeout(Duration::from_secs(10), async {
                        loop {
                            match tokio::net::TcpStream::connect(&address).await {
                                Ok(stream) => break stream,
                                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                            }
                        }
                    }).await.unwrap()
                };
                let mut unauth = connect().await;
                unauth.write_all(b"GET /api/v2/state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.unwrap();
                let mut response = Vec::new();
                unauth.read_to_end(&mut response).await.unwrap();
                assert!(response.starts_with(b"HTTP/1.1 401"));
                for (credential, expected) in [("invalid-token", "401"), ("synthetic-token", "200")] {
                    let mut rest = connect().await;
                    rest.write_all(format!("GET /api/v2/state HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {credential}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                    let mut response = Vec::new();
                    rest.read_to_end(&mut response).await.unwrap();
                    assert!(response.starts_with(format!("HTTP/1.1 {expected}").as_bytes()));
                    assert!(!String::from_utf8_lossy(&response).contains("synthetic-token"));
                }
                for body in [
                    r#"{"preset":"synthetic-provider-key","model":"m","api_key":"synthetic-provider-key"}"#,
                    r#"{"preset":"openai","model":"m","kind":"synthetic-provider-key","api_key":"synthetic-provider-key"}"#,
                ] {
                    let mut rest = connect().await;
                    rest.write_all(format!("POST /api/v2/config/provider HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer synthetic-token\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                    let mut response = Vec::new();
                    rest.read_to_end(&mut response).await.unwrap();
                    assert!(response.starts_with(b"HTTP/1.1 400"));
                    assert!(!String::from_utf8_lossy(&response).contains("synthetic-provider-key"));
                }
                let mut sse = connect().await;
                sse.write_all(b"GET /api/v2/events?cursor=0 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer synthetic-token\r\n\r\n").await.unwrap();
                let mut headers = [0; 1024];
                let n = tokio::time::timeout(Duration::from_secs(5), sse.read(&mut headers)).await.unwrap().unwrap();
                assert!(headers[..n].starts_with(b"HTTP/1.1 200"));
                stop_tx.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap();
                let mut tail = Vec::new();
                tokio::time::timeout(Duration::from_secs(5), sse.read_to_end(&mut tail)).await.unwrap().unwrap();
            }
            for host in ["127.0.0.1", "localhost", "::1"] {
                let probe_address = if host == "::1" { "[::1]:0" } else { "127.0.0.1:0" };
                let probe = match tokio::net::TcpListener::bind(probe_address).await {
                    Ok(listener) => listener,
                    Err(error) if host == "::1" && matches!(error.kind(), std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::Unsupported) => {
                        eprintln!("IPv6 loopback unavailable: {error}");
                        continue;
                    }
                    Err(error) => panic!("cannot bind {host}: {error}"),
                };
                config.server.bind = host.to_owned();
                config.server.port = u32::from(probe.local_addr().unwrap().port());
                drop(probe);
                let connect_address = if host == "::1" { format!("[::1]:{}", config.server.port) } else { format!("127.0.0.1:{}", config.server.port) };
                let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
                let task = tokio::spawn(run_until(temp.path().to_path_buf(), config.clone(), async move { let _ = stop_rx.await; }));
                let mut stream = tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        match tokio::net::TcpStream::connect(&connect_address).await {
                            Ok(stream) => break stream,
                            Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                        }
                    }
                }).await.unwrap();
                stream.write_all(b"GET /api/v2/state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.unwrap();
                let mut response = Vec::new();
                stream.read_to_end(&mut response).await.unwrap();
                assert!(response.starts_with(b"HTTP/1.1 200"), "{host} must allow loopback access");
                stop_tx.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap();
            }
        });
    }

    #[cfg(unix)]
    #[test]
    fn sigterm_drains_server_and_allows_restart() {
        use std::{
            io::{Read, Write},
            process::{Command, Stdio},
            time::Instant,
        };
        const CHILD: &str = "WEB_SIGTERM_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let workspace = PathBuf::from(std::env::var_os("WEB_SIGTERM_WORKSPACE").unwrap());
            let port: u32 = std::env::var("WEB_SIGTERM_PORT").unwrap().parse().unwrap();
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let mut config = protium_core::config::Config::default();
                config.data_dir = workspace.join("data");
                config.server.bind = "127.0.0.1".into();
                config.server.port = port;
                run(workspace, config).await.unwrap();
            });
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        for _ in 0..2 {
            let mut child = Command::new(std::env::current_exe().unwrap());
            child
                .arg("--exact")
                .arg("server::bind_tests::sigterm_drains_server_and_allows_restart")
                .arg("--nocapture")
                .env(CHILD, "1")
                .env("WEB_SIGTERM_WORKSPACE", temp.path())
                .env("WEB_SIGTERM_PORT", port.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            for name in [
                "OPENAI_API_KEY",
                "AGENT_API_KEY",
                "DEEPSEEK_API_KEY",
                "DASHSCOPE_API_KEY",
                "QWEN_API_KEY",
                "ARK_API_KEY",
                "VOLCANO_API_KEY",
            ] {
                child.env(name, "synthetic-provider-key");
            }
            let mut child = child.spawn().unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                match std::net::TcpStream::connect(("127.0.0.1", port)) {
                    Ok(stream) => break stream,
                    Err(_) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(error) => {
                        let _ = child.kill();
                        panic!("server startup failed: {error}");
                    }
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .write_all(
                    b"GET /api/v2/state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).unwrap();
            assert!(response.starts_with(b"HTTP/1.1 200"));
            assert!(
                Command::new("kill")
                    .arg("-TERM")
                    .arg(child.id().to_string())
                    .status()
                    .unwrap()
                    .success()
            );
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success(), "SIGTERM did not drain normally: {status}");
                    break;
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    panic!("SIGTERM shutdown timed out");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    #[test]
    fn locked_core_redacts_provider_echo_over_http_sse_and_logs() {
        const CHILD: &str = "WEB_REDACTION_TEST_CHILD";
        const KEY: &str = "synthetic/provider-key.with-punctuation";
        const OTHER: &str = "synthetic/other-provider-key-82";
        if std::env::var_os(CHILD).is_none() {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child
                .arg("--exact")
                .arg("server::bind_tests::locked_core_redacts_provider_echo_over_http_sse_and_logs")
                .arg("--nocapture")
                .env(CHILD, "1");
            for name in [
                "AGENT_API_KEY",
                "DEEPSEEK_API_KEY",
                "DASHSCOPE_API_KEY",
                "QWEN_API_KEY",
                "ARK_API_KEY",
                "VOLCANO_API_KEY",
            ] {
                child.env(name, OTHER);
            }
            child.env("OPENAI_API_KEY", KEY);
            let output = child.output().unwrap();
            let logs = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(output.status.success(), "isolated test failed: {logs}");
            assert!(!logs.contains(KEY));
            assert!(!logs.contains(OTHER));
            assert!(logs.contains("[REDACTED]"), "retry log was not captured");
            return;
        }
        tracing::subscriber::set_global_default(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::WARN)
                .finish(),
        )
        .unwrap();
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let provider_address = provider_listener.local_addr().unwrap();
            let provider = tokio::spawn(async move {
                for attempt in 0..3 {
                    let (mut socket, _) = provider_listener.accept().await.unwrap();
                    let mut request = [0u8; 16384];
                    let _ = socket.read(&mut request).await.unwrap();
                    let (status, body) = if attempt == 0 {
                        ("429 Too Many Requests", format!("credential={KEY}"))
                    } else if attempt == 1 {
                        ("200 OK", [
                            serde_json::json!({"type":"response.output_item.done", "item":{"type":"function_call", "call_id":"web-call-1", "name":"file_read", "arguments":"{\"path\":\"fixture.txt\"}"}}),
                            serde_json::json!({"type":"response.completed"}),
                        ].iter().map(|v| format!("data: {v}\n\n")).collect::<String>())
                    } else {
                        ("200 OK", [
                            serde_json::json!({"type":"response.output_text.delta", "delta":"answer synthetic/other-provider-"}),
                            serde_json::json!({"type":"response.output_text.delta", "delta":"key-82 done"}),
                            serde_json::json!({"type":"response.completed"}),
                        ].iter().map(|v| format!("data: {v}\n\n")).collect::<String>())
                    };
                    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nRetry-After: 0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                }
            });
            let temp = tempfile::tempdir().unwrap();
            std::fs::write(temp.path().join("fixture.txt"), format!("normal content {KEY} {OTHER}")).unwrap();
            let mut config = protium_core::config::Config::default();
            config.data_dir = temp.path().join("data");
            config.provider.base_url = format!("http://{provider_address}");
            config.provider.context_window_tokens = Some(128_000);
            config.model_metadata.fetch = false;
            let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            config.server.port = u32::from(probe.local_addr().unwrap().port());
            let address = format!("127.0.0.1:{}", config.server.port);
            drop(probe);
            let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
            let server = tokio::spawn(run_until(temp.path().to_owned(), config, async move { let _ = stop_rx.await; }));
            let connect = || async {
                tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        if let Ok(socket) = tokio::net::TcpStream::connect(&address).await { break socket; }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }).await.unwrap()
            };
            let mut sse = connect().await;
            sse.write_all(b"GET /api/v2/events?cursor=0 HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
            let mut rejected = connect().await;
            let rejected_body = serde_json::json!({"text":format!("secret {OTHER}")}).to_string();
            rejected.write_all(format!("POST /api/v2/sessions/new/input HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{rejected_body}", rejected_body.len()).as_bytes()).await.unwrap();
            let mut rejection = Vec::new();
            rejected.read_to_end(&mut rejection).await.unwrap();
            assert!(rejection.starts_with(b"HTTP/1.1 400"));
            assert!(!String::from_utf8_lossy(&rejection).contains(OTHER));
            let mut memory = connect().await;
            let memory_body = serde_json::json!({"title":"note", "content":OTHER, "candidate":false}).to_string();
            memory.write_all(format!("POST /api/v2/memories HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{memory_body}", memory_body.len()).as_bytes()).await.unwrap();
            let mut memory_response = Vec::new();
            memory.read_to_end(&mut memory_response).await.unwrap();
            assert!(memory_response.starts_with(b"HTTP/1.1 400"));
            assert!(!String::from_utf8_lossy(&memory_response).contains(OTHER));
            let mut input = connect().await;
            let body = r#"{"text":"hello"}"#;
            input.write_all(format!("POST /api/v2/sessions/new/input HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            let mut response = Vec::new();
            input.read_to_end(&mut response).await.unwrap();
            assert!(response.starts_with(b"HTTP/1.1 202"));
            let mut event_bytes = Vec::new();
            tokio::time::timeout(Duration::from_secs(15), async {
                let mut buffer = [0; 4096];
                while !String::from_utf8_lossy(&event_bytes).contains("\"type\":\"completed\"") {
                    let n = sse.read(&mut buffer).await.unwrap();
                    assert_ne!(n, 0);
                    event_bytes.extend_from_slice(&buffer[..n]);
                }
            }).await.unwrap();
            let event_text = String::from_utf8_lossy(&event_bytes);
            assert!(!event_text.contains(KEY));
            assert!(!event_text.contains(OTHER));
            assert!(event_text.contains("normal content"));
            assert!(event_text.contains("[REDACTED]"));
            let mut state = connect().await;
            state.write_all(b"GET /api/v2/state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await.unwrap();
            let mut state_bytes = Vec::new();
            state.read_to_end(&mut state_bytes).await.unwrap();
            let state_text = String::from_utf8(state_bytes).unwrap();
            let state_json: serde_json::Value = serde_json::from_str(state_text.split_once("\r\n\r\n").unwrap().1).unwrap();
            let session = state_json["active_session"].as_str().unwrap();
            let mut messages = connect().await;
            messages.write_all(format!("GET /api/v2/sessions/{session}/messages HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            let mut message_bytes = Vec::new();
            messages.read_to_end(&mut message_bytes).await.unwrap();
            let message_text = String::from_utf8_lossy(&message_bytes);
            assert!(!message_text.contains(KEY));
            assert!(!message_text.contains(OTHER));
            assert!(message_text.contains("normal content"));
            assert!(message_text.contains("[REDACTED]"));
            drop(sse);
            stop_tx.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(10), server).await.unwrap().unwrap().unwrap();
            provider.await.unwrap();
        });
    }
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
        return api_error_response(ApiError::bad_request("unknown provider preset"));
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
                return api_error_response(ApiError::bad_request("unknown provider kind"));
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
        if protium_core::secrets::store_api_key_cached(preset, key_id, api_key).is_err() {
            tracing::warn!("keyring write failed; the key applies to this run only");
            key_warning = Some("密钥已生效（本次运行），但写入系统钥匙串失败".to_owned());
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
/// The client subscribes atomically from the snapshot's `event_cursor`.
/// Buffered events strictly after that cursor are replayed first, then live
/// events stream until the connection closes. When the requested cursor has been
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

    // subscribe_from closes the replay/live gap. If the requested cursor was
    // evicted, establish a fresh atomic subscription after a resync marker; a
    // few retries cover a continuously advancing ring without spinning forever.
    let mut replay_events = Vec::new();
    let mut needs_resync = false;
    let mut requested_cursor = cursor;
    let mut subscription = None;
    for _ in 0..4 {
        let after = requested_cursor.unwrap_or_else(|| handle.current_cursor());
        match handle.subscribe_cursor_from(after) {
            Ok(next) => {
                if needs_resync {
                    replay_events.push(resync_envelope_at(after));
                }
                let replay = next.replay;
                let changed = next.changed;
                replay_events.extend(replay);
                subscription = Some((after, changed));
                break;
            }
            Err(_) => {
                needs_resync = true;
                requested_cursor = None;
            }
        }
    }
    let Some((mut last_cursor, mut changed)) = subscription else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };

    // Materialize the replay into owned SSE events so the returned stream does
    // not borrow local state.
    let mut replay_out = Vec::with_capacity(replay_events.len());
    for envelope in replay_events {
        last_cursor = last_cursor.max(envelope.cursor);
        if matches!(envelope.event, Event::ResyncRequired)
            || filter.as_ref().is_none_or(|f| &envelope.session_id == f)
        {
            replay_out.push(to_sse(&envelope));
        }
    }
    let replay_stream = futures_util::stream::iter(replay_out);
    let mut shutdown = state.shutdown.clone();
    let stream = replay_stream
        .chain(async_stream::stream! {
            const EVENT_BATCH: usize = 128;
            loop {
                match handle.events_after(last_cursor, EVENT_BATCH) {
                    Some(events) if !events.is_empty() => {
                        for envelope in events {
                            last_cursor = envelope.cursor;
                            if filter.as_ref().is_none_or(|f| &envelope.session_id == f) {
                                yield to_sse(&envelope);
                            }
                        }
                        continue;
                    }
                    Some(_) => {}
                    None => {
                        // The ring no longer covers this consumer's cursor. Ask it
                        // to resync and continue from the authoritative current
                        // cursor, so recovery does not create an unbounded queue.
                        last_cursor = handle.current_cursor();
                        yield to_sse(&resync_envelope_at(last_cursor));
                        continue;
                    }
                }
                if changed.changed().await.is_err() {
                    break;
                }
            }
        })
        .take_until(async move {
            if !*shutdown.borrow() {
                let _ = shutdown.changed().await;
            }
        });

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn resync_envelope_at(cursor: u64) -> Arc<Envelope> {
    Arc::new(Envelope {
        cursor,
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
