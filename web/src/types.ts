// Re-export of the ts-rs generated v2 protocol types. These files are
// generated in the protium-core repository; do not edit them by hand. Use
// scripts/core-bindings.sh after updating the locked Git core dependency.

import type { ApiError as CoreApiError } from "../ts/ApiError";
import type { ApiErrorKind as CoreApiErrorKind } from "../ts/ApiErrorKind";
import type { AppSnapshotV2 as CoreAppSnapshotV2 } from "../ts/AppSnapshotV2";
import type { ApprovalDto as CoreApprovalDto } from "../ts/ApprovalDto";
import type { ContextBudgetDto as CoreContextBudgetDto } from "../ts/ContextBudgetDto";
import type { Envelope as CoreEnvelope } from "../ts/Envelope";
import type { Event as CoreEvent } from "../ts/Event";
import type { MessageDto as CoreMessageDto } from "../ts/MessageDto";
import type { MessagePage as CoreMessagePage } from "../ts/MessagePage";
import type { PartialDto as CorePartialDto } from "../ts/PartialDto";
import type { SessionStateDto as CoreSessionStateDto } from "../ts/SessionStateDto";
import type { TodoDto as CoreTodoDto } from "../ts/TodoDto";
import type { TodoStatus as CoreTodoStatus } from "../ts/TodoStatus";
import type { TodoTask as CoreTodoTask } from "../ts/TodoTask";
import type { ToolCall as CoreToolCall } from "../ts/ToolCall";

/** Core uses bigint for SQLite integers; JSON transports them as numbers. */
type JsonNumber<T> = T extends bigint
  ? number
  : T extends readonly (infer Item)[]
    ? JsonNumber<Item>[]
    : T extends object
      ? { [Key in keyof T]: JsonNumber<T[Key]> }
      : T;

export type Envelope = JsonNumber<CoreEnvelope>;
export type Event = JsonNumber<CoreEvent>;
export type AppSnapshotV2 = JsonNumber<CoreAppSnapshotV2>;
export type SessionStateDto = JsonNumber<CoreSessionStateDto>;
export type ApprovalDto = JsonNumber<CoreApprovalDto>;
export type ContextBudgetDto = JsonNumber<CoreContextBudgetDto>;
export type PartialDto = JsonNumber<CorePartialDto>;
export type TodoDto = JsonNumber<CoreTodoDto>;
export type TodoTask = JsonNumber<CoreTodoTask>;
export type TodoStatus = JsonNumber<CoreTodoStatus>;
export type MessageDto = JsonNumber<CoreMessageDto>;
export type MessagePage = JsonNumber<CoreMessagePage>;
export type ApiError = JsonNumber<CoreApiError>;
export type ApiErrorKind = JsonNumber<CoreApiErrorKind>;
export type ToolCall = JsonNumber<CoreToolCall>;

/**
 * The flattened event payload of an `Envelope` — the discriminated union of
 * every `Event` variant (the envelope is `{ cursor, session_id } & Event`).
 */
export type EventPayload = Exclude<Envelope, { cursor: number; session_id: string }>;

/** Current wire protocol version served by the backend. */
export const PROTOCOL_VERSION = 2;
