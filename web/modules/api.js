// Thin REST + SSE client. All endpoints are same-origin; no keys ever cross
// the wire from the browser (the server never returns them).

async function jsonRequest(method, url, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

export const api = {
  getState: () => jsonRequest('GET', '/api/state'),
  getMessages: (sessionId) => jsonRequest('GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages`),
  input: (sessionId, text) =>
    jsonRequest('POST', `/api/sessions/${sessionId ? encodeURIComponent(sessionId) : 'new'}/input`, { text }),
  command: (sessionId, text) =>
    jsonRequest('POST', `/api/sessions/${sessionId ? encodeURIComponent(sessionId) : 'new'}/commands`, { text }),
  approve: (approvalId, accept) =>
    jsonRequest('POST', `/api/approvals/${encodeURIComponent(approvalId)}`, { accept }),
  cancel: (sessionId) =>
    jsonRequest('POST', `/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {}),
  activate: (sessionId) =>
    jsonRequest('POST', `/api/sessions/${encodeURIComponent(sessionId)}/activate`, {}),
  setProvider: (preset, model) =>
    jsonRequest('POST', '/api/config/provider', { preset, model }),
};

/// Opens the SSE event stream with automatic reconnect and `Last-Event-ID`
/// resume. `onEvent(dto)` is called for every event; `onOpen` fires after a
/// (re)connection is established so the caller can refresh state.
export function openEventStream({ onEvent, onOpen, onError }) {
  let source = null;
  let closed = false;

  function connect() {
    source = new EventSource('/api/events');
    source.onopen = () => onOpen?.();
    source.onmessage = (event) => {
      try {
        onEvent?.(JSON.parse(event.data));
      } catch (error) {
        // Surface handler errors (e.g. a rendering bug) instead of silently
        // dropping the frame; the stream stays alive either way.
        const status = document.getElementById('chat-status');
        if (status) status.textContent = `事件处理错误：${error?.message || error}`;
      }
    };
    source.onerror = () => {
      // EventSource auto-reconnects; the browser sends Last-Event-ID on the
      // retry. Only surface persistent failures to the caller.
      onError?.();
    };
  }

  connect();
  return {
    close() {
      closed = true;
      source?.close();
    },
  };
}
