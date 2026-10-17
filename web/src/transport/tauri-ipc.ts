import type {
  AppSnapshotV2,
  Envelope,
  MessagePage,
  MemoryDto,
  ProviderModelsDto,
  ProviderSetOptions,
  ProviderSettingsDto,
} from "../types";
import type { Subscription, Transport } from "./transport";

export interface NativeIpc {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
}

export function nativeIpc(): NativeIpc | undefined {
  return (window as unknown as { __TAURI__?: { core: NativeIpc } }).__TAURI__?.core;
}

/**
 * Tauri IPC transport for 1h-agent-desktop: the Rust core runs in-process via
 * `AppService::start` and is exposed over the Tauri invoke/event bridge. No
 * localhost server is started. Atomic cursor replay/watch uses bounded invoke
 * batches; actions/store/hooks share the same transport surface.
 */
export class TauriIpcTransport implements Transport {
  private readonly requestSequences = new Map<string, number>();
  private pendingNewSessions = 0;
  private pruningSequences: Promise<void> | undefined;
  constructor(private readonly native: NativeIpc = nativeIpc()!,
    private readonly onError: (error: unknown) => void = console.error) {
    if (!native) throw new Error("Tauri native IPC is unavailable");
  }
  private async invoke<T>(method: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const registration = this.native.invoke<number>("core_register_request", { requestId });
    const cancel = () => {
      void registration.then(ticket => this.native.invoke("core_cancel_request", { requestId, ticket })).catch(this.onError);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const ticket = await registration;
      if (signal?.aborted) {
        await this.native.invoke("core_cancel_request", { requestId, ticket });
        signal.throwIfAborted();
      }
      const value = await this.native.invoke<T>("core_call", { requestId, ticket, call: { method, ...args } });
      signal?.throwIfAborted();
      return value;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  snapshot(): Promise<AppSnapshotV2> {
    return this.invoke("snapshot");
  }

  messages(sessionId: string, opts?: { before?: number | null; limit?: number; signal?: AbortSignal }): Promise<MessagePage> {
    return this.invoke("messages", { sessionId, before: opts?.before ?? null, limit: opts?.limit }, opts?.signal);
  }

  memories(query?: string, includeDeleted = false): Promise<MemoryDto[]> {
    return this.invoke("memories", { query, includeDeleted });
  }

  saveMemory(title: string, content: string, candidate = false): Promise<MemoryDto> {
    return this.invoke("saveMemory", { title, content, candidate });
  }

  confirmMemory(id: number): Promise<MemoryDto> {
    return this.invoke("confirmMemory", { id });
  }

  updateMemory(id: number, title: string, content: string): Promise<MemoryDto> {
    return this.invoke("updateMemory", { id, title, content });
  }

  deleteMemory(id: number): Promise<void> {
    return this.invoke("deleteMemory", { id });
  }

  async submit(sessionId: string | null, text: string): Promise<void> {
    if ((!sessionId || !this.requestSequences.has(sessionId)) && this.requestSequences.size + this.pendingNewSessions >= 64) {
      await this.pruneSequences();
      if ((!sessionId || !this.requestSequences.has(sessionId)) && this.requestSequences.size + this.pendingNewSessions >= 64) {
        throw new Error("Desktop Agent sequence capacity exceeded");
      }
    }
    if (sessionId && !this.requestSequences.has(sessionId)) this.requestSequences.set(sessionId, 0);
    if (!sessionId) this.pendingNewSessions += 1;
    try {
      const receipt = await this.invoke<{session_id: string; request_seq: number}>("submit", { sessionId, text });
      this.requestSequences.set(receipt.session_id, receipt.request_seq);
    } catch (error) {
      if (sessionId && this.requestSequences.get(sessionId) === 0) this.requestSequences.delete(sessionId);
      throw error;
    } finally {
      if (!sessionId) this.pendingNewSessions -= 1;
    }
  }

  private pruneSequences(): Promise<void> {
    if (this.pruningSequences) return this.pruningSequences;
    const prune = async () => {
      // Only core authority can retire a receipt. Sequential bounded requests
      // leave capacity for subscriptions and cancellation, without idle polling.
      for (const [sessionId, sequence] of [...this.requestSequences]) {
        if (!sequence) continue; // A submit receipt is still in flight.
        let active: number | null;
        try { active = await this.invoke<number | null>("requestSequence", { sessionId }); }
        catch (error) {
          if ((error as {kind?: string})?.kind !== "not_found") continue;
          active = null; // Evicted/deleted runtimes have no live request.
        }
        if (active !== sequence && this.requestSequences.get(sessionId) === sequence) {
          this.requestSequences.delete(sessionId);
        }
      }
    };
    this.pruningSequences = prune().finally(() => { this.pruningSequences = undefined; });
    return this.pruningSequences;
  }

  executeCommand(sessionId: string | null, text: string): Promise<void> {
    return this.invoke("executeCommand", { sessionId, text });
  }

  approve(approvalId: string, accept: boolean, allowSession = false): Promise<void> {
    return this.invoke("approve", { approvalId, accept, allowSession });
  }

  async cancel(sessionId: string): Promise<void> {
    // Keep an existing receipt: a stale caller must not adopt a newer task.
    // An attached adapter has no receipt and asks the core for its authority.
    const requestSeq = this.requestSequences.get(sessionId) ||
      await this.invoke<number | null>("requestSequence", { sessionId });
    if (!requestSeq) return;
    await this.invoke("cancel", { sessionId, requestSeq });
  }

  activateSession(sessionId: string): Promise<void> {
    return this.invoke("activateSession", { sessionId });
  }

  providerSettings(): Promise<ProviderSettingsDto> {
    return this.invoke("providerSettings");
  }

  providerModels(refresh = false): Promise<ProviderModelsDto> {
    return this.invoke("providerModels", { refresh });
  }

  setProvider(preset: string, model: string, options?: ProviderSetOptions): Promise<void> {
    return this.invoke("setProvider", { preset, model, options });
  }

  removeProvider(id: string): Promise<void> {
    return this.invoke("removeProvider", { id });
  }

  subscribe(fromCursor: number, onEvent: (envelope: Envelope) => void): Subscription {
    const controller = new AbortController();
    let cursor = fromCursor;
    // Each invocation owns an atomic replay/watch in core. At most one bounded
    // batch is in flight; the next request waits for a core event, never a timer.
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const batch = await this.invoke<Envelope[]>("eventsNext", { cursor }, controller.signal);
          for (const envelope of batch) {
            if (controller.signal.aborted) return;
            if (envelope.type === "resync_required") { onEvent(envelope); return; }
            if (envelope.cursor <= cursor) continue;
            cursor = envelope.cursor;
            // A delayed terminal envelope has no request sequence. It cannot
            // safely invalidate a newer submit receipt; cancel remains scoped
            // to that receipt until a subsequent submit replaces it.
            onEvent(envelope);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.onError(error);
          onEvent({ cursor, session_id: "", type: "resync_required" });
        }
      }
    })();
    return {
      unsubscribe: () => controller.abort(),
    };
  }
}
