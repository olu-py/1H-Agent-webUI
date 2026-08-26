import type {
  ApiError,
  AppSnapshotV2,
  Envelope,
  MessagePage,
  ProviderSetOptions,
  ProviderSettingsDto,
} from "../types";
import type { Subscription, Transport } from "./transport";

/** A structured v2 API error, preserving the machine-readable kind. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly kind: string;

  constructor(status: number, api: ApiError | null, message?: string) {
    super(api?.message ?? message ?? `HTTP ${status}`);
    this.name = "ApiRequestError";
    this.status = status;
    this.kind = api?.kind ?? "internal";
  }
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 8000;

function encodeQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

/**
 * The browser transport: REST via `fetch`, events via a fetch-based SSE reader
 * (fetch is used instead of `EventSource` so the bearer token can be sent for
 * non-loopback auth). The reader parses `id:`/`data:` blocks and reconnects
 * from the last delivered cursor, honoring the server's `resync_required`
 * signal when the cursor has been evicted.
 */
export class HttpSseTransport implements Transport {
  private lastCursor = 0;
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly base: string = "",
    private readonly headers: Record<string, string> = {},
  ) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: { ...this.headers, ...(init?.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      let api: ApiError | null = null;
      try {
        api = (await res.json()) as ApiError;
      } catch {
        // non-JSON error body; fall back to status text
      }
      throw new ApiRequestError(res.status, api);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    return (await res.json()) as T;
  }

  snapshot(): Promise<AppSnapshotV2> {
    return this.json("/api/v2/state");
  }

  messages(sessionId: string, opts?: { before?: number | null; limit?: number }): Promise<MessagePage> {
    const query = encodeQuery({
      before: opts?.before ?? undefined,
      limit: opts?.limit,
    });
    return this.json(`/api/v2/sessions/${encodeURIComponent(sessionId)}/messages${query}`);
  }

  private async post(path: string): Promise<void> {
    await this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  }

  submit(sessionId: string | null, text: string): Promise<void> {
    const id = sessionId ?? "new";
    return this.withBody(`/api/v2/sessions/${encodeURIComponent(id)}/input`, { text });
  }

  executeCommand(sessionId: string | null, text: string): Promise<void> {
    const id = sessionId ?? "new";
    return this.withBody(`/api/v2/sessions/${encodeURIComponent(id)}/commands`, { text });
  }

  approve(approvalId: string, accept: boolean, allowSession?: boolean): Promise<void> {
    return this.withBody(`/api/v2/approvals/${encodeURIComponent(approvalId)}`, {
      accept,
      allow_session: allowSession ?? false,
    });
  }

  cancel(sessionId: string): Promise<void> {
    return this.post(`/api/v2/sessions/${encodeURIComponent(sessionId)}/cancel`);
  }

  activateSession(sessionId: string): Promise<void> {
    return this.post(`/api/v2/sessions/${encodeURIComponent(sessionId)}/activate`);
  }

  providerSettings(): Promise<ProviderSettingsDto> {
    return this.json("/api/v2/config/provider");
  }

  setProvider(preset: string, model: string, options?: ProviderSetOptions): Promise<void> {
    return this.withBody("/api/v2/config/provider", {
      preset,
      model,
      base_url: options?.baseUrl,
      kind: options?.kind,
      // Send only when non-empty: the key is write-only and must never be
      // needlessly transmitted (let alone stored or echoed).
      api_key: options?.apiKey?.trim() ? options.apiKey : undefined,
    });
  }

  private withBody(path: string, body: unknown): Promise<void> {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(() => undefined);
  }

  subscribe(fromCursor: number, onEvent: (envelope: Envelope) => void): Subscription {
    this.lastCursor = fromCursor;
    let closed = false;
    const read = () => {
      if (closed) return;
      this.readLoop(onEvent).finally(() => {
        if (closed) return;
        // Schedule reconnect with exponential backoff, resuming from the last
        // delivered cursor.
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.max(1, 2 ** (this.retryCount++)));
        this.retryTimer = setTimeout(read, delay);
      });
    };
    this.retryCount = 0;
    read();

    return {
      unsubscribe: () => {
        closed = true;
        this.controller?.abort();
        if (this.retryTimer !== null) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
      },
    };
  }

  private retryCount = 0;

  private async readLoop(onEvent: (envelope: Envelope) => void): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const res = await this.request(
      `/api/v2/events${encodeQuery({ cursor: this.lastCursor })}`,
      { signal: controller.signal, headers: { Accept: "text/event-stream" } },
    );
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let data = "";
    let id = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") {
          if (data) {
            this.dispatch(data, id, onEvent);
            data = "";
          }
          id = "";
        } else if (line.startsWith("id:")) {
          id = line.slice(3).trim();
        } else if (line.startsWith("data:")) {
          data += line.slice(5).trimStart() + "\n";
        } else if (line.startsWith("event:")) {
          // only "message" carries an envelope; others are ignored
        }
        // comment lines (": keep-alive") are ignored
      }
    }
    if (data) {
      this.dispatch(data, id, onEvent);
    }
  }

  private dispatch(data: string, id: string, onEvent: (envelope: Envelope) => void): void {
    const text = data.endsWith("\n") ? data.slice(0, -1) : data;
    const envelope = JSON.parse(text) as Envelope;
    if (typeof envelope.cursor === "number") {
      this.lastCursor = envelope.cursor;
    } else if (id !== "") {
      this.lastCursor = Number(id);
    }
    onEvent(envelope);
  }
}
