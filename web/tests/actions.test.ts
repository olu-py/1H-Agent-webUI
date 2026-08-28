import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshotV2, MessagePage } from "../src/types";
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

    await actions.setProvider("openai", "gpt-5", { baseUrl: "not a url" });

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
});
