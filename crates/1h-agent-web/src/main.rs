use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;
use protium_core::config::Config;

mod auth;
mod server;

#[derive(Debug, Parser)]
#[command(name = "1h-agent-web", version, about)]
struct Cli {
    /// Directory the agent is allowed to access.
    #[arg(long, default_value = ".")]
    workspace: PathBuf,

    /// Optional TOML configuration path.
    #[arg(long)]
    config: Option<PathBuf>,

    /// TCP port for the WebUI (overrides `server.port` in config). Clamped to
    /// 1024..=65535.
    #[arg(long)]
    port: Option<u32>,

    /// Bind address for the WebUI (overrides `server.bind` in config). Defaults
    /// to loopback 127.0.0.1; a non-loopback bind requires token auth.
    #[arg(long, default_value = None)]
    host: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let workspace = cli
        .workspace
        .canonicalize()
        .with_context(|| format!("cannot open workspace {}", cli.workspace.display()))?;
    let mut config = Config::load(cli.config.as_deref(), &workspace)?;

    if let Some(port) = cli.port {
        config.server.port = port.clamp(1024, 65535);
    }
    if let Some(host) = cli.host {
        config.server.bind = host;
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "protium_core=info,1h_agent_web=info".into()),
        )
        .with_writer(std::io::stderr)
        .try_init()
        .ok();

    server::run(workspace, config).await
}
