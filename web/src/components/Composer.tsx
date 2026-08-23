import { useState } from "react";
import type { ChatActions } from "../hooks";

const MODES = ["build", "plan", "explore"] as const;

export function Composer({
  mode,
  busy,
  actions,
}: {
  mode: string;
  busy: boolean;
  actions: ChatActions;
}) {
  const [text, setText] = useState("");

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    void actions.submit(value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <footer className="composer">
      <div className="composer-row">
        <select
          className="mode-select"
          title="Agent 模式"
          value={mode}
          onChange={(e) => void actions.executeCommand(`/mode ${e.target.value}`)}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m.toUpperCase()}
            </option>
          ))}
        </select>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="输入消息，/ 命令，! Shell，@ 附加文件（Enter 发送，Shift+Enter 换行）"
        />
        {busy ? (
          <button type="button" className="danger" onClick={() => void actions.cancel()} title="取消">
            ■
          </button>
        ) : (
          <button type="button" className="primary" onClick={send} title="发送">
            ↵
          </button>
        )}
      </div>
    </footer>
  );
}
