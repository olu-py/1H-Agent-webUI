import type { Envelope, MemoryDto, ProviderModelsDto, ProviderSetOptions } from "./types";
import type { Transport, Subscription } from "./transport/transport";
import type { Store } from "./state/store";
import { createMemoryActions } from "./actions/memory";
import { createProviderActions } from "./actions/provider";
import { createSessionActions } from "./actions/session";
import { PAGE_SIZE } from "./state/reducer";
import { errorMessage } from "./actions/shared";

/** Imperative action layer: mediates `Transport` and the pure `Store`. This is
 * the only place (besides transport) that touches side effects; React views
 * only call these actions. */
export interface Actions {
  /** Fetches the snapshot, then subscribes to the event stream from the
   * snapshot's `event_cursor`. Re-runs the dirty-flag effect loop after each
   * dispatch. */
  init(): Promise<void>;
  /** Submits a message. Echoes it into the transcript optimistically (before
   * the request) so it renders ahead of the streamed reply - normal chat
   * ordering; a rejected submit drops the echo. `mode` is an optional
   * *pending* mode preference used only when the snapshot does not already
   * carry it (e.g. the first message that lazily creates a session): it is
   * applied via a single `/${mode}` command after the snapshot converges,
   * never guessed locally. */
  submit(text: string, mode?: string): Promise<void>;
  executeCommand(text: string): Promise<void>;
  /** Resolves a pending approval; `allowSession` permits the tool for the rest
   * of the session. */
  approve(approvalId: string, accept: boolean, allowSession?: boolean): Promise<void>;
  cancel(): Promise<void>;
  activate(sessionId: string): Promise<void>;
  /** Forks a specific session (not necessarily the active one): activates it
   * first, then runs `/fork`. No-op without error when the activation fails —
   * the command must never run against the wrong (still-active) session. */
  forkSession(sessionId: string): Promise<void>;
  /** Deletes a specific session (not necessarily the active one): activates it
   * first, then runs `/delete`. Guarded like `forkSession`. */
  deleteSession(sessionId: string): Promise<void>;
  setProvider(preset: string, model: string, options?: ProviderSetOptions): Promise<void>;
  /** Fetches the provider settings view into the store (settings dialog). */
  loadProviderSettings(): Promise<void>;
  /** Loads the active provider's model list into the store (settings
   * dialog). `refresh = true` refetches the provider endpoint and models.dev
   * first; failures fall back to the previously cached list / static preset
   * lists without surfacing an error (metadata is best effort). */
  loadProviderModels(refresh?: boolean): Promise<ProviderModelsDto | null>;
  loadMemories(query?: string, includeDeleted?: boolean): Promise<void>;
  saveMemory(title: string, content: string, candidate?: boolean): Promise<MemoryDto | null>;
  confirmMemory(id: number): Promise<void>;
  updateMemory(id: number, title: string, content: string): Promise<void>;
  deleteMemory(id: number): Promise<void>;
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
    try {
      const page = await transport.messages(activeSession, { limit: PAGE_SIZE });
      store.dispatch({ type: "messages", page, replace: true });
    } catch (error) {
      // The active session may have just been deleted server-side: a `/delete`
      // lands a `transcript_invalidated` for the deleted session while the
      // client still points at it, and this follow-up fetch would 404. Its
      // transcript is gone too — clear the cache and let the incoming snapshot
      // converge to the new active session rather than surfacing a confusing
      // "unknown session" banner.
      if (isNotFound(error)) {
        store.dispatch({ type: "clearTranscript" });
        return;
      }
      throw error;
    }
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

  const stop = (): void => {
    subscription?.unsubscribe();
    subscription = null;
  };

  const sessionActions = createSessionActions(transport, store, { refreshSnapshot, refreshTranscript });
  const providerActions = createProviderActions(transport, store, refreshSnapshot);
  const memoryActions = createMemoryActions(transport, store);

  return {
    init,
    ...sessionActions,






    ...providerActions,


    ...memoryActions,





    refreshSnapshot,
    refreshTranscript,
    stop,
  };
}

/** True for a 404/not-found transport error. Duck-typed on `status` so the
 * actions layer stays decoupled from the HTTP error class (a Tauri IPC
 * transport can carry the same shape). */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}
