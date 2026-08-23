import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshotV2, Envelope } from "../src/types";
import { ApiRequestError, HttpSseTransport } from "../src/transport/http-sse";

function sseResponse(blocks: { id: string; data: string }[]): Response {
  const body = blocks.map((b) => `id: ${b.id}\nevent: message\ndata: ${b.data}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const snapshot: AppSnapshotV2 = {
  protocol_version: 2,
  event_cursor: 3,
  active_session: "s1",
  sessions: [],
  provider: "deepseek",
  model: "deepseek-v4-flash",
  mode: "build",
  approval: null,
  todos: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HttpSseTransport REST contract", () => {
  it("fetches the snapshot from /api/v2/state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(snapshot));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const transport = new HttpSseTransport();
    await expect(transport.snapshot()).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/state", expect.objectContaining({}));
  });

  it("requests a message page with before/limit query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ messages: [], next_before: 1, has_more: true }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const transport = new HttpSseTransport();
    await transport.messages("s1", { before: 5, limit: 100 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v2/sessions/s1/messages?before=5&limit=100");
  });

  it("posts input to the new-session endpoint when session is null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 202));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const transport = new HttpSseTransport();
    await transport.submit(null, "hello");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v2/sessions/new/input");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "hello" });
  });

  it("throws a structured ApiRequestError on non-OK responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ kind: "not_found", message: "nope" }, 404));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const transport = new HttpSseTransport();
    const error = await transport.snapshot().catch((e) => e as ApiRequestError);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.status).toBe(404);
    expect(error.kind).toBe("not_found");
    expect(error.message).toBe("nope");
  });
});

describe("HttpSseTransport SSE contract", () => {
  it("parses id/data blocks and delivers envelopes with cursor tracking", async () => {
    const e5: Envelope = { cursor: 5, session_id: "s1", type: "sessions_changed" };
    const e6: Envelope = { cursor: 6, session_id: "s1", type: "sessions_changed" };
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        { id: "5", data: JSON.stringify(e5) },
        { id: "6", data: JSON.stringify(e6) },
      ]),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const transport = new HttpSseTransport();
    const received: Envelope[] = [];
    const sub = transport.subscribe(4, (e) => received.push(e));
    // wait for the async read to complete
    await new Promise((r) => setTimeout(r, 20));
    sub.unsubscribe();
    expect(received).toEqual([e5, e6]);
    // reconnect resumes from the last delivered cursor
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/v2/events?cursor=4");
  });

  it("reconnects from the last cursor after the stream ends", async () => {
    vi.useFakeTimers();
    try {
      const e5: Envelope = { cursor: 5, session_id: "s1", type: "sessions_changed" };
      const e9: Envelope = { cursor: 9, session_id: "s1", type: "sessions_changed" };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(sseResponse([{ id: "5", data: JSON.stringify(e5) }]))
        .mockResolvedValueOnce(sseResponse([{ id: "9", data: JSON.stringify(e9) }]));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const transport = new HttpSseTransport();
      const received: Envelope[] = [];
      const sub = transport.subscribe(4, (e) => received.push(e));
      // let the first stream finish, then advance past the retry backoff
      await vi.advanceTimersByTimeAsync(2000);
      sub.unsubscribe();
      expect(received.map((e) => e.cursor)).toEqual([5, 9]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondUrl = (fetchMock.mock.calls[1][0] as string).split("?")[1];
      expect(secondUrl).toBe("cursor=5");
    } finally {
      vi.useRealTimers();
    }
  });
});
