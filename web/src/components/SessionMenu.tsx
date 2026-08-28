import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatActions } from "../hooks";
import { Icon } from "./icons";

/**
 * Per-session action menu (fork / delete) for the session lists. A hidden
 * three-dots trigger is revealed on row hover (CSS); the dropdown itself is
 * portaled to `document.body` with fixed positioning so it is never clipped by
 * the scrollable session tree. Delete is destructive and requires an inline
 * confirmation inside the same dropdown.
 */
export function SessionMenu({
  sessionId,
  title,
  actions,
}: {
  sessionId: string;
  title: string;
  actions: ChatActions;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click and Escape; reset the confirm step too. The menu is
  // portaled, so "outside" means outside BOTH the trigger and the menu — a
  // click on a menu item must reach its `click` handler before we close.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      const inside =
        (triggerRef.current && triggerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target));
      if (!inside) {
        setOpen(false);
        setConfirming(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setConfirming(false);
  };

  // Right-align the dropdown to the trigger, flipping above when there is not
  // enough room below (the menu is ~120px tall incl. the confirm step).
  const rect = triggerRef.current?.getBoundingClientRect();
  const openUp = rect ? window.innerHeight - rect.bottom < 150 : false;
  const style: React.CSSProperties = rect
    ? {
        position: "fixed",
        top: openUp ? rect.top - 4 : rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
        transform: openUp ? "translateY(-100%)" : undefined,
      }
    : { position: "fixed", top: 0, left: 0 };

  return (
    <div className="session-menu-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn session-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="会话操作"
        title="会话操作"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="dots" size={16} />
      </button>
      {open
        ? createPortal(
            <div ref={menuRef} className="session-menu" role="menu" style={style}>
              {confirming ? (
                <>
                  <p className="session-menu-confirm">
                    删除会话「{title || "(无标题)"}」？此操作不可撤销。
                  </p>
                  <div className="session-menu-confirm-actions">
                    <button type="button" className="ghost" onClick={close}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        close();
                        void actions.deleteSession(sessionId);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-item"
                    onClick={() => {
                      close();
                      void actions.forkSession(sessionId);
                    }}
                  >
                    <Icon name="fork" size={14} />
                    分支
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-item destructive"
                    onClick={() => setConfirming(true)}
                  >
                    <Icon name="trash" size={14} />
                    删除
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
