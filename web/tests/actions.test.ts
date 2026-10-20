import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshotV2, Envelope, MessagePage } from "../src/types";
import { createActions } from "../src/actions";
import { createStore } from "../src/state/store";

/** A controllable fake transport; each method is a vi.fn returning a default. */
function fakeTransport(overrides: Partial<Record<keyof import("../src/transport/transport").Transport, unknown>> = {}) {
  const snapshot = vi.fn();
  const messages = vi.fn();
  const submit = vi.fn();
  const executeCommand = vi.fn();
  const approve = vi.fn();
  const cancel = vi.fn();
  const activateSession = vi.fn();
  const setProvider = vi.fn();
  const providerSettings = vi.fn();
  const providerModels = vi.fn();
  const subscribe = vi.fn().mockReturnValue({ unsubscribe: vi.fn() });
  return {
    snapshot,
    messages,
    submit,
    executeCommand,
    approve,
    cancel,
    activateSession,
    setProvider,
    providerSettings,
    providerModels,
    subscribe,
    ...overrides,
  } as unknown as import("../src/transport/transport").Transport;
}

function snap(mode: string, activeSession: string | null = null): AppSnapshotV2 {
  return {
    protocol_version: 2,
    event_cursor: 10,
    active_session: activeSession,
    sessions: [],
    provider: "deepseek",
    model: "deepseek-v4-flash",
    mode,
    approval: null,
    todos: [],
    context: null,
    assistant_partial: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transcript refresh lifetime", () => {
  it("reestablishes the subscription after authoritative resync", async () => {
    const callbacks: Array<(event: Envelope) => void> = [];
    const unsubscribe = vi.fn();
    const transport = fakeTransport({ snapshot: vi.fn().mockResolvedValue(snap("build", "A")),
      messages: vi.fn().mockResolvedValue({messages:[],next_before:null,has_more:false}),
      subscribe: vi.fn((_cursor, callback) => { callbacks.push(callback); return {unsubscribe}; }) });
    const store = createStore();
    const actions = createActions(transport,store);
    await actions.init();
    callbacks[0]({cursor:20,session_id:"",type:"resync_required"});
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    expect(unsubscribe).toHaveBeenCalledOnce();
    callbacks[0]({cursor:21,session_id:"A",type:"text_delta",delta:"STALE"});
    expect(store.getState().messages).toEqual([]);
    actions.stop();
  });
  it("rejects a late prepend after A to B to A", async () => {
    let release!: (page: MessagePage) => void;
    const transport = fakeTransport({ messages: vi.fn(() => new Promise<MessagePage>(resolve => { release = resolve; })) });
    const store = createStore();
    const actions = createActions(transport, store);
    store.dispatch({type:"snapshot", snapshot:snap("build", "A")});
    store.dispatch({type:"messages", replace:true, page:{messages:[], next_before:30n, has_more:true}});
    const pending = actions.loadOlder();
    store.dispatch({type:"snapshot", snapshot:snap("build", "B")});
    store.dispatch({type:"snapshot", snapshot:snap("build", "A")});
    release({messages:[{id:1,kind:"user",content:"STALE A"}], next_before:null, has_more:false});
    await pending;
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().lastError).toBeNull();
  });
  it("rejects a late prepend from a stopped lifetime after init", async () => {
    let release!: (page: MessagePage) => void;
    const transport = fakeTransport({ messages: vi.fn()
      .mockImplementationOnce(() => new Promise<MessagePage>(resolve => { release = resolve; }))
      .mockResolvedValue({messages:[], next_before:null, has_more:false}),
      snapshot: vi.fn().mockResolvedValue(snap("build", "A")) });
    const store = createStore();
    const actions = createActions(transport, store);
    store.dispatch({type:"snapshot", snapshot:snap("build", "A")});
    store.dispatch({type:"messages", replace:true, page:{messages:[], next_before:30n, has_more:true}});
    const pending = actions.loadOlder();
    actions.stop();
    await actions.init();
    release({messages:[{id:1,kind:"user",content:"STALE LIFETIME"}], next_before:null, has_more:false});
    await pending;
    expect(store.getState().messages).toEqual([]);
    actions.stop();
  });
  it("aborts prepend on session switch and rejects a late old page", async () => {
    let release!: (page: MessagePage) => void;
    const transport = fakeTransport({ messages: vi.fn(() => new Promise<MessagePage>(resolve => { release = resolve; })) });
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "old") });
    store.dispatch({ type: "messages", replace: true, page: { messages: [], next_before: 30n, has_more: true } });
    const actions = createActions(transport, store);
    const pending = actions.loadOlder();
    const signal = vi.mocked(transport.messages).mock.calls[0][1]?.signal;
    store.dispatch({ type: "snapshot", snapshot: snap("build", "new") });
    expect(signal?.aborted).toBe(true);
    release({ messages: [{ id: 1, kind: "user", content: "OLD PREPEND" }], next_before: null, has_more: false });
    await pending;
    expect(store.getState().messages).toEqual([]);
    actions.stop();
  });
  it("stopping actions aborts an actual pending history request", async () => {
    let release!: (page: MessagePage) => void;
    const transport = fakeTransport({ messages: vi.fn(() => new Promise<MessagePage>(resolve => { release = resolve; })) });
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s1") });
    store.dispatch({ type: "messages", replace: true, page: { messages: [], next_before: 30n, has_more: true } });
    const actions = createActions(transport, store);
    const pending = actions.loadOlder();
    actions.stop();
    expect(vi.mocked(transport.messages).mock.calls[0][1]?.signal?.aborted).toBe(true);
    release({ messages: [{ id: 1, kind: "user", content: "LATE" }], next_before: null, has_more: false });
    await pending;
    expect(store.getState().messages).toEqual([]);
  });
  it("discards an old session response delivered after the new session", async () => {
    let release!: (page: MessagePage) => void;
    const transport = fakeTransport({ messages: vi.fn()
      .mockImplementationOnce(() => new Promise<MessagePage>(resolve => { release = resolve; }))
      .mockResolvedValue({ messages: [], next_before: null, has_more: false }) });
    const store = createStore();
    const actions = createActions(transport, store);
    store.dispatch({ type: "snapshot", snapshot: snap("build", "old") });
    const old = actions.refreshTranscript();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "new") });
    await actions.refreshTranscript();
    release({ messages: [{ id: 99, kind: "user", content: "OLD_SESSION" }], next_before: null, has_more: false });
    await old;
    expect(store.getState().messages).toEqual([]);
    const options = vi.mocked(transport.messages).mock.calls[0][1];
    expect(options?.signal?.aborted).toBe(true);
  });
});

describe("actions.submit with a pending mode", () => {
  it("applies the pending mode exactly once when the snapshot differs", async () => {
    const transport = fakeTransport();
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build"));
    (transport.messages as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
      next_before: null,
      has_more: false,
    } satisfies MessagePage);
    const store = createStore();
    const actions = createActions(transport, store);

    await actions.submit("hello", "plan");

    // Snapshot converged to "build"; pending "plan" differs → one command.
    expect(transport.submit).toHaveBeenCalledWith(null, "hello");
    expect(transport.executeCommand).toHaveBeenCalledTimes(1);
    expect(transport.executeCommand).toHaveBeenCalledWith(null, "/plan");
    expect(store.getState().mode).toBe("build");
  });

  it("does not send a mode command when the snapshot already matches", async () => {
    const transport = fakeTransport();
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("plan"));
    const store = createStore();
    const actions = createActions(transport, store);

    await actions.submit("hello", "plan");

    expect(transport.submit).toHaveBeenCalledWith(null, "hello");
    expect(transport.executeCommand).not.toHaveBeenCalled();
  });

  it("does not send a mode command when no pending mode is given", async () => {
    const transport = fakeTransport();
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build"));
    const store = createStore();
    const actions = createActions(transport, store);

    await actions.submit("hello");

    expect(transport.submit).toHaveBeenCalledWith(null, "hello");
    expect(transport.executeCommand).not.toHaveBeenCalled();
  });
});

describe("actions.submit optimistic echo", () => {
  it("echoes the message into the transcript before the transport resolves", async () => {
    const transport = fakeTransport();
    let release!: (value: void) => void;
    (transport.submit as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build"));
    const store = createStore();
    const actions = createActions(transport, store);

    const pending = actions.submit("你好");
    // The echo landed synchronously, while the request is still in flight.
    expect(store.getState().messages.map((m) => [m.kind, m.content])).toEqual([["user", "你好"]]);

    release();
    await pending;
    // A successful submit keeps the echo until the completion refetch
    // replaces it with the persisted row.
    expect(store.getState().messages.map((m) => [m.kind, m.content])).toEqual([["user", "你好"]]);
  });

  it("drops the echo when the submit is rejected", async () => {
    const transport = fakeTransport();
    (transport.submit as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("session is busy with another request"),
    );
    const store = createStore();
    const actions = createActions(transport, store);

    await actions.submit("你好");

    expect(store.getState().messages).toHaveLength(0);
    expect(store.getState().lastError).toContain("busy");
  });

  it("does not echo commands or shell lines", async () => {
    const transport = fakeTransport();
    (transport.submit as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build"));
    const store = createStore();
    const actions = createActions(transport, store);

    await actions.submit("/plan");
    await actions.submit("!ls");

    expect(store.getState().messages).toHaveLength(0);
  });
});

describe("actions.setProvider / loadProviderSettings", () => {
  it("applies the edit, then refreshes snapshot and settings view", async () => {
    const transport = fakeTransport();
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build"));
    (transport.providerSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: { preset: "deepseek", kind: "responses", model: "deepseek-v4-pro", base_url: "https://api.deepseek.com" },
      saved: [{ preset: "deepseek", kind: "responses", model: "deepseek-v4-pro", base_url: "https://api.deepseek.com" }],
      connected: ["deepseek"],
    });
    const store = createStore();
    const actions = createActions(transport, store);

    await actions.setProvider("deepseek", "deepseek-v4-pro", {
      baseUrl: "https://api.deepseek.com",
      kind: "responses",
      apiKey: "sk-test",
    });

    expect(transport.setProvider).toHaveBeenCalledWith("deepseek", "deepseek-v4-pro", {
      baseUrl: "https://api.deepseek.com",
      kind: "responses",
      apiKey: "sk-test",
    });
    // Both post-apply refreshes ran and landed in the store.
    expect(transport.snapshot).toHaveBeenCalledTimes(1);
    expect(transport.providerSettings).toHaveBeenCalledTimes(1);
    expect(store.getState().providerSettings?.active.model).toBe("deepseek-v4-pro");
    expect(store.getState().lastError).toBeNull();
  });

  it("applies an inline model selection without options and refreshes state", async () => {
    const transport = fakeTransport();
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build"));
    (transport.providerSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: { preset: "qwen", kind: "responses", model: "qwen-plus", base_url: "https://qwen.example/v1" },
      saved: [{ preset: "qwen", kind: "responses", model: "qwen-plus", base_url: "https://qwen.example/v1" }],
      connected: ["qwen"],
    });
    const store = createStore();
    store.dispatch({
      type: "providerModels",
      models: { models: [{ id: "old-provider-model", context_window_tokens: null, max_output_tokens: null }], fetched_at: null },
    });
    const actions = createActions(transport, store);

    // The grouped switcher sends exactly the two core-owned identifiers.
    await actions.setProvider("qwen", "qwen-plus");

    expect(transport.setProvider).toHaveBeenCalledWith("qwen", "qwen-plus", undefined);
    expect(transport.snapshot).toHaveBeenCalledTimes(1);
    expect(transport.providerSettings).toHaveBeenCalledTimes(1);
    expect(store.getState().provider).toBe("deepseek");
    expect(store.getState().providerSettings?.active.model).toBe("qwen-plus");
    expect(store.getState().providerModels).toBeNull();
  });

  it("keeps the settings view when its refresh fails after a successful apply", async () => {
    const transport = fakeTransport();
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build"));
    (transport.providerSettings as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("settings fetch failed"),
    );
    const store = createStore();
    const actions = createActions(transport, store);

    await actions.setProvider("openai", "gpt-5");

    // The apply itself succeeded: no error surfaced from the settings refresh.
    expect(transport.setProvider).toHaveBeenCalledWith("openai", "gpt-5", undefined);
    expect(store.getState().lastError).toBeNull();
  });

  it("surfaces a structured apply error in the store", async () => {
    const transport = fakeTransport();
    (transport.setProvider as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("provider Base URL is invalid"),
    );
    const store = createStore();
    const actions = createActions(transport, store);

    const applied = await actions.setProvider("openai", "gpt-5", { baseUrl: "not a url" });

    expect(applied).toBe(false);
    expect(store.getState().lastError).toContain("Base URL");
  });

  it("dispatches providerSettings into the store", async () => {
    const transport = fakeTransport();
    const settings = {
      active: { preset: "openai", kind: "responses", model: "gpt-5-mini", base_url: "https://api.openai.com/v1" },
      saved: [],
      connected: [],
    };
    (transport.providerSettings as ReturnType<typeof vi.fn>).mockResolvedValue(settings);
    const store = createStore();
    const actions = createActions(transport, store);

    await actions.loadProviderSettings();

    expect(store.getState().providerSettings).toEqual(settings);
  });

  it("dispatches providerModels into the store and forwards refresh", async () => {
    const transport = fakeTransport();
    const models = {
      models: [{ id: "gpt-5-mini", context_window_tokens: 400000, max_output_tokens: null }],
      fetched_at: 1718000000,
    };
    (transport.providerModels as ReturnType<typeof vi.fn>).mockResolvedValue(models);
    const store = createStore();
    const actions = createActions(transport, store);

    // The refreshed DTO is returned so focused callers (the fetch-window
    // button) can read it without waiting on a store re-render.
    await expect(actions.loadProviderModels()).resolves.toEqual(models);
    expect(transport.providerModels).toHaveBeenCalledWith(false);
    expect(store.getState().providerModels).toEqual(models);

    await expect(actions.loadProviderModels(true)).resolves.toEqual(models);
    expect(transport.providerModels).toHaveBeenCalledWith(true);
  });

  it("swallows providerModels failures: metadata is best effort", async () => {
    const transport = fakeTransport();
    (transport.providerModels as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("gateway unreachable"),
    );
    const store = createStore();
    const actions = createActions(transport, store);

    await expect(actions.loadProviderModels(true)).resolves.toBeNull();

    expect(store.getState().providerModels).toBeNull();
    expect(store.getState().lastError).toBeNull();
  });
});

describe("actions.forkSession / deleteSession", () => {
  const page = { messages: [], next_before: null, has_more: false } satisfies MessagePage;

  it("forks a non-active session: activates it first, then runs /fork", async () => {
    const transport = fakeTransport();
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build", "s2"));
    (transport.messages as ReturnType<typeof vi.fn>).mockResolvedValue(page);
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s1") });
    const actions = createActions(transport, store);

    await actions.forkSession("s2");

    expect(transport.activateSession).toHaveBeenCalledWith("s2");
    expect(transport.executeCommand).toHaveBeenCalledWith("s2", "/fork");
  });

  it("deletes a non-active session: activates it first, then runs /delete", async () => {
    const transport = fakeTransport();
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build", "s2"));
    (transport.messages as ReturnType<typeof vi.fn>).mockResolvedValue(page);
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s1") });
    const actions = createActions(transport, store);

    await actions.deleteSession("s2");

    expect(transport.activateSession).toHaveBeenCalledWith("s2");
    expect(transport.executeCommand).toHaveBeenCalledWith("s2", "/delete");
  });

  it("skips the activation when the target is already active", async () => {
    const transport = fakeTransport();
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build", "s2"));
    (transport.messages as ReturnType<typeof vi.fn>).mockResolvedValue(page);
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s2") });
    const actions = createActions(transport, store);

    await actions.forkSession("s2");

    expect(transport.activateSession).not.toHaveBeenCalled();
    expect(transport.executeCommand).toHaveBeenCalledWith("s2", "/fork");
  });

  it("aborts (no command) when the activation does not converge to the target", async () => {
    const transport = fakeTransport();
    // The server never becomes the target: snapshot keeps reporting s1.
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build", "s1"));
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s1") });
    const actions = createActions(transport, store);

    await actions.deleteSession("s2");

    expect(transport.activateSession).toHaveBeenCalledWith("s2");
    // The guard must stop the delete from hitting the still-active session.
    expect(transport.executeCommand).not.toHaveBeenCalled();
  });
});

describe("actions event refreshes during SSE resync", () => {
  it("does not lose a second transcript invalidation while an earlier page fetch is pending", async () => {
    let onEvent: ((envelope: Envelope) => void) | undefined;
    const subscribe = vi.fn((_cursor: number, callback: (envelope: Envelope) => void) => {
      onEvent = callback;
      return { unsubscribe: vi.fn() };
    });
    let resolveStale!: (page: MessagePage) => void;
    const staleFetch = new Promise<MessagePage>((resolve) => { resolveStale = resolve; });
    const makePage = (content: string, id: bigint): MessagePage => ({
      messages: [{ kind: "assistant", id, content, created_at: "2026-01-01T00:00:00Z" }],
      next_before: null,
      has_more: false,
    });
    const transport = fakeTransport({ subscribe });
    (transport.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap("build", "s1"));
    (transport.messages as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makePage("initial", 1n))
      .mockReturnValueOnce(staleFetch)
      .mockResolvedValueOnce(makePage("final transcript", 3n));
    const store = createStore();
    const actions = createActions(transport, store);
    await actions.init();
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect(onEvent).toBeTypeOf("function");

    onEvent?.({ cursor: 11n, session_id: "s1", type: "transcript_invalidated" });
    expect(store.getState().transcriptDirty).toBe(true);
    await vi.waitFor(() => expect(transport.messages).toHaveBeenCalledTimes(2));
    onEvent?.({ cursor: 12n, session_id: "s1", type: "completed" });
    resolveStale(makePage("stale page", 2n));

    await vi.waitFor(() => expect(transport.messages).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(store.getState().messages[0]?.content).toBe("final transcript"));
  });
});

describe("actions.refreshTranscript after a session is deleted", () => {
  it("clears the transcript instead of surfacing a 404 'unknown session'", async () => {
    const transport = fakeTransport();
    const notFound = Object.assign(new Error("unknown session s1"), {
      status: 404,
      kind: "not_found",
    });
    (transport.messages as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s1") });
    const actions = createActions(transport, store);

    await actions.refreshTranscript();

    expect(transport.messages).toHaveBeenCalledWith("s1", { limit: expect.any(Number), signal: expect.any(AbortSignal) });
    expect(store.getState().messages).toHaveLength(0);
    expect(store.getState().lastError).toBeNull();
  });

  it("still surfaces genuine (non-404) transcript failures", async () => {
    const transport = fakeTransport();
    (transport.messages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s1") });
    const actions = createActions(transport, store);

    await expect(actions.refreshTranscript()).rejects.toThrow("boom");
  });
});

describe("complete transcript search and offscreen message navigation", () => {
  const page = (id: bigint, content: string, next: bigint | null, more: boolean): MessagePage => ({
    messages: [{ kind: "assistant", id, content, created_at: "2026-01-01T00:00:00Z" }],
    next_before: next,
    has_more: more,
  });

  it("searches every page and stops at the authoritative cursor", async () => {
    const transport = fakeTransport();
    (transport.messages as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page(200n, "newer", 200n, true))
      .mockResolvedValueOnce(page(100n, "needle in the old page", null, false));
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s1") });
    const actions = createActions(transport, store);

    const result = await actions.searchTranscript("NEEDLE");

    expect(result.scanned).toBe(2);
    expect(result.results.map((hit) => hit.message.id)).toEqual([100]);
    expect(result.results[0]?.excerpt).toContain("needle");
    expect(transport.messages).toHaveBeenNthCalledWith(1, "s1", { before: null, limit: 100, signal: expect.any(AbortSignal) });
    expect(transport.messages).toHaveBeenNthCalledWith(2, "s1", { before: 200n, limit: 100, signal: expect.any(AbortSignal) });
  });

  it("stops issuing page requests after the search is cancelled", async () => {
    const transport = fakeTransport();
    (transport.messages as ReturnType<typeof vi.fn>).mockResolvedValue(page(200n, "newer", 200n, true));
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s1") });
    const actions = createActions(transport, store);
    const controller = new AbortController();

    const result = await actions.searchTranscript("miss", {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    expect(result.scanned).toBe(1);
    expect(transport.messages).toHaveBeenCalledTimes(1);
    expect(transport.messages).toHaveBeenCalledWith("s1", {
      before: null,
      limit: 100,
      signal: expect.any(AbortSignal),
    });
  });

  it("replaces the transcript with the page containing an offscreen hit", async () => {
    const transport = fakeTransport();
    (transport.messages as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page(200n, "newer", 200n, true))
      .mockResolvedValueOnce(page(100n, "target", null, false));
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: snap("build", "s1") });
    const actions = createActions(transport, store);

    await expect(actions.locateMessage(100)).resolves.toBe(true);

    expect(store.getState().messages.map((message) => message.id)).toEqual([100]);
    expect(transport.messages).toHaveBeenNthCalledWith(2, "s1", { before: 200n, limit: 100, signal: expect.any(AbortSignal) });
  });
});
