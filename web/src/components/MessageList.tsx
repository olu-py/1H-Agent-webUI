import { measureViewport, pruneMeasuredRows, retainedAssistantIndex, type MeasuredViewport } from "../lib/message-list-layout";
import { bindScrollFollower, remainsFollowing } from "../lib/scroll-follow";
import { p1Record } from "../lib/p1-diagnostics";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActivityState, ViewMessage } from "../state/reducer";
import { copyText, flashCopied } from "../lib/copy";
import { markdownCodeCopySource } from "./Markdown";
import { MessageItem } from "./MessageItem";

const OVERSCAN = 400;
const ESTIMATED_ROW = 48;

let diagnosticRowId = 0;

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
  jumpRequest,
}: {
  messages: ViewMessage[];
  hasMore: boolean;
  onLoadOlder: () => void;
  activity: ActivityState;
  jumpRequest: { id: number; nonce: number } | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<MeasuredViewport>(() => ({ heights: new Map(), scrollTop: 0, viewportH: 0, revision: 0 }));
  const { scrollTop, viewportH } = geometry;
  const geometryRef = useRef(geometry); geometryRef.current = geometry;
  const setScrollTop = useCallback((top: number) => setGeometry(previous => measureViewport(previous, [], top, previous.viewportH)), []);
  const appliedScrollTopRef = useRef<number | null>(null);
  const stickRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const hasMoreRef = useRef(hasMore);
  const onLoadOlderRef = useRef(onLoadOlder);
  const prevLayoutRef = useRef<number[] | null>(null);
  const prevMessagesRef = useRef<ViewMessage[] | null>(null);
  const prevScrollTopRef = useRef(0);
  /** Synthetic rows already animated in; guards against replays when the
   * virtualizer re-mounts a scrolled-out row. */
  const animatedKeysRef = useRef<Set<string>>(new Set());

  hasMoreRef.current = hasMore;
  onLoadOlderRef.current = onLoadOlder;

  // Expanding/collapsing a tool or thinking box above the tail must not be
  // swallowed by bottom-pinning (the pinned auto-scroll would scroll the
  // clicked header out of view). MessageItem only reports non-tail rows;
  // following resumes automatically once the user scrolls back to the bottom
  // (STICK_EPSILON in `onScroll`).
  const handleContentToggle = useCallback(() => {
    stickRef.current = false;
  }, []);

  // Delegated copy for code blocks rendered via dangerouslySetInnerHTML: any
  // click on a `[data-copy]` button copies its sibling `.code-body`.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest?.("[data-copy]");
      if (!target) return;
      const block = target.closest(".code-block");
      const code = markdownCodeCopySource(target as HTMLElement) ??
        block?.querySelector(".code-body")?.textContent ?? "";
      void copyText(code).then((ok) => flashCopied(target as HTMLElement, ok));
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (root) return bindScrollFollower(root, () => stickRef.current);
  }, []);

  // Track viewport height.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.scrollTop, height = el.clientHeight;
      setGeometry(previous => measureViewport(previous, [], top, height));
    };
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
  const setRowHeights = useCallback((rows: ReadonlyArray<readonly [string, number]>) => {
    const root = containerRef.current;
    if (!root) return;
    const top = root.scrollTop, viewport = root.clientHeight;
    setGeometry(previous => measureViewport(previous, rows, top, viewport));
    p1Record(43, rows.length, top, viewport, geometryRef.current.revision);
  }, []);
  const rowRefFor = useCallback(
    (key: string) => {
      let ref = rowRefs.current.get(key);
      if (ref) return ref;
      const rowId = ++diagnosticRowId;
      ref = (el: HTMLDivElement | null) => {
        if (el) {
          el.dataset.rowKey = key;
          el.dataset.p1RowId = String(rowId);
          p1Record(40, rowId, geometryRef.current.revision);
          rowEls.current.set(key, el);
          if (!observerRef.current) {
            observerRef.current = new ResizeObserver((entries) => {
              const measurements: Array<readonly [string, number]> = [];
              for (const entry of entries) {
                const target = entry.target as HTMLDivElement;
                const k = target.dataset.rowKey;
                if (k && rowEls.current.get(k) === target) measurements.push([k, entry.borderBoxSize[0]?.blockSize ?? target.getBoundingClientRect().height]);
              }
              setRowHeights(measurements);
            });
          }
          observerRef.current.observe(el);
          setRowHeights([[key, el.getBoundingClientRect().height]]);
        } else {
          const mounted = rowEls.current.get(key);
          if (mounted) {
            p1Record(41, rowId, geometryRef.current.revision);
            observerRef.current?.unobserve(mounted);
            rowEls.current.delete(key);
          }
        }
      };
      rowRefs.current.set(key, ref);
      return ref;
    },
    [setRowHeights],
  );
  // The reducer may evict either end of the bounded transcript window. Drop
  // all DOM/layout/animation bookkeeping for rows that left the window; a
  // long stream or repeated history paging must not retain every old key.
  useLayoutEffect(() => {
    const liveKeys = new Set(messages.map((message) => message.key));
    setGeometry(previous => pruneMeasuredRows(previous, liveKeys));
    for (const [key, element] of rowEls.current) {
      if (liveKeys.has(key)) continue;
      observerRef.current?.unobserve(element);
      rowEls.current.delete(key);
    }
    for (const key of rowRefs.current.keys()) {
      if (!liveKeys.has(key)) rowRefs.current.delete(key);
    }
    for (const key of animatedKeysRef.current) {
      if (!liveKeys.has(key)) animatedKeysRef.current.delete(key);
    }
  }, [messages]);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  // Compute cumulative offsets from measured heights. Unseen rows fall back
  // to the estimate until they render once; their correction is absorbed by
  // the scroll compensation below.
  const layout = useMemo(() => {
    const offsets: number[] = [0];
    for (const m of messages) {
      offsets.push(offsets[offsets.length - 1] + (geometry.heights.get(m.key) ?? ESTIMATED_ROW));
    }
    return offsets;
  }, [messages, geometry.heights]);
  const totalHeight = layout[layout.length - 1] ?? 0;

  const start = findRowContaining(layout, Math.max(0, scrollTop - OVERSCAN));
  const end = findRowFrom(layout, scrollTop + viewportH + OVERSCAN);
  const renderedIndices = messages.slice(start, end).map((_, index) => start + index);
  // The latest oversized assistant row owns an inner content virtualizer. Keep
  // that one row mounted while it is outside the list window so the inner
  // chunk measurements and scroll position survive a trip through history.
  // It is absolutely positioned in the spacer and does not affect list flow.
  const keepaliveLongIndex = retainedAssistantIndex(messages, stickRef.current);
  if (keepaliveLongIndex >= 0 && (keepaliveLongIndex < start || keepaliveLongIndex >= end)) {
    renderedIndices.push(keepaliveLongIndex);
    renderedIndices.sort((left, right) => left - right);
  }
  const tailKey = messages.length > 0 ? messages[messages.length - 1].key : null;

  // Auto-scroll to bottom while the user is pinned there. Pre-paint so a
  // growing last row never flashes past the bottom edge for a frame.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    appliedScrollTopRef.current = el.scrollTop;
    prevScrollTopRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
    p1Record(44, geometry.revision, el.scrollTop, totalHeight);
  }, [messages.length, totalHeight]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !jumpRequest) return;
    const index = messages.findIndex((message) => message.id === jumpRequest.id);
    if (index < 0) return;
    stickRef.current = false;
    appliedScrollTopRef.current = null;
    el.scrollTop = Math.max(0, (layout[index] ?? 0) - 72);
    prevScrollTopRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, [jumpRequest, layout, messages]);

  // Entrance animation for tail-appended rows, applied pre-paint. Only
  // synthetic rows animate: they are exactly the optimistic tail appends
  // (user echo / tool rows / streaming rows). Persisted rows (`m-<id>`) -
  // history pages, post-turn refetch replacements, session switches - never
  // animate, and rows first seen while scrolled away from the bottom are
  // skipped so scrolling them back into view never replays the fade.
  useLayoutEffect(() => {
    for (const index of renderedIndices) {
      if (index < start || index >= end) continue;
      const m = messages[index];
      if (!m.key.startsWith("syn-")) continue;
      if (animatedKeysRef.current.has(m.key)) continue;
      animatedKeysRef.current.add(m.key);
      if (!stickRef.current) continue;
      rowEls.current.get(m.key)?.classList.add("row-enter");
    }
  });

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
    stickRef.current = remainsFollowing(stickRef.current, el.scrollTop, appliedScrollTopRef.current, el.scrollHeight, el.clientHeight);
    if (!stickRef.current) appliedScrollTopRef.current = null;
    p1Record(45, stickRef.current ? 1 : 0, el.scrollTop, geometryRef.current.revision);
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

  useLayoutEffect(() => { p1Record(42, geometry.revision, start, end, totalHeight); });

  return (
    <div className="messages" ref={containerRef} onScroll={onScroll}>
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${layout[start] ?? 0}px)` }}>
            {renderedIndices.map((index) => {
              const message = messages[index];
              const outsideWindow = index < start || index >= end;
              const rowStyle = outsideWindow
                ? {
                  position: "absolute" as const,
                  top: (layout[index] ?? 0) - (layout[start] ?? 0),
                  left: 0,
                  right: 0,
                }
                : undefined;
              return (
                <div key={message.key} ref={rowRefFor(message.key)} className="message-row" data-message-id={message.id} style={rowStyle}>
                  <MessageItem
                    message={message}
                    liveThinking={
                      activity.kind === "thinking" &&
                      message.streamingThinking !== undefined &&
                      // Only the row still in its thinking phase (no body text yet)
                      // is the live one; an earlier segment's row stays collapsed.
                      message.streamingText === undefined
                    }
                    isTail={message.key === tailKey}
                    onContentToggle={handleContentToggle}
                  />
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
