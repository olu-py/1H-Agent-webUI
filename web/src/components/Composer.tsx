import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatActions } from "../hooks";
import type { ProviderModelsDto, ProviderSettingsDto } from "../types";
import { modeCommand } from "../lib/modes";
import { buildCommand, filterCommands, slashCommandToken } from "../lib/commands";
import type { PaletteCommand } from "../lib/commands";
import { Icon } from "./icons";
import { ArgInput, CommandEmpty, CommandList, ConfirmView } from "./CommandList";
import { ModeSegmented } from "./ModeSegmented";
import { ProviderSwitcher } from "./ProviderSwitcher";

const MAX_ROWS = 8;
const ROW_LINE_HEIGHT = 1.55; // px per line height factor (matches CSS line-height)

/**
 * Composer card: auto-growing textarea (1–8 rows), the shared animated mode
 * segmented control (`ModeSegmented`) whose highlight comes straight from the
 * authoritative `state.mode` (no second local copy — clicking runs
 * `executeCommand('/<mode>')` and the gradient thumb slides once the state
 * lands), the provider/model switcher level with the modes on the same row,
 * and a rounded send/stop button. Keyboard: Enter sends, Shift+Enter newline,
 * Ctrl/Cmd+K
 * opens the modal palette (the shortcut hints live in the status bar's
 * bottom-right).
 *
 * Codex-CLI-style slash popup: while the input is exactly `/` + one token,
 * a popup floats above the card listing the shared command registry
 * (`lib/commands`, the same source as the modal palette). Typing filters
 * live, ↑/↓ navigate, Enter executes, Tab enters argument mode for
 * parameterized commands, Esc layers back (argument → list → dismiss, text
 * kept), Esc-Esc clears the input, and the selection resets on every filter
 * change — all mirroring the Codex TUI popup.
 */
export function Composer({
  mode,
  busy,
  provider,
  model,
  providerSettings,
  providerModels,
  actions,
  onOpenProvider,
}: {
  mode: string;
  busy: boolean;
  provider: string;
  model: string;
  providerSettings: ProviderSettingsDto | null;
  providerModels: ProviderModelsDto | null;
  actions: ChatActions;
  onOpenProvider: () => void;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(0);
  const [arg, setArg] = useState("");
  const [argOpen, setArgOpen] = useState(false);
  const [confirm, setConfirm] = useState<PaletteCommand | null>(null);
  // Codex keeps the popup tied to the input text; Esc dismisses it for the
  // current text until the text changes again.
  const [dismissed, setDismissed] = useState(false);
  const lastEscRef = useRef(0);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Autofocus on mount (the ChatScreen remounts this via `key` when the
  // active session changes, so the composer is ready to type after a switch).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const slash = slashCommandToken(text);
  const slashQuery = slash?.query ?? "";
  const popupActive = slash !== null && !dismissed;
  const matches = useMemo(
    () => (slash !== null && !dismissed ? filterCommands(slashQuery) : []),
    [slash !== null, dismissed, slashQuery],
  );
  const current = matches.length ? matches[Math.min(selected, matches.length - 1)] : undefined;
  const selectedId = current?.command.id ?? null;

  // Codex resets the popup selection whenever the filter changes (#25492) —
  // a selection pointing at a filtered-out command is a stale-state bug.
  useEffect(() => {
    setSelected(0);
    setArg("");
    setArgOpen(false);
    setConfirm(null);
  }, [slashQuery, dismissed]);

  // Leaving a parameterized command drops its pending argument/confirm.
  useEffect(() => {
    setArg("");
    setArgOpen(false);
    setConfirm(null);
  }, [current?.command.id]);

  // Click outside the popup dismisses it (no backdrop; the page stays live).
  useEffect(() => {
    if (!popupActive) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (popupRef.current && e.target instanceof Node && !popupRef.current.contains(e.target)) {
        setDismissed(true);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [popupActive]);

  const resetPopupState = () => {
    setSelected(0);
    setArg("");
    setArgOpen(false);
    setConfirm(null);
  };

  const focusInput = () => {
    inputRef.current?.focus();
  };

  const executeCommand = (command: PaletteCommand) => {
    if (command.argument?.required && !arg.trim()) return;
    void actions.executeCommand(buildCommand(command, arg));
    setText("");
    resetPopupState();
    setDismissed(false);
    focusInput();
  };

  const selectCommand = (command: PaletteCommand | undefined) => {
    if (!command) return;
    if (command.destructive) {
      setConfirm(command);
      return;
    }
    if (command.local === "provider-settings") {
      onOpenProvider();
      setText("");
      resetPopupState();
      setDismissed(false);
      focusInput();
      return;
    }
    if (command.argument) {
      // Parameterized commands switch the popup to argument mode instead of
      // running immediately (required args stay blocked on empty submits).
      setArgOpen(true);
      return;
    }
    executeCommand(command);
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    void actions.submit(value);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popupActive) {
      if (e.key === "Escape") {
        e.preventDefault();
        lastEscRef.current = Date.now();
        if (confirm) {
          setConfirm(null);
        } else if (argOpen) {
          setArgOpen(false);
        } else {
          setDismissed(true); // keep the typed text for editing
        }
        return;
      }
      if (confirm) {
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
        e.preventDefault();
        selectCommand(current?.command);
        return;
      }
    } else if (e.key === "Escape") {
      // Codex: Esc-Esc clears the composer input (#1297). The first Esc is
      // a no-op; a second one inside the double-press window clears.
      const now = Date.now();
      if (now - lastEscRef.current < 800) {
        e.preventDefault();
        lastEscRef.current = 0;
        setText("");
        if (inputRef.current) autoGrow(inputRef.current);
      } else {
        lastEscRef.current = now;
      }
      return;
    }
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
      {popupActive ? (
        <div className="slash-popup" id="composer-slash-popup" ref={popupRef} aria-label="命令补全">
          {confirm ? (
            <ConfirmView command={confirm} onCancel={() => setConfirm(null)} onConfirm={() => executeCommand(confirm)} />
          ) : (
            <>
              {matches.length === 0 ? (
                <CommandEmpty />
              ) : (
                <CommandList
                  matches={matches}
                  selectedId={selectedId}
                  mode={mode}
                  onHover={(command) =>
                    setSelected(matches.findIndex((m) => m.command.id === command.id))
                  }
                  onExecute={selectCommand}
                />
              )}
              {argOpen && current?.command.argument ? (
                <ArgInput
                  placeholder={current.command.argument.placeholder}
                  required={current.command.argument.required}
                  value={arg}
                  onChange={setArg}
                  onSubmit={() => executeCommand(current.command)}
                  onDismiss={() => setArgOpen(false)}
                />
              ) : null}
              <div className="palette-footer">
                <span>
                  <kbd>↑</kbd> <kbd>↓</kbd> 选择
                </span>
                <span>
                  <kbd>Enter</kbd> 执行
                </span>
                {current?.command.argument ? (
                  <span>
                    <kbd>Tab</kbd> 参数
                  </span>
                ) : null}
                <span>
                  <kbd>Esc</kbd> 关闭
                </span>
              </div>
            </>
          )}
        </div>
      ) : null}
      <div className="composer-card">
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDismissed(false);
            autoGrow(e.target);
          }}
          onKeyDown={onKeyDown}
          placeholder="输入消息，/ 命令，! Shell，@ 附加文件…"
          aria-label="消息输入"
          role="combobox"
          aria-expanded={popupActive}
          aria-controls={popupActive ? "composer-slash-popup" : undefined}
          aria-activedescendant={selectedId ? `palette-option-${selectedId}` : undefined}
        />
        <div className="composer-row">
          <ModeSegmented
            className="composer-modes"
            value={mode}
            ariaLabel="Agent 模式"
            disabled={busy}
            onSelect={(key) => void actions.executeCommand(modeCommand(key))}
          />
          <ProviderSwitcher
            provider={provider}
            model={model}
            providerSettings={providerSettings}
            providerModels={providerModels}
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
