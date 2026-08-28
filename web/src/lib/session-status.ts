/** Status text to show next to a session in a list (sidebar tree / home
 * cards). The plain "就绪" ready marker is idle noise on parked sessions —
 * only the active session carries it (it confirms the switch); other sessions
 * keep live/error statuses (搜索中、请求失败、需要配置提供商…) but never the
 * bare ready label. Exact match on "就绪" so compound/error-ish states like
 * "就绪，但刷新会话失败" are not hidden. */
export function sessionListStatus(status: string, isActive: boolean): string {
  if (!status) return "";
  return isActive || status !== "就绪" ? status : "";
}
