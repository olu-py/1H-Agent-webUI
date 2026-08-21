// Pure client-side state + wire-protocol event reduction.
//
// This module is the "store" layer of the transport -> store -> view split:
// it owns all client state, exposes reduce()/applySnapshot() to consume wire
// events and snapshots, and notify()s subscribers so the view can render.
// It imports nothing (no DOM, no network, no api.js) and is therefore shared
// unchanged by any alternate UI implementation.

const listeners = new Set();

/// Client-side wire protocol version. Must match `PROTOCOL_VERSION` in
/// src/server/dto.rs; on mismatch the view surfaces a compatibility warning.
export const PROTOCOL_VERSION = 1;

// Pure data only. DOM-backed transient state (live streaming, cluster rows,
// completion dropdown, panel visibility) is intentionally NOT here: views own
// whatever they render. Adding fields here is additive and safe for old views
// (mirrors the additive wire contract).
const state = {
  activeSession: null,
  sessions: [],
  provider: 'openai',
  model: 'gpt-5-mini',
  mode: 'build',
  todos: [],
  pendingApproval: null,
  status: { text: '', busy: false },
  // protocol_version reported by GET /api/state; null until first snapshot.
  protocolVersion: null,
  // message logs per session (pure data from GET /api/sessions/:id/messages).
  logs: new Map(),
};

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(change) {
  // Copy so listeners may subscribe/unsubscribe during dispatch.
  for (const listener of [...listeners]) listener(state, change);
}

// --- status (transient, rendered by every view) ---
export function setStatus(text, busy = false) {
  state.status = { text, busy };
  notify({ kind: 'status' });
}

// --- message logs ---
export function setLogs(sessionId, messages) {
  state.logs.set(sessionId, messages || []);
  notify({ kind: 'logs', sessionId });
}

export function forgetLog(sessionId) {
  state.logs.delete(sessionId);
}

// --- snapshot (GET /api/state) ---
export function applySnapshot(snapshot) {
  state.sessions = snapshot.sessions || [];
  state.activeSession = snapshot.active_session ?? null;
  state.provider = normalizeProvider(snapshot.provider);
  state.model = snapshot.model || '';
  state.mode = snapshot.mode || 'build';
  state.todos = snapshot.todos || [];
  state.protocolVersion = snapshot.protocol_version ?? null;
  state.pendingApproval =
    snapshot.approval && snapshot.approval.approval_id ? snapshot.approval : null;
  notify({ kind: 'snapshot', snapshot });
}

function normalizeProvider(label) {
  const value = String(label || '').toLowerCase();
  if (value === 'openai') return 'openai';
  if (value === 'deepseek') return 'deepseek';
  if (value === 'qwen / bailian') return 'qwen';
  if (value === 'volcano ark') return 'volcano';
  return 'custom';
}

// --- event reduction (SSE EventDto) ---
export function reduce(dto) {
  // Events for non-active sessions are tolerated and ignored (same semantics
  // as the pre-modular UI); activeSession is null on the home screen, where
  // no events are acted upon either.
  if (
    dto?.session_id &&
    state.activeSession &&
    dto.session_id !== state.activeSession
  ) {
    console.debug('store: ignored event for non-active session', dto.session_id);
    return;
  }

  switch (dto?.type) {
    case 'todo_updated':
      state.todos = dto.tasks || [];
      break;
    case 'approval':
      state.pendingApproval = dto;
      break;
    case 'approval_resolved':
      state.pendingApproval = null;
      state.status = { text: dto.approved ? '已批准' : '已拒绝', busy: false };
      break;
    case 'sessions_changed':
    case 'completed':
      state.status = { text: '就绪', busy: false };
      break;
    case 'cancelled':
      state.status = { text: `已取消：${dto.reason}`, busy: false };
      break;
    case 'failed':
      state.status = { text: `失败：${dto.error}`, busy: false };
      break;
    case 'web_search_started':
      state.status = { text: `正在联网搜索：${dto.query}`, busy: false };
      break;
    case 'web_search_completed':
      state.status = { text: `联网搜索完成：${dto.count} 条结果`, busy: false };
      break;
    case 'provider_retry':
      state.status = {
        text: `请求失败，${Math.ceil(dto.delay_ms / 1000)} 秒后第 ${dto.attempt} 次重试`,
        busy: false,
      };
      break;
    case 'model_streaming':
      state.status = { text: '等待模型响应…', busy: false };
      break;
    default:
      // Additive wire protocol: unknown types are archived rather than
      // crashing, mirroring the server's Option<> drop semantics.
      console.debug('store: tolerated unknown event type', dto?.type);
      break;
  }
  notify({ kind: 'event', dto });
}

// --- approval modal (view calls this when the user decides optimistically) ---
export function dismissPendingApproval() {
  state.pendingApproval = null;
  notify({ kind: 'approval' });
}
