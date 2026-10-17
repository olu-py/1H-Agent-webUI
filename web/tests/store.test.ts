import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/state/store";
import type { UiState } from "../src/state/reducer";
import type { AppSnapshotV2, Envelope } from "../src/types";
import { createMarkdownStreamCache, renderMarkdownStreamUpdate } from "../src/lib/markdown";

/** Minimal action used to drive the store without touching the network. */
function connected(connected: boolean) {
  return { type: "connected", connected } as const;
}

/** State guard: exercises unrelated fields to keep the test type-honest. */
function expectState(state: UiState, connected: boolean): void {
  expect(state.connected).toBe(connected);
}

describe("createStore coalesced notification", () => {
  it("delivers every text delta in the coalesced render revision", () => {
    const store = createStore();
    store.dispatch({ type: "snapshot", snapshot: {
      protocol_version: 2, event_cursor: 0, active_session: "s1",
      sessions: [{ id: "s1", title: "s1", parent_id: null, busy: false, phase: "IDLE", status: "" }],
      provider: "test", model: "test", mode: "build", approval: null, todos: [],
      context: null, assistant_partial: null,
    } as AppSnapshotV2 });
    vi.advanceTimersByTime(20);
    const send = (cursor: number, delta: string) => store.dispatch({
      type: "event",
      envelope: { type: "text_delta", cursor, session_id: "s1", delta } as Envelope,
    });
    send(1, "**one** ");
    send(2, "**two** ");
    send(3, "**three** ");
    vi.advanceTimersByTime(20);
    const first = store.getSnapshot().messages.at(-1)!;
    expect(first.streamingDelta).toBe("**one** **two** **three** ");
    expect(first.streamingDeltaFromRevision).toBe(0);
    expect(first.streamRevision).toBe(3);
    const cache = createMarkdownStreamCache();
    renderMarkdownStreamUpdate(cache, first.streamingText!, 18, true, {
      id: first.key, revision: first.streamRevision!, fromRevision: first.streamingDeltaFromRevision,
      delta: first.streamingDelta!,
    });
    send(4, "**four** ");
    send(5, "**five** ");
    vi.advanceTimersByTime(20);
    const second = store.getSnapshot().messages.at(-1)!;
    expect(second.streamingDelta).toBe("**four** **five** ");
    expect(second.streamingDeltaFromRevision).toBe(3);
    const update = renderMarkdownStreamUpdate(cache, second.streamingText!, 18, true, {
      id: second.key, revision: second.streamRevision!, fromRevision: second.streamingDeltaFromRevision,
      delta: second.streamingDelta!,
    });
    expect(update.reset).toBe(false);
    expect(cache.streamRevision).toBe(5);
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies exactly once for multiple synchronous dispatches", () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);

    for (let i = 0; i < 5; i += 1) store.dispatch(connected(true));

    // State is current immediately, before any scheduled flush.
    expectState(store.getState(), true);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(listener).toHaveBeenCalledTimes(1);
    // The single notification observes the latest state.
    expectState(store.getState(), true);
  });

  it("keeps getState current synchronously across dispatches", () => {
    const store = createStore();
    store.dispatch(connected(false));
    expectState(store.getState(), false);
    store.dispatch(connected(true));
    expectState(store.getState(), true);
  });

  it("does not notify after unsubscribing", () => {
    const store = createStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.dispatch(connected(true));
    unsubscribe();
    vi.advanceTimersByTime(20);

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify when no listener is subscribed", () => {
    const store = createStore();
    store.dispatch(connected(true));
    // No listener: nothing scheduled, nothing to assert beyond no-throw.
    vi.advanceTimersByTime(20);
  });

  it("notifies a listener subscribed before the flush", () => {
    const store = createStore();
    store.dispatch(connected(true));
    const late = vi.fn();
    store.subscribe(late);

    vi.advanceTimersByTime(20);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("coalesces across an already-pending flush", () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch(connected(true));
    store.dispatch(connected(false));

    vi.advanceTimersByTime(20);
    expect(listener).toHaveBeenCalledTimes(1);
    expectState(store.getState(), false);
  });
});
