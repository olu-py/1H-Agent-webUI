import { Profiler, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import type { ChatActions } from "../src/hooks";
import { useUiState } from "../src/hooks";
import { buildSessionTree } from "../src/lib/session-tree";
import { childSessionLabel, sessionDotKind } from "../src/lib/session-status";
import { Icon } from "../src/components/icons";
import { SessionMenu } from "../src/components/SessionMenu";
import { SessionTree } from "../src/components/SessionTree";
import { createStore } from "../src/state/store";
import type { UiState } from "../src/state/reducer";
import type { Store } from "../src/state/store";
import type { AppSnapshotV2, SessionStateDto } from "../src/types";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const baseline = params.get("variant") === "before";
const eventCount = Number(params.get("events") || "500");
const delta = "streaming-response-".padEnd(512, "x");
const sessions: SessionStateDto[] = Array.from({ length: 1001 }, (_, index) => ({
  id: `s${index}`,
  title: `Session ${index}`,
  parent_id: index > 0 && index % 5 === 0 ? `s${index - 1}` : null,
  busy: false,
  phase: "IDLE",
  status: "",
}));
const snapshot: AppSnapshotV2 = {
  protocol_version: 2,
  event_cursor: 0,
  active_session: "s1000",
  sessions,
  provider: "profile",
  provider_id: "profile",
  model: "profile",
  mode: "build",
  approval: null,
  todos: [],
  context: null,
  assistant_partial: null,
};
const store = createStore();
store.dispatch({ type: "snapshot", snapshot });
const actions = {} as ChatActions;
const activate = () => undefined;

interface ProfileSample {
  phase: string;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

interface ProfileResult {
  variant: string;
  userAgent: string;
  sessionCount: number;
  eventCount: number;
  deltaCharacters: number;
  domNodes: number;
  rowNodes: number;
  frameIntervalsMs: number[];
  profiler: ProfileSample[];
  startedAt: number;
  finishedAt?: number;
  completed: boolean;
}

const result: ProfileResult = {
  variant: baseline ? "before" : "after",
  userAgent: navigator.userAgent,
  sessionCount: sessions.length,
  eventCount,
  deltaCharacters: delta.length,
  domNodes: 0,
  rowNodes: 0,
  frameIntervalsMs: [],
  profiler: [],
  startedAt: 0,
  completed: false,
};
(window as Window & { __m3Profile?: ProfileResult }).__m3Profile = result;
const insertedRoots: SessionStateDto[] = [];
(window as Window & { __m3ProfileControls?: { insertRoot(): void } }).__m3ProfileControls = {
  insertRoot: () => {
    const id = `inserted-root-${insertedRoots.length + 1}`;
    insertedRoots.unshift({ id, title: "Inserted root", parent_id: null, busy: false, phase: "IDLE", status: "" });
    store.dispatch({
      type: "snapshot",
      snapshot: {
        ...snapshot,
        event_cursor: eventCount + insertedRoots.length,
        sessions: [...insertedRoots, ...sessions],
      },
    });
  },
};

function LegacySessionTree({ state }: { state: UiState }) {
  const roots = buildSessionTree(state.sessions);
  const renderNode = (node: ReturnType<typeof buildSessionTree>[number], depth: number): ReactNode => {
    const session = node.session;
    const active = session.id === state.activeSession;
    const status = state.backgroundStatus[session.id] || session.status || "";
    const childStatus = state.childStatus[session.id] || session.child_status || "";
    const label = state.backgroundStatus[session.id] || (session.child_status
      ? childSessionLabel(session.child_status, session.child_phase, session.child_turn, session.child_max_turns, session.child_tool)
      : "");
    return createElement("li", { key: session.id },
      createElement("div", { className: "session-row" },
        createElement("button", {
          type: "button",
          className: `session-item ${active ? "active" : ""}`,
          onClick: activate,
          style: { paddingLeft: `${0.5 + depth * 0.9}rem` },
          title: session.title || "(无标题)",
        },
          createElement("span", { className: `session-dot ${sessionDotKind(status, session.busy, state.approval?.session_id === session.id, childStatus)}` }),
          createElement("span", { className: "session-title" }, session.title || "(无标题)"),
          session.parent_id && label ? createElement("span", { className: "session-status", title: label }, label) : null,
          session.parent_id ? createElement("span", { className: "session-child", title: "子会话" }, createElement(Icon, { name: "fork", size: 12 })) : null,
        ),
        createElement(SessionMenu, { sessionId: session.id, title: session.title, actions }),
      ),
      node.children.length
        ? createElement("ul", { className: "session-tree" }, node.children.map((child) => renderNode(child, depth + 1)))
        : null,
    );
  };
  return createElement("ul", { className: "session-tree" }, roots.map((node) => renderNode(node, 0)));
}

function profileRender(
  _id: string,
  phase: string,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
): void {
  result.profiler.push({ phase, actualDuration, baseDuration, startTime, commitTime });
}

function StreamProfile({ store }: { store: Store }) {
  const state = useUiState(store);
  useEffect(() => {
    let frame = 0;
    let lastFrame = 0;
    let previousFrameTime = 0;
    const tick = (time: number) => {
      if (previousFrameTime) result.frameIntervalsMs.push(time - previousFrameTime);
      previousFrameTime = time;
      if (frame < eventCount) {
        store.dispatch({
          type: "event",
          envelope: {
            cursor: frame + 1,
            session_id: "s1000",
            type: "text_delta",
            delta,
          } as never,
        });
        frame += 1;
        requestAnimationFrame(tick);
        return;
      }
      if (lastFrame < 2) {
        lastFrame += 1;
        requestAnimationFrame(tick);
        return;
      }
      result.finishedAt = performance.now();
      result.domNodes = document.querySelectorAll("*").length;
      result.rowNodes = document.querySelectorAll("[role=treeitem], .session-row").length;
      result.completed = true;
      document.body.dataset.profileComplete = "true";
    };
    result.startedAt = performance.now();
    requestAnimationFrame(tick);
  }, [store]);

  const tree = baseline
    ? createElement(LegacySessionTree, { state })
    : createElement(SessionTree, { store, actions, onActivate: activate });
  return createElement("div", { className: "chat-sidebar", style: { width: 380, height: 680, display: "flex", flexDirection: "column" } },
    createElement("div", { className: "sidebar-tree", style: { minHeight: 0, flex: 1, overflow: "hidden" } },
      createElement(Profiler, { id: "session-tree", onRender: profileRender }, tree),
    ),
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(createElement(StreamProfile, { store }));
