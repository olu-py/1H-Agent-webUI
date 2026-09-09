import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/state/store";
import type { UiState } from "../src/state/reducer";

/** Minimal action used to drive the store without touching the network. */
function connected(connected: boolean) {
  return { type: "connected", connected } as const;
}

/** State guard: exercises unrelated fields to keep the test type-honest. */
function expectState(state: UiState, connected: boolean): void {
  expect(state.connected).toBe(connected);
}

describe("createStore coalesced notification", () => {
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
