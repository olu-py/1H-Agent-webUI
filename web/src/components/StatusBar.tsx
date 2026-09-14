import type { ActivityState, UsageInfo } from "../state/reducer";
import type { ContextBudgetDto } from "../types";

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 1_000_000)}m`;
  if (tokens >= 1_000) return `${Math.floor(tokens / 1_000)}k`;
  return String(tokens);
}

/** Window-source badge labels (`ContextBudgetDto.window_source`). `config`
 * is the explicit user setting — authoritative, no badge. The others are
 * discovered/resolved tiers and mark the window as an estimate. */
const SOURCE_LABELS: Record<string, string> = {
  provider: "接口",
  community: "社区",
  registry: "注册表",
  unknown: "未知",
};

/** Context capacity of the active session, rendered as a small progress ring.
 * `overlayTokens` is the frontend's live estimate of tokens streamed since the
 * last authoritative `context_updated`; it is layered on `used_tokens` so the
 * ring grows during generation instead of only at round boundaries. The ring
 * carries no inline text — the hover title reveals the full detail. */
function contextView(context: ContextBudgetDto | null, overlayTokens: number): {
  detail: string;
  percent: number | null;
  tone: "ok" | "warn" | "danger" | "";
} {
  if (!context) return { detail: "", percent: null, tone: "" };
  const used = Number(context.used_tokens) + overlayTokens;
  const limit =
    context.context_window_tokens != null ? Number(context.context_window_tokens) : null;
  const reserve = Number(context.output_reserve_tokens);
  const safe =
    limit != null ? Math.max(0, limit - reserve - used) : null;
  const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const source = String(context.window_source ?? "unknown");
  const segments: string[] = [percent != null ? `上下文 ${percent}%` : "上下文"];
  segments.push(
    limit != null
      ? `已用 ${compactTokens(used)} / ${compactTokens(limit)}`
      : `已用 ${compactTokens(used)}`,
  );
  if (safe != null) segments.push(`可用 ${compactTokens(safe)}`);
  if (source !== "config") segments.push(`窗口来源：${SOURCE_LABELS[source] ?? source}`);
  if (context.estimated || overlayTokens > 0) segments.push("（估算）");
  const detail = segments.join(" · ");
  const tone = percent == null ? "" : percent >= 95 ? "danger" : percent >= 85 ? "warn" : "ok";
  return { detail, percent, tone };
}

/** Ring geometry: SVG viewBox 20×20 with r=8, so the full circumference is
 * 2πr ≈ 50.27 user units; the dash offset is derived from the percentage. */
const CONTEXT_RING_R = 8;
const CONTEXT_RING_C = 2 * Math.PI * CONTEXT_RING_R;

/**
 * Merged status bar: activity indicator, context progress ring (tiered at
 * 85%/95%, hover shows the full detail), token usage, an optional status
 * line, and the composer keyboard shortcuts pinned to the bottom-right. Replaces the old separate `.status`
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
        {ctx.detail ? (
          <span
            className={`context-meter ${ctx.tone}`}
            title={ctx.detail}
            role="progressbar"
            aria-label={ctx.percent != null ? `上下文 ${ctx.percent}%` : "上下文"}
            aria-valuenow={ctx.percent ?? undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <svg className="context-ring" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
              <circle className="context-ring-track" cx="10" cy="10" r={CONTEXT_RING_R} />
              {ctx.percent != null && ctx.percent > 0 ? (
                <circle
                  className="context-ring-fill"
                  cx="10"
                  cy="10"
                  r={CONTEXT_RING_R}
                  strokeDasharray={`${CONTEXT_RING_C} ${CONTEXT_RING_C}`}
                  strokeDashoffset={CONTEXT_RING_C * (1 - ctx.percent / 100)}
                  transform="rotate(-90 10 10)"
                />
              ) : null}
            </svg>
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
