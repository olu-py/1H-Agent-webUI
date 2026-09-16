import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

type PanelStyle = CSSProperties &
  Partial<Record<"--panel-list-max" | "--panel-origin", string>>;
import type { ProviderModelsDto, ProviderSettingsDto } from "../types";
import {
  buildProviderModelGroups,
  providerKey,
  providerLabel,
  type ProviderModelOption,
} from "../lib/providers";
import { Icon } from "./icons";

/** Trigger geometry captured while the panel is opening. */
interface TriggerRect {
  top: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.floor(tokens / 1_000_000)}m`;
  if (tokens >= 1_000) return `${Math.floor(tokens / 1_000)}k`;
  return String(tokens);
}

/** Optional metadata shown beside the model id when the provider reported it. */
function modelMeta(model: ProviderModelOption): string {
  const parts: string[] = [];
  if (model.context_window_tokens != null) {
    parts.push(`${compactTokens(Number(model.context_window_tokens))} ctx`);
  }
  if (model.max_output_tokens != null) {
    parts.push(`${Number(model.max_output_tokens).toLocaleString()} out`);
  }
  return parts.join(" · ");
}

/**
 * Provider / model switcher pinned to the composer's bottom-right.
 *
 * The trigger expands into a grouped, portaled list instead of opening the
 * full settings dialog. The floating panel is positioned around the trigger so
 * the two render as one large rounded surface. Selecting a model uses the same
 * provider endpoint as the settings dialog; "Provider 设置" remains available
 * for base URL, protocol and API key edits.
 */
export function ProviderSwitcher({
  provider,
  model,
  providerSettings,
  providerModels,
  onExpand,
  onSelectModel,
  onOpen,
}: {
  provider: string;
  model: string;
  providerSettings: ProviderSettingsDto | null;
  providerModels: ProviderModelsDto | null;
  /** Called once each time the panel opens to lazy-load settings/models. */
  onExpand: () => void;
  onSelectModel: (preset: string, model: string) => void;
  /** Opens the app-level settings dialog. */
  onOpen: () => void;
}) {
  const activeKey = providerKey(provider);
  const activeLabel = providerLabel(activeKey);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [triggerRect, setTriggerRect] = useState<TriggerRect | null>(null);
  const [selected, setSelected] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const focusTriggerRef = useRef(false);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const listId = `provider-model-list-${uid}`;

  const groups = useMemo(
    () =>
      buildProviderModelGroups({
        settings: providerSettings,
        provider,
        model,
        providerModels: providerModels?.models ?? null,
      }),
    [providerSettings, provider, model, providerModels],
  );

  const options = useMemo(
    () =>
      groups.flatMap((group) =>
        group.models.map((modelOption) => ({ ...modelOption, groupKey: group.key })),
      ),
    [groups],
  );

  // Prefer the current model as the keyboard's starting point; otherwise the
  // first connected model is selected.
  useEffect(() => {
    if (!open) return;
    const index = options.findIndex((option) => option.groupKey === activeKey && option.id === model);
    setSelected(index >= 0 ? index : 0);
  }, [open, activeKey, model, options]);

  // Keep the keyboard-selected row visible without stealing DOM focus from
  // the combobox trigger (the selected row is described by aria-activedescendant).
  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${listId}-option-${selected}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, selected, listId]);

  // The original trigger remains above the portaled panel. Return focus only
  // for keyboard dismissal; outside clicks must not steal focus.
  useEffect(() => {
    if (open || !focusTriggerRef.current) return;
    focusTriggerRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    onExpand();
  }, [open]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (panelRef.current?.contains(target) || triggerRef.current?.contains(target))
      ) {
        return;
      }
      closePanel(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel(true);
      }
    };
    const onLayoutChange = (event: Event) => {
      // Scrolling inside the long model list must not close the picker.
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      closePanel(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onLayoutChange);
    window.addEventListener("scroll", onLayoutChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onLayoutChange);
      window.removeEventListener("scroll", onLayoutChange, true);
    };
  }, [open]);

  const openPanel = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    closingRef.current = false;
    setClosing(false);
    setTriggerRect({
      top: rect.top,
      bottom: rect.bottom,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    });
    focusTriggerRef.current = false;
    setOpen(true);
  };

  const closePanel = (focusTrigger: boolean) => {
    if (!open || closingRef.current) return;
    focusTriggerRef.current = focusTrigger;
    closingRef.current = true;
    setClosing(true);
    // Keep the panel mounted long enough for the reverse animation. This
    // matches --motion-base and is simpler than wiring animationend fallbacks.
    closeTimerRef.current = window.setTimeout(() => {
      closingRef.current = false;
      setClosing(false);
      setOpen(false);
    }, 180);
  };

  const togglePanel = () => {
    if (closing) {
      openPanel();
      return;
    }
    if (open) closePanel(true);
    else openPanel();
  };

  const chooseModel = (index: number) => {
    const option = options[index];
    if (!option) return;
    closePanel(false);
    onSelectModel(option.groupKey, option.id);
  };

  const moveSelection = (delta: number) => {
    if (!options.length) return;
    setSelected((current) => {
      const count = options.length;
      return (current + delta + count) % count;
    });
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setSelected(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setSelected(Math.max(0, options.length - 1));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseModel(selected);
    }
  };

  const rect = triggerRect;
  let direction: "up" | "down" = "up";
  let panelStyle: PanelStyle = {};
  if (rect) {
    const margin = 8;
    const width = Math.min(Math.max(15 * 16, rect.width), window.innerWidth - margin * 2);
    const desiredRight = window.innerWidth - rect.right;
    const right = Math.max(
      margin,
      Math.min(window.innerWidth - margin - width, desiredRight),
    );
    const availableUp = rect.top - margin;
    const availableDown = window.innerHeight - rect.bottom - margin;
    direction = availableUp >= Math.min(17 * 16, Math.max(12 * 16, availableDown)) ? "up" : "down";
    const chrome = rect.height + 40 + 12;
    const listMax = Math.min(
      window.innerHeight * 0.45,
      Math.max(10 * 16, (direction === "up" ? availableUp : availableDown) - chrome),
    );
    panelStyle = direction === "up"
      ? {
          position: "fixed",
          bottom: window.innerHeight - rect.bottom,
          right,
          width,
          "--panel-list-max": `${listMax}px`,
          "--panel-origin": `${rect.height}px`,
        }
      : {
          position: "fixed",
          top: rect.top,
          right,
          width,
          "--panel-list-max": `${listMax}px`,
          "--panel-origin": `${rect.height}px`,
        };
  }

  return (
    <div className="provider-switcher">
      <button
        ref={triggerRef}
        type="button"
        className="provider-btn"
        onClick={togglePanel}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && options[selected] ? `${listId}-option-${selected}` : undefined
        }
        title={`切换 Provider 与模型（当前 ${activeLabel} · ${model || "未设置"}）`}
      >
        <Icon name="sparkles" size={12} />
        <span className="provider-btn-text">
          {activeLabel} · {model || "未设置"}
        </span>
        <Icon name="chevronDown" size={12} />
      </button>

      {open && rect
        ? createPortal(
            <div
              ref={panelRef}
              className={`provider-panel ${closing ? "closing" : ""}`}
              data-direction={direction}
              style={panelStyle}
            >
              {direction === "down" ? <div className="provider-panel-slot" /> : null}

              <div id={listId} className="provider-panel-list" role="listbox" aria-label="已连接供应商与模型">
                {groups.length === 0 ? (
                  <p className="provider-panel-empty">暂无已连接供应商</p>
                ) : null}
                {groups.map((group) => {
                  const groupHeading = `${listId}-group-${group.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                  return (
                    <div key={group.key} role="group" className="provider-group" aria-labelledby={groupHeading}>
                      <div id={groupHeading} className="provider-group-label">
                        {group.label}
                      </div>
                      <div className="provider-group-items" role="presentation">
                        {group.models.length === 0 ? (
                          <p className="provider-model-empty">未配置模型</p>
                        ) : (
                          group.models.map((modelOption) => {
                            const index = options.findIndex(
                              (option) =>
                                option.groupKey === group.key && option.id === modelOption.id,
                            );
                            const active = group.key === activeKey && modelOption.id === model;
                            return (
                              <button
                                key={modelOption.id}
                                type="button"
                                role="option"
                                id={`${listId}-option-${index}`}
                                className={`provider-model-option ${active ? "active" : ""} ${
                                  index === selected ? "selected" : ""
                                }`}
                                aria-selected={index === selected}
                                title={modelMeta(modelOption) || modelOption.id}
                                onClick={() => chooseModel(index)}
                                onMouseEnter={() => setSelected(index)}
                              >
                                <span className="provider-model-name">{modelOption.id}</span>
                                {modelMeta(modelOption) ? (
                                  <span className="provider-model-meta">{modelMeta(modelOption)}</span>
                                ) : null}
                                {active ? <Icon name="check" size={14} /> : null}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                className="ghost provider-settings-row"
                onClick={() => {
                  closePanel(false);
                  onOpen();
                }}
              >
                <Icon name="dots" size={12} />
                Provider 设置
              </button>

              {direction === "up" ? <div className="provider-panel-slot" /> : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
