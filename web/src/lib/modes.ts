/**
 * Single source of truth for the agent modes in the Web UI.
 *
 * Order mirrors the core `AgentMode` enum (`build, plan, explore, cluster`);
 * the mode commands `/build`, `/plan`, `/explore`, `/cluster` are parsed by
 * the core command parser — the frontend never re-implements that parsing.
 * Composer segmented control, command palette and Home mode preference all
 * derive from `AGENT_MODES` so the three entry points can never drift apart.
 */

export type AgentModeKey = "build" | "plan" | "explore" | "cluster";

export interface AgentModeInfo {
  /** Core mode name; also the command suffix (`/${key}`). */
  key: AgentModeKey;
  /** Short Chinese label for controls. */
  label: string;
  /** One-line description shown in the palette / status tooltip. */
  description: string;
  /** Icon key rendered by `components/icons.tsx`. */
  icon: "build" | "plan" | "explore" | "cluster";
  /** Accent tone used by the status bar mode badge. */
  tone: "build" | "plan" | "explore" | "cluster";
}

/** The four modes, in core `AgentMode` order. */
export const AGENT_MODES: AgentModeInfo[] = [
  { key: "build", label: "构建", description: "实施改动、编写与测试代码", icon: "build", tone: "build" },
  { key: "plan", label: "计划", description: "先制定计划再推进实施", icon: "plan", tone: "plan" },
  { key: "explore", label: "探索", description: "阅读与调研代码库", icon: "explore", tone: "explore" },
  { key: "cluster", label: "集群", description: "多子 Agent 并行协作", icon: "cluster", tone: "cluster" },
];

/** The slash command the core understands for a mode: `/${key}`. */
export function modeCommand(mode: string): string {
  return `/${mode}`;
}

/** Lookup a mode's metadata by key (case-sensitive, tolerant of unknown). */
export function modeInfo(mode: string): AgentModeInfo | undefined {
  return AGENT_MODES.find((m) => m.key === mode);
}
