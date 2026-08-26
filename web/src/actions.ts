import { modeCommand } from "./lib/modes";
import type { Envelope, ProviderSetOptions } from "./types";
import type { Transport, Subscription } from "./transport/transport";
import type { Store } from "./state/store";
import { PAGE_SIZE } from "./state/reducer";

/** Imperative action layer: mediates `Transport` and the pure `Store`. This is
 * the only place (besides transport) that touches side effects; React views
 * only call these actions. */
export interface Actions {
  /** Fetches the snapshot, then subscribes to the event stream from the
   * snapshot's `event_cursor`. Re-runs the dirty-flag effect loop after each
   * dispatch. */
  init(): Promise<void>;
  /** Submits a message. `mode` is an optional *pending* mode preference used
   * only when the snapshot does not already carry it (e.g. the first message
   * that lazily creates a session): it is applied via a single `/${mode}`
   * command after the snapshot converges, never guessed locally. */
  submit(text: string, mode?: string): Promise<void>;
  executeCommand(text: string): Promise<void>;
  /** Resolves a pending approval; `allowSession` permits the tool for the rest
   * of the session. */
  approve(approvalId: string, accept: boolean, allowSession?: boolean): Promise<void>;
  cancel(): Promise<void>;
  activate(sessionId: string): Promise<void>;
  setProvider(preset: string, model: string, options?: ProviderSetOptions): Promise<void>;
  /** Fetches the provider settings view into the store (settings dialog). */
  loadProviderSettings(): Promise<void>;
  /** Fetches the next (older) message page and prepends it to the cache. */
  loadOlder(): Promise<void>;
  refreshSnapshot(): Promise<void>;
  refreshTranscript(): Promise<void>;
  /** Closes the event subscription. */
  stop(): void;
}

export function createActions(transport: Transport, store: Store): Actions {
  let subscription: Subscription | null = null;
  let refreshing = false;

  const refreshSnapshot = async (): Promise<void> => {
    const snapshot = await transport.snapshot();
    store.dispatch({ type: "snapshot", snapshot });
  };

  const refreshTranscript = async (): Promise<void> => {
    const { activeSession } = store.getState();
    if (!activeSession) {
      store.dispatch({ type: "clearTranscript" });
      return;
    }
    const page = await transport.messages(activeSession, { limit: PAGE_SIZE });
    store.dispatch({ type: "messages", page, replace: true });
  };

  const onEvent = (envelope: Envelope): void => {
    store.dispatch({ type: "event", envelope });
    runEffects();
  };

  /** After any event, honor the reducer's dirty flags by refetching. */
  const runEffects = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      const { snapshotDirty, transcriptDirty } = store.getState();
      if (snapshotDirty) {
        try {
          await refreshSnapshot();
        } catch (error) {
          store.dispatch({ type: "error", message: errorMessage(error) });
        }
        // A snapshot change may alter the active session / transcript.
        if (store.getState().transcriptDirty) {
          try {
            await refreshTranscript();
          } catch (error) {
            store.dispatch({ type: "error", message: errorMessage(error) });
          }
        }
      } else if (transcriptDirty) {
        try {
          await refreshTranscript();
        } catch (error) {
          store.dispatch({ type: "error", message: errorMessage(error) });
        }
      }
    } finally {
      refreshing = false;
    }
  };

  const init = async (): Promise<void> => {
    store.dispatch({ type: "connected", connected: false });
    try {
      const snapshot = await transport.snapshot();
      if (snapshot.protocol_version !== 2) {
        store.dispatch({
          type: "error",
          message: `协议版本不匹配：服务器 v${snapshot.protocol_version}，期望 v2`,
        });
      }
      store.dispatch({ type: "snapshot", snapshot });
      if (snapshot.active_session) {
        const page = await transport.messages(snapshot.active_session, { limit: PAGE_SIZE });
        store.dispatch({ type: "messages", page, replace: true });
      }
      store.dispatch({ type: "connected", connected: true });
      subscription = transport.subscribe(snapshot.event_cursor, onEvent);
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const submit = async (text: string, mode?: string): Promise<void> => {
    store.dispatch({ type: "clearError" });
    try {
      const { activeSession } = store.getState();
      await transport.submit(activeSession, text);
      // The session may be created lazily on first input; refresh to learn the
      // new active session and its (empty) transcript.
      await refreshSnapshot();
      if (store.getState().transcriptDirty) {
        await refreshTranscript();
      }
      // Apply the pending mode only when it differs from the authoritative
      // snapshot — one command, exactly once.
      if (mode) {
        const snap = store.getState();
        if (snap.mode !== mode) {
          await executeCommand(modeCommand(mode));
        }
      }
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const executeCommand = async (text: string): Promise<void> => {
    store.dispatch({ type: "clearError" });
    try {
      const { activeSession } = store.getState();
      await transport.executeCommand(activeSession, text);
      // Commands mutate history: the server emits transcript_invalidated, but
      // also refresh to converge immediately.
      await refreshSnapshot();
      if (store.getState().transcriptDirty) {
        await refreshTranscript();
      }
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const approve = async (approvalId: string, accept: boolean, allowSession?: boolean): Promise<void> => {
    try {
      await transport.approve(approvalId, accept, allowSession);
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const cancel = async (): Promise<void> => {
    const { activeSession } = store.getState();
    if (!activeSession) return;
    try {
      await transport.cancel(activeSession);
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const activate = async (sessionId: string): Promise<void> => {
    try {
      await transport.activateSession(sessionId);
      await refreshSnapshot();
      if (store.getState().transcriptDirty) {
        await refreshTranscript();
      }
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const setProvider = async (
    preset: string,
    model: string,
    options?: ProviderSetOptions,
  ): Promise<void> => {
    try {
      await transport.setProvider(preset, model, options);
      await refreshSnapshot();
      // Refresh the settings view too: `connected` may have changed (a newly
      // stored key) and the dialog reads from this slice. A failure here must
      // not look like a failed apply - the edit itself succeeded.
      try {
        const settings = await transport.providerSettings();
        store.dispatch({ type: "providerSettings", settings });
      } catch {
        // best-effort: the next dialog open refetches
      }
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const loadProviderSettings = async (): Promise<void> => {
    try {
      const settings = await transport.providerSettings();
      store.dispatch({ type: "providerSettings", settings });
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const loadOlder = async (): Promise<void> => {
    const { activeSession, nextBefore, hasMore } = store.getState();
    if (!activeSession || !hasMore || nextBefore === null) return;
    try {
      const page = await transport.messages(activeSession, {
        before: nextBefore,
        limit: PAGE_SIZE,
      });
      store.dispatch({ type: "messages", page, replace: false });
    } catch (error) {
      store.dispatch({ type: "error", message: errorMessage(error) });
    }
  };

  const stop = (): void => {
    subscription?.unsubscribe();
    subscription = null;
  };

  return {
    init,
    submit,
    executeCommand,
    approve,
    cancel,
    activate,
    setProvider,
    loadProviderSettings,
    loadOlder,
    refreshSnapshot,
    refreshTranscript,
    stop,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
