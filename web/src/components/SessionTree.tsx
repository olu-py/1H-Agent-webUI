import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ChatActions } from "../hooks";
import { useUiSelector } from "../hooks";
import type { Store } from "../state/store";
import type { UiState } from "../state/reducer";
import { buildSessionTree, flattenSessionTree, sessionWindow } from "../lib/session-tree";
import type { FlatSessionNode } from "../lib/session-tree";
import { childSessionLabel, sessionDotKind } from "../lib/session-status";
import { Icon } from "./icons";
import { SessionMenu } from "./SessionMenu";

/**
 * Session tree for the desktop sidebar / mobile drawer: nests fork sessions by
 * `parent_id` and indicates per-session state with the leading status light
 * only (busy / approval / error via `sessionDotKind`). Each row carries a
 * hover-revealed action menu (fork / delete) on its right.
 */
const ROW_HEIGHT = 36;
const OVERSCAN = 8;
const selectSessions = (state: UiState) => state.sessions;
const selectActive = (state: UiState) => state.activeSession;
const selectStatuses = (state: UiState) => state.backgroundStatus;
const selectChildStatuses = (state: UiState) => state.childStatus;
const selectApproval = (state: UiState) => state.approval;

const SessionRow = memo(function SessionRow({
  row, index, active, status, childStatus, approval, actions, onActivate,
}: {
  row: FlatSessionNode;
  index: number;
  active: boolean;
  status: string;
  childStatus: string;
  approval: boolean;
  actions: ChatActions;
  onActivate: (id: string) => void;
}) {
  const { session } = row;
  const dotKind = sessionDotKind(status || session.status || "", session.busy, approval, childStatus || session.child_status || "");
  const childStatusLabel = status || (session.child_status
    ? childSessionLabel(session.child_status, session.child_phase, session.child_turn, session.child_max_turns, session.child_tool)
    : "");
  return (
    <li className="session-tree-row" role="treeitem" aria-level={row.depth + 1}
      aria-posinset={row.siblingIndex} aria-setsize={row.siblingCount} data-row-index={index}
      data-session-id={session.id}
      style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}>
      <div className="session-row">
        <button type="button" className={`session-item ${active ? "active" : ""}`}
          onClick={() => onActivate(session.id)} style={{ paddingLeft: `${0.5 + row.depth * 0.9}rem` }}
          title={session.title || "(无标题)"} aria-current={active ? "page" : undefined}>
          <span className={`session-dot ${dotKind}`} />
          <span className="session-title">{session.title || "(无标题)"}</span>
          {session.parent_id && childStatusLabel ? <span className="session-status" title={childStatusLabel}>{childStatusLabel}</span> : null}
          {session.parent_id ? <span className="session-child" title="子会话"><Icon name="fork" size={12} /></span> : null}
        </button>
        <SessionMenu sessionId={session.id} title={session.title} actions={actions} />
      </div>
    </li>
  );
});

export const SessionTree = memo(function SessionTree({ store, actions, onActivate }: {
  store: Store;
  actions: ChatActions;
  onActivate: (id: string) => void;
}) {
  const sessions = useUiSelector(store, selectSessions);
  const active = useUiSelector(store, selectActive);
  const statuses = useUiSelector(store, selectStatuses);
  const childStatuses = useUiSelector(store, selectChildStatuses);
  const approval = useUiSelector(store, selectApproval);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousRows = useRef<FlatSessionNode[] | null>(null);
  const revealedActive = useRef<string | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const rows = useMemo(() => flattenSessionTree(buildSessionTree(sessions)), [sessions]);
  const activeIndex = rows.findIndex((row) => row.session.id === active);
  const { start, end } = sessionWindow(rows.length, viewport.top, viewport.height, ROW_HEIGHT, OVERSCAN);
  const visibleRows = rows.slice(start, end);

  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (element) setViewport({ top: element.scrollTop, height: element.clientHeight || 600 });
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    updateViewport();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateViewport);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [updateViewport]);

  // Preserve the same first visible session and offset after rows are inserted above it.
  useLayoutEffect(() => {
    const oldRows = previousRows.current;
    const element = scrollRef.current;
    if (oldRows && element) {
      const oldIndex = Math.floor(element.scrollTop / ROW_HEIGHT);
      const anchor = oldRows[oldIndex]?.session.id;
      const nextIndex = anchor ? rows.findIndex((row) => row.session.id === anchor) : -1;
      if (nextIndex >= 0) element.scrollTop = nextIndex * ROW_HEIGHT + (element.scrollTop % ROW_HEIGHT);
    }
    previousRows.current = rows;
    updateViewport();
  }, [rows, updateViewport]);

  useLayoutEffect(() => {
    // A snapshot can insert rows above the user's viewport without changing
    // the active session. Keep the restored scroll anchor in that case.
    if (active === null) {
      revealedActive.current = null;
      return;
    }
    if (revealedActive.current === active) return;
    const element = scrollRef.current;
    if (!element || activeIndex < 0) return;
    revealedActive.current = active;
    const top = activeIndex * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    updateViewport();
  }, [active, activeIndex, updateViewport]);

  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    scrollRef.current
      ?.querySelector<HTMLButtonElement>(`[data-row-index="${pendingFocus.current}"] button.session-item`)
      ?.focus();
    pendingFocus.current = null;
  });

  const onTreeKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || rows.length === 0) return;
    const current = event.target instanceof HTMLElement
      ? Number(event.target.closest("[data-row-index]")?.getAttribute("data-row-index"))
      : NaN;
    const base = Number.isFinite(current) ? current : activeIndex;
    const target = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, base + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    const targetButton = target >= start && target < end
      ? scrollRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${target}"] button.session-item`)
      : null;
    if (targetButton) {
      targetButton.focus();
      pendingFocus.current = null;
    } else {
      pendingFocus.current = target;
    }
    const element = scrollRef.current;
    if (element) {
      const top = target * ROW_HEIGHT;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
      updateViewport();
    }
  };

  return (
    <div ref={scrollRef} className="session-tree-viewport" onScroll={updateViewport}>
      <ul className="session-tree session-tree-virtual" role="tree" aria-label="会话列表"
        onKeyDown={onTreeKeyDown} style={{ height: rows.length * ROW_HEIGHT }}>
        {visibleRows.map((row, offset) => {
          const index = start + offset;
          const session = row.session;
          return <SessionRow key={session.id} row={row} index={index} active={session.id === active}
            status={statuses[session.id] || ""} childStatus={childStatuses[session.id] || ""}
            approval={approval?.session_id === session.id} actions={actions} onActivate={onActivate} />;
        })}
      </ul>
    </div>
  );
});
