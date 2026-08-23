import type {
  ApprovalDto,
  AppSnapshotV2,
  Envelope,
  MessageDto,
  MessagePage,
  SessionStateDto,
  TodoDto,
  TodoTask,
  ToolCall,
} from "../types";

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
  label?: string;
  callId?: string;
  name?: string;
  args?: unknown;
  status?: string;
  result?: string | null;
  calls?: ToolCall[];
  output?: string;
  createdAt: string;
  /** In-flight streamed text not yet persisted by the server. */
  streamingText?: string;
  /** In-flight streamed reasoning. */
  streamingThinking?: string;
}

export interface UiState {
  protocolVersion: number;
  cursor: number;
  connected: boolean;
  activeSession: string | null;
  sessions: SessionStateDto[];
  provider: string;
  model: string;
  mode: string;
  approval: ApprovalDto | null;
  todos: TodoDto[];
  messages: ViewMessage[];
  nextBefore: number | null;
  hasMore: boolean;
  status: string;
  busy: boolean;
  lastError: string | null;
  snapshotDirty: boolean;
  transcriptDirty: boolean;
  synthSeq: number;
}

export type Action =
  | { type: "snapshot"; snapshot: AppSnapshotV2 }
  | { type: "messages"; page: MessagePage; replace: boolean }
  | { type: "event"; envelope: Envelope }
  | { type: "connected"; connected: boolean }
  | { type: "clearTranscript" }
  | { type: "error"; message: string }
  | { type: "clearError" };

export const initialState: UiState = {
  protocolVersion: 0,
  cursor: 0,
  connected: false,
  activeSession: null,
  sessions: [],
  provider: "",
  model: "",
  mode: "",
  approval: null,
  todos: [],
  messages: [],
  nextBefore: null,
  hasMore: false,
  status: "",
  busy: false,
  lastError: null,
  snapshotDirty: false,
  transcriptDirty: false,
  synthSeq: 0,
};

export function toViewMessage(dto: MessageDto): ViewMessage {
  const base = { key: `m-${dto.id}`, id: dto.id, createdAt: dto.created_at, content: "" };
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

function evict(messages: ViewMessage[]): ViewMessage[] {
  if (messages.length <= MAX_CACHE_MESSAGES) return messages;
  // Trim oldest (the tail, since display order is oldest→newest).
  return messages.slice(messages.length - MAX_CACHE_MESSAGES);
}

function replaceAt(state: UiState, index: number, message: ViewMessage): UiState {
  const messages = [...state.messages];
  messages[index] = message;
  return { ...state, messages };
}

/** Appends a streamed delta to the last assistant message, creating a
 * synthetic one when the session has not produced any assistant message yet. */
function appendStream(state: UiState, which: "text" | "thinking", delta: string): UiState {
  let index = state.messages.length - 1;
  while (index >= 0 && state.messages[index].kind !== "assistant") index -= 1;
  if (index >= 0) {
    const current = state.messages[index];
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
  return { ...state, synthSeq, messages: [...state.messages, created], busy: true };
}

/** Merges in-flight streaming into `content` (used when the turn ends). */
function flushStreaming(state: UiState): UiState {
  const messages = state.messages.map((m) => {
    if (!m.streamingText && !m.streamingThinking) return m;
    return {
      ...m,
      content: m.content + (m.streamingText ?? ""),
      streamingText: undefined,
      streamingThinking: undefined,
    };
  });
  return { ...state, messages };
}

/** Finds a synthetic or persisted tool message by call id. */
function findToolIndex(state: UiState, callId: string): number {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const m = state.messages[i];
    if ((m.callId && m.callId === callId) || (m.calls?.some((c) => c.id === callId))) return i;
  }
  return -1;
}

export function reduce(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "snapshot": {
      const s = action.snapshot;
      const sessionChanged = s.active_session !== state.activeSession;
      return {
        ...state,
        protocolVersion: s.protocol_version,
        cursor: s.event_cursor,
        activeSession: s.active_session,
        sessions: s.sessions,
        provider: s.provider,
        model: s.model,
        mode: s.mode,
        approval: s.approval,
        todos: s.todos,
        snapshotDirty: false,
        // Transcript is authoritative from the server for the current session;
        // when the session changed or after a resync, drop the cache.
        transcriptDirty: state.transcriptDirty || sessionChanged,
        messages: sessionChanged ? [] : state.messages,
        nextBefore: sessionChanged ? null : state.nextBefore,
        hasMore: sessionChanged ? false : state.hasMore,
      };
    }

    case "messages": {
      const fresh = action.page.messages.map(toViewMessage);
      const messages = action.replace
        ? evict(fresh)
        : evict([...fresh, ...state.messages]);
      return {
        ...state,
        messages,
        nextBefore: action.page.next_before,
        hasMore: action.page.has_more,
        transcriptDirty: false,
      };
    }

    case "clearTranscript":
      return {
        ...state,
        messages: [],
        nextBefore: null,
        hasMore: false,
        transcriptDirty: false,
      };

    case "connected":
      return { ...state, connected: action.connected };

    case "error":
      return { ...state, lastError: action.message, busy: false };

    case "clearError":
      return { ...state, lastError: null };

    case "event": {
      const envelope = action.envelope;
      const event = envelope as unknown as { type: string; [k: string]: unknown };
      const base: UiState = { ...state, cursor: envelope.cursor };
      const str = (key: string): string => String(event[key] ?? "");
      const num = (key: string): number => Number(event[key] ?? 0);
      const call = (): ToolCall => event.call as unknown as ToolCall;
      switch (event.type) {
        case "text_delta":
          return appendStream(base, "text", str("delta"));
        case "reasoning_delta":
          return appendStream(base, "thinking", str("delta"));
        case "model_streaming":
          return { ...base, busy: true, status: "模型响应中…" };
        case "provider_retry":
          return { ...base, status: `重试（${num("attempt")}）…` };
        case "web_search_started":
          return { ...base, status: `正在搜索：${str("query")}` };
        case "web_search_result":
          return { ...base, status: `搜索结果：${str("title")}` };
        case "web_search_completed":
          return { ...base, status: `搜索完成（${num("count")} 条）` };
        case "tool_started": {
          const c = call();
          const synthSeq = base.synthSeq + 1;
          const toolMsg: ViewMessage = {
            key: `syn-tool-${synthSeq}`,
            id: -synthSeq,
            kind: "tool",
            role: "tool",
            callId: c.id,
            name: c.name,
            args: c.arguments,
            status: "running",
            content: "",
            createdAt: new Date(0).toISOString(),
          };
          return {
            ...base,
            synthSeq,
            busy: true,
            status: `正在执行工具：${c.name}`,
            messages: [...base.messages, toolMsg],
          };
        }
        case "tool_finished": {
          const c = call();
          const result = str("result");
          const index = findToolIndex(base, c.id);
          if (index >= 0) {
            const current = base.messages[index];
            const updated: ViewMessage = { ...current, status: "done", result };
            return { ...replaceAt(base, index, updated), busy: true, status: `工具完成：${c.name}` };
          }
          const synthSeq = base.synthSeq + 1;
          const toolMsg: ViewMessage = {
            key: `syn-tool-${synthSeq}`,
            id: -synthSeq,
            kind: "tool",
            role: "tool",
            callId: c.id,
            name: c.name,
            args: c.arguments,
            status: "done",
            result,
            content: "",
            createdAt: new Date(0).toISOString(),
          };
          return {
            ...base,
            synthSeq,
            busy: true,
            status: `工具完成：${c.name}`,
            messages: [...base.messages, toolMsg],
          };
        }
        case "approval": {
          return {
            ...base,
            approval: {
              approval_id: str("approval_id"),
              session_id: (event.source_session_id as string | null) ?? "",
              call: call(),
              reason: str("reason"),
              source_session_id: event.source_session_id as string | null,
              source_title: event.source_title as string | null,
              created_at_ms: 0,
            } satisfies ApprovalDto,
          };
        }
        case "approval_resolved": {
          if (base.approval?.approval_id === str("approval_id")) {
            return { ...base, approval: null, status: event.approved ? "已允许" : "已拒绝" };
          }
          return base;
        }
        case "usage":
          return { ...base, status: `Tokens: ${num("total_tokens")}` };
        case "completed":
          return {
            ...flushStreaming(base),
            busy: false,
            status: "",
            transcriptDirty: true,
          };
        case "failed":
          return {
            ...flushStreaming(base),
            busy: false,
            status: "",
            lastError: str("error"),
            transcriptDirty: true,
          };
        case "cancelled":
          return {
            ...flushStreaming(base),
            busy: false,
            status: "",
            transcriptDirty: true,
          };
        case "sessions_changed":
          return { ...base, snapshotDirty: true };
        case "child_session_progress":
          return {
            ...base,
            status: `子会话 ${str("status")}（${num("turn")}/${num("max_turns")}）`,
          };
        case "local_command_finished":
          return { ...base, status: `命令完成：${str("command")}` };
        case "compaction_started":
          return { ...base, status: "上下文压缩中…", busy: true };
        case "compaction_completed":
          return {
            ...base,
            status: `已压缩（隐藏 ${num("hidden")} 条）`,
            busy: false,
            transcriptDirty: true,
          };
        case "compaction_failed":
          return { ...base, status: `压缩失败：${str("error")}`, busy: false };
        case "todo_updated": {
          const tasks = event.tasks as unknown as TodoTask[];
          const todos: TodoDto[] = tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            created_at: t.created_at,
            updated_at: t.updated_at,
          }));
          return { ...base, todos };
        }
        case "transcript_invalidated":
          return { ...base, transcriptDirty: true };
        case "resync_required":
          return { ...base, snapshotDirty: true, transcriptDirty: true };
        default:
          // Unknown/ignored event type: tolerate additive protocol growth.
          return base;
      }
    }
  }
}
