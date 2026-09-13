/** Status text to show next to a session on the home screen's recent list.
 * The plain "就绪" ready marker is idle noise on parked sessions — only the
 * active session carries it (it confirms the switch); other sessions keep
 * live/error statuses (搜索中、请求失败、需要配置提供商…) but never the bare
 * ready label. Exact match on "就绪" so compound/error-ish states like
 * "就绪，但刷新会话失败" are not hidden. */
export function sessionListStatus(status: string, isActive: boolean): string {
  if (!status) return "";
  return isActive || status !== "就绪" ? status : "";
}

/** Status-light kind for a session row in the sidebar tree. The dot is the
 * only per-session indicator there (no status text), so it has to carry
 * approval, failure and live-work states on its own. Priority:
 * approval > failure > busy flag > live label > idle.
 *
 * Live background labels arrive with streaming events while the snapshot's
 * `busy` flag lags behind, so any label that is not a known terminal or
 * ready-ish marker keeps the dot busy even when `busy` is still false; a
 * failure marker wins over a stale busy flag because the failure label is
 * always the fresher signal. */
const ENDED_LABELS = new Set(["已完成", "已取消", "已允许", "已拒绝"]);

export function sessionDotKind(status: string, busy: boolean, approval: boolean): string {
  if (approval) return "approval";
  const label = status.trim();
  if (label.includes("失败") || label.includes("需要配置")) return "error";
  if (busy) return "busy";
  if (!label || label.endsWith("就绪") || ENDED_LABELS.has(label)) return "";
  return "busy";
}
