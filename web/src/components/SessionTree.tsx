import type { ApprovalDto, SessionStateDto } from "../types";
import type { SessionNode } from "../lib/session-tree";
import type { ChatActions } from "../hooks";
import { buildSessionTree } from "../lib/session-tree";
import { sessionDotKind } from "../lib/session-status";
import { Icon } from "./icons";
import { SessionMenu } from "./SessionMenu";

/**
 * Session tree for the desktop sidebar / mobile drawer: nests fork sessions by
 * `parent_id` and indicates per-session state with the leading status light
 * only (busy / approval / error via `sessionDotKind`). Each row carries a
 * hover-revealed action menu (fork / delete) on its right.
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
    // The status light is the row's only state indicator: live background
    // labels keep it busy/approval/error even while the snapshot's busy flag
    // lags behind (see sessionDotKind).
    const dotKind = sessionDotKind(
      statuses[session.id] || session.status || "",
      session.busy,
      isApproval,
    );
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
            <span className={`session-dot ${dotKind}`} />
            <span className="session-title">{session.title || "(无标题)"}</span>
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
