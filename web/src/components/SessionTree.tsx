import type { ApprovalDto, SessionStateDto } from "../types";
import type { SessionNode } from "../lib/session-tree";
import { buildSessionTree } from "../lib/session-tree";
import { Icon } from "./icons";

/**
 * Session tree for the desktop sidebar / mobile drawer: nests fork sessions by
 * `parent_id` and shows busy, approval-waiting, live child progress and status
 * text per session.
 */
export function SessionTree({
  sessions,
  active,
  statuses,
  approval,
  onActivate,
}: {
  sessions: SessionStateDto[];
  active: string | null;
  /** Live per-session status text from background events. */
  statuses: Record<string, string>;
  approval: ApprovalDto | null;
  onActivate: (id: string) => void;
}) {
  const roots = buildSessionTree(sessions);

  const renderNode = (node: SessionNode, depth: number) => {
    const session = node.session;
    const isActive = session.id === active;
    const isApproval = approval?.session_id === session.id;
    const status = statuses[session.id] || session.status || "";
    const showBusy = session.busy && !isApproval;
    return (
      <li key={session.id}>
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
        {node.children.length ? (
          <ul className="session-tree">{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return <ul className="session-tree">{roots.map((node) => renderNode(node, 0))}</ul>;
}
