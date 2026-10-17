import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { extendTableColumnWidths, renderedTableRows, tableRowCellLengths } from "../lib/table-data";
import { HeightIndex } from "../lib/height-index";
import { p1Record } from "../lib/p1-diagnostics";
import { restoreIndexedScrollAnchor } from "../lib/scroll-anchor";
import { renderedBlockEstimate, splitRenderedBlocks } from "../lib/html-blocks";
import {
  createMarkdownModelCache,
  createMarkdownStreamCache,
  renderMarkdownStreamUpdate,
  STREAM_FADE_CHARS,
  updateMarkdownModel,
  type MarkdownDocument,
  type MarkdownBlock,
} from "../lib/markdown";
import {
  cancelMarkdownParse,
  createMarkdownWorkerClientId,
  requestMarkdownParse,
  subscribeMarkdownWorker,
} from "../lib/markdown-worker-client";

const STREAM_TEXT_NODE_CHARS = 16 * 1024;
const INLINE_CHUNK_CHARS = 4096;
const VIRTUALIZE_AFTER_CHARS = 96 * 1024;
const VIRTUALIZE_BLOCK_DOCUMENT_AFTER_CHARS = 2 * 1024;

interface GraphemeSegmenter {
  segment(text: string): Iterable<{ index: number; segment: string }>;
}

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => GraphemeSegmenter;

const GraphemeSegmenterImpl = (Intl as unknown as {
  Segmenter?: GraphemeSegmenterConstructor;
}).Segmenter;
const graphemeSegmenter = GraphemeSegmenterImpl
  ? new GraphemeSegmenterImpl(undefined, { granularity: "grapheme" })
  : null;

/** Returns a UTF-16 offset at a grapheme boundary near the requested limit. */
export function graphemeBoundary(text: string, start: number, maxChars: number): number {
  const limit = Math.min(text.length, start + Math.max(1, maxChars));
  if (limit === text.length) return limit;
  if (graphemeSegmenter) {
    // A grapheme can be arbitrarily longer than 64 UTF-16 units (combining
    // marks, emoji modifiers, and ZWJ chains). Segment the complete remainder
    // so a lookahead cap is never mistaken for a proven cluster boundary.
    const window = text.slice(start);
    let boundary = start;
    for (const item of graphemeSegmenter.segment(window)) {
      const end = start + item.index + item.segment.length;
      if (end > limit) return boundary > start ? boundary : end;
      boundary = end;
    }
    return boundary > start ? boundary : text.length;
  }
  // Without a full grapheme oracle the safe boundary is the end of the source.
  // This sacrifices chunking on old engines rather than splitting a cluster.
  return text.length;
}

interface VirtualChunk {
  element: HTMLDivElement;
  html: string;
  virtual: boolean;
}

interface VirtualParagraph {
  container: HTMLDivElement;
  chunks: VirtualChunk[];
  observer: IntersectionObserver;
  resizeObserver: ResizeObserver;
  active: boolean;
  width: number;
  root: HTMLElement | null;
  addChunk: (chunk: VirtualChunk) => void;
  current?: {
    element: HTMLDivElement;
    committed: HTMLSpanElement;
    live: HTMLSpanElement;
    chars: number;
  };
}

interface WindowedDocumentBlock {
  id: string;
  revision: number;
  html: string;
  sourceStart?: number;
  sourceEnd?: number;
  create?: () => HTMLElement | null;
  reusable?: boolean;
  element: HTMLDivElement | null;
  height: number;
  estimate?: { textLength: number; kind: "bounded" | "heading" | "rule" | "text" };
}

interface MarkdownWindowAnchor {
  blockId: string;
  localOffset: number;
  viewportOffset: number;
}

interface MarkdownDocumentWindow {
  host: HTMLElement;
  root: HTMLElement;
  container: HTMLDivElement;
  blocks: WindowedDocumentBlock[];
  heightCache: Map<string, number>;
  scroll: () => void;
  resizeObserver: ResizeObserver;
  frame: number;
  widthKey: string;
  disposed: boolean;
  captureAnchor: () => MarkdownWindowAnchor | null;
  refresh: () => void;
  dispose: () => void;
  reconcile: (blocks: WindowedDocumentBlock[], anchor: MarkdownWindowAnchor | null, prepared?: PreparedWindow) => void;
}

interface PreparedWindow {
  source: string;
  blocks: WindowedDocumentBlock[];
  heights: HeightIndex;
  indices: Map<string, number>;
  widthKey: string;
}

const DOCUMENT_OVERSCAN_PX = 360;
const CODE_LINE_OVERSCAN = 12;
const markdownCodeCopySources = new WeakMap<Element, string>();

export function markdownCodeCopySource(button: HTMLElement): string | undefined {
  return markdownCodeCopySources.get(button);
}

function documentWidthKey(host: HTMLElement): string {
  const style = getComputedStyle(host);
  return [Math.round(host.clientWidth), style.font, style.lineHeight, style.letterSpacing].join("|");
}

function estimateBlockHeight(block: WindowedDocumentBlock, width: number, fontSize: number): number {
  if (!block.estimate) {
    const template = document.createElement("template");
    template.innerHTML = block.html;
    block.estimate = blockEstimate(template.content.firstElementChild);
  }
  const { textLength, kind } = block.estimate;
  const lines = Math.max(1, Math.ceil(textLength / Math.max(24, Math.floor(width / (fontSize * 0.52)))));
  if (kind === "bounded") return Math.min(window.innerHeight * 0.6, Math.max(48, lines * fontSize * 1.55 + 40));
  if (kind === "heading") return Math.max(30, lines * fontSize * 1.4 + 12);
  if (kind === "rule") return 20;
  return Math.max(28, lines * fontSize * 1.55 + 18);
}

function blockEstimate(element: Element | null): NonNullable<WindowedDocumentBlock["estimate"]> {
  return { textLength: element?.textContent?.length ?? 0,
    kind: element?.matches(".table-wrap, .code-block") ? "bounded"
      : element?.matches("h1,h2,h3,h4,h5,h6") ? "heading"
        : element?.matches("hr") ? "rule" : "text" };
}

function makeDocumentWindow(
  host: HTMLElement,
  blocks: WindowedDocumentBlock[],
  initialAnchor?: MarkdownWindowAnchor | null,
): MarkdownDocumentWindow | null {
  const root = host.closest(".messages") as HTMLElement | null;
  if (!root || blocks.length === 0) return null;
  const container = document.createElement("div");
  container.className = "markdown-virtual-document";
  p1Record(10, blocks.length);
  p1Record(48, Number(host.closest(".message-row")?.getAttribute("data-p1-row-id") ?? 0), blocks.length);
  container.style.position = "relative";
  host.replaceChildren(container);
  const widthKey = documentWidthKey(host);
  const fontSize = Number.parseFloat(getComputedStyle(host).fontSize) || 14;
  const initialWidth = host.clientWidth;
  const heightCache = new Map<string, number>();
  const initialHeights: number[] = [];
  let blockIndices = new Map<string, number>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const key = `${block.id}:${block.revision}:${widthKey}`;
    block.height = heightCache.get(key) ?? estimateBlockHeight(block, initialWidth, fontSize);
    initialHeights.push(block.height);
    blockIndices.set(block.id, index);
  }
  const state: MarkdownDocumentWindow = {
    host, root, container, blocks, heightCache, widthKey, frame: 0, disposed: false,
    scroll: () => {}, resizeObserver: null!, captureAnchor: () => null, refresh: () => {}, dispose: () => {}, reconcile: () => {},
  };
  let heights = new HeightIndex(initialHeights);
  const mounted = new Set<number>();
  const measuredHeights = new Map<number, number>();
  let measurementPending = false;
  const appendHeights = (width: number, size: number) => {
    while (heights.length < state.blocks.length) {
      const index = heights.length;
      const block = state.blocks[index];
      if (block.height === 0) block.height = estimateBlockHeight(block, width, size);
      blockIndices.set(block.id, index);
      heights.append(block.height);
    }
  };
  const captureAnchor = (
    hostRect = container.getBoundingClientRect(),
    rootRect = root.getBoundingClientRect(),
  ): MarkdownWindowAnchor | null => {
    const localTop = Math.max(0, rootRect.top - hostRect.top);
    if (!state.blocks.length) return null;
    const index = Math.min(state.blocks.length - 1, heights.lowerBound(localTop + 1) - 1);
    const block = state.blocks[Math.max(0, index)];
    const blockTop = heights.prefix(Math.max(0, index));
    const localOffset = Math.max(0, localTop - blockTop);
    return {
      blockId: block.id,
      localOffset,
      viewportOffset: hostRect.top + blockTop + localOffset - rootRect.top,
    };
  };
  const restoreAnchor = (
    anchor: MarkdownWindowAnchor | null,
    hostRect?: DOMRect,
    rootRect?: DOMRect,
    previousScrollTop?: number,
  ) => {
    restoreIndexedScrollAnchor(root, anchor, blockIndices, (index) => heights.prefix(index), () => ({
      hostTop: (hostRect ?? container.getBoundingClientRect()).top,
      rootTop: (rootRect ?? root.getBoundingClientRect()).top,
      scrollTop: previousScrollTop ?? root.scrollTop,
    }));
  };
  state.captureAnchor = () => captureAnchor();
  let previousViewKey = "";
  state.refresh = () => {
    p1Record(11, state.blocks.length);
    if (state.disposed) return;
    const nextWidthKey = documentWidthKey(host);
    const currentWidth = host.clientWidth;
    const initialHostRect = container.getBoundingClientRect();
    const initialRootRect = root.getBoundingClientRect();
    const initialScrollTop = root.scrollTop;
    const viewKey = [nextWidthKey, initialHostRect.top, initialRootRect.top,
      initialRootRect.bottom, root.scrollTop, state.blocks.length].join("|");
    if (viewKey === previousViewKey && !measurementPending) return;
    previousViewKey = viewKey;
    measurementPending = false;
    const widthChanged = nextWidthKey !== state.widthKey;
    const anchor = captureAnchor(initialHostRect, initialRootRect);
    if (widthChanged) {
      state.widthKey = nextWidthKey;
      const size = Number.parseFloat(getComputedStyle(host).fontSize) || 14;
      for (const index of mounted) {
        state.resizeObserver.unobserve(state.blocks[index].element!);
        state.blocks[index].element?.remove();
        state.blocks[index].element = null;
      }
      mounted.clear();
      measuredHeights.clear();
      for (let index = 0; index < heights.length; index += 1) {
        const block = state.blocks[index];
        const key = `${block.id}:${block.revision}:${state.widthKey}`;
        block.height = state.heightCache.get(key) ?? estimateBlockHeight(block, currentWidth, size);
        heights.set(index, block.height);
      }
    }
    appendHeights(currentWidth, fontSize);
    const hostRect = initialHostRect;
    const rootRect = initialRootRect;
    const viewportStart = Math.max(0, rootRect.top - hostRect.top - DOCUMENT_OVERSCAN_PX);
    const viewportEnd = Math.max(viewportStart, rootRect.bottom - hostRect.top + DOCUMENT_OVERSCAN_PX);
    const start = Math.max(0, heights.lowerBound(viewportStart) - 1);
    const end = Math.min(state.blocks.length, heights.lowerBound(viewportEnd) + 1);
    for (const index of mounted) {
      if (index < start || index >= end) {
        const block = state.blocks[index];
        state.resizeObserver.unobserve(block.element!);
        const body = block.element?.querySelector("tbody"); if (body) streamingTableWindows.get(body)?.dispose();
        block.element?.remove();
        block.element = null;
        mounted.delete(index);
      }
    }
    const added: number[] = [];
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      const block = state.blocks[index];
      let element = block.element;
      if (!element) {
        const slot = document.createElement("div");
        slot.className = "markdown-virtual-block";
        slot.dataset.mdBlockId = block.id;
        slot.dataset.mdBlockRevision = String(block.revision);
        if (block.sourceStart !== undefined) slot.dataset.sourceStart = String(block.sourceStart);
        if (block.sourceEnd !== undefined) slot.dataset.sourceEnd = String(block.sourceEnd);
        const content = block.create?.();
        if (content) slot.append(content);
        else slot.innerHTML = block.html;
        slot.style.position = "absolute";
        slot.style.left = "0";
        slot.style.right = "0";
        slot.style.top = "0";
        slot.style.transform = `translateY(${heights.prefix(index)}px)`;
        fragment.append(slot);
        block.element = slot;
        p1Record(12, index, block.html.length);
        mounted.add(index);
        added.push(index);
        state.resizeObserver.observe(slot);
        element = slot;
      }
      const transform = `translateY(${heights.prefix(index)}px)`;
      if (element.style.transform !== transform) element.style.transform = transform;
    }
    if (added.length) state.container.append(fragment);
    // The browser reports both new and existing border boxes after layout.
    // Keep the source anchor while these estimates settle, without forcing
    // layout between DOM insertion and position/height writes on every frame.
    let changed = false;
    for (const [index, measured] of measuredHeights) {
      const block = state.blocks[index];
      if (!block.element) continue;
      if (measured > 0 && Math.abs(measured - block.height) > 0.5) {
        block.height = measured;
        heights.set(index, measured);
        changed = true;
        state.heightCache.set(`${block.id}:${block.revision}:${state.widthKey}`, measured);
      }
    }
    measuredHeights.clear();
    const documentHeight = `${heights.total}px`;
    if (container.style.height !== documentHeight) container.style.height = documentHeight;
    for (let index = start; index < end; index += 1) {
      const block = state.blocks[index];
      if (block.element) {
        const transform = `translateY(${heights.prefix(index)}px)`;
        if (block.element.style.transform !== transform) block.element.style.transform = transform;
      }
    }
    if (changed || widthChanged) restoreAnchor(anchor, initialHostRect, initialRootRect, initialScrollTop);
  };
  state.reconcile = (next, anchor, prepared) => {
    const started = performance.now();
    let reused = 0;
    const old = state.blocks;
    // Preparation handles all metadata in cancellable slices. Installation only
    // touches the mounted window and swaps the completed indices atomically.
    for (const index of [...mounted]) {
      const prior = old[index];
      const block = next[index];
      if (block?.reusable && prior.html === block.html) {
        block.element = prior.element; block.height = prior.height;
        reused += 1;
        if (block.element) for (const root of [block.element, ...block.element.children]) {
          (root as HTMLElement).dataset.mdBlockId = block.id;
          (root as HTMLElement).dataset.mdBlockRevision = String(block.revision);
          if (block.sourceStart !== undefined) (root as HTMLElement).dataset.sourceStart = String(block.sourceStart);
          if (block.sourceEnd !== undefined) (root as HTMLElement).dataset.sourceEnd = String(block.sourceEnd);
        }
        prepared?.heights.set(index, block.height);
      } else {
        const body = prior.element?.querySelector("tbody"); if (body) streamingTableWindows.get(body)?.dispose();
        if (prior.element) state.resizeObserver.unobserve(prior.element);
        prior.element?.remove(); mounted.delete(index);
      }
    }
    state.blocks = next;
    if (prepared) {
      blockIndices.clear();
      // Keep the observer's lookup reference via a mutable map binding below.
      blockIndices = prepared.indices;
      heights = prepared.heights;
      if (prepared.widthKey !== state.widthKey) state.widthKey = "";
    } else {
      blockIndices.clear(); next.forEach((block, index) => blockIndices.set(block.id, index));
      heights = new HeightIndex(next.map((block) => {
        if (!block.height) block.height = estimateBlockHeight(block, host.clientWidth, fontSize);
        return block.height;
      }));
    }
    measuredHeights.clear(); previousViewKey = "";
    state.refresh(); restoreAnchor(anchor);
    p1Record(13, reused, mounted.size - reused, performance.now() - started, next.length);
  };
  state.scroll = () => {
    if (state.frame || state.disposed) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      state.refresh();
    });
  };
  state.dispose = () => {
    p1Record(49, Number(host.closest(".message-row")?.getAttribute("data-p1-row-id") ?? 0), state.blocks.length);
    state.disposed = true;
    for (const block of state.blocks) { const body = block.element?.querySelector("tbody"); if (body) streamingTableWindows.get(body)?.dispose(); }
    root.removeEventListener("scroll", state.scroll);
    state.resizeObserver.disconnect();
    if (state.frame) cancelAnimationFrame(state.frame);
  };
  root.addEventListener("scroll", state.scroll, { passive: true });
  state.resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.mdBlockId;
      const index = id === undefined ? undefined : blockIndices.get(id);
      const height = entry.borderBoxSize[0]?.blockSize;
      if (index !== undefined && height !== undefined &&
        Math.abs(height - state.blocks[index].height) > 0.5) {
        measuredHeights.set(index, height);
        measurementPending = true;
      }
    }
    state.scroll();
  });
  state.resizeObserver.observe(host);
  state.refresh();
  restoreAnchor(initialAnchor ?? null);
  return state;
}

function modelWindowBlock(
  block: ReturnType<typeof updateMarkdownModel>["blocks"][number],
  source: string,
): WindowedDocumentBlock {
  let codeScrollTop = 0;
  let tableScrollTop = 0;
  return {
    id: String(block.id), revision: block.revision, html: block.html,
    reusable: block.kind !== "table" && block.kind !== "code",
    estimate: { textLength: block.source.length,
      kind: block.kind === "table" || block.kind === "code" ? "bounded"
        : block.kind === "heading" ? "heading" : block.kind === "rule" ? "rule" : "text" },
    sourceStart: block.sourceStart, sourceEnd: block.sourceEnd, element: null, height: 0,
    create: () => {
      const template = document.createElement("template");
      template.innerHTML = block.table?.shell ?? block.html;
      const root = template.content.firstElementChild as HTMLElement | null;
      if (!root) return null;
      root.setAttribute("data-md-block-id", String(block.id));
      root.setAttribute("data-md-block-revision", String(block.revision));
      root.setAttribute("data-source-start", String(block.sourceStart));
      root.setAttribute("data-source-end", String(block.sourceEnd));
      if (block.kind === "table" && block.table) {
        const body = root.querySelector("tbody");
        const wrap = root.matches(".table-wrap") ? root : root.querySelector<HTMLElement>(".table-wrap");
        if (body && wrap) {
          const controller = createTableRowsWindow(body, wrap, block);
          streamingTableWindows.set(body, controller);
          wrap.scrollTop = tableScrollTop;
          wrap.addEventListener("scroll", () => { tableScrollTop = wrap.scrollTop; }, { passive: true });
        }
      } else if (block.kind === "code") {
        const code = root.querySelector(".code-body");
        if (code && block.children.length > 0) {
          const sourceLines = block.children.map((range) => source.slice(range.sourceStart, range.sourceEnd));
          const button = root.querySelector(".code-copy");
          if (button) markdownCodeCopySources.set(button, sourceLines.join("\n"));
          const lineHeight = Number.parseFloat(getComputedStyle(code).lineHeight) || 20;
          const lineWindow = document.createElement("span");
          lineWindow.className = "code-line-window";
          lineWindow.style.display = "block";
          lineWindow.style.position = "relative";
          lineWindow.style.height = `${sourceLines.length * lineHeight}px`;
          const renderLines = () => {
            codeScrollTop = code.scrollTop;
            const start = Math.max(0, Math.floor(code.scrollTop / lineHeight) - CODE_LINE_OVERSCAN);
            const end = Math.min(sourceLines.length,
              Math.ceil((code.scrollTop + code.clientHeight) / lineHeight) + CODE_LINE_OVERSCAN);
            const fragment = document.createDocumentFragment();
            for (let index = start; index < end; index += 1) {
              const range = block.children[index];
              const line = document.createElement("span");
              line.className = "code-line";
              line.dataset.mdChildId = range.id;
              line.dataset.mdChildRevision = String(range.revision);
              line.dataset.sourceStart = String(range.sourceStart);
              line.dataset.sourceEnd = String(range.sourceEnd);
              line.style.position = "absolute";
              line.style.top = `${index * lineHeight}px`;
              line.style.left = "0";
              line.style.whiteSpace = "pre";
              line.textContent = sourceLines[index];
              fragment.append(line);
            }
            lineWindow.replaceChildren(fragment);
          };
          code.replaceChildren(lineWindow);
          code.scrollTop = codeScrollTop;
          code.addEventListener("scroll", renderLines, { passive: true });
          requestAnimationFrame(renderLines);
        }
      }
      return root;
    },
  };
}

function htmlWindowBlocks(html: string, firstId = 0): WindowedDocumentBlock[] {
  const blocks = splitRenderedBlocks(html);
  if (blocks) return blocks.map((blockHtml, index) => ({
    id: `stream:${firstId + index}`, revision: 0, html: blockHtml,
    estimate: renderedBlockEstimate(blockHtml), element: null, height: 0,
  }));
  const template = document.createElement("template");
  template.innerHTML = html;
  return [...template.content.children].map((element, index) => ({
    id: `stream:${firstId + index}`,
    revision: 0,
    html: element.outerHTML,
    estimate: blockEstimate(element),
    element: null,
    height: 0,
  }));
}

interface StreamingTableWindow {
  update: (rowsHtml: string, source: string, settled: boolean, delta?: string) => void;
  reconcile: (block: MarkdownBlock) => void;
  dispose: () => void;
}
const streamingTableWindows = new WeakMap<HTMLTableSectionElement, StreamingTableWindow>();

function createTableRowsWindow(body: HTMLTableSectionElement, wrap: HTMLElement, initialBlock: MarkdownBlock): StreamingTableWindow {
  let block = initialBlock;
  let rows = block.table!.rows.slice();
  let lengths = block.table!.cellLengths.slice();
  let ranges = block.children.slice(2);
  let widths = block.table!.widths.slice();
  let lineHeight = Number.parseFloat(getComputedStyle(wrap).lineHeight) || 20;
  let sourceLength = block.sourceEnd;
  let pendingLineStart = block.sourceEnd - block.source.length + block.source.lastIndexOf("\n") + 1;
  let pendingLine = block.source.slice(block.source.lastIndexOf("\n") + 1);
  const table = body.closest("table")!;
  const head = table.querySelector("thead");
  const estimate = (cells: number[]) => Math.max(28, cells.reduce((maximum, length, column) =>
    Math.max(maximum, Math.ceil(length * 8 / Math.max(24, (widths[column] ?? widths.at(-1) ?? 80) - 24))), 1) * lineHeight + 12);
  let heights = new HeightIndex(lengths.map(estimate));
  const mounted = new Map<number, HTMLTableRowElement>();
  const measurements = new Map<number, number>();
  let frame = 0;
  let disposed = false;
  let widthKey = "";
  let invalidateEstimates = false;
  const columns = document.createElement("colgroup");
  table.insertBefore(columns, table.firstChild);
  const setColumns = () => {
    columns.replaceChildren(...widths.map((width) => {
      const column = document.createElement("col"); column.style.width = `${width}px`; return column;
    }));
    table.style.tableLayout = "fixed";
    table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    table.style.minWidth = "100%";
    if (head) { head.style.position = "sticky"; head.style.top = "0"; head.style.zIndex = "1"; }
  };
  const spacer = () => {
    const row = document.createElement("tr"); row.className = "table-window-spacer"; row.setAttribute("aria-hidden", "true");
    const cell = document.createElement("td"); cell.style.padding = "0"; cell.style.border = "0";
    cell.append(document.createElement("span")); row.append(cell); return row;
  };
  const topSpacer = spacer(); const bottomSpacer = spacer();
  const bind = (row: HTMLTableRowElement, index: number) => {
    const range = ranges[index];
    row.dataset.mdRowIndex = String(index);
    row.dataset.mdChildId = range?.id ?? `${block.id}:table-row:${index + 2}`;
    row.dataset.mdChildRevision = String(range?.revision ?? 0);
    if (range) { row.dataset.sourceStart = String(range.sourceStart); row.dataset.sourceEnd = String(range.sourceEnd); }
  };
  const schedule = () => {
    if (frame || disposed) return;
    frame = requestAnimationFrame(refresh);
  };
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const index = Number((entry.target as HTMLElement).dataset.mdRowIndex);
      const height = entry.borderBoxSize[0]?.blockSize;
      if (mounted.get(index) === entry.target && Number.isInteger(index) && height !== undefined) measurements.set(index, height);
    }
    schedule();
  });
  function refresh() {
    frame = 0;
    if (disposed || !wrap.isConnected) return;
    const started = performance.now();
    // All geometry/style reads precede writes. ResizeObserver supplies row heights.
    const style = getComputedStyle(wrap);
    const nextKey = [wrap.clientWidth, style.font, style.lineHeight, style.letterSpacing].join("|");
    const viewportHeight = wrap.clientHeight;
    const headerHeight = head?.getBoundingClientRect().height ?? 0;
    const bodyTop = Math.max(0, wrap.scrollTop - headerHeight);
    const anchorIndex = Math.max(0, Math.min(rows.length - 1, heights.lowerBound(bodyTop + 1) - 1));
    const anchorBefore = heights.prefix(anchorIndex);
    if (nextKey !== widthKey || invalidateEstimates) {
      lineHeight = Number.parseFloat(style.lineHeight) || 20;
      heights = new HeightIndex(lengths.map(estimate));
      measurements.clear();
      widthKey = nextKey;
      invalidateEstimates = false;
      // Existing rows may retain the same border-box size and produce no new RO entry.
      // Reobserve them so invalidated estimates always converge to actual geometry.
      for (const row of mounted.values()) { observer.unobserve(row); observer.observe(row); }
    }
    for (const [index, height] of measurements) {
      if (index < heights.length && mounted.has(index) && height > 0) heights.set(index, height);
    }
    measurements.clear();
    const correction = heights.prefix(anchorIndex) - anchorBefore;
    const adjustedTop = Math.max(0, bodyTop + correction);
    const first = Math.max(0, heights.lowerBound(Math.max(0, adjustedTop - 480)) - 1);
    const last = Math.min(rows.length, heights.lowerBound(adjustedTop + viewportHeight + 480) + 1);
    let reused = 0; let created = 0;
    for (const [index, row] of mounted) {
      if (index < first || index >= last) { observer.unobserve(row); row.remove(); mounted.delete(index); }
    }
    const fragment = document.createDocumentFragment();
    for (let index = first; index < last; index += 1) {
      let row = mounted.get(index);
      if (!row) {
        const template = document.createElement("template"); template.innerHTML = rows[index];
        row = template.content.firstElementChild as HTMLTableRowElement;
        if (!row) continue;
        bind(row, index); mounted.set(index, row); observer.observe(row); created += 1;
      } else reused += 1;
      // insert only newly created rows; retaining existing nodes preserves selection.
      if (!row.parentElement) fragment.append(row);
    }
    if (!topSpacer.parentElement) body.prepend(topSpacer);
    if (!bottomSpacer.parentElement) body.append(bottomSpacer);
    if (fragment.childNodes.length) {
      // Newly entering rows can precede the retained window when scrolling upward.
      for (const row of [...fragment.children]) {
        const index = Number((row as HTMLElement).dataset.mdRowIndex);
        const following = [...mounted].filter(([other]) => other > index).sort((a, b) => a[0] - b[0])
          .map(([, node]) => node).find((node) => node.parentElement === body);
        body.insertBefore(row, following ?? bottomSpacer);
      }
    }
    const setSpacer = (row: HTMLTableRowElement, height: number) => {
      const cell = row.firstElementChild as HTMLTableCellElement;
      cell.colSpan = widths.length; cell.style.height = `${Math.max(0, height)}px`;
    };
    setSpacer(topSpacer, heights.prefix(first));
    setSpacer(bottomSpacer, heights.total - heights.prefix(last));
    if (Math.abs(correction) > 0.01) wrap.scrollTop += correction;
    p1Record(14, reused, created, rows.length, performance.now() - started);
  }
  const reconcile = (next: MarkdownBlock) => {
    const data = next.table!;
    let reused = 0;
    for (const [index, row] of mounted) {
      if (rows[index] !== data.rows[index]) { observer.unobserve(row); row.remove(); mounted.delete(index); }
      else reused += 1;
    }
    const oldRows = rows;
    block = next; rows = data.rows.slice(); lengths = data.cellLengths.slice(); ranges = next.children.slice(2);
    const widthChanged = widths.join("|") !== data.widths.join("|"); widths = data.widths.slice();
    if (widthChanged) { setColumns(); invalidateEstimates = true; }
    heights.truncate(rows.length);
    for (let index = 0; index < rows.length; index += 1) {
      if (index >= heights.length) heights.append(estimate(lengths[index]));
      else if (oldRows[index] !== rows[index]) heights.set(index, estimate(lengths[index]));
    }
    for (const [index, row] of mounted) bind(row, index);
    const headerRow = head?.querySelector("tr"); const range = next.children[0];
    if (headerRow && range) {
      headerRow.dataset.mdChildId = range.id; headerRow.dataset.mdChildRevision = String(range.revision);
      headerRow.dataset.sourceStart = String(range.sourceStart); headerRow.dataset.sourceEnd = String(range.sourceEnd);
    }
    p1Record(15, reused, rows.length, 0, 0); schedule();
  };
  const controller: StreamingTableWindow = {
    reconcile,
    update: (rowsHtml, nextSource, settled, delta) => {
      // Consume only the new suffix; metadata and row representations remain persistent.
      const useDelta = delta !== undefined && delta.length === nextSource.length - sourceLength;
      const appended = useDelta ? delta : nextSource.slice(sourceLength);
      p1Record(19, appended.length, useDelta ? 1 : 0, nextSource.length);
      if (appended) {
        const hadPending = pendingLine.includes("|");
        const parts = (pendingLine + appended).split("\n"); pendingLine = parts.pop() ?? "";
        let start = pendingLineStart; let replace = hadPending; let changed = false;
        const add = (line: string) => {
          changed = extendTableColumnWidths(widths, line) || changed;
          if (line.includes("|")) {
            const end = start + (line.endsWith("\r") ? line.length - 1 : line.length);
            if (replace && ranges.length) { ranges[ranges.length - 1] = { ...ranges.at(-1)!, sourceEnd: end, revision: ranges.at(-1)!.revision + 1 }; }
            else { const index = ranges.length + 2; ranges.push({ kind: "table-row", index,
              id: `${block.id}:table-row:${index}`, revision: 0, sourceStart: start, sourceEnd: end }); }
            replace = false;
          }
          start += line.length + 1;
        };
        for (const line of parts) add(line);
        pendingLineStart = start;
        if (pendingLine) add(pendingLine);
        sourceLength = nextSource.length;
        if (changed) { setColumns(); invalidateEstimates = true; }
      }
      const additions = renderedTableRows(rowsHtml);
      if (additions.length) {
        const replaceIndex = Math.max(0, rows.length - 1);
        const oldRow = mounted.get(replaceIndex);
        if (oldRow) { observer.unobserve(oldRow); oldRow.remove(); mounted.delete(replaceIndex); }
        rows.splice(replaceIndex, 1, ...additions);
        lengths.splice(replaceIndex, 1, ...additions.map(tableRowCellLengths));
        heights.truncate(replaceIndex);
        for (let index = replaceIndex; index < rows.length; index += 1) heights.append(estimate(lengths[index]));
      }
      // Keep only ranges belonging to actually rendered rows. No synthetic zero-offset rows.
      if (ranges.length > rows.length) ranges.length = rows.length;
      void settled; schedule();
    },
    dispose: () => { disposed = true; observer.disconnect(); wrap.removeEventListener("scroll", schedule); if (frame) cancelAnimationFrame(frame); },
  };
  setColumns(); body.replaceChildren(); observer.observe(wrap);
  wrap.addEventListener("scroll", schedule, { passive: true });
  reconcile(initialBlock); schedule(); return controller;
}

function createStreamingTableWindow(body: HTMLTableSectionElement, wrap: HTMLElement, source: string): StreamingTableWindow | null {
  const block = updateMarkdownModel(createMarkdownModelCache(), source).blocks.find((candidate) => candidate.kind === "table");
  return block?.table && block.table.rows.length >= 96 ? createTableRowsWindow(body, wrap, block) : null;
}

function chunkElement(): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "markdown-inline-chunk";
  return element;
}

function restoreChunk(chunk: VirtualChunk): void {
  if (!chunk.virtual) return;
  chunk.element.innerHTML = chunk.html;
  chunk.element.style.height = "";
  chunk.virtual = false;
}

function virtualizeChunk(chunk: VirtualChunk, height: number): void {
  if (chunk.virtual) return;
  chunk.element.style.height = `${height}px`;
  chunk.element.replaceChildren();
  chunk.virtual = true;
}

function updateVirtualChunks(state: VirtualParagraph): void {
  if (!state.active) return;
  const bounds = state.root?.getBoundingClientRect() ?? {
    top: 0, bottom: window.innerHeight,
  };
  const measurements = state.chunks.map((chunk) => ({
    chunk, rect: chunk.element.getBoundingClientRect(),
  }));
  for (const { chunk, rect } of measurements) {
    if (rect.bottom >= bounds.top - 600 && rect.top <= bounds.bottom + 600) {
      restoreChunk(chunk);
    } else {
      virtualizeChunk(chunk, rect.height);
    }
  }
}

function createVirtualParagraph(host: HTMLElement): VirtualParagraph {
  const container = document.createElement("div");
  container.className = "markdown-inline-container";
  const root = host.closest(".messages") as HTMLElement | null;
  const byElement = new WeakMap<Element, VirtualChunk>();
  const state: VirtualParagraph = {
    container, chunks: [], active: false, width: 0, root,
    observer: null!, resizeObserver: null!, addChunk: (chunk) => {
      byElement.set(chunk.element, chunk);
      state.observer.observe(chunk.element);
    },
  };
  state.observer = new IntersectionObserver((entries) => {
    if (!state.active) return;
    // IntersectionObserverEntry geometry can be stale if the streamed tail
    // grew after the browser queued this notification. Read current geometry
    // for every exiting chunk before mutating any of them, then apply the
    // placeholders together so scrolling keeps the measured document height.
    const updates = entries.flatMap((entry) => {
      const chunk = byElement.get(entry.target);
      if (!chunk) return [];
      return [{
        chunk,
        intersecting: entry.isIntersecting,
        height: !entry.isIntersecting && !chunk.virtual
          ? chunk.element.getBoundingClientRect().height
          : 0,
      }];
    });
    for (const { chunk, intersecting, height } of updates) {
      if (intersecting) restoreChunk(chunk);
      else virtualizeChunk(chunk, height);
    }
  }, { root, rootMargin: "600px 0px" });
  state.resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0;
    if (!width || Math.abs(width - state.width) < 1) return;
    state.width = width;
    if (!state.active) return;
    for (const chunk of state.chunks) restoreChunk(chunk);
    requestAnimationFrame(() => updateVirtualChunks(state));
  });
  state.resizeObserver.observe(container);
  return state;
}

function finalizeChunk(state: VirtualParagraph, element: HTMLDivElement): void {
  const chunk: VirtualChunk = { element, html: element.innerHTML, virtual: false };
  state.chunks.push(chunk);
  state.addChunk(chunk);
}

function boundPlainStreamChunk(state: VirtualParagraph): void {
  let current = state.current;
  while (current && current.chars >= INLINE_CHUNK_CHARS) {
    const committedText = current.committed.textContent ?? "";
    // Include the pending tail when finding a boundary: it may continue the
    // last committed grapheme. A giant indivisible grapheme stays together.
    const boundary = graphemeBoundary(committedText + (current.live.textContent ?? ""), 0, INLINE_CHUNK_CHARS);
    if (boundary > committedText.length) break;
    const remaining = committedText.slice(boundary);
    current.committed.textContent = committedText.slice(0, boundary);
    current.live.remove();
    finalizeChunk(state, current.element);
    const next = chunkElement();
    const committed = document.createElement("span");
    committed.className = "markdown-stream-committed";
    appendBoundedText(committed, remaining);
    next.append(committed, current.live);
    state.container.append(next);
    current = { element: next, committed, live: current.live, chars: remaining.length };
    state.current = current;
  }
}

function activateVirtualization(state: VirtualParagraph, sourceChars: number): void {
  if (state.active || sourceChars < VIRTUALIZE_AFTER_CHARS) return;
  state.active = true;
  updateVirtualChunks(state);
}

function adoptStaticParagraph(host: HTMLElement, tail: HTMLDivElement, sourceChars: number): VirtualParagraph | null {
  if (sourceChars < VIRTUALIZE_AFTER_CHARS || tail.children.length !== 1) return null;
  const paragraph = tail.firstElementChild;
  if (paragraph?.tagName !== "P") return null;
  const state = createVirtualParagraph(host);
  paragraph.replaceWith(state.container);
  let current = chunkElement();
  state.container.append(current);
  let chars = 0;
  while (paragraph.firstChild) {
    let node = paragraph.firstChild;
    const length = node.textContent?.length ?? 0;
    if (chars && chars + length > INLINE_CHUNK_CHARS) {
      finalizeChunk(state, current);
      current = chunkElement();
      state.container.append(current);
      chars = 0;
    }
    if (node.nodeType === Node.TEXT_NODE && length > INLINE_CHUNK_CHARS) {
      while ((node.textContent?.length ?? 0) > INLINE_CHUNK_CHARS) {
        const nodeText = node.textContent ?? "";
        const boundary = graphemeBoundary(nodeText, 0, INLINE_CHUNK_CHARS);
        const rest = (node as Text).splitText(boundary);
        current.append(node);
        finalizeChunk(state, current);
        current = chunkElement();
        state.container.append(current);
        node = rest;
      }
    }
    current.append(node);
    chars += node.textContent?.length ?? 0;
  }
  finalizeChunk(state, current);
  activateVirtualization(state, sourceChars);
  return state;
}

function appendBoundedText(container: Element, text: string): void {
  let offset = 0;
  while (offset < text.length) {
    let last = container.lastChild;
    if (!last || last.nodeType !== Node.TEXT_NODE || (last as Text).length >= STREAM_TEXT_NODE_CHARS) {
      last = document.createTextNode("");
      container.appendChild(last);
    }
    const node = last as Text;
    const boundary = graphemeBoundary(
      text,
      offset,
      STREAM_TEXT_NODE_CHARS - node.length,
    );
    const count = boundary - offset;
    if (count === 0) break;
    node.appendData(text.slice(offset, offset + count));
    offset += count;
  }
}

/** Renders markdown content. The renderer escapes all user input, so this is
 * safe for `dangerouslySetInnerHTML`. `fadeTail` enables the streaming
 * develop effect on the trailing characters. */
export function Markdown({
  text,
  fadeTail,
  stream,
}: {
  text: string;
  fadeTail?: boolean;
  stream?: { id: string; revision: number; delta: string; fromRevision?: number };
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cacheRef = useRef(createMarkdownStreamCache());
  const modelRef = useRef(createMarkdownModelCache());
  const workerClientIdRef = useRef("");
  if (!workerClientIdRef.current) workerClientIdRef.current = createMarkdownWorkerClientId();
  const workerGenerationRef = useRef(0);
  const workerRequestRef = useRef("");
  const [workerDocument, setWorkerDocument] = useState<MarkdownDocument | null>(null);
  const [preparedWindow, setPreparedWindow] = useState<PreparedWindow | null>(null);
  const replyAtRef = useRef(0);
  const [parseFailure, setParseFailure] = useState<string | null>(null);
  const targetsRef = useRef<{ stable: HTMLDivElement; tail: HTMLDivElement } | null>(null);
  const virtualRef = useRef<VirtualParagraph | null>(null);
  const documentWindowRef = useRef<MarkdownDocumentWindow | null>(null);
  const streamBlockCountRef = useRef(0);
  const settlingAnchorRef = useRef<{ anchor: MarkdownWindowAnchor; index: number } | null>(null);

  useEffect(() => {
    p1Record(46, Number(hostRef.current?.closest(".message-row")?.getAttribute("data-p1-row-id") ?? 0));
    return () => {
    p1Record(47, Number(hostRef.current?.closest(".message-row")?.getAttribute("data-p1-row-id") ?? 0));
    virtualRef.current?.observer.disconnect();
    virtualRef.current?.resizeObserver.disconnect();
    documentWindowRef.current?.dispose();
    const body = targetsRef.current?.tail.querySelector("tbody"); if (body) streamingTableWindows.get(body)?.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    const unsubscribe = subscribeMarkdownWorker(workerClientIdRef.current, (reply) => {
      if (reply.type === "parsed") {
        replyAtRef.current = performance.now();
        p1Record(17, reply.generation);
        workerRequestRef.current = reply.source;
        modelRef.current = { source: reply.source, nextId: reply.nextId, document: reply.document };
        setWorkerDocument(reply.document);
        setParseFailure(null);
      } else {
        setParseFailure(workerRequestRef.current);
        workerRequestRef.current = "";
      }
    });
    return () => {
      unsubscribe();
      workerRequestRef.current = "";
    };
  }, []);

  useEffect(() => {
    if (stream || !workerDocument || workerDocument.source !== text || text.length < VIRTUALIZE_BLOCK_DOCUMENT_AFTER_CHARS) return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const channel = new MessageChannel();
    const prior = documentWindowRef.current;
    const widthKey = documentWidthKey(host);
    const width = host.clientWidth;
    const fontSize = Number.parseFloat(getComputedStyle(host).fontSize) || 14;
    const prepared: PreparedWindow = { source: text, blocks: [], heights: new HeightIndex(), indices: new Map(), widthKey };
    const started = performance.now();
    let index = 0;
    const prepare = () => {
      if (cancelled) return;
      const end = Math.min(index + 128, workerDocument.blocks.length);
      for (; index < end; index += 1) {
        const block = modelWindowBlock(workerDocument.blocks[index], text);
        const old = prior?.blocks[index];
        block.height = old && block.reusable && old.html === block.html && widthKey === prior?.widthKey
          ? old.height : estimateBlockHeight(block, width, fontSize);
        prepared.blocks.push(block); prepared.heights.append(block.height); prepared.indices.set(block.id, index);
      }
      if (index < workerDocument.blocks.length) channel.port2.postMessage(0);
      else { p1Record(18, performance.now() - started, prepared.blocks.length); setPreparedWindow(prepared); }
    };
    channel.port1.onmessage = prepare;
    channel.port2.postMessage(0);
    return () => { cancelled = true; channel.port1.close(); channel.port2.close(); };
  }, [workerDocument, text, !!stream]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const diagnosticStart = performance.now();
    p1Record(7, stream?.revision ?? -1, text.length, stream ? 1 : 0);
    try {
    let targets = targetsRef.current;
    if (!targets) {
      const stable = document.createElement("div");
      stable.className = "markdown-stable";
      const tail = document.createElement("div");
      tail.className = "markdown-tail";
      host.append(stable, tail);
      targets = { stable, tail };
      targetsRef.current = targets;
    }
    const clearVirtual = () => {
      virtualRef.current?.observer.disconnect();
      virtualRef.current?.resizeObserver.disconnect();
      virtualRef.current = null;
      documentWindowRef.current?.dispose();
      documentWindowRef.current = null;
      streamBlockCountRef.current = 0;
    };

    if ((stream || text.length < VIRTUALIZE_BLOCK_DOCUMENT_AFTER_CHARS) && workerRequestRef.current) {
      cancelMarkdownParse(workerClientIdRef.current);
      workerRequestRef.current = "";
    }

    // The settled view consumes the same source-addressable model as the
    // compatibility string renderer. Keep IDs/revisions on semantic roots
    // and exact raw-source offsets on table rows and code lines.
    if (!stream) {
      if (text.length >= VIRTUALIZE_BLOCK_DOCUMENT_AFTER_CHARS && workerDocument?.source !== text) {
        if (parseFailure === text) return;
        if (workerRequestRef.current !== text) {
          workerGenerationRef.current += 1;
          workerRequestRef.current = text;
          requestMarkdownParse(workerClientIdRef.current, workerGenerationRef.current, text, modelRef.current);
        }
        return;
      }
      if (workerDocument?.source === text && text.length >= VIRTUALIZE_BLOCK_DOCUMENT_AFTER_CHARS && preparedWindow?.source !== text) return;
      const activeAnchor = documentWindowRef.current?.captureAnchor() ?? null;
      const streamIndex = activeAnchor?.blockId.startsWith("stream:")
        ? Number(activeAnchor.blockId.slice("stream:".length))
        : activeAnchor
          ? documentWindowRef.current?.blocks.findIndex((block) => block.id === activeAnchor.blockId) ?? -1
          : -1;
      settlingAnchorRef.current = activeAnchor && Number.isInteger(streamIndex) && streamIndex >= 0
        ? { anchor: activeAnchor, index: streamIndex }
        : null;
      const retainedWindow = documentWindowRef.current;
      if (!retainedWindow) clearVirtual();
      p1Record(9, modelRef.current.document.blocks.length, text.length);
      if (!retainedWindow) targets.stable.replaceChildren();
      const model = workerDocument?.source === text
        ? workerDocument
        : updateMarkdownModel(modelRef.current, text);
      const tailBody = targets.tail.querySelector<HTMLTableSectionElement>("tbody");
      const tailController = tailBody ? streamingTableWindows.get(tailBody) : undefined;
      const finalTable = model.blocks.length === 1 ? model.blocks[0] : undefined;
      if (tailController && finalTable?.table &&
        targets.tail.querySelector("thead")?.innerHTML.replace(/ data-(?:md|source)[^=]*="[^"]*"/g, "") === /<thead>([^]*?)<\/thead>/.exec(finalTable.table.shell)?.[1]) {
        const root = targets.tail.querySelector<HTMLElement>(".table-wrap")!;
        root.dataset.mdBlockId = String(finalTable.id); root.dataset.mdBlockRevision = String(finalTable.revision);
        root.dataset.sourceStart = String(finalTable.sourceStart); root.dataset.sourceEnd = String(finalTable.sourceEnd);
        tailController.reconcile(finalTable); p1Record(16, 1); return;
      }
      tailController?.dispose();
      targets.tail.replaceChildren();
      if (model.blocks.length === 1 &&
        model.blocks[0].kind === "paragraph" &&
        text.length >= VIRTUALIZE_AFTER_CHARS) {
        const block = model.blocks[0];
        const template = document.createElement("template");
        template.innerHTML = block.html;
        const root = template.content.firstElementChild;
        if (root) {
          root.setAttribute("data-md-block-id", String(block.id));
          root.setAttribute("data-md-block-revision", String(block.revision));
          root.setAttribute("data-source-start", String(block.sourceStart));
          root.setAttribute("data-source-end", String(block.sourceEnd));
          targets.tail.append(template.content);
          const state = adoptStaticParagraph(host, targets.tail, text.length);
          if (state) {
            state.container.setAttribute("data-md-block-id", String(block.id));
            state.container.setAttribute("data-md-block-revision", String(block.revision));
            state.chunks.forEach((chunk, index) => {
              chunk.element.setAttribute("data-md-block-id", String(block.id));
              chunk.element.setAttribute("data-md-block-revision", String(block.revision));
              chunk.element.setAttribute("data-md-chunk-index", String(index));
            });
            virtualRef.current = state;
          }
          return;
        }
      }
      const hasLargeChildWindow = model.blocks.some((block) => block.kind === "table" || block.kind === "code");
      if (text.length >= VIRTUALIZE_BLOCK_DOCUMENT_AFTER_CHARS &&
        (model.blocks.length > 1 || hasLargeChildWindow)) {
        const blocks = preparedWindow?.source === text ? preparedWindow.blocks : model.blocks.map((block) => modelWindowBlock(block, text));
        const pendingAnchor = settlingAnchorRef.current;
        const targetBlock = pendingAnchor ? blocks[pendingAnchor.index] : undefined;
        const mappedAnchor = pendingAnchor && targetBlock
          ? { ...pendingAnchor.anchor, blockId: targetBlock.id }
          : null;
        if (retainedWindow) retainedWindow.reconcile(blocks, mappedAnchor, preparedWindow?.source === text ? preparedWindow : undefined);
        else documentWindowRef.current = makeDocumentWindow(targets.stable, blocks, mappedAnchor);
        settlingAnchorRef.current = null;
        if (documentWindowRef.current) return;
      }
      if (retainedWindow) { clearVirtual(); targets.stable.replaceChildren(); }
      const fragment = document.createDocumentFragment();
      for (const block of model.blocks) {
        const template = document.createElement("template");
        template.innerHTML = block.html;
        const root = template.content.firstElementChild;
        if (!root) continue;
        root.setAttribute("data-md-block-id", String(block.id));
        root.setAttribute("data-md-block-revision", String(block.revision));
        root.setAttribute("data-source-start", String(block.sourceStart));
        root.setAttribute("data-source-end", String(block.sourceEnd));
        if (block.kind === "table") {
          const rows = [...root.querySelectorAll("tr")];
          const ranges = [block.children[0], ...block.children.slice(2)];
          rows.forEach((row, index) => {
            const range = ranges[index];
            if (!range) return;
            row.setAttribute("data-md-child-id", range.id);
            row.setAttribute("data-md-child-revision", String(range.revision));
            row.setAttribute("data-source-start", String(range.sourceStart));
            row.setAttribute("data-source-end", String(range.sourceEnd));
          });
        } else if (block.kind === "code") {
          const code = root.querySelector(".code-body");
          const lines = code?.textContent?.split("\n") ?? [];
          if (code && lines.length === block.children.length) {
            const lineFragment = document.createDocumentFragment();
            lines.forEach((line, index) => {
              if (index) lineFragment.append(document.createTextNode("\n"));
              const range = block.children[index];
              const span = document.createElement("span");
              span.className = "code-line";
              span.setAttribute("data-md-child-id", range.id);
              span.setAttribute("data-md-child-revision", String(range.revision));
              span.setAttribute("data-source-start", String(range.sourceStart));
              span.setAttribute("data-source-end", String(range.sourceEnd));
              span.textContent = line;
              lineFragment.append(span);
            });
            code.replaceChildren(lineFragment);
          }
        }
        fragment.append(template.content);
      }
      targets.stable.append(fragment);
      return;
    }

    const update = renderMarkdownStreamUpdate(
      cacheRef.current,
      text,
      fadeTail ? STREAM_FADE_CHARS : 0,
      !!fadeTail,
      stream,
    );
    if (update.reset) { p1Record(50, stream.revision, text.length); clearVirtual(); }
    else if (update.inlineStart || update.plainStart ||
      (!update.inlineAppend && !update.inlineFinal && !update.plainAppend && virtualRef.current)) {
      // Tail paragraph transitions must not dispose the independent stable document.
      virtualRef.current?.observer.disconnect();
      virtualRef.current?.resizeObserver.disconnect();
      virtualRef.current = null;
    }
    if (update.reset) targets.stable.replaceChildren();
    if (update.stableHtml) {
      if (documentWindowRef.current) {
        const next = htmlWindowBlocks(update.stableHtml, streamBlockCountRef.current);
        streamBlockCountRef.current += next.length;
        documentWindowRef.current.blocks.push(...next);
        documentWindowRef.current.scroll();
      } else if (text.length >= VIRTUALIZE_BLOCK_DOCUMENT_AFTER_CHARS) {
        const priorHtml = [...targets.stable.children].map((element) => element.outerHTML).join("");
        const allBlocks = htmlWindowBlocks(priorHtml + update.stableHtml);
        const hasLargeBlock = allBlocks.some((block) => block.estimate?.kind === "bounded");
        if (allBlocks.length > 1 || hasLargeBlock) {
          streamBlockCountRef.current = allBlocks.length;
          documentWindowRef.current = makeDocumentWindow(targets.stable, allBlocks);
        }
        if (!documentWindowRef.current) {
          const template = document.createElement("template");
          template.innerHTML = update.stableHtml;
          targets.stable.append(template.content);
        }
      } else {
        const template = document.createElement("template");
        template.innerHTML = update.stableHtml;
        targets.stable.append(template.content);
      }
    }
    if (update.plainStart) {
      const state = createVirtualParagraph(host);
      const chunk = chunkElement();
      const committed = document.createElement("span");
      committed.className = "markdown-stream-committed";
      appendBoundedText(committed, update.plainStart.committedText);
      const live = document.createElement("span");
      live.className = "markdown-stream-live";
      live.innerHTML = update.plainStart.fadeHtml;
      chunk.append(committed, live);
      state.container.append(chunk);
      state.current = { element: chunk, committed, live, chars: update.plainStart.committedText.length };
      targets.tail.replaceChildren(state.container);
      virtualRef.current = state;
      boundPlainStreamChunk(state);
      activateVirtualization(state, text.length);
    } else if (update.plainAppend) {
      const state = virtualRef.current;
      const current = state?.current;
      if (state && current) {
        appendBoundedText(current.committed, update.plainAppend.committedText);
        current.chars += update.plainAppend.committedText.length;
        current.live.innerHTML = update.plainAppend.fadeHtml;
        boundPlainStreamChunk(state);
        activateVirtualization(state, text.length);
      }
    } else if (update.fenceAppend !== undefined) {
      const code = targets.tail.querySelector(".code-body");
      if (code) appendBoundedText(code, update.fenceAppend);
    } else if (update.tableAppend) {
      const body = targets.tail.querySelector(".md-table tbody") as HTMLTableSectionElement | null;
      if (body) {
        const window = streamingTableWindows.get(body);
        if (window) {
          window.update(update.tableAppend.rowsHtml, text, !fadeTail, stream.delta);
        } else {
          body.lastElementChild?.remove();
          const template = document.createElement("template");
          template.innerHTML = update.tableAppend.rowsHtml;
          body.append(template.content);
          if (body.querySelectorAll("tr").length >= 96) {
            const wrap = body.closest(".table-wrap") as HTMLElement | null;
            const nextWindow = wrap ? createStreamingTableWindow(body, wrap, text) : null;
            if (nextWindow) streamingTableWindows.set(body, nextWindow);
          }
        }
      }
    } else if (update.inlineStart) {
      const state = createVirtualParagraph(host);
      const chunk = chunkElement();
      const committed = document.createElement("span");
      committed.className = "markdown-inline-committed";
      committed.innerHTML = update.inlineStart.committedHtml;
      const live = document.createElement("span");
      live.className = "markdown-inline-live";
      live.innerHTML = update.inlineStart.liveHtml;
      chunk.append(committed, live);
      state.container.append(chunk);
      state.current = {
        element: chunk, committed, live,
        chars: committed.textContent?.length ?? 0,
      };
      targets.tail.replaceChildren(state.container);
      virtualRef.current = state;
    } else if (update.inlineAppend) {
      const state = virtualRef.current;
      const current = state?.current;
      if (current && update.inlineAppend.committedHtml) {
        const template = document.createElement("template");
        template.innerHTML = update.inlineAppend.committedHtml;
        current.chars += template.content.textContent?.length ?? 0;
        current.committed.append(template.content);
      }
      if (current) {
        current.live.innerHTML = update.inlineAppend.liveHtml;
        if (current.chars >= INLINE_CHUNK_CHARS && state) {
          current.live.remove();
          finalizeChunk(state, current.element);
          const next = chunkElement();
          const committed = document.createElement("span");
          committed.className = "markdown-inline-committed";
          next.append(committed, current.live);
          state.container.append(next);
          state.current = { element: next, committed, live: current.live, chars: 0 };
        }
        if (state) activateVirtualization(state, text.length);
      }
    } else if (update.inlineFinal) {
      if (update.inlineFinal.liveHtml !== undefined && virtualRef.current?.current) {
        virtualRef.current.current.live.innerHTML = update.inlineFinal.liveHtml;
      }
      if (virtualRef.current) activateVirtualization(virtualRef.current, text.length);
    } else {
      const oldBody = targets.tail.querySelector("tbody"); if (oldBody) streamingTableWindows.get(oldBody)?.dispose();
      targets.tail.innerHTML = update.tailHtml;
      virtualRef.current = adoptStaticParagraph(host, targets.tail, text.length);
      const body = targets.tail.querySelector(".md-table tbody") as HTMLTableSectionElement | null;
      const wrap = body?.closest(".table-wrap") as HTMLElement | null;
      if (body && wrap && body.querySelectorAll("tr").length >= 96 && !streamingTableWindows.has(body)) {
        const tableWindow = createStreamingTableWindow(body, wrap, text);
        if (tableWindow) streamingTableWindows.set(body, tableWindow);
      }
    }
    } finally { p1Record(8, stream?.revision ?? -1, performance.now() - diagnosticStart, stream ? 1 : 0, !stream && replyAtRef.current ? performance.now() - replyAtRef.current : 0); }
  }, [text, fadeTail, stream?.id, stream?.revision, stream?.delta, stream?.fromRevision, workerDocument, preparedWindow, parseFailure]);

  return (
    <>
      <div className="markdown" ref={hostRef} />
      {!stream && parseFailure === text ? (
        <div role="alert" className="error-banner">
          内容暂时无法显示。
          <button type="button" className="ghost" onClick={() => setParseFailure(null)}>重试显示</button>
        </div>
      ) : null}
    </>
  );
}
