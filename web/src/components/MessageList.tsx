import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewMessage } from "../state/reducer";
import { MessageItem } from "./MessageItem";

const OVERSCAN = 400;
const ESTIMATED_ROW = 48;
const STICK_EPSILON = 48;

/** Virtualized, streaming-aware message list. Renders only the visible window
 * (variable row heights are measured lazily) and triggers older-page loading
 * when the user scrolls to the top. */
export function MessageList({
  messages,
  hasMore,
  onLoadOlder,
}: {
  messages: ViewMessage[];
  hasMore: boolean;
  onLoadOlder: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef<Map<string, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const stickRef = useRef(true);
  const loadingOlderRef = useRef(false);

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

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_EPSILON;
    // Load older page when near the top.
    if (hasMore && el.scrollTop < 80 && !loadingOlderRef.current) {
      loadingOlderRef.current = true;
      onLoadOlder();
      setTimeout(() => {
        loadingOlderRef.current = false;
      }, 300);
    }
  }, [hasMore, onLoadOlder]);

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
              <MessageItem message={m} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
