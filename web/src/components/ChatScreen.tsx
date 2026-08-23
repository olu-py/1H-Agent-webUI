import type { ChatActions } from "../hooks";
import type { UiState } from "../state/reducer";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { SessionList } from "./SessionList";

/** Main chat screen: session sidebar, message stream, composer, status. */
export function ChatScreen({
  state,
  actions,
  onToggleSessions,
  showSessions,
  onToggleTodo,
}: {
  state: UiState;
  actions: ChatActions;
  onToggleSessions: () => void;
  showSessions: boolean;
  onToggleTodo: () => void;
}) {
  const active = state.sessions.find((s) => s.id === state.activeSession);
  return (
    <section className="chat">
      <header className="chat-header">
        <div className="chat-title">
          <span className="chat-session-title">{active?.title ?? "(无标题)"}</span>
          {active ? (
            <span className="chat-session-meta meta">
              {active.phase}
              {active.busy ? " · 运行中" : ""}
            </span>
          ) : null}
        </div>
        <div className="chat-controls">
          <button type="button" className="ghost" onClick={onToggleTodo} title="任务清单">
            ✓
          </button>
          <button type="button" className="ghost" onClick={onToggleSessions} title="切换会话">
            ☰
          </button>
        </div>
      </header>

      {showSessions ? (
        <aside className="session-panel">
          <SessionList
            sessions={state.sessions}
            active={state.activeSession}
            onActivate={(id) => void actions.activate(id)}
          />
        </aside>
      ) : null}

      <main className="chat-main">
        {state.lastError ? <p className="error-banner">{state.lastError}</p> : null}
        <MessageList
          messages={state.messages}
          hasMore={state.hasMore}
          onLoadOlder={() => void actions.loadOlder()}
        />
      </main>

      <div className="status">{state.status}</div>
      <Composer mode={state.mode} busy={state.busy} actions={actions} />
    </section>
  );
}
