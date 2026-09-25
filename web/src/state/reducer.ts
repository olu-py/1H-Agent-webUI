import {
  appendStream,
  closeLiveRows,
  dropGeneratingRows,
  dropTrailingUserEcho,
  estimateTokens,
  evict,
  findToolIndex,
  flushStreaming,
  replaceAt,
  toViewMessage,
  upsertGeneratingRow,
} from "./transcript";
import type { ActivityState, UsageInfo, ViewMessage } from "./transcript";
import { reduceProvider } from "./provider";
import { reduceSnapshot } from "./session";
import { reduceTodoUpdated } from "./todo";
import { childSessionLabel } from "../lib/session-status";

export { MAX_CACHE_MESSAGES, PAGE_SIZE, toViewMessage } from "./transcript";
export type { ActivityKind, ActivityState, UsageInfo, ViewMessage } from "./transcript";
import type {
  ApprovalDto,
  AppSnapshotV2,
  ContextBudgetDto,
  Envelope,
  MessagePage,
  MemoryDto,
  PartialDto,
  ProviderModelsDto,
  ProviderSettingsDto,
  SessionStateDto,
  TodoDto,
  TodoTask,
  ToolCall,
} from "../types";

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
  /** Live-estimated tokens streamed since the last authoritative context
   * refresh (snapshot / context_updated). The meter overlays this on
   * `context.used_tokens` so it grows during generation instead of only at
   * round boundaries; it is zeroed at every authoritative anchor. */
  contextOverlayTokens: number;
  /** Persisted incomplete answer of the active session (survives a restart). */
  assistantPartial: PartialDto | null;
  usage: UsageInfo | null;
  activity: ActivityState;
  /** Latest live status of background (non-active) sessions, for the tree. */
  backgroundStatus: Record<string, string>;
  /** Machine-readable child statuses used for terminal-aware tree indicators. */
  childStatus: Record<string, string>;
  /** Provider settings view (active + saved profiles, connected presets);
   * fetched when the settings dialog opens and after each apply. */
  providerSettings: ProviderSettingsDto | null;
  /** The active provider's model list from the core's metadata cache
   * (`GET /models` + models.dev), for the settings dialog's model picker.
   * Null until first loaded; a fetch failure keeps the previous value (the
   * static preset lists remain the fallback). */
  providerModels: ProviderModelsDto | null;
  memories: MemoryDto[];
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
  | { type: "userEcho"; text: string }
  | { type: "dropUserEcho" }
  | { type: "event"; envelope: Envelope }
  | { type: "connected"; connected: boolean }
  | { type: "clearTranscript" }
  | { type: "providerSettings"; settings: ProviderSettingsDto }
  | { type: "providerModels"; models: ProviderModelsDto }
  | { type: "providerModelsCleared" }
  | { type: "memories"; memories: MemoryDto[] }
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
  contextOverlayTokens: 0,
  assistantPartial: null,
  usage: null,
  activity: { kind: "idle", text: "就绪" },
  backgroundStatus: {},
  childStatus: {},
  providerSettings: null,
  providerModels: null,
  memories: [],
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

export function reduce(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "snapshot": {
      return reduceSnapshot(state, action.snapshot);
    }

    case "messages": {
      const fresh = action.page.messages.map(toViewMessage);
      const messages = action.replace
        ? evict(fresh)
        : evict([...fresh, ...state.messages], "newest");
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

    case "userEcho": {
      // Optimistic echo of an outgoing message, appended before the submit
      // request resolves: the server persists the row on submit but sends no
      // transcript event, and no refetch happens until the turn ends - so
      // without the echo the reply would stream above an invisible question.
      // The post-completion refetch replaces it with the persisted row (same
      // content, same position - no layout shift).
      const synthSeq = state.synthSeq + 1;
      const echo: ViewMessage = {
        key: `syn-user-${synthSeq}`,
        id: -synthSeq,
        kind: "user",
        role: "user",
        content: action.text,
        createdAt: new Date(0).toISOString(),
      };
      return { ...state, synthSeq, messages: evict([...state.messages, echo]) };
    }

    case "dropUserEcho":
      return dropTrailingUserEcho(state);

    case "connected":
      return { ...state, connected: action.connected };

    case "providerSettings":
    case "providerModels":
    case "providerModelsCleared":
      return reduceProvider(state, action);
    case "memories":
      return { ...state, memories: action.memories };

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
          // Round barrier: every previous round's live row is closed here (and
          // any stale generating row dropped) so this round's deltas always
          // open a fresh row below everything that precedes them.
          return local(
            (s) => ({
              ...dropGeneratingRows(closeLiveRows(s)),
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
            (s) => ({
              ...appendStream(s, "text", str("delta")),
              activity: { kind: "generating", text: "正在生成回复" },
              contextOverlayTokens: s.contextOverlayTokens + estimateTokens(str("delta")),
            }),
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
          const toolArgsTokens = estimateTokens(c.name + JSON.stringify(c.arguments ?? ""));
          return local(
            (s) => ({
              ...s,
              synthSeq,
              busy: true,
              status: `正在执行工具：${c.name}`,
              activity: { kind: "tool_run", text: "正在执行工具" },
              contextOverlayTokens: s.contextOverlayTokens + toolArgsTokens,
              messages: evict([...dropGeneratingRows(s).messages, toolMsg]),
            }),
            `正在执行工具：${c.name}`,
          );
        }
        case "tool_finished": {
          const c = call();
          const result = str("result");
          // A finished call ends the argument-streaming phase even when no
          // `tool_started` ever arrived (denied / rejected / duplicate calls) -
          // drop the transient generating row so it cannot linger mid-transcript.
          const cleaned = dropGeneratingRows(base);
          const resultTokens = estimateTokens(result);
          const index = findToolIndex(cleaned, c.id);
          if (index >= 0) {
            const current = cleaned.messages[index];
            const updated: ViewMessage = { ...current, status: "done", result };
            return local(
              (s) => ({
                ...replaceAt(dropGeneratingRows(s), index, updated),
                busy: true,
                status: `工具完成：${c.name}`,
                activity: { kind: "tool_run", text: "工具执行完成" },
                contextOverlayTokens: s.contextOverlayTokens + resultTokens,
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
              contextOverlayTokens: s.contextOverlayTokens + resultTokens,
              messages: evict([...dropGeneratingRows(s).messages, toolMsg]),
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
          return local((s) => ({ ...s, context: budget, contextOverlayTokens: 0 }), "");
        }
        case "completed":
          return local(
            (s) => ({
              ...dropGeneratingRows(flushStreaming(s)),
              busy: false,
              status: "",
              activity: { kind: "completed", text: "已完成" },
              transcriptDirty: true,
              contextOverlayTokens: 0,
              // The turn ended: the refetched transcript is authoritative, so
              // the snapshot's stale partial must not render below the answer.
              assistantPartial: null,
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
              contextOverlayTokens: 0,
              // The half-finished answer is already flushed into the live rows
              // (and persists server-side); appending it again would duplicate.
              assistantPartial: null,
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
              contextOverlayTokens: 0,
              assistantPartial: null,
            }),
            "已取消",
          );
        case "sessions_changed":
          return global((s) => ({ ...s, snapshotDirty: true }));
        case "child_session_progress": {
          const childSession = str("child_session_id");
          const machineStatus = str("status");
          const phase = str("phase");
          const turn = num("turn");
          const maxTurns = num("max_turns");
          const label = childSessionLabel(
            machineStatus,
            phase,
            turn,
            maxTurns,
            typeof event.tool === "string" ? event.tool : null,
          );
          const sessionLabel = machineStatus === "running" ? `子会话：${label}` : label;
          const withChild = (s: UiState): UiState =>
            childSession ? {
              ...s,
              childStatus: { ...s.childStatus, [childSession]: machineStatus },
              backgroundStatus: { ...s.backgroundStatus, [childSession]: label },
            } : s;
          // Always record the child's live progress for the tree, even when
          // the owning parent is a background session.
          return withChild(local((s) => ({ ...s, status: sessionLabel }), sessionLabel));
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
              contextOverlayTokens: 0,
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
              contextOverlayTokens: 0,
            }),
            `压缩失败：${str("error")}`,
          );
        case "todo_updated": {
          const tasks = event.tasks as unknown as TodoTask[];
          return local((s) => reduceTodoUpdated(s, tasks), "任务清单已更新");
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
