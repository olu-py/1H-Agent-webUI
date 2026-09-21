import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** Retain the last visible content until its exit finishes. Closing content
 * becomes inert immediately; reopening cancels the pending unmount. */
export function Presence({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const lastContent = useRef(children);
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open) lastContent.current = children;
  }, [open, children]);

  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const duration = getComputedStyle(document.documentElement).getPropertyValue("--motion-base").trim();
    const milliseconds = parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
    const finish = () => {
      lastContent.current = null;
      setMounted(false);
    };
    if (reduced.matches) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, Number.isFinite(milliseconds) ? milliseconds : 180);
    reduced.addEventListener("change", finish, { once: true });
    return () => {
      window.clearTimeout(timer);
      reduced.removeEventListener("change", finish);
    };
  }, [open, mounted]);

  useLayoutEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else if (root.current?.contains(document.activeElement)) {
      if (returnFocus.current?.isConnected && !returnFocus.current.closest("[inert]")) {
        returnFocus.current.focus({ preventScroll: true });
      } else {
        (document.activeElement as HTMLElement)?.blur();
      }
    }
  }, [open]);

  if (!open && !mounted) return null;
  return (
    <div ref={root} className="presence" data-state={open ? "open" : "closing"} inert={!open} aria-hidden={!open || undefined}>
      {open ? children : lastContent.current}
    </div>
  );
}
