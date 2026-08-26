import { useState } from "react";
import type { ChatActions } from "../hooks";
import type { UiState } from "../state/reducer";
import { AGENT_MODES, modeInfo } from "../lib/modes";
import { PROVIDERS, providerKey } from "../lib/providers";
import { Icon } from "./icons";

/**
 * Home screen: centered hero + a big input card carrying a local pending mode
 * preference + model settings + recent session cards. No session is created
 * here — the first message lazily creates it and `actions.submit(text, mode)`
 * applies the pending mode only when the snapshot differs.
 */
export function HomeScreen({ state, actions }: { state: UiState; actions: ChatActions }) {
  const [text, setText] = useState("");
  const [pendingMode, setPendingMode] = useState<string>(state.mode || "build");

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    void actions.submit(value, pendingMode);
  };

  return (
    <section className="home">
      <div className="home-inner">
        <header className="home-hero">
          <div className="home-logo" aria-hidden="true">
            <Icon name="sparkles" size={28} />
          </div>
          <h1 className="home-title">1H-Agent</h1>
          <p className="home-subtitle">极致轻量、权限感知的浏览器 Agent</p>
          {state.lastError ? <p className="error-banner">{state.lastError}</p> : null}
        </header>

        <div className="home-card">
          <textarea
            className="home-input"
            rows={4}
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
          <div className="home-modes">
            <span className="home-modes-label">模式</span>
            <div className="seg" role="group" aria-label="默认模式">
              {AGENT_MODES.map((m) => {
                const active = m.key === pendingMode;
                const info = modeInfo(m.key);
                return (
                  <button
                    key={m.key}
                    type="button"
                    className={`seg-item ${active ? "active" : ""} mode-${m.tone}`}
                    title={info?.description}
                    aria-pressed={active}
                    onClick={() => setPendingMode(m.key)}
                  >
                    <Icon name={m.icon} size={12} />
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="home-settings">
            <label className="field-provider">
              Provider
              {/* The snapshot reports the preset label ("DeepSeek"); normalize
                  it to the option key so the current preset is selected. */}
              <select
                value={providerKey(state.provider)}
                onChange={(e) => void actions.setProvider(e.target.value, state.model)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-model">
              模型
              <input
                type="text"
                spellCheck={false}
                value={state.model}
                onChange={(e) => void actions.setProvider(state.provider, e.target.value)}
              />
            </label>
            <button
              type="button"
              className="primary home-start"
              onClick={send}
              disabled={!text.trim()}
            >
              开始
            </button>
          </div>
        </div>

        <div className="home-recent">
          <h2>最近会话</h2>
          {state.sessions.length === 0 ? (
            <p className="home-empty">暂无历史会话，输入首条消息即可开始。</p>
          ) : (
            <ul className="session-cards">
              {state.sessions.slice(0, 8).map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`session-card ${session.id === state.activeSession ? "active" : ""}`}
                    onClick={() => void actions.activate(session.id)}
                  >
                    <span className="session-card-title">{session.title || "(无标题)"}</span>
                    <span className="session-card-meta">
                      <span className={`session-dot ${session.busy ? "busy" : ""}`} />
                      {session.busy ? "运行中" : session.status || "空闲"}
                      {session.parent_id ? (
                        <Icon name="fork" size={12} title="子会话" />
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
