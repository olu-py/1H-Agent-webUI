import type { SessionStateDto } from "../types";

/** Session list shown in the sidebar / home resume panel. */
export function SessionList({
  sessions,
  active,
  onActivate,
}: {
  sessions: SessionStateDto[];
  active: string | null;
  onActivate: (id: string) => void;
}) {
  return (
    <ul className="session-list">
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            className={`session-item ${session.id === active ? "active" : ""}`}
            onClick={() => onActivate(session.id)}
            title={session.status}
          >
            <span className={`session-dot ${session.busy ? "busy" : ""}`} />
            <span className="session-title">{session.title || "(无标题)"}</span>
            {session.parent_id ? <span className="session-child" title="子会话">⤷</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
