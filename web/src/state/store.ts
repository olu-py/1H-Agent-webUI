import type { Action, UiState } from "./reducer";
import { initialState, reduce } from "./reducer";
import { p1Record } from "../lib/p1-diagnostics";

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
  /** Synchronous session transitions for cancelling scoped reads. */
  subscribeSession(listener: Listener): () => void;
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
  const sessionListeners = new Set<Listener>();
  let notifyScheduled = false;
  let oldestNotifyAt = 0;
  let pendingText: { key: string; fromRevision: number; revision: number; delta: string } | null = null;

  const flush = (): void => {
    p1Record(2, performance.now() - oldestNotifyAt, state.cursor);
    notifyScheduled = false;
    if (pendingText) {
      const pending = pendingText;
      const index = state.messages.findIndex((message) => message.key === pending.key);
      const row = state.messages[index];
      if (row?.streamRevision === pending.revision && row.streamingText !== undefined) {
        const messages = [...state.messages];
        messages[index] = {
          ...row,
          streamingDelta: pending.delta,
          streamingDeltaFromRevision: pending.fromRevision,
        };
        state = { ...state, messages };
      }
      pendingText = null;
    }
    for (const listener of [...listeners]) listener();
  };

  return {
    getState: () => state,
    dispatch: (action: Action) => {
      const previousSession = state.activeSession;
      state = reduce(state, action);
      if (previousSession !== state.activeSession) {
        for (const listener of [...sessionListeners]) listener();
      }
      if (action.type === "event" && action.envelope.type === "text_delta" &&
        action.envelope.session_id === state.activeSession) {
        p1Record(1, action.envelope.cursor, action.envelope.delta.length);
        let row: UiState["messages"][number] | undefined;
        for (let index = state.messages.length - 1; index >= 0; index -= 1) {
          const candidate = state.messages[index];
          if (candidate.streamingText !== undefined && candidate.streamRevision !== undefined) {
            row = candidate;
            break;
          }
        }
        if (row?.streamRevision !== undefined && row.streamingDelta === action.envelope.delta) {
          const fromRevision = row.streamRevision - 1;
          const pending = pendingText;
          pendingText = pending && pending.key === row.key && pending.revision === fromRevision
            ? { ...pending, revision: row.streamRevision, delta: pending.delta + action.envelope.delta }
            : { key: row.key, fromRevision, revision: row.streamRevision, delta: action.envelope.delta };
        }
      }
      if (notifyScheduled) return;
      notifyScheduled = true;
      oldestNotifyAt = performance.now();
      scheduleNotify(flush);
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeSession: (listener: Listener) => {
      sessionListeners.add(listener);
      return () => { sessionListeners.delete(listener); };
    },
    getSnapshot: () => state,
  };
}
