import { useEffect, useRef, useState } from "react";
import type { ChatActions } from "../hooks";
import { AGENT_MODES, modeCommand } from "../lib/modes";
import { Icon } from "./icons";
import { ProviderSwitcher } from "./ProviderSwitcher";

const MAX_ROWS = 8;
const ROW_LINE_HEIGHT = 1.55; // px per line height factor (matches CSS line-height)

/**
 * Composer card: auto-growing textarea (1–8 rows), a segmented mode control
 * whose highlight comes straight from the authoritative `state.mode` (no
 * second local copy — clicking runs `executeCommand('/<mode>')`), the
 * provider/model switcher level with the modes on the same row, and a round
 * send/stop button. Keyboard: Enter sends, Shift+Enter newline, Ctrl/Cmd+K
 * opens the palette (the shortcut hints live in the status bar's bottom-right).
 */
export function Composer({
  mode,
  busy,
  provider,
  model,
  actions,
  onOpenProvider,
}: {
  mode: string;
  busy: boolean;
  provider: string;
  model: string;
  actions: ChatActions;
  onOpenProvider: () => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Autofocus on mount (the ChatScreen remounts this via `key` when the
  // active session changes, so the composer is ready to type after a switch).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    void actions.submit(value);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(parseFloat(getComputedStyle(el).fontSize) * ROW_LINE_HEIGHT * MAX_ROWS))}px`;
  };

  return (
    <footer className="composer">
      <div className="composer-card">
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={onKeyDown}
          placeholder="输入消息，/ 命令，! Shell，@ 附加文件…"
          aria-label="消息输入"
        />
        <div className="composer-row">
          <div className="seg composer-modes" role="group" aria-label="Agent 模式">
            {AGENT_MODES.map((m) => {
              const active = m.key === mode;
              return (
                <button
                  key={m.key}
                  type="button"
                  className={`seg-item ${active ? "active" : ""} mode-${m.tone}`}
                  title={m.description}
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() => void actions.executeCommand(modeCommand(m.key))}
                >
                  <Icon name={m.icon} size={12} />
                  {m.label}
                </button>
              );
            })}
          </div>
          <ProviderSwitcher provider={provider} model={model} onOpen={onOpenProvider} />
          <button
            type="button"
            className={`send-btn ${busy ? "danger" : "primary"}`}
            onClick={() => (busy ? void actions.cancel() : send())}
            title={busy ? "停止" : "发送（Enter）"}
            aria-label={busy ? "停止" : "发送"}
          >
            <Icon name={busy ? "stop" : "send"} size={16} />
          </button>
        </div>
      </div>
    </footer>
  );
}
