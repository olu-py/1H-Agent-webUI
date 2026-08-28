import type { ActivityState, UsageInfo } from "../state/reducer";
import type { ContextBudgetDto } from "../types";

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 1_000_000)}m`;
  if (tokens >= 1_000) return `${Math.floor(tokens / 1_000)}k`;
  return String(tokens);
}

/** Context capacity of the active session, plus a tiered progress bar.
 * `overlayTokens` is the frontend's live estimate of tokens streamed since the
 * last authoritative `context_updated`; it is layered on `used_tokens` so the
 * meter grows during generation instead of only at round boundaries. */
function contextView(context: ContextBudgetDto | null, overlayTokens: number): {
  text: string;
  percent: number | null;
  tone: "ok" | "warn" | "danger" | "";
} {
  if (!context) return { text: "", percent: null, tone: "" };
  const used = Number(context.used_tokens) + overlayTokens;
  const limit =
    context.context_window_tokens != null ? Number(context.context_window_tokens) : null;
  const reserve = Number(context.output_reserve_tokens);
  const safe =
    limit != null ? Math.max(0, limit - reserve - used) : null;
  const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const estimate = context.estimated || overlayTokens > 0 ? "（估算）" : "";
  let text: string;
  if (limit != null && safe != null) {
    text = `上下文 ${percent}% 可用${compactTokens(safe)}${estimate}`;
  } else if (limit != null) {
    text = `上下文 ${percent}% ${compactTokens(used)}/${compactTokens(limit)}${estimate}`;
  } else {
    text = `上下文 ${compactTokens(used)}${estimate}`;
  }
  const tone = percent == null ? "" : percent >= 95 ? "danger" : percent >= 85 ? "warn" : "ok";
  return { text, percent, tone };
}

/**
 * Merged status bar: activity indicator, context progress bar (tiered at
 * 85%/95%), token usage, an optional status line, and the composer keyboard
 * shortcuts pinned to the bottom-right. Replaces the old separate `.status`
 * row + ActivityBar. The provider·model summary lives in the composer's
 * provider switcher; the mode badge and SSE "online" indicator were removed
 * (the latter never reflected the real connection state).
 */
export function StatusBar({
  activity,
  context,
  contextOverlayTokens,
  usage,
  status,
}: {
  activity: ActivityState;
  context: ContextBudgetDto | null;
  contextOverlayTokens: number;
  usage: UsageInfo | null;
  status: string;
}) {
  const ctx = contextView(context, contextOverlayTokens);
  return (
    <div className="status-bar">
      <div className="status-bar-inner">
        <span className={`activity ${activity.kind}`} title={activity.text}>
          <span className="activity-dot" />
          <span className="activity-text">{activity.text}</span>
        </span>
        {ctx.text ? (
          <span
            className={`context-meter ${ctx.tone}`}
            title={ctx.text}
            role="progressbar"
            aria-valuenow={ctx.percent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className="context-bar">
              <span
                className="context-bar-fill"
                style={{ width: `${Math.min(100, ctx.percent ?? 0)}%` }}
              />
            </span>
            {ctx.text}
          </span>
        ) : null}
        {usage ? (
          <span className="usage" title={`输入 ${usage.inputTokens} · 输出 ${usage.outputTokens}`}>
            Tokens: {compactTokens(usage.totalTokens)}
          </span>
        ) : null}
        {status ? <span className="activity-text">{status}</span> : null}
        <span className="status-meta">
          <span className="status-hint">
            <span>
              <kbd>Enter</kbd> 发送
            </span>
            <span>
              <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
            </span>
            <span>
              <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> 命令面板
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}
