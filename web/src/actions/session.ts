import { modeCommand } from "../lib/modes";
import type { Transport } from "../transport/transport";
import type { Store } from "../state/store";
import { PAGE_SIZE } from "../state/reducer";
import { errorMessage } from "./shared";

type Refresh = () => Promise<void>;

export function createSessionActions(
  transport: Transport,
  store: Store,
  helpers: { refreshSnapshot: Refresh; refreshTranscript: Refresh },
) {
  const { refreshSnapshot, refreshTranscript } = helpers;
  const submit = async (text: string, mode?: string): Promise<void> => {
    store.dispatch({ type: "clearError" });
    // Optimistic echo: append the outgoing message before the request so the
    // transcript immediately shows it with the reply streaming below. The
    // server persists the user row on submit but emits no transcript event,
    // so without the echo the question stays invisible until the turn ends.
    // Commands (`/…`) and shell lines (`!…`) get no echo: they are not
    // persisted as user messages and their feedback comes from events / the
    // post-command refetch.
    if (!text.startsWith("/") && !text.startsWith("!")) {
      store.dispatch({ type: "userEcho", text });
    }
    try {
      const { activeSession } = store.getState();
      try {
        await transport.submit(activeSession, text);
      } catch (error) {
        // The input was not accepted: drop the trailing echo so a rejected
        // message does not linger as if it had been sent. (An echo followed
        // by streamed content is kept - that submit was accepted, only its
        // response was lost - and the terminal refetch replaces it.)
        store.dispatch({ type: "dropUserEcho" });
        throw error;
      }
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

  // The core `/fork` and `/delete` commands operate on the *active* session, so
  // a session-picked action first activates the target (unless it already is
  // the active one). `activate` swallows failures, so after it we re-check that
  // the active session actually converged to the target; otherwise the command
  // would silently hit the wrong (still-active) session — abort instead.
  const forkSession = async (sessionId: string): Promise<void> => {
    const { activeSession } = store.getState();
    if (activeSession !== sessionId) {
      await activate(sessionId);
    }
    if (store.getState().activeSession !== sessionId) return;
    await executeCommand("/fork");
  };

  const deleteSession = async (sessionId: string): Promise<void> => {
    const { activeSession } = store.getState();
    if (activeSession !== sessionId) {
      await activate(sessionId);
    }
    if (store.getState().activeSession !== sessionId) return;
    await executeCommand("/delete");
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
  return { submit, executeCommand, approve, cancel, activate, forkSession, deleteSession, loadOlder };
}
