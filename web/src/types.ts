// Re-export of the ts-rs generated v2 protocol types. These files are
// generated from Rust (`protium-tsgen`); do not edit them by hand. The CI
// drift check fails if they diverge from the Rust source.

import type { Envelope } from "../ts/Envelope";

export type { Envelope } from "../ts/Envelope";
export type { AppSnapshotV2 } from "../ts/AppSnapshotV2";
export type { SessionStateDto } from "../ts/SessionStateDto";
export type { ApprovalDto } from "../ts/ApprovalDto";
export type { TodoDto } from "../ts/TodoDto";
export type { TodoTask } from "../ts/TodoTask";
export type { TodoStatus } from "../ts/TodoStatus";
export type { MessageDto } from "../ts/MessageDto";
export type { MessagePage } from "../ts/MessagePage";
export type { ApiError } from "../ts/ApiError";
export type { ApiErrorKind } from "../ts/ApiErrorKind";
export type { ToolCall } from "../ts/ToolCall";

/**
 * The flattened event payload of an `Envelope` — the discriminated union of
 * every `Event` variant (the envelope is `{ cursor, session_id } & Event`).
 */
export type EventPayload = Exclude<Envelope, { cursor: number; session_id: string }>;

/** Current wire protocol version served by the backend. */
export const PROTOCOL_VERSION = 2;
