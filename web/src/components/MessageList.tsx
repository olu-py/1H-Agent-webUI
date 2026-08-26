import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityState, ViewMessage } from "../state/reducer";
import { copyText, flashCopied } from "../lib/copy";
import { MessageItem } from "./MessageItem";

const OVERSCAN = 400;
const ESTIMATED_ROW = 48;
const STICK_EPSILON = 48;

/** Virtualized, streaming-aware message list. Renders only the visible window
 * (variable row heights are measured lazily) and triggers older-page loading
 * when the user scrolls to the top, anchoring the viewport so prepending older
 * messages does not jump. */
export function MessageList({
  messages,
  hasMore,
  onLoadOlder,
  activity,
}: {
  messages: ViewMessage[];
  hasMore: boolean;
  onLoadOlder: () => void;
  activity: ActivityState;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef<Map<string, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const stickRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const anchorRef = useRef<{ key: string; offset: number } | null>(null);
  const prevMessages = useRef(messages);
  const layoutRef = useRef<number[]>([]);

  // Delegated copy for code blocks rendered via dangerouslySetInnerHTML: any
  // click on a `[data-copy]` button copies its sibling `.code-body`.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest?.("[data-copy]");
      if (!target) return;
      const block = target.closest(".code-block");
      const code = block?.querySelector(".code-body")?.textContent ?? "";
      void copyText(code).then((ok) => flashCopied(target as HTMLElement, ok));
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  // Track viewport height.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute cumulative offsets from measured heights.
  const layout = useMemo(() => {
    const offsets: number[] = [0];
    for (const m of messages) {
      offsets.push(offsets[offsets.length - 1] + (heights.current.get(m.key) ?? ESTIMATED_ROW));
    }
    return offsets;
  }, [messages]);
  layoutRef.current = layout;
  const totalHeight = layout[layout.length - 1] ?? 0;

  const findIndex = useCallback(
    (offset: number): number => {
      let lo = 0;
      let hi = layout.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (layout[mid] < offset) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    [layout],
  );

  const start = findIndex(Math.max(0, scrollTop - OVERSCAN));
  const end = findIndex(scrollTop + viewportH + OVERSCAN);
  const visible = messages.slice(start, end);

  // Auto-scroll to bottom while the user is pinned there.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, totalHeight]);

  // Restore the scroll anchor after older messages are prepended, so the
  // previously visible message stays at the same screen position.
  useEffect(() => {
    if (prevMessages.current === messages) return;
    prevMessages.current = messages;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!anchor) return;
    const index = messages.findIndex((m) => m.key === anchor.key);
    if (index < 0) return;
    const delta = (layout[index] ?? 0) - anchor.offset;
    const el = containerRef.current;
    if (el) el.scrollTop = Math.max(0, el.scrollTop + delta);
  }, [messages, layout]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_EPSILON;
    // Load older page when near the top, anchoring the current viewport.
    if (hasMore && el.scrollTop < 80 && !loadingOlderRef.current) {
      loadingOlderRef.current = true;
      const layoutNow = layoutRef.current;
      let lo = 0;
      let hi = layoutNow.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (layoutNow[mid] < el.scrollTop) lo = mid + 1;
        else hi = mid;
      }
      const key = messages[lo]?.key;
      if (key) anchorRef.current = { key, offset: layoutNow[lo] ?? 0 };
      onLoadOlder();
      setTimeout(() => {
        loadingOlderRef.current = false;
      }, 300);
    }
  }, [hasMore, onLoadOlder, messages]);

  const measureRow = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) {
      const h = el.getBoundingClientRect().height;
      if (heights.current.get(key) !== h) {
        heights.current.set(key, h);
      }
    }
  }, []);

  return (
    <div className="messages" ref={containerRef} onScroll={onScroll}>
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${layout[start] ?? 0}px)` }}>
          {visible.map((m) => (
            <div key={m.key} ref={(el) => measureRow(m.key, el)} className="message-row">
              <MessageItem
                message={m}
                liveThinking={activity.kind === "thinking" && m.streamingThinking !== undefined}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
