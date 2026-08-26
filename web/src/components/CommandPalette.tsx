import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatActions } from "../hooks";
import { AGENT_MODES, modeCommand } from "../lib/modes";
import { Icon } from "./icons";

interface PaletteCommand {
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

interface PaletteGroup {
  id: string;
  label: string;
  commands: PaletteCommand[];
}

const GROUPS: PaletteGroup[] = [
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

/** Ordered-subsequence fuzzy match scoring, mirroring the core palette. */
function fuzzyScore(query: string, candidate: string): number | null {
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

interface Match {
  group: PaletteGroup;
  command: PaletteCommand;
  score: number;
}

/**
 * Command palette: searches the core slash commands (grouped) and executes
 * them via `executeCommand`. The mode group is generated from `AGENT_MODES`
 * and marks the current mode with ✓. Parameterized commands show an argument
 * input; destructive commands require an explicit confirmation. Entries with
 * a `local` action open a view instead ("Provider 设置" opens the app-level
 * provider settings dialog). Opened with Ctrl/Cmd+K (the composer's inline
 * `/` submission is unaffected).
 */
export function CommandPalette({
  actions,
  mode,
  onClose,
  onOpenProviderSettings,
}: {
  actions: ChatActions;
  mode: string;
  onClose: () => void;
  onOpenProviderSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [arg, setArg] = useState("");
  const [confirm, setConfirm] = useState<PaletteCommand | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const argRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    const scored: Match[] = [];
    for (const group of GROUPS) {
      for (const command of group.commands) {
        const score = fuzzyScore(query, `${command.label} ${command.keywords}`);
        if (score !== null) scored.push({ group, command, score });
      }
    }
    return scored.sort((a, b) => a.score - b.score);
  }, [query]);

  const current = matches[Math.min(selected, matches.length - 1)];

  // Reset the argument buffer when the selected command changes, and focus the
  // argument input when a parameterized command is selected.
  useEffect(() => {
    setArg("");
    setConfirm(null);
    if (current?.command.argument) argRef.current?.focus();
  }, [current?.command.id]);

  const run = (command: PaletteCommand) => {
    // Local UI actions open a view instead of hitting the core command
    // channel (the core `/provider` only prints the current provider).
    if (command.local === "provider-settings") {
      onOpenProviderSettings();
      onClose();
      return;
    }
    const full = command.argument
      ? `${command.command} ${arg.trim()}`.trimEnd()
      : command.command;
    void actions.executeCommand(full);
    onClose();
  };

  const select = (command: PaletteCommand) => {
    if (command.destructive) {
      setConfirm(command);
      return;
    }
    if (command.argument?.required && !arg.trim()) {
      // Block empty required argument.
      return;
    }
    run(command);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (confirm) {
        setConfirm(null);
      } else {
        onClose();
      }
      return;
    }
    if (confirm) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) select(current.command);
    }
  };

  // Render matches grouped, hiding empty groups.
  const grouped = useMemo(() => {
    const out: { group: PaletteGroup; items: Match[] }[] = [];
    for (const group of GROUPS) {
      const items = matches.filter((m) => m.group.id === group.id);
      if (items.length) out.push({ group, items });
    }
    return out;
  }, [matches]);

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette-card" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={searchRef}
          className="palette-search"
          placeholder="搜索命令（/new、/rename、/todo …）"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        {confirm ? (
          <div className="palette-confirm">
            <p>
              确认执行 <code>{confirm.command}</code>？此操作{confirm.destructive ? "不可撤销" : "将修改会话"}。
            </p>
            <div className="palette-confirm-actions">
              <button type="button" className="ghost" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const pending = confirm;
                  setConfirm(null);
                  run(pending);
                }}
              >
                确认执行
              </button>
            </div>
          </div>
        ) : (
          <>
            {matches.length === 0 ? (
              <p className="palette-empty">没有匹配的命令</p>
            ) : (
              <div className="palette-groups">
                {grouped.map(({ group, items }) => (
                  <section key={group.id} className="palette-group">
                    <div className="palette-group-label">{group.label}</div>
                    <ul className="palette-list">
                      {items.map(({ command }) => {
                        const index = matches.findIndex((m) => m.command.id === command.id);
                        const isCurrentMode =
                          command.id.startsWith("mode-") && command.command === `/${mode}`;
                        return (
                          <li key={command.id}>
                            <button
                              type="button"
                              className={`palette-item ${index === selected ? "selected" : ""}`}
                              onMouseEnter={() => setSelected(index)}
                              onClick={() => select(command)}
                            >
                              <code>{command.command}</code>
                              <span className="palette-label">{command.label}</span>
                              <span className="palette-desc">{command.description}</span>
                              {isCurrentMode ? (
                                <span className="current-check" title="当前模式">
                                  <Icon name="check" size={14} />
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            {current?.command.argument ? (
              <input
                ref={argRef}
                className="palette-arg"
                placeholder={
                  current.command.argument.placeholder +
                  (current.command.argument.required ? "（必填）" : "")
                }
                value={arg}
                onChange={(e) => setArg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    select(current.command);
                  }
                  if (e.key === "Escape") onClose();
                }}
              />
            ) : null}
            <div className="palette-footer">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> 选择
              </span>
              <span>
                <kbd>Enter</kbd> 执行
              </span>
              <span>
                <kbd>Esc</kbd> 关闭
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
