import { useMemo } from "react";
import type { ChatActions } from "../hooks";
import type { UiState } from "../state/reducer";
import type { ThemePreference } from "../lib/theme";
import { attachToolOutputs, withPartial } from "../lib/transcript";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { SessionTree } from "./SessionTree";
import { StatusBar } from "./StatusBar";
import { Icon } from "./icons";
import { Presence } from "./Presence";

/**
 * Main chat screen: CSS-grid shell with a full-height session-tree sidebar
 * beside a right-hand column (chat header above the message stream), a
 * slide-in drawer for the sidebar on narrow screens, a merged status bar
 * and the composer card. The composer is keyed by the active session so it
 * remounts (and refocuses) after switching sessions.
 */
export function ChatScreen({
  state,
  actions,
  theme,
  onCycleTheme,
  onToggleSessions,
  showSessions,
  onToggleTodo,
  onTogglePalette,
  onOpenProvider,
  onOpenMemory,
}: {
  state: UiState;
  actions: ChatActions;
  theme: ThemePreference;
  onCycleTheme: () => void;
  onToggleSessions: () => void;
  showSessions: boolean;
  onToggleTodo: () => void;
  onTogglePalette: () => void;
  onOpenProvider: () => void;
  onOpenMemory: () => void;
}) {
  const active = state.sessions.find((s) => s.id === state.activeSession);
  // Fold tool outputs into their call rows before rendering; memoized so
  // unrelated state updates (status/usage ticks) keep row identities stable.
  // While busy the partial is suppressed: a live turn renders its own rows.
  const viewMessages = useMemo(
    () => attachToolOutputs(withPartial(state.messages, state.busy ? null : state.assistantPartial)),
    [state.messages, state.assistantPartial, state.busy],
  );
  // On mobile the drawer closes after picking a session; desktop is static.
  const onToggleSessionsClosed = () => {
    if (showSessions && window.matchMedia("(max-width: 860px)").matches) {
      onToggleSessions();
    }
  };
  const activate = (id: string) => {
    void actions.activate(id);
    onToggleSessionsClosed();
  };

  const themeTitle =
    theme === "auto" ? "主题：跟随系统" : theme === "light" ? "主题：浅色" : "主题：深色";

  return (
    <section className="chat">
      <div className="chat-layout">
        <Presence open={showSessions}>
          <div className="sidebar-backdrop" onClick={onToggleSessions} aria-hidden="true" />
        </Presence>
        <aside className={`chat-sidebar ${showSessions ? "open" : ""}`} onKeyDown={(event) => {
          if (event.key === "Escape" && showSessions) onToggleSessions();
        }}>
          <div className="sidebar-brand">
            <span className="brand-logo" aria-hidden="true">
              <Icon name="sparkles" size={16} />
            </span>
            <span className="brand-name">1H-Agent</span>
            <button
              type="button"
              className="icon-btn sidebar-close"
              onClick={onToggleSessions}
              title="关闭"
              aria-label="关闭会话列表"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <button
            type="button"
            className="primary sidebar-new"
            onClick={() => void actions.executeCommand("/new")}
          >
            <Icon name="plus" size={14} />
            新会话
          </button>
          <div className="sidebar-tree">
            <SessionTree
              sessions={state.sessions}
              active={state.activeSession}
              statuses={state.backgroundStatus}
              childStatuses={state.childStatus}
              approval={state.approval}
              onActivate={activate}
              actions={actions}
            />
          </div>
          <div className="sidebar-footer">
            <span className="provider-line">
              <span className="dim">Provider</span> {state.provider || "—"}
            </span>
            <span className="model-line">
              <span className="dim">模型</span> {state.model || "—"}
            </span>
          </div>
        </aside>

        <div className="chat-column">
          <header className="chat-header">
            <div className="chat-title">
              <span className="chat-session-title">{active?.title ?? "(无标题)"}</span>
              <span className="chat-session-meta meta">
                {active?.phase ?? ""}
                {active?.busy ? " · 运行中" : ""}
              </span>
            </div>
            <div className="chat-controls">
              <button
                type="button"
                className="icon-btn"
                onClick={onTogglePalette}
                title="命令面板（Ctrl/Cmd+K）"
                aria-label="命令面板"
              >
                <Icon name="palette" size={16} />
              </button>
              <button type="button" className="icon-btn" onClick={onOpenMemory} title="工作区记忆" aria-label="工作区记忆">
                <Icon name="search" size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={onToggleTodo}
                title="任务清单"
                aria-label="任务清单"
              >
                <Icon name="todo" size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={onCycleTheme}
                title={themeTitle}
                aria-label={themeTitle}
              >
                <Icon name={theme === "light" ? "sun" : theme === "dark" ? "moon" : "sparkles"} size={16} />
              </button>
              <button
                type="button"
                className="icon-btn chat-toggle-sessions"
                onClick={onToggleSessions}
                title="切换会话"
                aria-label="切换会话"
              >
                <Icon name="menu" size={16} />
              </button>
            </div>
          </header>

          <main className="chat-main">
            {state.lastError ? <p className="error-banner">{state.lastError}</p> : null}
            <MessageList
              messages={viewMessages}
              hasMore={state.hasMore}
              onLoadOlder={() => void actions.loadOlder()}
              activity={state.activity}
            />
            <Composer
              key={state.activeSession ?? "none"}
              mode={state.mode}
              busy={state.busy}
              provider={state.provider}
              model={state.model}
              providerSettings={state.providerSettings}
              providerModels={state.providerModels}
              actions={actions}
              onOpenProvider={onOpenProvider}
            />
            <StatusBar
              activity={state.activity}
              context={state.context}
              contextOverlayTokens={state.contextOverlayTokens}
              usage={state.usage}
              status={state.status}
            />
          </main>
        </div>
      </div>
    </section>
  );
}
