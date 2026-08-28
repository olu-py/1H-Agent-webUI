import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActivityState, ViewMessage } from "../state/reducer";
import { copyText, flashCopied } from "../lib/copy";
import { MessageItem } from "./MessageItem";

const OVERSCAN = 400;
const ESTIMATED_ROW = 48;
const STICK_EPSILON = 48;

/** Index of the last row whose start offset is <= `offset` (i.e. the row
 * containing `offset`); 0 when `offset` lies before the first row. */
function findRowContaining(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let res = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= offset) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/** Index of the first row whose start offset is >= `offset`. */
function findRowFrom(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Virtualized, streaming-aware message list. Renders only the visible window
 * of a variable-height transcript. Three invariants keep scrolling smooth:
 *
 * 1. Row heights are measured on mount (and re-measured on any size change via
 *    a shared ResizeObserver) and every measurement immediately feeds the
 *    cumulative layout, so the window offset always matches the real DOM
 *    stacking instead of stale `ESTIMATED_ROW` guesses.
 * 2. Whenever offsets above the viewport change (height corrections, prepended
 *    history pages, cache eviction), the scroll position is compensated in a
 *    pre-paint layout effect so the row under the viewport top stays put -
 *    corrections are invisible instead of jolting the content.
 * 3. While pinned near the bottom the list follows `scrollHeight` so streaming
 *    output stays glued to the bottom edge.
 *
 * Older pages load when the user scrolls near the top. */
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
  // Bumped whenever a measured row height changes. The layout memo depends on
  // it, so measurements apply on the very next (pre-paint) render instead of
  // waiting for the next `messages` update - the old behavior let stale
  // estimates accumulate and then jump all at once.
  const [heightsVersion, setHeightsVersion] = useState(0);
  const stickRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const hasMoreRef = useRef(hasMore);
  const onLoadOlderRef = useRef(onLoadOlder);
  const prevLayoutRef = useRef<number[] | null>(null);
  const prevMessagesRef = useRef<ViewMessage[] | null>(null);
  const prevScrollTopRef = useRef(0);

  hasMoreRef.current = hasMore;
  onLoadOlderRef.current = onLoadOlder;

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

  // ---- Row measurement ----------------------------------------------------
  // One shared ResizeObserver plus per-key stable callback refs. Newly mounted
  // rows are measured synchronously (so the next layout is already correct)
  // and re-measured automatically when their size changes (streaming text,
  // window resize). Stable ref identities mean re-renders no longer force a
  // `getBoundingClientRect` per visible row.
  const observerRef = useRef<ResizeObserver | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const rowRefs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const setRowHeight = useCallback((key: string, height: number) => {
    if (heights.current.get(key) === height) return;
    heights.current.set(key, height);
    setHeightsVersion((v) => v + 1);
  }, []);
  const rowRefFor = useCallback(
    (key: string) => {
      let ref = rowRefs.current.get(key);
      if (ref) return ref;
      ref = (el: HTMLDivElement | null) => {
        if (el) {
          el.dataset.rowKey = key;
          rowEls.current.set(key, el);
          if (!observerRef.current) {
            observerRef.current = new ResizeObserver((entries) => {
              for (const entry of entries) {
                const target = entry.target as HTMLDivElement;
                const k = target.dataset.rowKey;
                if (k) setRowHeight(k, target.getBoundingClientRect().height);
              }
            });
          }
          observerRef.current.observe(el);
          setRowHeight(key, el.getBoundingClientRect().height);
        } else {
          const mounted = rowEls.current.get(key);
          if (mounted) {
            observerRef.current?.unobserve(mounted);
            rowEls.current.delete(key);
          }
        }
      };
      rowRefs.current.set(key, ref);
      return ref;
    },
    [setRowHeight],
  );
  useEffect(() => () => observerRef.current?.disconnect(), []);

  // Compute cumulative offsets from measured heights. Unseen rows fall back
  // to the estimate until they render once; their correction is absorbed by
  // the scroll compensation below.
  const layout = useMemo(() => {
    const offsets: number[] = [0];
    for (const m of messages) {
      offsets.push(offsets[offsets.length - 1] + (heights.current.get(m.key) ?? ESTIMATED_ROW));
    }
    return offsets;
  }, [messages, heightsVersion]);
  const totalHeight = layout[layout.length - 1] ?? 0;

  const start = findRowContaining(layout, Math.max(0, scrollTop - OVERSCAN));
  const end = findRowFrom(layout, scrollTop + viewportH + OVERSCAN);
  const visible = messages.slice(start, end);

  // Auto-scroll to bottom while the user is pinned there. Pre-paint so a
  // growing last row never flashes past the bottom edge for a frame.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, totalHeight]);

  // Compensate the scroll position whenever offsets above the viewport change
  // (measured-height corrections, prepended older pages, eviction), keeping
  // the row under the viewport top at the same screen position. Without this,
  // every layout correction shifts the content under a fixed scrollTop, which
  // the user perceives as twitchy, discontinuous scrolling.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const prevLayout = prevLayoutRef.current;
    const prevMessages = prevMessagesRef.current;
    prevLayoutRef.current = layout;
    prevMessagesRef.current = messages;
    if (!el || !prevLayout || !prevMessages || prevLayout === layout) return;
    if (stickRef.current) return; // bottom-pinned: the auto-scroll effect owns it
    const top = prevScrollTopRef.current;
    const idx = findRowContaining(prevLayout, top);
    const key = prevMessages[idx]?.key;
    if (!key) return;
    const next = messages.findIndex((m) => m.key === key);
    if (next < 0) return;
    const delta = layout[next] - prevLayout[idx];
    if (delta === 0) return;
    el.scrollTop += delta;
    prevScrollTopRef.current = el.scrollTop;
  }, [layout, messages]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    prevScrollTopRef.current = el.scrollTop;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_EPSILON;
    // Load an older page when near the top; the compensation effect above
    // anchors the viewport across the prepend.
    if (hasMoreRef.current && el.scrollTop < 80 && !loadingOlderRef.current) {
      loadingOlderRef.current = true;
      onLoadOlderRef.current();
      window.setTimeout(() => {
        loadingOlderRef.current = false;
      }, 300);
    }
  }, []);

  return (
    <div className="messages" ref={containerRef} onScroll={onScroll}>
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${layout[start] ?? 0}px)` }}>
          {visible.map((m) => (
            <div key={m.key} ref={rowRefFor(m.key)} className="message-row">
              <MessageItem
                message={m}
                liveThinking={
                  activity.kind === "thinking" &&
                  m.streamingThinking !== undefined &&
                  // Only the row still in its thinking phase (no body text yet)
                  // is the live one; an earlier segment's row stays collapsed.
                  m.streamingText === undefined
                }
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
