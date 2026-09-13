import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatActions } from "../hooks";
import { filterCommands } from "../lib/commands";
import type { PaletteCommand } from "../lib/commands";
import { ArgInput, CommandEmpty, CommandList, ConfirmView } from "./CommandList";

/**
 * Modal command palette (Ctrl/Cmd+K): searches the shared command registry
 * (`lib/commands`) and executes via `executeCommand`. List rendering, the
 * argument input and the destructive confirmation are the shared
 * `CommandList` pieces, so this surface and the composer's inline `/` popup
 * (`Composer.tsx`, the Codex-CLI-style sibling entry) always stay in sync.
 * The mode group is generated from `AGENT_MODES` and marks the current mode
 * with ✓. Parameterized commands show an argument input; destructive
 * commands require an explicit confirmation. Entries with a `local` action
 * open a view instead ("Provider 设置" opens the app-level provider
 * settings dialog).
 */
export function CommandPalette({
  actions,
  mode,
  onClose,
  onOpenProviderSettings,
}: {
  actions: ChatActions;
  mode: string;
  onClose: () => void;
  onOpenProviderSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [arg, setArg] = useState("");
  const [confirm, setConfirm] = useState<PaletteCommand | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the search field on open (the palette mounts fresh each time).
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const matches = useMemo(() => filterCommands(query), [query]);
  const current = matches[Math.min(selected, matches.length - 1)];
  const selectedId = current?.command.id ?? null;

  // Reset the argument buffer when the selection moves. ArgInput
  // self-focuses on mount, which happens exactly when the selection lands
  // on (or leaves) a parameterized command.
  useEffect(() => {
    setArg("");
    setConfirm(null);
  }, [current?.command.id]);

  const run = (command: PaletteCommand, argValue: string) => {
    // Local UI actions open a view instead of hitting the core command
    // channel (the core `/provider` only prints the current provider).
    if (command.local === "provider-settings") {
      onOpenProviderSettings();
      onClose();
      return;
    }
    const full = command.argument
      ? `${command.command} ${argValue.trim()}`.trimEnd()
      : command.command;
    void actions.executeCommand(full);
    onClose();
  };

  const select = (command: PaletteCommand) => {
    if (command.destructive) {
      setConfirm(command);
      return;
    }
    if (command.argument?.required && !arg.trim()) {
      // Block empty required argument.
      return;
    }
    run(command, arg);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (confirm) {
        setConfirm(null);
      } else {
        onClose();
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
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) select(current.command);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette-card" role="dialog" aria-label="命令面板" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={searchRef}
          className="palette-search"
          role="combobox"
          placeholder="搜索命令（/new、/rename、/todo …）"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={selectedId ? `palette-option-${selectedId}` : undefined}
        />
        {confirm ? (
          <ConfirmView
            command={confirm}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const pending = confirm;
              setConfirm(null);
              run(pending, arg);
            }}
          />
        ) : (
          <>
            {matches.length === 0 ? (
              <CommandEmpty />
            ) : (
              <CommandList
                matches={matches}
                selectedId={selectedId}
                mode={mode}
                id="command-palette-list"
                label="命令列表"
                onHover={(command) =>
                  setSelected(matches.findIndex((m) => m.command.id === command.id))
                }
                onExecute={select}
              />
            )}
            {current?.command.argument ? (
              <ArgInput
                placeholder={current.command.argument.placeholder}
                required={current.command.argument.required}
                value={arg}
                onChange={setArg}
                onSubmit={() => select(current.command)}
                onDismiss={onClose}
              />
            ) : null}
            <div className="palette-footer">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> 选择
              </span>
              <span>
                <kbd>Enter</kbd> 执行
              </span>
              <span>
                <kbd>Esc</kbd> 关闭
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
