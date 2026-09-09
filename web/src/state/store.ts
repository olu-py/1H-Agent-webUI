import type { Action, UiState } from "./reducer";
import { initialState, reduce } from "./reducer";

export type Listener = () => void;

/**
 * Pure state container: `getState` / `dispatch` / `subscribe`, nothing else.
 * It never touches the network — the actions layer mediates between this store
 * and the `Transport`.
 */
export interface Store {
  getState(): UiState;
  dispatch(action: Action): void;
  subscribe(listener: Listener): () => void;
  getSnapshot(): UiState;
}

/**
 * Notifier used to coalesce listener notification. `requestAnimationFrame`
 * caps re-renders at one per frame in the browser; anything without rAF
 * (tests, node) falls back to a short timeout with the same coalescing
 * contract.
 */
function scheduleNotify(flush: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => flush());
  } else {
    setTimeout(flush, 16);
  }
}

/**
 * Streaming turns deliver one SSE envelope per token chunk, each in its own
 * macrotask — React cannot batch across those, so notifying listeners per
 * `dispatch` re-renders the whole transcript at network-chunk rate (the
 * perceived jank of tool/thinking rows while streaming).
 *
 * `dispatch` still applies the action synchronously — `getState()` is always
 * current and action ordering is untouched — but listener notification is
 * coalesced: the first change schedules exactly one flush, and a single
 * notification reports the latest state. `useSyncExternalStore` reconciles
 * against the snapshot on every render, so the delayed notify is safe.
 * Consumers must therefore not assume a listener runs synchronously with a
 * dispatch.
 */
export function createStore(): Store {
  let state: UiState = initialState;
  const listeners = new Set<Listener>();
  let notifyScheduled = false;

  const flush = (): void => {
    notifyScheduled = false;
    for (const listener of [...listeners]) listener();
  };

  return {
    getState: () => state,
    dispatch: (action: Action) => {
      state = reduce(state, action);
      if (notifyScheduled) return;
      notifyScheduled = true;
      scheduleNotify(flush);
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
  };
}
