import { useRef, useState } from "react";
import type { ChatActions } from "../hooks";
import type { UiState } from "../state/reducer";
import { modeInfo } from "../lib/modes";
import { sessionListStatus } from "../lib/session-status";
import { Icon } from "./icons";
import { ModeSegmented } from "./ModeSegmented";
import { SessionMenu } from "./SessionMenu";
import { ProviderSwitcher } from "./ProviderSwitcher";

/** Quick-start suggestions under the composer card; clicking fills the input. */
const HOME_CHIPS: Array<{ label: string; prompt: string }> = [
  { label: "梳理仓库结构", prompt: "梳理这个仓库的模块结构，输出一份架构说明" },
  { label: "修复失败的测试", prompt: "运行测试，修复当前失败的用例并说明原因" },
  { label: "调研重试策略", prompt: "调研 Provider 的重试与降级策略，给出建议" },
];

/**
 * Home screen (immersive layout): vertically centered hero + a hollow card
 * mirroring the chat composer (borderless textarea; the same animated mode
 * segments via the shared `ModeSegmented`, provider·model control and the
 * rounded send button share one row), a status-line under the card
 * mirroring the status bar (mode description + shortcut hints), quick-start
 * chips, and recent sessions rendered as the sidebar's `.session-item` rows.
 * No session is created here — the first message lazily creates it and
 * `actions.submit(text, mode)` applies the pending mode only when the snapshot
 * differs.
 */
export function HomeScreen({
  state,
  actions,
  onOpenProvider,
  onOpenMemory,
}: {
  state: UiState;
  actions: ChatActions;
  /** Opens the app-owned provider settings modal (same one as the composer). */
  onOpenProvider: () => void;
  onOpenMemory: () => void;
}) {
  const [text, setText] = useState("");
  const [pendingMode, setPendingMode] = useState<string>(state.mode || "build");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    void actions.submit(value, pendingMode);
  };

  const mode = modeInfo(pendingMode);

  return (
    <section className="home">
      <div className="home-inner">
        <header className="home-hero">
          <div className="home-hero-row">
            <div className="home-logo" aria-hidden="true">
              <Icon name="sparkles" size={22} />
            </div>
            <button type="button" className="icon-btn" onClick={onOpenMemory} title="工作区记忆" aria-label="工作区记忆"><Icon name="search" size={16} /></button>
            <h1 className="home-title">1H-Agent</h1>
          </div>
          <p className="home-subtitle">极致轻量、权限感知的 Agent</p>
          {state.lastError ? <p className="error-banner">{state.lastError}</p> : null}
        </header>

        <div>
          <div className="home-card">
            <textarea
              ref={inputRef}
              className="home-input"
              rows={3}
              placeholder="输入首条消息开始…（支持 / 命令，! 执行 Shell，@ 附加文件）"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="home-row">
              <ModeSegmented value={pendingMode} ariaLabel="默认模式" onSelect={setPendingMode} />
              <ProviderSwitcher
                provider={state.provider}
                providerId={state.providerId}
                model={state.model}
                providerSettings={state.providerSettings}
                providerModels={state.providerModels}
                onExpand={() => {
                  void actions.loadProviderSettings();
                  void actions.loadProviderModels();
                }}
                onSelectModel={(preset, nextModel) =>
                  void actions.setProvider(preset, nextModel)
                }
                onOpen={onOpenProvider}
              />
              <button
                type="button"
                className="send-btn primary"
                onClick={send}
                disabled={!text.trim()}
                title={text.trim() ? "发送（Enter）" : "输入内容后发送"}
                aria-label="发送"
              >
                <Icon name="send" size={16} />
              </button>
            </div>
          </div>

          <div className={`home-statusline mode-${pendingMode}`}>
            <span className="mode-dot" />
            <span className="mode-desc">{mode ? `${mode.label} · ${mode.description}` : ""}</span>
            <span className="status-hint">
              <span>
                <kbd>Enter</kbd> 发送
              </span>
              <span>
                <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
              </span>
              <span>
                <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> 命令面板
              </span>
            </span>
          </div>

          <div className="chips" aria-label="快捷开始">
            {HOME_CHIPS.map((chip) => (
              <button
                key={chip.label}
                type="button"
                className="chip"
                onClick={() => {
                  setText(chip.prompt);
                  inputRef.current?.focus();
                }}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>

        <div className="home-recent">
          <div className="section-head">
            <h2>最近会话</h2>
            <span className="count">
              {state.sessions.length > 8
                ? `前 8 / 共 ${state.sessions.length}`
                : `${state.sessions.length} 个会话`}
            </span>
          </div>
          {state.sessions.length === 0 ? (
            <p className="home-empty">暂无历史会话，输入首条消息即可开始。</p>
          ) : (
            <ul className="home-sessions">
              {state.sessions.slice(0, 8).map((session) => {
                const isActive = session.id === state.activeSession;
                return (
                  <li key={session.id}>
                    <div className="session-row">
                      <button
                        type="button"
                        className={`session-item ${isActive ? "active" : ""}`}
                        onClick={() => void actions.activate(session.id)}
                        title={session.title || "(无标题)"}
                      >
                        <span className={`session-dot ${session.busy ? "busy" : ""}`} />
                        <span className="session-title">{session.title || "(无标题)"}</span>
                        <span className="session-status">
                          {session.busy
                            ? "运行中"
                            : sessionListStatus(session.status, isActive) || "空闲"}
                        </span>
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
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
