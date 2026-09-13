import { useEffect, useMemo, useRef } from "react";
import type { CommandMatch, PaletteCommand } from "../lib/commands";
import { Icon } from "./icons";

/**
 * Shared rendering for the two command surfaces (the Ctrl/Cmd+K modal
 * palette and the composer slash popup): grouped matches with hover
 * selection, the current-mode check and scroll-into-view for the keyboard
 * selection. Rendering lives here so both surfaces can never drift apart.
 */

export function CommandList({
  matches,
  selectedId,
  mode,
  id,
  label,
  onHover,
  onExecute,
}: {
  matches: CommandMatch[];
  /** id of the keyboard/hover-selected command (index-free on purpose). */
  selectedId: string | null;
  mode: string;
  /** Root id/label so hosts can wire aria-controls/activedescendant. */
  id?: string;
  label?: string;
  onHover: (command: PaletteCommand) => void;
  onExecute: (command: PaletteCommand) => void;
}) {
  // Render matches grouped, hiding empty groups.
  const grouped = useMemo(() => {
    const out: { id: string; label: string; items: CommandMatch[] }[] = [];
    for (const match of matches) {
      const bucket = out.find((g) => g.id === match.group.id);
      if (bucket) {
        bucket.items.push(match);
      } else {
        out.push({ id: match.group.id, label: match.group.label, items: [match] });
      }
    }
    return out;
  }, [matches]);

  // Keep the keyboard selection visible while arrowing through the list
  // (Codex follows the selection the same way; without this the highlight
  // scrolls out of view on long lists).
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <div className="palette-groups" role="listbox" id={id} aria-label={label}>
      {grouped.map(({ id: groupId, label: groupLabel, items }) => (
        <section key={groupId} className="palette-group">
          <div className="palette-group-label">{groupLabel}</div>
          <ul className="palette-list">
            {items.map(({ command }) => (
              <li key={command.id}>
                <button
                  ref={command.id === selectedId ? selectedRef : undefined}
                  type="button"
                  role="option"
                  id={`palette-option-${command.id}`}
                  aria-selected={command.id === selectedId}
                  className={`palette-item ${command.id === selectedId ? "selected" : ""}`}
                  onMouseEnter={() => onHover(command)}
                  onClick={() => onExecute(command)}
                >
                  <code>{command.command}</code>
                  <span className="palette-label">{command.label}</span>
                  <span className="palette-desc">{command.description}</span>
                  {command.command === `/${mode}` && command.id.startsWith("mode-") ? (
                    <span className="current-check" title="当前模式">
                      <Icon name="check" size={14} />
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Shared empty state for both surfaces. */
export function CommandEmpty() {
  return <p className="palette-empty">没有匹配的命令</p>;
}

/**
 * Shared argument input: self-focuses on mount (the modal shows it whenever
 * a parameterized command is selected; the popup shows it in argument mode),
 * Enter submits and Escape hands control back to the host.
 */
export function ArgInput({
  placeholder,
  required,
  value,
  onChange,
  onSubmit,
  onDismiss,
}: {
  placeholder: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      className="palette-arg"
      placeholder={placeholder + (required ? "（必填）" : "")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onDismiss();
        }
      }}
    />
  );
}

/** Shared destructive-confirmation step for both surfaces. */
export function ConfirmView({
  command,
  onCancel,
  onConfirm,
}: {
  command: PaletteCommand;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="palette-confirm">
      <p>
        确认执行 <code>{command.command}</code>？此操作{command.destructive ? "不可撤销" : "将修改会话"}。
      </p>
      <div className="palette-confirm-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          确认执行
        </button>
      </div>
    </div>
  );
}
