import type {
  ApprovalDto,
  AppSnapshotV2,
  ContextBudgetDto,
  Envelope,
  MessageDto,
  MessagePage,
  PartialDto,
  ProviderSettingsDto,
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
  /** Context capacity of the active session (from snapshot / context_updated). */
  context: ContextBudgetDto | null;
  /** Persisted incomplete answer of the active session (survives a restart). */
  assistantPartial: PartialDto | null;
  usage: UsageInfo | null;
  activity: ActivityState;
  /** Latest live status of background (non-active) sessions, for the tree. */
  backgroundStatus: Record<string, string>;
  /** Provider settings view (active + saved profiles, connected presets);
   * fetched when the settings dialog opens and after each apply. */
  providerSettings: ProviderSettingsDto | null;
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
  | { type: "providerSettings"; settings: ProviderSettingsDto }
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
  context: null,
  assistantPartial: null,
  usage: null,
  activity: { kind: "idle", text: "就绪" },
  backgroundStatus: {},
  providerSettings: null,
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

/** Removes the transient "正在生成工具调用" rows (replaced by the transcript). */
function dropGeneratingRows(state: UiState): UiState {
  const messages = state.messages.filter((m) => !(m.kind === "tool" && m.status === "generating"));
  return messages.length === state.messages.length ? state : { ...state, messages };
}

/** Creates or updates the single transient "正在生成工具调用" row. */
function upsertGeneratingRow(state: UiState, name: string): UiState {
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
  return { ...state, synthSeq, messages: [...messages, toolMsg] };
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
        context: s.context,
        assistantPartial: s.assistant_partial,
        snapshotDirty: false,
        // Transcript is authoritative from the server for the current session;
        // when the session changed or after a resync, drop the cache.
        transcriptDirty: state.transcriptDirty || sessionChanged,
        messages: sessionChanged ? [] : state.messages,
        nextBefore: sessionChanged ? null : state.nextBefore,
        hasMore: sessionChanged ? false : state.hasMore,
        // Per-session view state resets when switching sessions.
        usage: sessionChanged ? null : state.usage,
        activity: sessionChanged ? { kind: "idle", text: "就绪" } : state.activity,
        backgroundStatus: sessionChanged ? {} : state.backgroundStatus,
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

    case "providerSettings":
      return { ...state, providerSettings: action.settings };

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
      const isActive = envelope.session_id === state.activeSession;

      /** Global events (approval, session changes, resync) always process. */
      const global = (fn: (s: UiState) => UiState): UiState => fn(base);
      /** Session-local events mutate the active session's view only; for a
       * background session they just update the tree's per-session status. */
      const local = (fn: (s: UiState) => UiState, bg: string): UiState => {
        if (isActive) return fn(base);
        if (!bg) return base;
        return {
          ...base,
          backgroundStatus: {
            ...base.backgroundStatus,
            [envelope.session_id]: bg,
          },
        };
      };

      switch (event.type) {
        case "reasoning_delta":
          return local(
            (s) => ({ ...appendStream(s, "thinking", str("delta")), activity: { kind: "thinking", text: "正在思考" } }),
            "正在思考",
          );
        case "reasoning_completed":
          // Thinking phase over; collapse the live thinking panel (the next
          // text/tool event sets the precise activity).
          return local(
            (s) => ({ ...s, activity: { kind: "generating", text: "正在生成回复" }, status: "" }),
            "正在生成回复",
          );
        case "model_streaming":
          return local(
            (s) => ({
              ...s,
              busy: true,
              status: "",
              activity: { kind: "thinking", text: "模型响应中" },
            }),
            "正在思考",
          );
        case "provider_retry":
          return local(
            (s) => ({
              ...s,
              busy: true,
              status: `重试（${num("attempt")}）…`,
              activity: { kind: "retry", text: `重试（${num("attempt")}）` },
            }),
            `重试（${num("attempt")}）…`,
          );
        case "text_delta":
          return local(
            (s) => ({ ...appendStream(s, "text", str("delta")), activity: { kind: "generating", text: "正在生成回复" } }),
            "正在生成回复",
          );
        case "web_search_started":
          return local(
            (s) => ({ ...s, status: `正在搜索：${str("query")}`, busy: true }),
            `正在搜索：${str("query")}`,
          );
        case "web_search_result":
          return local(
            (s) => ({ ...s, status: `搜索结果：${str("title")}` }),
            `搜索结果：${str("title")}`,
          );
        case "web_search_completed":
          return local(
            (s) => ({ ...s, status: `搜索完成（${num("count")} 条）` }),
            `搜索完成（${num("count")} 条）`,
          );
        case "tool_call_streaming": {
          const name = str("name") || "工具调用";
          return local(
            (s) => ({
              ...upsertGeneratingRow(s, name),
              busy: true,
              status: `正在生成工具调用：${name}…`,
              activity: { kind: "tool_call", text: "正在生成工具调用" },
            }),
            `正在生成工具调用：${name}…`,
          );
        }
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
          return local(
            (s) => ({
              ...s,
              synthSeq,
              busy: true,
              status: `正在执行工具：${c.name}`,
              activity: { kind: "tool_run", text: "正在执行工具" },
              messages: [...dropGeneratingRows(s).messages, toolMsg],
            }),
            `正在执行工具：${c.name}`,
          );
        }
        case "tool_finished": {
          const c = call();
          const result = str("result");
          const index = findToolIndex(base, c.id);
          if (index >= 0) {
            const current = base.messages[index];
            const updated: ViewMessage = { ...current, status: "done", result };
            return local(
              (s) => ({
                ...replaceAt(s, index, updated),
                busy: true,
                status: `工具完成：${c.name}`,
                activity: { kind: "tool_run", text: "工具执行完成" },
              }),
              `工具完成：${c.name}`,
            );
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
          return local(
            (s) => ({
              ...s,
              synthSeq,
              busy: true,
              status: `工具完成：${c.name}`,
              activity: { kind: "tool_run", text: "工具执行完成" },
              messages: [...s.messages, toolMsg],
            }),
            `工具完成：${c.name}`,
          );
        }
        case "approval": {
          const sourceSession = (event.source_session_id as string | null) ?? "";
          const approval: ApprovalDto = {
            approval_id: str("approval_id"),
            session_id: sourceSession,
            call: call(),
            reason: str("reason"),
            source_session_id: event.source_session_id as string | null,
            source_title: event.source_title as string | null,
            created_at_ms: 0,
          };
          return global((s) => ({
            ...s,
            approval,
            activity: { kind: "approval", text: "等待审批" },
            backgroundStatus: sourceSession
              ? { ...s.backgroundStatus, [sourceSession]: "等待审批" }
              : s.backgroundStatus,
          }));
        }
        case "approval_resolved": {
          const sourceSession = envelope.session_id;
          if (base.approval?.approval_id === str("approval_id")) {
            return global((s) => {
              const label = event.approved ? "已允许" : "已拒绝";
              return {
                ...s,
                approval: null,
                status: label,
                activity: { kind: "approval", text: label },
                backgroundStatus: sourceSession
                  ? { ...s.backgroundStatus, [sourceSession]: label }
                  : s.backgroundStatus,
              };
            });
          }
          return base;
        }
        case "usage": {
          const inputTokens = num("input_tokens");
          const outputTokens = num("output_tokens");
          const totalTokens = num("total_tokens");
          return local(
            (s) => ({
              ...s,
              usage: { inputTokens, outputTokens, totalTokens },
              status: `Tokens: ${totalTokens}`,
            }),
            `Tokens: ${totalTokens}`,
          );
        }
        case "context_updated": {
          const budget = event.budget as unknown as ContextBudgetDto;
          return local((s) => ({ ...s, context: budget }), "");
        }
        case "completed":
          return local(
            (s) => ({
              ...dropGeneratingRows(flushStreaming(s)),
              busy: false,
              status: "",
              activity: { kind: "completed", text: "已完成" },
              transcriptDirty: true,
            }),
            "已完成",
          );
        case "failed":
          return local(
            (s) => ({
              ...dropGeneratingRows(flushStreaming(s)),
              busy: false,
              status: "",
              activity: { kind: "failed", text: "请求失败" },
              lastError: str("error"),
              transcriptDirty: true,
            }),
            "请求失败",
          );
        case "cancelled":
          return local(
            (s) => ({
              ...dropGeneratingRows(flushStreaming(s)),
              busy: false,
              status: "",
              activity: { kind: "cancelled", text: "已取消" },
              transcriptDirty: true,
            }),
            "已取消",
          );
        case "sessions_changed":
          return global((s) => ({ ...s, snapshotDirty: true }));
        case "child_session_progress": {
          const childSession = str("child_session_id");
          const label = `子会话 ${str("status")}（${num("turn")}/${num("max_turns")}）`;
          const withChild = (s: UiState): UiState =>
            childSession ? { ...s, backgroundStatus: { ...s.backgroundStatus, [childSession]: label } } : s;
          // Always record the child's live progress for the tree, even when
          // the owning parent is a background session.
          return withChild(local((s) => ({ ...s, status: label }), label));
        }
        case "local_command_finished":
          return local(
            (s) => ({ ...s, status: `命令完成：${str("command")}` }),
            `命令完成：${str("command")}`,
          );
        case "compaction_started":
          return local(
            (s) => ({
              ...s,
              status: "上下文压缩中…",
              busy: true,
              activity: { kind: "compacting", text: "上下文压缩中" },
            }),
            "上下文压缩中…",
          );
        case "compaction_completed":
          return local(
            (s) => ({
              ...s,
              status: `已压缩（隐藏 ${num("hidden")} 条）`,
              busy: false,
              activity: { kind: "compacting", text: "上下文压缩完成" },
              transcriptDirty: true,
            }),
            `已压缩（隐藏 ${num("hidden")} 条）`,
          );
        case "compaction_failed":
          return local(
            (s) => ({
              ...s,
              status: `压缩失败：${str("error")}`,
              busy: false,
              activity: { kind: "compacting", text: "上下文压缩失败" },
            }),
            `压缩失败：${str("error")}`,
          );
        case "todo_updated": {
          const tasks = event.tasks as unknown as TodoTask[];
          const todos: TodoDto[] = tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            created_at: t.created_at,
            updated_at: t.updated_at,
          }));
          return local((s) => ({ ...s, todos }), "任务清单已更新");
        }
        case "transcript_invalidated":
          if (!isActive) return base;
          return { ...base, transcriptDirty: true };
        case "resync_required":
          return global((s) => ({ ...s, snapshotDirty: true, transcriptDirty: true }));
        default:
          // Unknown/ignored event type: tolerate additive protocol growth.
          return base;
      }
    }
  }
}
