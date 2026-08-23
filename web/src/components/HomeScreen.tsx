import { useState } from "react";
import type { ChatActions } from "../hooks";
import type { UiState } from "../state/reducer";
import { SessionList } from "./SessionList";

const PRESETS = ["openai", "deepseek", "qwen", "volcano", "custom"] as const;

/** Home screen: provider/model selection, first message, and resume list. */
export function HomeScreen({ state, actions }: { state: UiState; actions: ChatActions }) {
  const [text, setText] = useState("");

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    void actions.submit(value);
  };

  return (
    <section className="home">
      <header className="home-header">
        <h1>1H-Agent</h1>
        <p className="home-subtitle">轻量、权限感知的浏览器 Agent</p>
        {state.lastError ? <p className="error-banner">{state.lastError}</p> : null}
      </header>

      <div className="home-provider">
        <label>
          Provider
          <select
            value={state.provider}
            onChange={(e) => void actions.setProvider(e.target.value, state.model)}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          <input
            type="text"
            spellCheck={false}
            value={state.model}
            onChange={(e) => void actions.setProvider(state.provider, e.target.value)}
          />
        </label>
      </div>

      <form
        className="home-form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
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
        <div className="home-actions">
          <button type="submit" className="primary">
            开始
          </button>
        </div>
      </form>

      <div className="home-sessions">
        <h2>恢复会话</h2>
        {state.sessions.length === 0 ? (
          <p className="dim">暂无历史会话，输入首条消息即可开始。</p>
        ) : (
          <SessionList
            sessions={state.sessions}
            active={state.activeSession}
            onActivate={(id) => void actions.activate(id)}
          />
        )}
      </div>
    </section>
  );
}
