import { modeCommand } from "../lib/modes";
import type { Transport } from "../transport/transport";
import type { Store } from "../state/store";
import { PAGE_SIZE } from "../state/reducer";
import { errorMessage } from "./shared";
import { toViewMessage, type ViewMessage } from "../state/transcript";

type Refresh = () => Promise<void>;

export function createSessionActions(
  transport: Transport,
  store: Store,
  helpers: { refreshSnapshot: Refresh; refreshTranscript: Refresh; readSignal: () => AbortSignal },
) {
  const { refreshSnapshot, refreshTranscript } = helpers;
  let locateRevision = 0;
  let olderRequest: AbortController | undefined;
  let locateRequest: AbortController | undefined;
  const readPage: Transport["messages"] = async (session, options) => {
    const switched = new AbortController();
    const unsubscribe = store.subscribeSession(() => {
      if (store.getState().activeSession !== session) switched.abort();
    });
    const signal = AbortSignal.any([switched.signal, helpers.readSignal(), ...(options?.signal ? [options.signal] : [])]);
    signal.addEventListener("abort", unsubscribe, { once: true });
    try {
      signal.throwIfAborted();
      const page = await transport.messages(session, { ...options, signal });
      signal.throwIfAborted();
      return page;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally { signal.removeEventListener("abort", unsubscribe); unsubscribe(); }
  };
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
    olderRequest?.abort();
    const request = new AbortController();
    olderRequest = request;
    try {
      const page = await readPage(activeSession, {
        before: nextBefore,
        limit: PAGE_SIZE,
        signal: request.signal,
      });
      if (request.signal.aborted || helpers.readSignal().aborted || store.getState().activeSession !== activeSession) return;
      store.dispatch({ type: "messages", page, replace: false });
    } catch (error) {
      if (request.signal.aborted || helpers.readSignal().aborted || store.getState().activeSession !== activeSession || (error instanceof DOMException && error.name === "AbortError")) return;
      store.dispatch({ type: "error", message: errorMessage(error) });
    } finally { if (olderRequest === request) olderRequest = undefined; }
  };
  const searchTranscript = async (
    query: string,
    options: { signal?: AbortSignal; onProgress?: (scanned: number) => void } = {},
  ): Promise<{ results: Array<{ message: ViewMessage; excerpt: string }>; scanned: number }> => {
    const needle = query.trim().toLocaleLowerCase();
    const { activeSession } = store.getState();
    if (!needle || !activeSession) return { results: [], scanned: 0 };
    const results: Array<{ message: ViewMessage; excerpt: string }> = [];
    let before: number | null = null;
    let scanned = 0;
    while (!options.signal?.aborted && store.getState().activeSession === activeSession) {
      const page = await readPage(activeSession, {
        before,
        limit: PAGE_SIZE,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (options.signal?.aborted || store.getState().activeSession !== activeSession) break;
      for (const dto of page.messages) {
        scanned += 1;
        const candidate = [
          "content" in dto ? dto.content : "",
          "output" in dto ? dto.output : "",
          "result" in dto ? dto.result ?? "" : "",
          "name" in dto ? dto.name : "",
          "arguments" in dto ? JSON.stringify(dto.arguments) : "",
          "calls" in dto ? JSON.stringify(dto.calls) : "",
        ].filter(Boolean).join("\n");
        const index = candidate.toLocaleLowerCase().indexOf(needle);
        if (index >= 0) {
          const start = Math.max(0, index - 72);
          results.push({
            message: toViewMessage(dto),
            excerpt: `${start ? "…" : ""}${candidate.slice(start, index + needle.length + 112)}${index + needle.length + 112 < candidate.length ? "…" : ""}`,
          });
        }
      }
      options.onProgress?.(scanned);
      if (!page.has_more || page.next_before === null) break;
      before = page.next_before;
    }
    return { results, scanned };
  };
  const locateMessage = async (messageId: number): Promise<boolean> => {
    locateRequest?.abort();
    const request = new AbortController();
    locateRequest = request;
    const revision = ++locateRevision;
    const { activeSession, messages } = store.getState();
    if (!activeSession) return false;
    const cached = messages.find((message) => message.id === messageId);
    if (cached) return true;
    let before: number | null = null;
    while (revision === locateRevision && store.getState().activeSession === activeSession) {
      let page;
      try { page = await readPage(activeSession, { before, limit: PAGE_SIZE, signal: request.signal }); }
      catch (error) { if (request.signal.aborted || helpers.readSignal().aborted || store.getState().activeSession !== activeSession || (error instanceof DOMException && error.name === "AbortError")) return false; throw error; }
      if (revision !== locateRevision || store.getState().activeSession !== activeSession) return false;
      if (page.messages.some((message) => Number(message.id) === messageId)) {
        store.dispatch({ type: "messages", page, replace: true });
        return true;
      }
      if (!page.has_more || page.next_before === null) return false;
      before = page.next_before;
    }
    return false;
  };
  const cancelMessageSearch = () => { locateRevision += 1; locateRequest?.abort(); locateRequest = undefined; };
  return { submit, executeCommand, approve, cancel, activate, forkSession, deleteSession, loadOlder, searchTranscript, locateMessage, cancelMessageSearch };
}
