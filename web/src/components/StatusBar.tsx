import type { ActivityState, UsageInfo } from "../state/reducer";
import type { ContextBudgetDto } from "../types";

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 1_000_000)}m`;
  if (tokens >= 1_000) return `${Math.floor(tokens / 1_000)}k`;
  return String(tokens);
}

/** Context capacity of the active session, plus a tiered progress bar. */
function contextView(context: ContextBudgetDto | null): {
  text: string;
  percent: number | null;
  tone: "ok" | "warn" | "danger" | "";
} {
  if (!context) return { text: "", percent: null, tone: "" };
  const used = Number(context.used_tokens);
  const limit =
    context.context_window_tokens != null ? Number(context.context_window_tokens) : null;
  const safe = context.safe_input_tokens != null ? Number(context.safe_input_tokens) : null;
  const percent = limit ? Math.round((used / limit) * 100) : null;
  const estimate = context.estimated ? "（估算）" : "";
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
  usage,
  status,
}: {
  activity: ActivityState;
  context: ContextBudgetDto | null;
  usage: UsageInfo | null;
  status: string;
}) {
  const ctx = contextView(context);
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
