import type {
  AppSnapshotV2,
  Envelope,
  MessagePage,
} from "../types";
import type { Subscription, Transport } from "./transport";

/**
 * Tauri IPC transport for 1h-agent-desktop: the Rust core runs in-process via
 * `AppService::start` and is exposed over the Tauri invoke/event bridge. No
 * localhost server is started. This is implemented in the Desktop phase; the
 * surface is kept stable so actions/store/hooks never know which transport is
 * active.
 */
export class TauriIpcTransport implements Transport {
  private async invoke<T>(_cmd: string, _args?: Record<string, unknown>): Promise<T> {
    throw new Error("TauriIpcTransport is not implemented yet (Desktop phase)");
  }

  snapshot(): Promise<AppSnapshotV2> {
    return this.invoke("snapshot");
  }

  messages(sessionId: string, opts?: { before?: number | null; limit?: number }): Promise<MessagePage> {
    return this.invoke("messages", { sessionId, before: opts?.before ?? null, limit: opts?.limit });
  }

  submit(sessionId: string | null, text: string): Promise<void> {
    return this.invoke("submit", { sessionId, text });
  }

  executeCommand(sessionId: string | null, text: string): Promise<void> {
    return this.invoke("executeCommand", { sessionId, text });
  }

  approve(approvalId: string, accept: boolean): Promise<void> {
    return this.invoke("approve", { approvalId, accept });
  }

  cancel(sessionId: string): Promise<void> {
    return this.invoke("cancel", { sessionId });
  }

  activateSession(sessionId: string): Promise<void> {
    return this.invoke("activateSession", { sessionId });
  }

  setProvider(preset: string, model: string): Promise<void> {
    return this.invoke("setProvider", { preset, model });
  }

  subscribe(_fromCursor: number, _onEvent: (envelope: Envelope) => void): Subscription {
    // Desktop phase: register the Tauri event listener first, then request a
    // replay from `fromCursor`; unregister on unsubscribe.
    return {
      unsubscribe: () => {
        // no-op until Desktop phase wires the listener
      },
    };
  }
}
