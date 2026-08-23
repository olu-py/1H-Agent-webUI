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

export function createStore(): Store {
  let state: UiState = initialState;
  const listeners = new Set<Listener>();

  return {
    getState: () => state,
    dispatch: (action: Action) => {
      state = reduce(state, action);
      for (const listener of [...listeners]) listener();
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
