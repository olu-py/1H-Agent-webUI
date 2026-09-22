import type { MessageDto, ToolCall } from "../types";
import type { UiState } from "./reducer";
/** Maximum transcript cache per active session (5 pages × 100). */
export const MAX_CACHE_MESSAGES = 500;
/** Page size used for pagination fetches. */
export const PAGE_SIZE = 100;

/** Normalized message for rendering; superset of the wire `MessageDto`. */
export interface ViewMessage {
  key: string;
  id: number;
  kind: MessageDto["kind"];
  role: "user" | "assistant" | "system" | "thinking" | "context" | "tool" | "tool_calls" | "tool_output" | "compaction_summary";
  content: string;
  /** Reasoning that already finished streaming (kept when a live row is
   * closed at a round boundary or flushed at turn end). Rendered as the
   * collapsed thinking panel above the text. */
  thinking?: string;
  label?: string;
  callId?: string;
  name?: string;
  args?: unknown;
  status?: string;
  result?: string | null;
  calls?: ToolCall[];
  /** Per-call outputs folded from trailing `tool_output` rows, keyed by call id. */
  outputs?: Record<string, string>;
  output?: string;
  createdAt: string;
  /** In-flight streamed text not yet persisted by the server. */
  streamingText?: string;
  /** In-flight streamed reasoning. */
  streamingThinking?: string;
  /** True for the synthetic "未完成" message restored from `assistant_partial`. */
  partial?: boolean;
}

/** The current activity of the active session, mirroring the TUI's projection. */
export type ActivityKind =
  | "idle"
  | "thinking"
  | "generating"
  | "tool_call"
  | "tool_run"
  | "approval"
  | "retry"
  | "compacting"
  | "completed"
  | "failed"
  | "cancelled";

export interface ActivityState {
  kind: ActivityKind;
  text: string;
}

/** Token usage reported by the most recent `usage` event of the active session. */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function toViewMessage(dto: MessageDto): ViewMessage {
  const base = { key: `m-${dto.id}`, id: Number(dto.id), createdAt: dto.created_at, content: "" };
  switch (dto.kind) {
    case "user":
    case "assistant":
    case "system":
    case "thinking":
    case "compaction_summary":
      return { ...base, kind: dto.kind, role: dto.kind, content: dto.content };
    case "context":
      return { ...base, kind: dto.kind, role: dto.kind, label: dto.label, content: dto.content };
    case "tool":
      return {
        ...base,
        kind: dto.kind,
        role: dto.kind,
        callId: dto.call_id,
        name: dto.name,
        args: dto.arguments,
        status: dto.status,
        result: dto.result,
        content: "",
      };
    case "tool_calls":
      return { ...base, kind: dto.kind, role: dto.kind, calls: dto.calls, content: "" };
    case "tool_output":
      return {
        ...base,
        kind: dto.kind,
        role: dto.kind,
        callId: dto.call_id,
        output: dto.output,
        content: "",
      };
  }
}

export function evict(messages: ViewMessage[], direction: "oldest" | "newest" = "oldest"): ViewMessage[] {
  if (messages.length <= MAX_CACHE_MESSAGES) return messages;
  // Display order is oldest→newest. Live/newer appends evict the oldest end;
  // prepending an older page evicts the newer end so the window follows the
  // direction the user is browsing. A later refresh can always re-anchor at
  // the newest page.
  return direction === "oldest"
    ? messages.slice(messages.length - MAX_CACHE_MESSAGES)
    : messages.slice(0, MAX_CACHE_MESSAGES);
}

export function replaceAt(state: UiState, index: number, message: ViewMessage): UiState {
  const messages = [...state.messages];
  messages[index] = message;
  return { ...state, messages };
}

/** Index of the live streaming row of the current model round: the trailing
 * streaming row, or - when the transient "正在生成工具调用" row sits at the
 * tail (tool arguments still streaming), the live row right above it - body
 * text belongs to that row, not to a new one below the transient row. */
function streamingTargetIndex(messages: ViewMessage[]): number {
  const isLive = (m: ViewMessage | undefined): boolean =>
    m?.kind === "assistant" && (m.streamingText !== undefined || m.streamingThinking !== undefined);
  const last = messages[messages.length - 1];
  if (isLive(last)) return messages.length - 1;
  if (last?.kind === "tool" && last.status === "generating" && isLive(messages[messages.length - 2])) {
    return messages.length - 2;
  }
  return -1;
}

/** Appends a streamed delta to the current round's live row, creating a new
 * synthetic one whenever no live row is attachable. Two rules keep the live
 * layout in arrival order (and matching the persisted transcript):
 *
 * - The tail must be the current round's live row: a persisted row, the user's
 *   message, tool rows from an earlier round, or an already-closed row all
 *   force a fresh row - attaching to them would render the stream above
 *   content that precedes it.
 * - Thinking never merges into a row whose body text already streamed: a
 *   later reasoning segment opens a new row below that text (the TUI likewise
 *   persists each reasoning segment as its own entry below earlier output). */
export function appendStream(state: UiState, which: "text" | "thinking", delta: string): UiState {
  const index = streamingTargetIndex(state.messages);
  const current = index >= 0 ? state.messages[index] : undefined;
  if (current && !(which === "thinking" && current.streamingText !== undefined)) {
    const next = {
      ...current,
      streamingText: which === "text" ? (current.streamingText ?? "") + delta : current.streamingText,
      streamingThinking: which === "thinking" ? (current.streamingThinking ?? "") + delta : current.streamingThinking,
    };
    return { ...replaceAt(state, index, next), busy: true };
  }
  const synthSeq = state.synthSeq + 1;
  const created: ViewMessage = {
    key: `syn-${synthSeq}`,
    id: -synthSeq,
    kind: "assistant",
    role: "assistant",
    content: "",
    createdAt: new Date(0).toISOString(),
    streamingText: which === "text" ? delta : undefined,
    streamingThinking: which === "thinking" ? delta : undefined,
  };
  return { ...state, synthSeq, messages: evict([...state.messages, created]), busy: true };
}

/** Merges in-flight streaming into `content`/`thinking` (used when a round
 * closes or the turn ends). The reasoning is kept on the row - collapsed in
 * the thinking panel - instead of vanishing until the terminal refetch. */
function closeRow(m: ViewMessage): ViewMessage {
  return {
    ...m,
    content: m.content + (m.streamingText ?? ""),
    thinking: m.thinking ?? m.streamingThinking,
    streamingText: undefined,
    streamingThinking: undefined,
  };
}

/** Closes every row that still carries in-flight streaming flags (text folded
 * into `content`, reasoning into `thinking`). Invoked at each round boundary so
 * exactly one round's rows stay live: later deltas open fresh rows below, and
 * the "live thinking" highlight can never resurrect an earlier round's panel. */
export function closeLiveRows(state: UiState): UiState {
  let changed = false;
  const messages = state.messages.map((m) => {
    if (m.streamingText === undefined && m.streamingThinking === undefined) return m;
    changed = true;
    return closeRow(m);
  });
  return changed ? { ...state, messages } : state;
}

/** Merges every in-flight streaming row (used when the turn ends). */
export function flushStreaming(state: UiState): UiState {
  const messages = state.messages.map((m) => {
    if (!m.streamingText && !m.streamingThinking) return m;
    return closeRow(m);
  });
  return { ...state, messages };
}

/** Removes the transient "正在生成工具调用" rows (replaced by the transcript). */
export function dropGeneratingRows(state: UiState): UiState {
  const messages = state.messages.filter((m) => !(m.kind === "tool" && m.status === "generating"));
  return messages.length === state.messages.length ? state : { ...state, messages };
}

/** Removes the trailing optimistic user-echo row - its submit was rejected,
 * so the message never reached the server. An echo that streamed content
 * already follows is kept: that submit was accepted (only its response was
 * lost) and the terminal refetch will replace it with the persisted row. */
export function dropTrailingUserEcho(state: UiState): UiState {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.kind !== "user" || last.id >= 0) return state;
  return { ...state, messages: state.messages.slice(0, -1) };
}

/** Creates or updates the single transient "正在生成工具调用" row. */
export function upsertGeneratingRow(state: UiState, name: string): UiState {
  const messages = [...state.messages];
  const last = messages[messages.length - 1];
  if (last && last.kind === "tool" && last.status === "generating") {
    messages[messages.length - 1] = { ...last, name };
    return { ...state, messages };
  }
  const synthSeq = state.synthSeq + 1;
  const toolMsg: ViewMessage = {
    key: `syn-tool-stream-${synthSeq}`,
    id: -synthSeq,
    kind: "tool",
    role: "tool",
    name,
    status: "generating",
    content: "",
    createdAt: new Date(0).toISOString(),
  };
  return { ...state, synthSeq, messages: evict([...messages, toolMsg]) };
}

/** Finds a synthetic or persisted tool message by call id. */
export function findToolIndex(state: UiState, callId: string): number {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const m = state.messages[i];
    if ((m.callId && m.callId === callId) || (m.calls?.some((c) => c.id === callId))) return i;
  }
  return -1;
}

/** UTF-8 byte length of a string (browser/node-safe). */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Estimated token cost of freshly streamed content, mirroring the core's
 * `estimate_context_tokens` (ceil(bytes / 4), min 1). Used to overlay live
 * context growth between authoritative `context_updated` anchors. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(utf8Bytes(text) / 4));
}

