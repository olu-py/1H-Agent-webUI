import { useLayoutEffect, useRef } from "react";
import { AGENT_MODES, modeInfo } from "../lib/modes";
import type { AgentModeKey } from "../lib/modes";
import { Icon } from "./icons";

/**
 * Animated agent-mode segmented control (single source: `AGENT_MODES`).
 *
 * A gradient thumb (`span.seg-thumb`, aria-hidden, pointer-events: none) is
 * absolutely positioned inside the `.seg` band and slides to the active item
 * with a spring-eased transform while its duotone gradient crossfades between
 * mode tones — the tone colors are registered `@property` colors declared per
 * `data-tone` on the band (see `.seg` in styles.css), which is what makes the
 * gradient interpolable.
 *
 * Geometry is measured, never index-guessed: `useLayoutEffect` runs before
 * paint (no slide-from-zero artifact on mount) and a `ResizeObserver` on the
 * band re-places the thumb when late font loads, window resizes or item
 * wrapping move the items. Coordinates come from `getBoundingClientRect`
 * relative to the band's padding box (the absolute positioning origin), so
 * borders and padding cannot skew the placement. The thumb is out of flow,
 * so observing the band cannot feed back into its own size.
 */
export function ModeSegmented({
  value,
  onSelect,
  ariaLabel,
  disabled = false,
  className,
}: {
  /** Active mode key (authoritative state; unknown/empty hides the thumb). */
  value: string;
  /** Called with the mode's key when an item is clicked. */
  onSelect: (key: AgentModeKey) => void;
  /** Accessible name for the group. */
  ariaLabel: string;
  /** Disables every item (the composer passes `busy`). */
  disabled?: boolean;
  /** Extra class on the `.seg` band (the composer passes `composer-modes`). */
  className?: string;
}) {
  const bandRef = useRef<HTMLDivElement | null>(null);
  const active = modeInfo(value);

  // Re-measure whenever the active item changes; the ResizeObserver covers
  // geometry changes that do not coincide with a mode switch.
  useLayoutEffect(() => {
    const band = bandRef.current;
    if (!band) return;
    const place = () => {
      const item = band.querySelector<HTMLButtonElement>(".seg-item.active");
      if (!item) {
        band.style.setProperty("--seg-o", "0");
        return;
      }
      const b = band.getBoundingClientRect();
      const cs = getComputedStyle(band);
      const r = item.getBoundingClientRect();
      band.style.setProperty("--seg-x", `${r.left - (b.left + parseFloat(cs.borderLeftWidth))}px`);
      band.style.setProperty("--seg-y", `${r.top - (b.top + parseFloat(cs.borderTopWidth))}px`);
      band.style.setProperty("--seg-w", `${r.width}px`);
      band.style.setProperty("--seg-h", `${r.height}px`);
      band.style.setProperty("--seg-o", "1");
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(band);
    return () => ro.disconnect();
  }, [value]);

  return (
    <div
      className={className ? `seg ${className}` : "seg"}
      data-tone={active?.tone ?? ""}
      role="group"
      aria-label={ariaLabel}
      ref={bandRef}
    >
      <span className="seg-thumb" aria-hidden="true" />
      {AGENT_MODES.map((m) => {
        const on = m.key === value;
        return (
          <button
            key={m.key}
            type="button"
            className={`seg-item ${on ? "active" : ""} mode-${m.tone}`}
            title={m.description}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onSelect(m.key)}
          >
            <Icon name={m.icon} size={12} />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
