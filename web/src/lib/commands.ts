/**
 * Single source of truth for palette commands, shared by the Ctrl/Cmd+K
 * modal palette (`components/CommandPalette`) and the composer slash popup
 * (`components/Composer`, the Codex-CLI-style inline popup). Both surfaces
 * render the same registry through `components/CommandList`, so a command
 * can never exist in one surface but not the other.
 *
 * The command strings must stay in sync with the core command parser
 * (`/help` output is the ground truth); the mode group derives from
 * `AGENT_MODES` and is never hardcoded twice.
 */
import { AGENT_MODES, modeCommand } from "./modes";

export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  command: string;
  /** When set, an argument input is shown; `required` blocks empty submits. */
  argument?: { placeholder: string; required?: boolean };
  /** Destructive operations require a confirmation step. */
  destructive?: boolean;
  /** Extra searchable text (e.g. the command with its slash prefix). */
  keywords: string;
  /** Local UI action: opens a view instead of running a core command. The
   * `command` string stays as the display chip only. */
  local?: "provider-settings";
}

export interface PaletteGroup {
  id: string;
  label: string;
  commands: PaletteCommand[];
}

export const COMMAND_GROUPS: PaletteGroup[] = [
  {
    id: "session",
    label: "会话",
    commands: [
      { id: "help", label: "帮助", description: "显示可用命令和输入语法", command: "/help", keywords: "/help h" },
      { id: "new", label: "新建会话", description: "创建并切换到一个新会话", command: "/new", keywords: "/new n" },
      { id: "rename", label: "重命名会话", description: "重命名当前会话", command: "/rename", keywords: "/rename", argument: { placeholder: "新标题" } },
      { id: "delete", label: "删除会话", description: "删除当前会话；若删除最后一个会话会自动新建空白会话", command: "/delete", keywords: "/delete rm", destructive: true },
      { id: "fork", label: "分支当前会话", description: "从当前历史创建一个新分支会话", command: "/fork", keywords: "/fork" },
    ],
  },
  {
    id: "history",
    label: "历史与上下文",
    commands: [
      { id: "undo", label: "撤销", description: "将当前会话回退一轮", command: "/undo", keywords: "/undo", destructive: true },
      { id: "redo", label: "重做", description: "恢复已撤销的一轮", command: "/redo", keywords: "/redo", destructive: true },
      { id: "compact", label: "压缩上下文", description: "总结较早历史以释放上下文空间", command: "/compact", keywords: "/compact summarize", argument: { placeholder: "保留说明（可选）" } },
      { id: "uncompact", label: "恢复压缩", description: "恢复最近一次压缩前的历史", command: "/uncompact", keywords: "/uncompact decompact", destructive: true },
      { id: "export", label: "导出会话", description: "将当前会话导出为工作区内 Markdown", command: "/export", keywords: "/export", argument: { placeholder: "工作区内路径（可选）" } },
      { id: "diff", label: "查看改动", description: "显示 workspace 中的未提交改动", command: "/diff", keywords: "/diff" },
    ],
  },
  {
    id: "mode",
    label: "模式",
    // Modes derive from the single AGENT_MODES source (never hardcoded twice).
    commands: AGENT_MODES.map((m) => ({
      id: `mode-${m.key}`,
      label: `${m.label}模式`,
      description: m.description,
      command: modeCommand(m.key),
      keywords: `${modeCommand(m.key)} ${m.label}`,
    })),
  },
  {
    id: "model",
    label: "模型",
    commands: [
      { id: "model", label: "当前模型", description: "显示当前模型；可指定新模型", command: "/model", keywords: "/model", argument: { placeholder: "模型名（可选）" } },
      {
        id: "provider",
        label: "Provider 设置",
        description: "打开 Provider 与模型选择（密钥经环境变量/系统钥匙串配置，不进界面）",
        command: "/provider",
        keywords: "/provider provider 供应商",
        local: "provider-settings",
      },
      { id: "agent", label: "当前 Agent", description: "显示当前 Agent 模式；可指定新 Agent", command: "/agent", keywords: "/agent", argument: { placeholder: "Agent（可选）" } },
    ],
  },
  {
    id: "todo",
    label: "任务",
    commands: [
      { id: "todo-show", label: "任务清单", description: "查看当前会话任务", command: "/todo", keywords: "/todo todos" },
      { id: "todo-add", label: "添加任务", description: "向当前会话添加一项任务", command: "/todo add", keywords: "/todo add 添加", argument: { placeholder: "任务标题", required: true } },
      { id: "todo-clear", label: "清空任务", description: "清空当前会话全部任务", command: "/todo clear", keywords: "/todo clear 清空", destructive: true },
    ],
  },
];

/** One scored match: group is kept for the grouped rendering. */
export interface CommandMatch {
  group: PaletteGroup;
  command: PaletteCommand;
  score: number;
}

/** Ordered-subsequence fuzzy match scoring, mirroring the core palette. */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const c = candidate.toLowerCase();
  let position = 0;
  let score = 0;
  let previous: number | null = null;
  for (const ch of q) {
    const found = c.indexOf(ch, position);
    if (found < 0) return null;
    score += found - (previous ?? 0);
    if (found === 0 || c[found - 1] === " ") score -= 2;
    previous = found;
    position = found + ch.length;
  }
  return score + (c.length - q.length);
}

/** Filter+score the whole registry for a query; an empty query lists every
 * command in registry order (the sort is stable, so ties keep that order). */
export function filterCommands(query: string): CommandMatch[] {
  const scored: CommandMatch[] = [];
  for (const group of COMMAND_GROUPS) {
    for (const command of group.commands) {
      const score = fuzzyScore(query, `${command.label} ${command.keywords}`);
      if (score !== null) scored.push({ group, command, score });
    }
  }
  return scored.sort((a, b) => a.score - b.score);
}

/**
 * Slash state of the composer text, mirroring the Codex CLI popup trigger:
 * the popup is active only while the whole input is `/` plus one non-space
 * token (line start, no spaces). Mid-text or spaced tokens never trigger it
 * — the same invalid-activation guard as Codex PR #7704. Returns the filter
 * query (text after the slash) or null when inactive.
 */
export function slashCommandToken(text: string): { query: string } | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? { query: match[1] } : null;
}

/** Full command string for execution: joins the argument when present. */
export function buildCommand(command: PaletteCommand, arg = ""): string {
  return command.argument
    ? `${command.command} ${arg.trim()}`.trimEnd()
    : command.command;
}
