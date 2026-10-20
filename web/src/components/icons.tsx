/**
 * Inline SVG icon set (24×24, stroke-based, currentColor). No icon library —
 * every icon is hand-picked so the Web UI has zero runtime dependencies.
 * Component code must never use text/emoji characters as icons.
 */

export type IconName =
  | "send"
  | "stop"
  | "plus"
  | "search"
  | "memory"
  | "server"
  | "monitor"
  | "eye"
  | "eyeOff"
  | "settings"
  | "sun"
  | "moon"
  | "sparkles"
  | "check"
  | "chevronDown"
  | "chevronRight"
  | "copy"
  | "todo"
  | "palette"
  | "fork"
  | "x"
  | "menu"
  | "edit"
  | "trash"
  | "play"
  | "undo"
  | "refresh"
  | "dots"
  | "build"
  | "plan"
  | "explore"
  | "cluster";

const PATHS: Record<IconName, React.ReactNode> = {
  send: (
    <>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </>
  ),
  stop: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  memory: (
    <>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="m3 3 18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.1 4.1M6.1 6.1A17.4 17.4 0 0 0 2 12s3.5 7 10 7a10.7 10.7 0 0 0 5.9-1.8" />
    </>
  ),
  settings: (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="6" r="2" />
      <circle cx="20" cy="14" r="2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
  sparkles: (
    <>
      <path d="M12 3 13.7 9.3 20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7Z" />
      <path d="M19 3l.5 1.5L21 5l-1.5.5L19 7l-.5-1.5L17 5l1.5-.5Z" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  todo: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="m8 12 2 2 5-5" />
      <path d="M9 4V2h6v2" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18h1.5a1.5 1.5 0 0 0 1.5-1.5 1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 1-1-1.4V16a1.5 1.5 0 0 1 1.5-1.5H18a3 3 0 0 0 3-3V12a9 9 0 0 0-9-9Z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10.5" cy="7.5" r="1" />
      <circle cx="14.5" cy="7.5" r="1" />
    </>
  ),
  fork: (
    <>
      <path d="M7 2v7a3 3 0 0 0 3 3h4a3 3 0 0 1 3 3v7" />
      <path d="M7 2H5M17 2h-2M7 4H5M17 4h-2" />
      <circle cx="7" cy="2" r="1" />
      <circle cx="7" cy="20" r="1" />
      <circle cx="17" cy="20" r="1" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  menu: (
    <>
      <path d="M3 6h18M3 12h18M3 18h18" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  play: <path d="m6 4 14 8-14 8Z" />,
  undo: (
    <>
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </>
  ),
  dots: (
    <>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </>
  ),
  build: (
    <>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4L15 12l-3-3 2.7-2.7Z" />
      <path d="m15 7 2-2" />
    </>
  ),
  plan: (
    <>
      <path d="M9 3v18" />
      <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M9 7h6M9 11h6M9 15h4" />
    </>
  ),
  explore: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5Z" />
    </>
  ),
  cluster: (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="19" r="2" />
      <circle cx="19" cy="12" r="2" />
      <path d="m6.5 10.5 3.5-4M6.5 13.5l3.5 4M15.5 8l2.5-1.5M15.5 16l2.5 1.5" />
    </>
  ),
};

const TITLES: Partial<Record<IconName, string>> = {
  send: "发送",
  stop: "停止",
  plus: "新建",
  search: "搜索",
  memory: "工作区记忆",
  server: "Provider",
  monitor: "跟随系统",
  sun: "浅色主题",
  moon: "深色主题",
  sparkles: "跟随系统",
  copy: "复制",
  todo: "任务清单",
  palette: "命令面板",
  fork: "子会话",
  x: "关闭",
  menu: "会话列表",
  edit: "编辑",
  trash: "删除",
  play: "开始",
  undo: "撤销",
  refresh: "刷新",
  dots: "更多",
  build: "构建模式",
  plan: "计划模式",
  explore: "探索模式",
  cluster: "集群模式",
};

export function Icon({
  name,
  size = 16,
  title,
  className,
}: {
  name: IconName;
  size?: number;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}

export function iconTitle(name: IconName): string {
  return TITLES[name] ?? "";
}
