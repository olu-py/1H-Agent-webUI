// Command completion: mirrors the server's `commands::fuzzy_score` ordered
// subsequence scoring so the dropdown behaves like the TUI palette.

const COMMANDS = [
  { cmd: '/help', label: '帮助', desc: '显示可用命令' },
  { cmd: '/new', label: '新建会话', desc: '创建并切换到新会话' },
  { cmd: '/rename', label: '重命名', desc: '重命名当前会话' },
  { cmd: '/delete', label: '删除会话', desc: '删除当前会话' },
  { cmd: '/fork', label: '分支会话', desc: '从当前历史创建分支' },
  { cmd: '/undo', label: '撤销', desc: '回退一轮' },
  { cmd: '/redo', label: '重做', desc: '恢复已撤销的一轮' },
  { cmd: '/compact', label: '压缩上下文', desc: '总结较早历史' },
  { cmd: '/uncompact', label: '恢复压缩', desc: '恢复最近一次压缩' },
  { cmd: '/export', label: '导出', desc: '导出为 Markdown' },
  { cmd: '/todo', label: '任务清单', desc: 'add/doing/done/undo/edit/remove/clear' },
  { cmd: '/diff', label: '查看改动', desc: '显示未提交改动' },
  { cmd: '/model', label: '当前模型', desc: '显示/设置模型' },
  { cmd: '/provider', label: 'Provider', desc: 'Provider 设置' },
  { cmd: '/agent', label: '当前 Agent', desc: '显示/设置 Agent 模式' },
  { cmd: '/plan', label: '计划模式', desc: '切换到计划模式' },
  { cmd: '/build', label: '构建模式', desc: '切换到构建模式' },
  { cmd: '/explore', label: '探索模式', desc: '切换到探索模式' },
  { cmd: '/cluster', label: '集群模式', desc: '切换到集群模式' },
  { cmd: '/clear', label: '清空显示', desc: '清空屏幕显示' },
];

export function fuzzyScore(query, candidate) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const c = candidate.toLowerCase();
  let position = 0;
  let score = 0;
  let previous = null;
  for (const ch of q) {
    const offset = c.slice(position).indexOf(ch);
    if (offset === -1) return null;
    const found = position + offset;
    score += found - (previous ?? 0);
    if (found === 0 || c[found - 1] === ' ') score -= 2;
    previous = found;
    position = found + 1;
  }
  return score + (c.length - q.length);
}

export function matchCommands(query, limit = 8) {
  const results = [];
  for (const item of COMMANDS) {
    const scores = [fuzzyScore(query, item.label), fuzzyScore(query, item.cmd)]
      .filter((s) => s !== null);
    if (!scores.length) continue;
    const score = Math.min(...scores);
    results.push({ ...item, score });
  }
  results.sort((a, b) => a.score - b.score || a.cmd.localeCompare(b.cmd));
  return results.slice(0, limit);
}
