#!/usr/bin/env bash
# One-click demo start for the 1H-Agent WebUI — no API key required.
#
# It builds whatever is stale (frontend first, then the Rust binary that embeds
# web/dist), starts the server on a free loopback port, waits until it is up,
# and opens the browser. Use Ctrl+C to stop.
#
# If a demo instance is already running on this workspace (the core takes an
# exclusive per-workspace lock, so a second instance would fail immediately),
# the script detects it and simply opens the browser to the running URL —
# re-running is safe and idempotent.
#
# Usage:
#   bash scripts/start-web.sh                # build-if-stale + start + open
#   bash scripts/start-web.sh -p 9000        # fixed port
#   bash scripts/start-web.sh -d             # daemonize (background) + print PID
#   bash scripts/start-web.sh -n             # do not open the browser
#   SKIP_BUILD=1 bash scripts/start-web.sh   # reuse existing artifacts as-is
#
# Demo mode: without a provider API key you can browse the UI, create/fork
# sessions, use the command palette (Ctrl/Cmd+K), todo panel, approvals, etc.
# Only actual model requests fail until OPENAI_API_KEY (or another provider
# key) is exported.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/debug/1h-agent-web"
DIST_HTML="$ROOT/web/dist/index.html"
DEMO_ROOT="$ROOT/.1h-agent-data/demo"
WORKSPACE="$DEMO_ROOT/workspace"
DATA_DIR="$DEMO_ROOT/data"
SERVER_LOG="$DEMO_ROOT/server.log"
PID_FILE="$DEMO_ROOT/server.pid"

PORT=7788
DAEMON=0
OPEN_BROWSER=1
SKIP_BUILD="${SKIP_BUILD:-0}"

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port) PORT="${2:?port required}"; shift 2 ;;
    -d|--daemon) DAEMON=1; shift ;;
    -n|--no-open) OPEN_BROWSER=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

open_browser() {
  local url="$1"
  case "$(uname -s)" in
    Darwin) open "$url" ;;
    Linux)
      if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1; fi
      ;;
    MINGW*|MSYS*|CYGWIN*) start "" "$url" ;;
  esac
}

# True when the URL answers our v2 API (we are not being fooled by a random
# service on that port).
is_demo_app() {
  curl -fsS "$1/api/v2/state" 2>/dev/null | grep -q '"protocol_version":2'
}

# ---- 0. idempotent relaunch -------------------------------------------------
# The core takes an exclusive per-workspace lock, so a second instance on the
# same demo workspace fails immediately. If a live instance already holds it,
# just open the browser to it instead of crashing. Locate it via the recorded
# daemon pid (+ its log port), then fall back to probing the requested port.
find_running_url() {
  local pid port
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      port=$(grep -oE 'listening on http://127\.0\.0\.1:[0-9]+' "$SERVER_LOG" 2>/dev/null |
        tail -1 | grep -oE '[0-9]+$')
      if [ -n "$port" ] && is_demo_app "http://127.0.0.1:$port"; then
        echo "http://127.0.0.1:$port"
        return 0
      fi
    else
      # stale pid file (a previous daemon exited); drop it so a later start is clean
      rm -f "$PID_FILE"
    fi
  fi
  for probe in "$PORT" 7788; do
    if is_demo_app "http://127.0.0.1:$probe"; then
      echo "http://127.0.0.1:$probe"
      return 0
    fi
  done
  return 1
}

mkdir -p "$WORKSPACE" "$DATA_DIR"

if RUNNING_URL=$(find_running_url); then
  say "== 1H-Agent 已在运行：$RUNNING_URL =="
  say "   （demo 工作区已被该实例占用，直接复用，不重复启动）"
  if [ "$OPEN_BROWSER" = "1" ]; then open_browser "$RUNNING_URL"; fi
  say "== ready: $RUNNING_URL =="
  exit 0
fi

# ---- 1. frontend build (embed web/dist into the binary) -------------------
build_frontend() {
  if [ ! -d "$ROOT/web/node_modules/.bin" ]; then
    say "== installing frontend deps =="
    (cd "$ROOT/web" && pnpm install --frozen-lockfile) || {
      echo "ERROR: pnpm install failed" >&2; exit 1
    }
  fi
  say "== rebuilding frontend (web/dist) =="
  (cd "$ROOT/web" && pnpm build) || {
    echo "ERROR: frontend build failed" >&2; exit 1
  }
}

if [ "$SKIP_BUILD" = "1" ]; then
  say "(SKIP_BUILD=1, reusing existing artifacts)"
else
  if [ ! -f "$DIST_HTML" ]; then
    build_frontend
  elif find "$ROOT/web/src" "$ROOT/web/ts" "$ROOT/web/package.json" \
       "$ROOT/web/vite.config.ts" "$ROOT/web/tsconfig.app.json" \
       -newer "$DIST_HTML" -print -quit 2>/dev/null | grep -q .; then
    build_frontend
  fi
  if [ ! -x "$BIN" ] || [ "$DIST_HTML" -nt "$BIN" ]; then
    say "== building 1h-agent-web (embeds web/dist) =="
    (cd "$ROOT" && cargo build -p protium-web) || {
      echo "ERROR: cargo build failed" >&2; exit 1
    }
  fi
fi

if [ ! -x "$BIN" ]; then
  echo "ERROR: no binary at $BIN" >&2
  echo "Run: (cd $ROOT && cargo build -p protium-web)" >&2
  exit 1
fi

# ---- 2. pick a free port --------------------------------------------------
port_free() {
  local port="$1"
  if command -v nc >/dev/null 2>&1; then
    ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1
  elif command -v lsof >/dev/null 2>&1; then
    ! lsof -i "tcp:$port" >/dev/null 2>&1
  else
    return 0
  fi
}

FINAL_PORT="$PORT"
while ! port_free "$FINAL_PORT"; do
  if [ "$FINAL_PORT" -ge 65535 ]; then
    echo "ERROR: no free port in $PORT..65535" >&2
    exit 1
  fi
  FINAL_PORT=$((FINAL_PORT + 1))
done
if [ "$FINAL_PORT" != "$PORT" ]; then
  say "port $PORT is busy, using $FINAL_PORT"
fi
URL="http://127.0.0.1:$FINAL_PORT"

# ---- 3. start -------------------------------------------------------------
say "== starting 1H-Agent WebUI =="
say "   workspace : $WORKSPACE"
say "   data dir  : $DATA_DIR"
say "   url       : $URL"
say "   (demo: 未设置 API Key 可浏览界面/创建会话/命令面板等；真正对话需 export OPENAI_API_KEY=... )"

if [ "$DAEMON" = "1" ]; then
  AGENT_DATA_DIR="$DATA_DIR" "$BIN" --workspace "$WORKSPACE" --port "$FINAL_PORT" \
    >"$SERVER_LOG" 2>&1 &
  echo $! >"$PID_FILE"
  say "   started in background, pid $(cat "$PID_FILE")"
  say "   log: $SERVER_LOG   stop: kill \$(cat "$PID_FILE")"
else
  AGENT_DATA_DIR="$DATA_DIR" "$BIN" --workspace "$WORKSPACE" --port "$FINAL_PORT" &
  SRV_PID=$!
  trap 'kill "$SRV_PID" 2>/dev/null' INT TERM EXIT
fi

# ---- 4. wait for readiness, then open the browser --------------------------
wait_for_server() {
  local url="$1"
  local i=0
  if command -v curl >/dev/null 2>&1; then
    while [ "$i" -lt 60 ]; do
      if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
      sleep 0.5
      i=$((i + 1))
    done
  else
    sleep 2
    return 0
  fi
  return 1
}

if wait_for_server "$URL"; then
  if [ "$OPEN_BROWSER" = "1" ]; then open_browser "$URL"; fi
  say "== ready: $URL =="
else
  echo "ERROR: server did not become ready" >&2
  if [ "$DAEMON" = "1" ]; then
    tail -n 20 "$SERVER_LOG" >&2 || true
  fi
  if grep -q "already in use" "$SERVER_LOG" 2>/dev/null; then
    echo "hint: the demo workspace is locked by another 1H-Agent instance." >&2
    echo "      stop it first (e.g. kill \$(cat $PID_FILE)), then re-run." >&2
  fi
  exit 1
fi

if [ "$DAEMON" != "1" ]; then
  say "press Ctrl+C to stop"
  wait "$SRV_PID"
fi
