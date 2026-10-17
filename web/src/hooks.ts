import { useMemo, useSyncExternalStore } from "react";
import type { Actions } from "./actions";
import type { Store } from "./state/store";
import type { UiState } from "./state/reducer";
import type { ProviderModelsDto, ProviderSetOptions } from "./types";

/** React binding for the store via `useSyncExternalStore`. */
export function useUiState(store: Store): UiState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Subscribe to one stable part of the UI state without rerendering for other
 * fields (for example, a session list does not need every streamed token). */
export function useUiSelector<T>(
  store: Store,
  selector: (state: UiState) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const subscribe = useMemo(() => (notify: () => void) => {
    let selected = selector(store.getSnapshot());
    return store.subscribe(() => {
      const next = selector(store.getSnapshot());
      if (!isEqual(selected, next)) {
        selected = next;
        notify();
      }
    });
  }, [isEqual, selector, store]);
  const getSelection = useMemo(() => {
    let initialized = false;
    let selected: T;
    return () => {
      const next = selector(store.getSnapshot());
      if (!initialized || !isEqual(selected, next)) {
        selected = next;
        initialized = true;
      }
      return selected;
    };
  }, [isEqual, selector, store]);
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

export interface ChatActions {
  submit(text: string, mode?: string): Promise<void>;
  executeCommand(text: string): Promise<void>;
  approve(approvalId: string, accept: boolean, allowSession?: boolean): Promise<void>;
  cancel(): Promise<void>;
  activate(sessionId: string): Promise<void>;
  forkSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  setProvider(preset: string, model: string, options?: ProviderSetOptions): Promise<void>;
  removeProvider(id: string): Promise<void>;
  loadProviderSettings(): Promise<void>;
  loadProviderModels(refresh?: boolean): Promise<ProviderModelsDto | null>;
  loadMemories(query?: string, includeDeleted?: boolean): Promise<void>;
  saveMemory(title: string, content: string, candidate?: boolean): Promise<import("./types").MemoryDto | null>;
  confirmMemory(id: number): Promise<void>;
  updateMemory(id: number, title: string, content: string): Promise<void>;
  deleteMemory(id: number): Promise<void>;
  loadOlder(): Promise<void>;
  searchTranscript: Actions["searchTranscript"];
  locateMessage: Actions["locateMessage"];
  cancelMessageSearch: Actions["cancelMessageSearch"];
}

export function useChatActions(actions: Actions): ChatActions {
  return useMemo(() => ({
    submit: actions.submit,
    executeCommand: actions.executeCommand,
    approve: actions.approve,
    cancel: actions.cancel,
    activate: actions.activate,
    forkSession: actions.forkSession,
    deleteSession: actions.deleteSession,
    setProvider: actions.setProvider,
    removeProvider: actions.removeProvider,
    loadProviderSettings: actions.loadProviderSettings,
    loadProviderModels: actions.loadProviderModels,
    loadMemories: actions.loadMemories,
    saveMemory: actions.saveMemory,
    confirmMemory: actions.confirmMemory,
    updateMemory: actions.updateMemory,
    deleteMemory: actions.deleteMemory,
    loadOlder: actions.loadOlder,
    searchTranscript: actions.searchTranscript,
    locateMessage: actions.locateMessage,
    cancelMessageSearch: actions.cancelMessageSearch,
  }), [actions]);
}
