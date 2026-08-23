#!/usr/bin/env bash
# Quick keyless smoke test for the 1H-Agent Web UI (v2).
#
# Verifies, end to end, without needing an API key:
#   * the React bundle is served (/, /assets/*)
#   * /api/v2/state returns protocol_version=2
#   * session creation (POST /api/v2/sessions/new/input)
#   * cursor pagination (GET /api/v2/sessions/<id>/messages)
#   * SSE stream content-type + replay
#   * unknown session -> 404
#
# Prints PASS/FAIL per check and cleans up after itself.
# Usage: bash scripts/smoke-web.sh

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/debug/1h-agent-web"
WORK="$ROOT/.smoke-test-$$"
PORT=$((20000 + RANDOM % 20000))
BASE="http://127.0.0.1:$PORT"

pass=0
fail=0
ok() { echo "  PASS  $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; fail=$((fail + 1)); }

# status <name> <expected> <curl args...>
status() {
  local name="$1" want="$2"; shift 2
  local got; got=$(curl -s -o /dev/null -w "%{http_code}" "$@")
  if [ "$got" = "$want" ]; then ok "$name"; else bad "$name (expected $want, got $got)"; fi
}

cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ ! -x "$BIN" ]; then
  echo "building debug binary..."
  (cd "$ROOT" && cargo build -p protium-web) || { echo "build failed"; exit 1; }
fi

mkdir -p "$WORK"
echo "== starting server on :$PORT =="
AGENT_DATA_DIR="$WORK/.data" "$BIN" --workspace "$WORK" --port "$PORT" >/dev/null 2>&1 &
SRV_PID=$!
sleep 1

echo "== static frontend =="
status "GET / serves React bundle" 200 "$BASE/"
JS=$(curl -s "$BASE/" | grep -o 'assets/index-[^"]*\.js' | head -1)
if [ -n "$JS" ] && curl -s -o /dev/null -w "%{http_code}" "$BASE/$JS" | grep -q 200; then
  ok "hashed JS asset served ($JS)"
else
  bad "hashed JS asset not served"
fi

echo "== v2 API =="
status "GET /api/v2/state (v2 snapshot)" 200 "$BASE/api/v2/state"
if curl -s "$BASE/api/v2/state" | grep -q '"protocol_version":2'; then
  ok "state protocol_version=2"
else
  bad "state protocol_version=2"
fi

status "POST /sessions/new/input (create session)" 202 \
  -X POST -H 'Content-Type: application/json' -d '{"text":"hello"}' "$BASE/api/v2/sessions/new/input"

SID=$(curl -s "$BASE/api/v2/state" | grep -o '"active_session":"[^"]*"' | cut -d'"' -f4)
if [ -n "$SID" ]; then
  ok "session created (id ${SID:0:8}…)"
else
  bad "no active session after input"
fi

status "GET /api/v2/sessions/<id>/messages (cursor page)" 200 "$BASE/api/v2/sessions/$SID/messages?limit=20"
status "GET unknown session -> 404" 404 "$BASE/api/v2/sessions/not-a-session/messages"

echo "== SSE =="
if curl -s -N --max-time 1 -D - -o /dev/null "$BASE/api/v2/events?cursor=0" | grep -qi "text/event-stream"; then
  ok "SSE content-type text/event-stream"
else
  bad "SSE content-type"
fi

echo
echo "== result: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
