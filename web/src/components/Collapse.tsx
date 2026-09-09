import type { ReactNode } from "react";

/**
 * Height-animated collapsible: `grid-template-rows` transitions between 0fr
 * and 1fr, so no JS measurement is needed and content stays mounted (bounded:
 * only rows inside the virtualized window are mounted at all). Browsers that
 * cannot animate grid tracks simply snap open/closed — the previous behavior.
 *
 * When closed, the inner box is `visibility: hidden` (after the collapse
 * transition) which also removes its content from the tab order.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="collapse" data-open={open ? "true" : "false"}>
      <div className="collapse-inner" aria-hidden={!open}>
        {children}
      </div>
    </div>
  );
}
