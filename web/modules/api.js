// Thin REST + SSE client. All endpoints are same-origin; no keys ever cross
// the wire from the browser (the server never returns them). This is the only
// module allowed to issue fetch() / build EventSource; it never touches the
// DOM and never holds UI state.

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
        // Frame/parse errors stay in the transport layer; the stream stays
        // alive. View feedback is the caller's job (onError is not fired here
        // because the connection itself is fine).
        console.error('SSE frame handling error:', error);
      }
    };
    source.onerror = () => {
      // EventSource auto-reconnects; the browser sends Last-Event-ID on the
      // retry. This is the single error notification path for the caller; it
      // never touches the DOM (views decide what to surface).
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
