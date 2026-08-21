// Semantic actions: the layer that maps UI intents to transport calls and
// writes responses/errors back into the store. Views call these functions
// instead of touching api.js directly. The transport layer (api.js) remains
// the only module that fetches or opens an EventSource.

import { api, openEventStream } from './api.js';
import {
  getState,
  applySnapshot,
  reduce,
  setLogs,
  setStatus,
  dismissPendingApproval,
} from './store.js';

/// Refreshes the full state snapshot from GET /api/state into the store.
/// Returns the snapshot (or null on failure, with the status bar updated).
export async function refreshState() {
  try {
    const data = await api.getState();
    applySnapshot(data);
    return data;
  } catch (err) {
    setStatus(`连接失败：${err.message}`);
    return null;
  }
}

/// Opens the SSE stream and routes every event into the store's reducer.
/// `onOpen` fires on each (re)connection so the caller can refresh state.
/// Returns the transport handle (`.close()`).
export function startEventStream(onOpen) {
  return openEventStream({
    onOpen,
    onEvent: (dto) => reduce(dto),
    // EventSource auto-reconnects; there is nothing to surface here. The
    // transport never touches the DOM, and neither does this layer.
    onError: () => {},
  });
}

/// Submits user text to the current (or `new`) session.
export async function sendInput(text, { create = false, status = '发送中…' } = {}) {
  const sid = create ? null : getState().activeSession;
  setStatus(status, true);
  try {
    await api.input(sid, text);
    return { ok: true, sid };
  } catch (err) {
    setStatus(`发送失败：${err.message}`);
    return { ok: false, err };
  }
}

/// Submits a structured slash command (commands::parse semantics).
export async function sendCommand(text) {
  const sid = getState().activeSession;
  try {
    await api.command(sid, text);
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

/// Decides the currently pending approval. Optimistically clears the store so
/// the modal closes immediately; the server's approval_resolved event confirms.
export async function approve(accept) {
  const pending = getState().pendingApproval;
  if (!pending) return { ok: false, err: new Error('无待审批项') };
  dismissPendingApproval();
  try {
    await api.approve(pending.approval_id, accept);
    return { ok: true };
  } catch (err) {
    setStatus(`审批失败：${err.message}`);
    return { ok: false, err };
  }
}

/// Cancels the current session's in-flight request.
export async function cancelSession() {
  const sid = getState().activeSession;
  if (!sid) return { ok: false, err: new Error('无活动会话') };
  setStatus('正在取消…', true);
  try {
    await api.cancel(sid);
    return { ok: true };
  } catch (err) {
    setStatus(`取消失败：${err.message}`);
    return { ok: false, err };
  }
}

/// Switches the server-side active session.
export async function activateSession(id) {
  setStatus('切换会话…', true);
  try {
    await api.activate(id);
    return { ok: true };
  } catch (err) {
    setStatus(`切换失败：${err.message}`);
    return { ok: false, err };
  }
}

/// Switches provider/model (non-secret fields only). Not fatal on failure; the
/// caller decides whether to proceed with a message.
export async function setProvider(preset, model) {
  try {
    await api.setProvider(preset, model);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/// Loads a session's message log into the store (view renders on subscription).
export async function loadMessages(sessionId) {
  try {
    const messages = await api.getMessages(sessionId);
    setLogs(sessionId, messages);
    return messages;
  } catch {
    setLogs(sessionId, []);
    return [];
  }
}
