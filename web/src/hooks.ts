import { useSyncExternalStore } from "react";
import type { Actions } from "./actions";
import type { Store } from "./state/store";
import type { UiState } from "./state/reducer";

/** React binding for the store via `useSyncExternalStore`. */
export function useUiState(store: Store): UiState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export interface ChatActions {
  submit(text: string): Promise<void>;
  executeCommand(text: string): Promise<void>;
  approve(approvalId: string, accept: boolean): Promise<void>;
  cancel(): Promise<void>;
  activate(sessionId: string): Promise<void>;
  setProvider(preset: string, model: string): Promise<void>;
  loadOlder(): Promise<void>;
}

export function useChatActions(actions: Actions): ChatActions {
  return {
    submit: actions.submit,
    executeCommand: actions.executeCommand,
    approve: actions.approve,
    cancel: actions.cancel,
    activate: actions.activate,
    setProvider: actions.setProvider,
    loadOlder: actions.loadOlder,
  };
}
