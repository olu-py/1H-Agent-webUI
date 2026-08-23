import type {
  AppSnapshotV2,
  Envelope,
  MessagePage,
} from "../types";

/** Result of an event subscription until the caller unsubscribes. */
export interface Subscription {
  unsubscribe(): void;
}

/**
 * UI-independent transport boundary. Its methods map one-to-one onto
 * `AppHandle` on the Rust side. Implementations are the *only* code allowed to
 * touch fetch / EventSource / Tauri IPC; actions, store, and hooks never do.
 *
 * A `sessionId` of `null` means "the active session, creating one on first
 * input" (the home-screen first-message-creates-a-session semantic).
 */
export interface Transport {
  /** `GET /api/v2/state` */
  snapshot(): Promise<AppSnapshotV2>;
  /** `GET /api/v2/sessions/{id}/messages?before=&limit=` */
  messages(
    sessionId: string,
    opts?: { before?: number | null; limit?: number },
  ): Promise<MessagePage>;
  /** `POST /api/v2/sessions/{id}/input` */
  submit(sessionId: string | null, text: string): Promise<void>;
  /** `POST /api/v2/sessions/{id}/commands` */
  executeCommand(sessionId: string | null, text: string): Promise<void>;
  /** `POST /api/v2/approvals/{approval_id}` */
  approve(approvalId: string, accept: boolean): Promise<void>;
  /** `POST /api/v2/sessions/{id}/cancel` */
  cancel(sessionId: string): Promise<void>;
  /** `POST /api/v2/sessions/{id}/activate` */
  activateSession(sessionId: string): Promise<void>;
  /** `POST /api/v2/config/provider` */
  setProvider(preset: string, model: string): Promise<void>;
  /**
   * Subscribes to the event stream from `fromCursor` (exclusive). The
   * transport reconnects on error/EOF, always resuming from the cursor of the
   * last delivered envelope; the server responds with a `resync_required`
   * envelope when that cursor has been evicted. Returns a `Subscription` whose
   * `unsubscribe()` closes the stream.
   */
  subscribe(fromCursor: number, onEvent: (envelope: Envelope) => void): Subscription;
}
