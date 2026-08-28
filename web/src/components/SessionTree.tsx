import type { ApprovalDto, SessionStateDto } from "../types";
import type { SessionNode } from "../lib/session-tree";
import type { ChatActions } from "../hooks";
import { buildSessionTree } from "../lib/session-tree";
import { sessionListStatus } from "../lib/session-status";
import { Icon } from "./icons";
import { SessionMenu } from "./SessionMenu";

/**
 * Session tree for the desktop sidebar / mobile drawer: nests fork sessions by
 * `parent_id` and shows busy, approval-waiting, live child progress and status
 * text per session. Each row carries a hover-revealed action menu (fork /
 * delete) on its right.
 */
export function SessionTree({
  sessions,
  active,
  statuses,
  approval,
  onActivate,
  actions,
}: {
  sessions: SessionStateDto[];
  active: string | null;
  /** Live per-session status text from background events. */
  statuses: Record<string, string>;
  approval: ApprovalDto | null;
  onActivate: (id: string) => void;
  actions: ChatActions;
}) {
  const roots = buildSessionTree(sessions);

  const renderNode = (node: SessionNode, depth: number) => {
    const session = node.session;
    const isActive = session.id === active;
    const isApproval = approval?.session_id === session.id;
    // The plain "就绪" ready marker is only shown on the active session; parked
    // sessions keep live/error statuses but not the idle ready label.
    const status = sessionListStatus(
      statuses[session.id] || session.status || "",
      isActive,
    );
    const showBusy = session.busy && !isApproval;
    return (
      <li key={session.id}>
        <div className="session-row">
          <button
            type="button"
            className={`session-item ${isActive ? "active" : ""}`}
            onClick={() => onActivate(session.id)}
            style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
            title={session.title || "(无标题)"}
          >
            <span className={`session-dot ${isApproval ? "approval" : showBusy ? "busy" : ""}`} />
            <span className="session-title">{session.title || "(无标题)"}</span>
            {status ? <span className="session-status">{status}</span> : null}
            {session.parent_id ? (
              <span className="session-child" title="子会话">
                <Icon name="fork" size={12} />
              </span>
            ) : null}
          </button>
          <SessionMenu
            sessionId={session.id}
            title={session.title}
            actions={actions}
          />
        </div>
        {node.children.length ? (
          <ul className="session-tree">{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return <ul className="session-tree">{roots.map((node) => renderNode(node, 0))}</ul>;
}
