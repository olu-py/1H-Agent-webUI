import { tableWindowData, type TableWindowData } from "./table-data";
import { escapeHtml, renderInline } from "./markdown/inline";
import { fadeTrailingText } from "./markdown/fade";
export { STREAM_FADE_CHARS } from "./markdown/fade";

// Dependency-free Markdown renderer (extended from the v1 web UI port).
// Safe by construction: no raw HTML passes through; all user content is
// escaped before inline processing, and we only ever emit tags we generate
// ourselves.
//
// Supported blocks: fenced code (``` and ~~~), ATX headings (#..######),
// GFM tables (with alignment and escaped pipes), blockquotes (recursive),
// horizontal rules, nested ordered/unordered lists, task lists, paragraphs
// (single newlines render as <br>). Inline: code spans, links (https only),
// bare-URL autolinks, images-as-links (no automatic remote loads), bold,
// italic, strikethrough.
//
// Deliberate deviations from CommonMark: `---` is always an <hr> (never a
// setext heading), soft line breaks become <br>, images render as links.
//
// Streaming: the optional `fadeTail` count wraps the trailing characters of
// the final text run in position-based opacity/blur spans (the "develop"
// effect). Both values are pure functions of the distance to the end, so
// they are recomputed — never replayed — on every per-chunk innerHTML rebuild.

// ---------- Fenced code blocks ----------

function fenceInfo(line: string): { char: string; lang: string } | null {
  const m = /^(`{3,}|~{3,})(.*)$/.exec(line.trim());
  return m ? { char: m[1][0], lang: m[2].trim() } : null;
}

/** Renders one fenced code block with a language label and copy button. The
 * copy button is wired by event delegation (see MessageList) because the block
 * is injected via `dangerouslySetInnerHTML`. */
function codeBlock(lang: string, code: string): string {
  const safeLang = escapeHtml(lang);
  return (
    `<pre class="code-block" data-lang="${safeLang}">` +
    `<div class="code-head">` +
    `<span class="code-lang">${safeLang || "code"}</span>` +
    `<button type="button" class="code-copy" data-copy>复制</button>` +
    `</div>` +
    `<code class="code-body">${escapeHtml(code)}</code>` +
    `</pre>`
  );
}

/** Splits lines into fenced `<pre>` blocks and plain lines. */
function renderFenced(lines: string[]): string[] {
  const html: string[] = [];
  let open: { char: string; lang: string } | null = null;
  let codeBuf: string[] = [];
  for (const line of lines) {
    const fence = fenceInfo(line);
    if (fence) {
      if (!open) {
        open = fence;
        codeBuf = [];
      } else if (fence.char === open.char) {
        html.push(codeBlock(open.lang, codeBuf.join("\n")));
        open = null;
      } else {
        codeBuf.push(line);
      }
    } else if (open) {
      codeBuf.push(line);
    } else {
      html.push(line);
    }
  }
  if (open) {
    html.push(codeBlock(open.lang, codeBuf.join("\n")));
  }
  return html;
}

// ---------- Tables ----------

function hasUnescapedPipe(line: string): boolean {
  return line.replace(/\\\|/g, "").includes("|");
}

/** Splits a table row on unescaped pipes; `\|` becomes a literal `|`. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparatorRow(line: string): boolean {
  if (!hasUnescapedPipe(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function cellOpen(tag: "th" | "td", align: string): string {
  return `<${tag}${align ? ` class="${align}"` : ""}>`;
}

function isTableBodyLine(line: string): boolean {
  const trimmed = line.trim();
  return !!trimmed && !line.startsWith("<pre") &&
    !fenceInfo(line) &&
    !/^(#{1,6})\s/.test(trimmed) &&
    !/^([-*_])(\s*\1){2,}$/.test(trimmed) &&
    !trimmed.startsWith(">") && !isListItem(line) && hasUnescapedPipe(line);
}

function isTableHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  return hasUnescapedPipe(line) && !fenceInfo(line) &&
    !/^(#{1,6})\s/.test(trimmed) &&
    !/^([-*_])(\s*\1){2,}$/.test(trimmed) &&
    !trimmed.startsWith(">") && !isListItem(line);
}

function renderTableBodyRow(line: string, aligns: string[]): string {
  const cells = splitRow(line);
  return `<tr>${aligns.map((align, k) =>
    `${cellOpen("td", align)}${renderInline(cells[k] ?? "")}</td>`).join("")}</tr>`;
}

/** Renders a GFM table starting at blocks[start] (header row). `start + 1`
 * must already be known to be the separator row. Returns the HTML and the
 * index of the first block after the table. */
function renderTable(
  blocks: string[],
  start: number,
): { html: string; end: number } {
  const header = splitRow(blocks[start]);
  const sepCells = splitRow(blocks[start + 1]);
  const aligns = header.map((_, k) => {
    const m = /^(:?)(-+)(:?)$/.exec(sepCells[k] ?? "");
    if (!m) return "";
    return m[1] && m[3] ? "ta-center" : m[3] ? "ta-right" : "";
  });
  let j = start + 2;
  const rows: string[] = [];
  while (j < blocks.length) {
    const line = blocks[j];
    if (!isTableBodyLine(line)) break;
    rows.push(line);
    j++;
  }
  const head = header
    .map((c, k) => `${cellOpen("th", aligns[k])}${renderInline(c)}</th>`)
    .join("");
  const body = rows.map((row) => renderTableBodyRow(row, aligns)).join("");
  return {
    html:
      `<div class="table-wrap"><table class="md-table">` +
      `<thead><tr>${head}</tr></thead>` +
      `<tbody>${body}</tbody></table></div>`,
    end: j,
  };
}

// ---------- Lists ----------

function isListItem(line: string): boolean {
  return /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+/.test(line);
}

function indentOf(prefix: string): number {
  let w = 0;
  for (const ch of prefix) w += ch === "\t" ? 4 : 1;
  return w;
}

const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK_RE = /^\[([ xX])\][ \t]+(.*)$/;

// ---------- Block rendering ----------

const MAX_QUOTE_DEPTH = 6;

function renderBlocks(blocks: string[], depth: number): string {
  const html: string[] = [];
  let para: string[] = [];
  let afterBlank = false;
  const lists: { tag: "ul" | "ol"; indent: number; liOpen: boolean }[] = [];

  const flushPara = (): void => {
    if (para.length) {
      html.push(
        `<p>${para
          .map((line) => renderInline(line.replace(/[ \t]+$/, "")))
          .join("<br>")}</p>`,
      );
      para = [];
    }
  };
  const closeLists = (): void => {
    while (lists.length) {
      const frame = lists.pop();
      if (!frame) break;
      if (frame.liOpen) html.push("</li>");
      html.push(`</${frame.tag}>`);
    }
  };

  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];

    // Fenced code block produced by renderFenced.
    if (block.startsWith("<pre")) {
      flushPara();
      closeLists();
      html.push(block);
      afterBlank = false;
      i++;
      continue;
    }

    const trimmed = block.trim();
    if (!trimmed) {
      flushPara();
      afterBlank = true;
      i++;
      continue;
    }

    // Heading (#..######).
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushPara();
      closeLists();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      afterBlank = false;
      i++;
      continue;
    }

    // Horizontal rule (checked before lists so "- - -" is a rule, not items).
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      flushPara();
      closeLists();
      html.push("<hr>");
      afterBlank = false;
      i++;
      continue;
    }

    // Blockquote: strip one ">" per line and recurse through the full
    // pipeline (so quotes may contain code blocks, tables, nested quotes…).
    if (trimmed.startsWith(">")) {
      flushPara();
      closeLists();
      const inner: string[] = [];
      while (i < blocks.length && blocks[i].trim().startsWith(">")) {
        inner.push(blocks[i].replace(/^[ \t]*>[ \t]?/, ""));
        i++;
      }
      const innerHtml =
        depth < MAX_QUOTE_DEPTH
          ? renderMarkdownLegacy(inner.join("\n"), depth + 1)
          : `<p>${escapeHtml(inner.join("\n"))}</p>`;
      html.push(`<blockquote>${innerHtml}</blockquote>`);
      afterBlank = false;
      continue;
    }

    // Table: header row followed by a delimiter row.
    if (hasUnescapedPipe(block) && i + 1 < blocks.length && isSeparatorRow(blocks[i + 1])) {
      flushPara();
      closeLists();
      const table = renderTable(blocks, i);
      html.push(table.html);
      i = table.end;
      afterBlank = false;
      continue;
    }

    // List item. An ordered item with a number other than 1 cannot interrupt
    // a paragraph (CommonMark rule; keeps "In 2024. things" out of lists).
    const item = LIST_ITEM_RE.exec(block);
    if (item && !(para.length > 0 && /\d/.test(item[2][0]) && item[2] !== "1." && item[2] !== "1)")) {
      flushPara();
      afterBlank = false;
      const indent = indentOf(item[1]);
      const ordered = /\d/.test(item[2][0]);
      const tag: "ul" | "ol" = ordered ? "ol" : "ul";
      const num = ordered ? parseInt(item[2], 10) : 1;
      // Dedent: close deeper levels (>= 2 spaces shallower).
      while (
        lists.length &&
        lists[lists.length - 1] &&
        indent < lists[lists.length - 1].indent - 1
      ) {
        const frame = lists.pop();
        if (!frame) break;
        if (frame.liOpen) html.push("</li>");
        html.push(`</${frame.tag}>`);
      }
      const top = lists[lists.length - 1];
      if (!top) {
        lists.push({ tag, indent, liOpen: false });
        html.push(tag === "ol" && num !== 1 ? `<ol start="${num}">` : `<${tag}>`);
      } else if (indent >= top.indent + 2) {
        // Nested list inside the currently open <li>.
        lists.push({ tag, indent, liOpen: false });
        html.push(tag === "ol" && num !== 1 ? `<ol start="${num}">` : `<${tag}>`);
      } else if (top.tag !== tag) {
        // Same level, list type switch: close and reopen.
        if (top.liOpen) html.push("</li>");
        html.push(`</${top.tag}>`);
        lists.pop();
        lists.push({ tag, indent, liOpen: false });
        html.push(tag === "ol" && num !== 1 ? `<ol start="${num}">` : `<${tag}>`);
      } else if (top.liOpen) {
        html.push("</li>");
      }
      const frame = lists[lists.length - 1];
      if (frame) frame.liOpen = true;
      const task = TASK_RE.exec(item[3]);
      if (task) {
        html.push(
          `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}>${renderInline(task[2])}`,
        );
      } else {
        html.push(`<li>${renderInline(item[3])}`);
      }
      i++;
      continue;
    }

    // Lazy continuation: a plain line right after an open list item extends
    // that item (multi-line bullets) unless a blank line intervened.
    const top = lists[lists.length - 1];
    if (top && top.liOpen && para.length === 0 && !afterBlank) {
      html.push(`<br>${renderInline(trimmed)}`);
      i++;
      continue;
    }

    // Paragraph line (closes any open list, as in the v1 renderer).
    closeLists();
    para.push(block);
    i++;
  }
  flushPara();
  closeLists();
  return html.join("\n");
}

/** Renders markdown to an HTML string; safe for `dangerouslySetInnerHTML`.
 * `fadeTail` > 0 fades the trailing characters (streaming effect). */
function renderMarkdownLegacy(text: string, depth = 0, fadeTail = 0): string {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = renderFenced(raw);
  const html = renderBlocks(blocks, depth);
  return fadeTail > 0 ? fadeTrailingText(html, fadeTail) : html;
}

export type MarkdownBlockKind = "paragraph" | "heading" | "rule" | "quote" | "table" | "list" | "code" | "document";
export type MarkdownSubrangeKind = "table-row" | "code-line";

export interface MarkdownSourceRange {
  /** Offsets are UTF-16 code-unit offsets into the original, unnormalized input. */
  sourceStart: number;
  sourceEnd: number;
}

export interface MarkdownSubrange extends MarkdownSourceRange {
  id: string;
  kind: MarkdownSubrangeKind;
  revision: number;
  index: number;
}

export interface MarkdownBlock extends MarkdownSourceRange {
  /** Monotonic local identity; content is deliberately not used as a key. */
  id: number;
  revision: number;
  kind: MarkdownBlockKind;
  source: string;
  html: string;
  children: MarkdownSubrange[];
  table?: TableWindowData;
}

export interface MarkdownDocument {
  source: string;
  blocks: MarkdownBlock[];
  html: string;
}

export interface MarkdownModelCache {
  source: string;
  nextId: number;
  document: MarkdownDocument;
}

interface SourceLine extends MarkdownSourceRange {
  text: string;
}

type ScannedBlock = Omit<MarkdownBlock, "id" | "revision" | "html" | "children">;

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    let textEnd = end;
    if (textEnd > start && source.charCodeAt(textEnd - 1) === 13) textEnd--;
    // Exclude the CRLF delimiter from the line's source range while preserving
    // UTF-16 offsets into the original, unnormalized input.
    lines.push({ sourceStart: start, sourceEnd: textEnd, text: source.slice(start, textEnd) });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

function lineKind(lines: SourceLine[], index: number): MarkdownBlockKind {
  const line = lines[index]?.text ?? "";
  const trimmed = line.trim();
  if (fenceInfo(line)) return "code";
  if (trimmed.startsWith(">")) return "quote";
  if (/^(#{1,6})\s+/.test(trimmed)) return "heading";
  if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) return "rule";
  if (hasUnescapedPipe(line) && isSeparatorRow(lines[index + 1]?.text ?? "")) return "table";
  if (LIST_ITEM_RE.test(line)) return "list";
  return "paragraph";
}

function startsBlock(lines: SourceLine[], index: number): boolean {
  const line = lines[index]?.text ?? "";
  const kind = lineKind(lines, index);
  if (kind === "list") {
    const item = LIST_ITEM_RE.exec(line);
    // Match renderBlocks: ordered items other than 1 cannot interrupt an
    // already-open paragraph, though they start a list at a block boundary.
    if (item && /\d/.test(item[2][0]) && item[2] !== "1." && item[2] !== "1)") {
      return false;
    }
  }
  return kind !== "paragraph" ||
    (hasUnescapedPipe(line) && isSeparatorRow(lines[index + 1]?.text ?? ""));
}

function scanSourceBlocks(source: string): ScannedBlock[] {
  const lines = sourceLines(source);
  const ranges: ScannedBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && !lines[index].text.trim()) index++;
    if (index >= lines.length) break;
    const startIndex = index;
    const kind = lineKind(lines, index);
    if (kind === "code") {
      const opening = fenceInfo(lines[index].text);
      index++;
      while (index < lines.length) {
        const close = fenceInfo(lines[index].text);
        index++;
        if (close && opening && close.char === opening.char) break;
      }
    } else if (kind === "quote") {
      while (index < lines.length && lines[index].text.trim().startsWith(">")) index++;
    } else if (kind === "heading" || kind === "rule") {
      index++;
    } else if (kind === "table") {
      index += 2;
      while (index < lines.length && isTableBodyLine(lines[index].text)) index++;
    } else if (kind === "list") {
      index++;
      while (index < lines.length) {
        const current = lines[index].text;
        if (LIST_ITEM_RE.test(current)) { index++; continue; }
        if (!current.trim()) {
          let next = index + 1;
          while (next < lines.length && !lines[next].text.trim()) next++;
          if (next < lines.length && (LIST_ITEM_RE.test(lines[next].text) || /^[ \t]+\S/.test(lines[next].text))) {
            index = next;
            continue;
          }
          break;
        }
        if (/^[ \t]+\S/.test(current)) { index++; continue; }
        if (startsBlock(lines, index)) break;
        // A lazy continuation belongs to the preceding list item.
        index++;
      }
    } else {
      index++;
      while (index < lines.length && lines[index].text.trim() && !startsBlock(lines, index)) index++;
    }
    const first = lines[startIndex];
    const last = lines[Math.max(startIndex, index - 1)];
    const sourceStart = first.sourceStart;
    const sourceEnd = last.sourceEnd;
    ranges.push({ kind, sourceStart, sourceEnd, source: source.slice(sourceStart, sourceEnd) });
  }
  return ranges;
}

function childRanges(block: Omit<MarkdownBlock, "html" | "children">): Omit<MarkdownSubrange, "id" | "revision">[] {
  const lines = sourceLines(block.source);
  if (block.kind === "table") {
    return lines.map((line, index) => ({
      kind: "table-row" as const,
      index,
      sourceStart: block.sourceStart + line.sourceStart,
      sourceEnd: block.sourceStart + line.sourceEnd,
    }));
  }
  if (block.kind === "code") {
    const opening = fenceInfo(lines[0]?.text ?? "");
    let end = lines.length;
    for (let index = 1; index < lines.length; index++) {
      const close = fenceInfo(lines[index].text);
      if (close && opening && close.char === opening.char) { end = index; break; }
    }
    const content = lines.slice(1, end);
    return content.map((line, index) => ({
      kind: "code-line" as const,
      index,
      sourceStart: block.sourceStart + line.sourceStart,
      sourceEnd: block.sourceStart + line.sourceEnd,
    }));
  }
  return [];
}

function createBlockHtml(blocks: MarkdownBlock[], fallbackSource: string): { blocks: MarkdownBlock[]; html: string } {
  const html = blocks.map((block) => block.html).filter(Boolean).join("\n");
  // Keep an executable compatibility oracle in development and tests without
  // paying for a second full-document parse in production.
  if (!import.meta.env.DEV || html === renderMarkdownLegacy(fallbackSource)) {
    return { blocks, html };
  }
  const source = fallbackSource;
  const expected = renderMarkdownLegacy(source);
  return {
    blocks: [{ id: blocks[0]?.id ?? 1, revision: blocks[0]?.revision ?? 0,
      kind: "document", sourceStart: 0, sourceEnd: source.length, source,
      html: expected, children: [] }],
    html: expected,
  };
}

export function createMarkdownModelCache(): MarkdownModelCache {
  return { source: "", nextId: 1, document: { source: "", blocks: [], html: "" } };
}

/** Parse into source-addressable blocks while preserving the legacy HTML byte-for-byte.
 * Completed blocks reuse their numeric IDs; only a changed previous tail can advance
 * its revision in place. Table rows and code lines retain original-source ranges. */
export function updateMarkdownModel(cache: MarkdownModelCache, input: string): MarkdownDocument {
  const source = String(input ?? "");
  const samePrefix = source.startsWith(cache.source);
  const oldByStart = new Map(cache.document.blocks.map((block) => [block.sourceStart, block]));
  const scanned = scanSourceBlocks(source);
  const blocks: MarkdownBlock[] = scanned.map((raw) => {
    const previous = samePrefix ? oldByStart.get(raw.sourceStart) : undefined;
    const same = previous?.source === raw.source && previous.kind === raw.kind;
    const mutableTail = previous && previous.sourceEnd === cache.source.length;
    const id = previous && (same || mutableTail) ? previous.id : cache.nextId++;
    const revision = !previous ? 0 : same ? previous.revision : mutableTail ? previous.revision + 1 : 0;
    const base = { ...raw, id, revision };
    const children = childRanges(base).map((child) => {
      const previousChild = previous?.children[child.index];
      const childSame = previousChild?.sourceStart === child.sourceStart &&
        previousChild.sourceEnd === child.sourceEnd;
      return { ...child, id: `${id}:${child.kind}:${child.index}`,
        revision: childSame ? previousChild.revision : previousChild ? previousChild.revision + 1 : 0 };
    });
    const html = renderMarkdownLegacy(raw.source);
    return { ...base, html, children, ...(raw.kind === "table" ? { table: tableWindowData(html, raw.source) } : {}) };
  });
  const rendered = createBlockHtml(blocks, source);
  cache.source = source;
  cache.document = { source, blocks: rendered.blocks, html: rendered.html };
  return cache.document;
}

/** Compatibility string renderer. Both APIs serialize the same source-mapped model. */
export function renderMarkdown(text: string, depth = 0, fadeTail = 0): string {
  const source = String(text ?? "");
  const html = depth === 0
    ? updateMarkdownModel(createMarkdownModelCache(), source).html
    : renderMarkdownLegacy(source, depth);
  return fadeTail > 0 ? fadeTrailingText(html, fadeTail) : html;
}

/** Mutable per-message cache used by the streaming view. Only blank-line
 * terminated segments outside an open fence are committed; that boundary
 * closes the renderer's paragraph/list/table/quote contexts. */
export interface MarkdownStreamCache {
  source: string;
  rawSource: string;
  stablePrefixLength: number;
  lastBlankEnd: number;
  fenceScanOffset: number;
  openFence: string | null;
  streamId: string | null;
  streamRevision: number;
  tailSource: string;
  scanOffset: number;
  scanLineParts: string[];
  scanPreviousLf: boolean;
  fenceAtLastBlank: string | null;
  pendingCR: boolean;
  normalizedLength: number;
  plainMode: boolean;
  plainPending: string;
  table: TableStreamState | null;
  inline: InlineStreamState | null;
  inlineFinalized: boolean;
}

interface TableStreamState {
  aligns: string[];
  pendingLine: string;
  lastRowLine: string;
}

interface InlineStreamState {
  pending: string;
  started: boolean;
}

export interface MarkdownStreamUpdate {
  stableHtml: string;
  tailHtml: string;
  reset: boolean;
  fenceAppend?: string;
  plainStart?: { committedText: string; fadeHtml: string };
  plainAppend?: { committedText: string; fadeHtml: string };
  tableAppend?: { rowsHtml: string };
  inlineStart?: { committedHtml: string; liveHtml: string };
  inlineAppend?: { committedHtml: string; liveHtml: string };
  inlineFinal?: { liveHtml?: string };
}

export function createMarkdownStreamCache(): MarkdownStreamCache {
  return {
    source: "",
    rawSource: "",
    stablePrefixLength: 0,
    lastBlankEnd: 0,
    fenceScanOffset: 0,
    openFence: null,
    streamId: null,
    streamRevision: 0,
    tailSource: "",
    scanOffset: 0,
    scanLineParts: [],
    scanPreviousLf: false,
    fenceAtLastBlank: null,
    pendingCR: false,
    normalizedLength: 0,
    plainMode: false,
    plainPending: "",
    table: null,
    inline: null,
    inlineFinalized: false,
  };
}

function resetIncrementalScan(cache: MarkdownStreamCache): void {
  cache.openFence = null;
  cache.lastBlankEnd = 0;
  cache.scanOffset = 0;
  cache.scanLineParts = [];
  cache.scanPreviousLf = false;
  cache.fenceAtLastBlank = null;
  cache.pendingCR = false;
  cache.table = null;
  cache.inline = null;
  cache.inlineFinalized = false;
}

const MAX_INLINE_PENDING = 4096;

/** Find a whitespace checkpoint that the complete inline parser agrees is
 * closed. A raw delimiter left in the rendered prefix could pair with future
 * text, so that prefix stays live. The comparison also preserves the exact
 * fade boundary when the last text run spans several source words. */
function inlineCheckpoint(text: string, fadeTail: number): {
  end: number; committedHtml: string; liveHtml: string;
} {
  const whole = `<p>${renderInline(text.replace(/[ \t]+$/, ""))}</p>`;
  const faded = fadeTrailingText(whole, fadeTail);
  let search = Math.max(0, text.length - Math.max(64, fadeTail + 32));
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const end = text.lastIndexOf(" ", search) + 1;
    if (!end) break;
    const committedHtml = renderInline(text.slice(0, end));
    if (!/[*~`\[]/.test(committedHtml)) {
      const liveSource = text.slice(end).replace(/[ \t]+$/, "");
      const liveHtml = fadeTrailingText(`<p>${renderInline(liveSource)}</p>`, fadeTail).slice(3, -4);
      if (`<p>${committedHtml}${liveHtml}</p>` === faded) {
        return { end, committedHtml, liveHtml };
      }
    }
    search = end - 2;
    if (search < 0) break;
  }
  return { end: 0, committedHtml: "", liveHtml: faded.slice(3, -4) };
}

function startInlineStream(cache: MarkdownStreamCache, fadeTail: number): void {
  if (cache.inline || cache.table || cache.stablePrefixLength ||
    cache.tailSource.length > MAX_INLINE_PENDING || cache.tailSource.includes("\n")) return;
  if (inlineCheckpoint(cache.tailSource, fadeTail).end > 0) {
    cache.inline = { pending: cache.tailSource, started: false };
  }
}

function appendInlineStream(cache: MarkdownStreamCache, appended: string, fadeTail: number): MarkdownStreamUpdate | null {
  const inline = cache.inline;
  if (!inline || fadeTail <= 0 || appended.includes("\n")) return null;
  const combined = inline.pending + appended;
  const checkpoint = inlineCheckpoint(combined, fadeTail);
  if (combined.length > MAX_INLINE_PENDING && checkpoint.end === 0) return null;
  inline.pending = combined.slice(checkpoint.end);
  const started = inline.started;
  inline.started = true;
  return started
    ? { stableHtml: "", tailHtml: "", reset: false, inlineAppend: {
      committedHtml: checkpoint.committedHtml, liveHtml: checkpoint.liveHtml,
    } }
    : { stableHtml: "", tailHtml: "", reset: false, inlineStart: {
      committedHtml: checkpoint.committedHtml, liveHtml: checkpoint.liveHtml,
    } };
}

/** Only a top-level table with at least one body row enters the fast path.
 * Its most recent row remains replaceable so the fade stays on the final cell. */
function startTableStream(cache: MarkdownStreamCache): void {
  // Delta coalescing can make the first usable table snapshot much larger
  // than a single transport chunk. A one-time table scan is still bounded;
  // refusing it here leaves the entire table on the DOM fast path forever.
  if (cache.table || cache.tailSource.length > 1024 * 1024) return;
  const lines = cache.tailSource.split("\n");
  if (lines.length < 3 || !isTableHeaderLine(lines[0]) || !isSeparatorRow(lines[1])) return;
  const body = lines.slice(2);
  if (body[body.length - 1] === "") body.pop();
  if (!body.length || !body.every(isTableBodyLine)) return;
  const header = splitRow(lines[0]);
  const separators = splitRow(lines[1]);
  const aligns = header.map((_, k) => {
    const match = /^(:?)(-+)(:?)$/.exec(separators[k] ?? "");
    return match ? (match[1] && match[3] ? "ta-center" : match[3] ? "ta-right" : "") : "";
  });
  cache.table = {
    aligns,
    pendingLine: lines[lines.length - 1],
    lastRowLine: body[body.length - 1],
  };
}

function appendTableStream(cache: MarkdownStreamCache, appended: string, fadeTail: number): MarkdownStreamUpdate | null {
  const table = cache.table;
  if (!table || fadeTail <= 0 || cache.lastBlankEnd > cache.stablePrefixLength) return null;
  const lines = (table.pendingLine + appended).split("\n");
  const complete = lines.slice(0, -1);
  const pending = lines[lines.length - 1];
  if (!complete.every(isTableBodyLine) || (pending && !isTableBodyLine(pending))) return null;
  const rows = table.pendingLine ? complete : [table.lastRowLine, ...complete];
  if (pending) rows.push(pending);
  if (!rows.length) return null;
  const last = rows.pop()!;
  const rowsHtml = rows.map((line) => renderTableBodyRow(line, table.aligns)).join("") +
    fadeTrailingText(renderTableBodyRow(last, table.aligns), fadeTail);
  table.pendingLine = pending;
  table.lastRowLine = last;
  return { stableHtml: "", tailHtml: "", reset: false, tableAppend: { rowsHtml } };
}

/** Converts just the incoming delta. A CRLF split over two transport chunks
 * must still normalize to a single LF. */
function normalizeStreamDelta(cache: MarkdownStreamCache, input: string): string {
  let text = input;
  if (cache.pendingCR) {
    if (text.startsWith("\n")) text = text.slice(1);
    cache.pendingCR = false;
  }
  const trailingCR = text.endsWith("\r");
  const normalized = text.replace(/\r\n?/g, "\n");
  cache.pendingCR = trailingCR;
  return normalized;
}

/** Advances blank-line and fence state using only the new text. In particular,
 * this never slices/searches the cumulative V8 string for a trusted delta. */
function advanceIncrementalScan(cache: MarkdownStreamCache, appended: string): boolean {
  const baseOffset = cache.scanOffset;
  let start = 0;
  let closedFence = false;
  while (start < appended.length) {
    const newline = appended.indexOf("\n", start);
    if (newline < 0) break;
    const part = appended.slice(start, newline);
    const blankBoundary = cache.scanPreviousLf && part.length === 0;
    cache.scanLineParts.push(part);
    const line = cache.scanLineParts.join("");
    cache.scanLineParts = [];
    const fence = fenceInfo(line);
    if (fence) {
      if (cache.openFence === null) cache.openFence = fence.char;
      else if (cache.openFence === fence.char) {
        cache.openFence = null;
        closedFence = true;
      }
    }
    const end = baseOffset + newline + 1;
    if (blankBoundary) {
      cache.lastBlankEnd = end;
      cache.fenceAtLastBlank = cache.openFence;
    }
    cache.scanPreviousLf = true;
    start = newline + 1;
  }
  const rest = appended.slice(start);
  if (rest) {
    cache.scanLineParts.push(rest);
    cache.scanPreviousLf = false;
  }
  cache.scanOffset = baseOffset + appended.length;
  return closedFence;
}

function rebuildIncrementalState(
  cache: MarkdownStreamCache,
  source: string,
  rawSource: string,
  stream: { id: string; revision: number },
): void {
  resetIncrementalScan(cache);
  advanceIncrementalScan(cache, source);
  cache.tailSource = source.slice(cache.stablePrefixLength);
  cache.normalizedLength = source.length;
  cache.source = source;
  cache.rawSource = rawSource;
  cache.streamId = stream.id;
  cache.streamRevision = stream.revision;
  cache.pendingCR = rawSource.endsWith("\r");
}

function renderTrustedStreamAppend(
  cache: MarkdownStreamCache,
  rawSource: string,
  delta: string,
  stream: { id: string; revision: number },
  fadeTail: number,
): MarkdownStreamUpdate {
  const oldStablePrefix = cache.stablePrefixLength;
  const previouslyOpenFence = cache.openFence;
  const appended = normalizeStreamDelta(cache, delta);
  cache.tailSource += appended;
  const closedFence = advanceIncrementalScan(cache, appended);
  cache.normalizedLength += appended.length;
  cache.source += appended;
  cache.rawSource = rawSource;
  cache.streamId = stream.id;
  cache.streamRevision = stream.revision;

  if (previouslyOpenFence !== null && !closedFence && cache.openFence === previouslyOpenFence) {
    return { stableHtml: "", tailHtml: "", reset: false, fenceAppend: appended };
  }

  const tableUpdate = appendTableStream(cache, appended, fadeTail);
  if (tableUpdate) return tableUpdate;
  const inlineUpdate = appendInlineStream(cache, appended, fadeTail);
  if (inlineUpdate) return inlineUpdate;
  cache.table = null;
  cache.inline = null;

  const boundary = cache.lastBlankEnd;
  let stableHtml = "";
  if (boundary > oldStablePrefix) {
    const segmentLength = boundary - oldStablePrefix;
    const segment = cache.tailSource.slice(0, segmentLength);
    const rest = cache.tailSource.slice(segmentLength);
    const nextLine = rest.replace(/^\n+/, "").split("\n", 1)[0] ?? "";
    const nextMayContinueList = (!rest || couldStartList(nextLine)) &&
      segment.split("\n").some(isListItem);
    if (cache.fenceAtLastBlank !== null || nextMayContinueList) {
      const tailHtml = renderMarkdown(cache.tailSource, 0, fadeTail);
      return {
        stableHtml,
        tailHtml: oldStablePrefix && tailHtml ? `\n${tailHtml}` : tailHtml,
        reset: false,
      };
    }
    stableHtml = oldStablePrefix ? `\n${renderMarkdown(segment)}` : renderMarkdown(segment);
    cache.stablePrefixLength = boundary;
    cache.tailSource = rest;
  }

  const tailHtml = renderMarkdown(cache.tailSource, 0, fadeTail);
  if (fadeTail > 0) {
    startTableStream(cache);
    startInlineStream(cache, fadeTail);
  }
  return {
    stableHtml,
    tailHtml: cache.stablePrefixLength && tailHtml ? `\n${tailHtml}` : tailHtml,
    reset: false,
  };
}

const PLAIN_MARKDOWN_SYNTAX = /[\r\n*_~`\[\]!>#|\-]/;
const URL_PREFIXES = ["http://", "https://"];

function isPlainStreamText(text: string): boolean {
  return !PLAIN_MARKDOWN_SYNTAX.test(text) && !/https?:\/\//.test(text);
}

/** Leaves only a possible trailing `http(s)://` prefix uncommitted so a URL
 * split across transport deltas can still be recognized by the complete parser. */
function possibleUrlSuffixLength(text: string): number {
  let longest = 0;
  for (const prefix of URL_PREFIXES) {
    for (let length = 1; length < prefix.length && length <= text.length; length += 1) {
      if (text.endsWith(prefix.slice(0, length))) longest = Math.max(longest, length);
    }
  }
  return longest;
}

function plainStreamAppend(
  cache: MarkdownStreamCache,
  rawSource: string,
  delta: string,
  stream: { id: string; revision: number },
  fadeTail: number,
  initial: boolean,
): { committedText: string; fadeHtml: string } | null {
  if (!isPlainStreamText(delta)) return null;
  const combined = cache.plainPending + delta;
  if (/https?:\/\//.test(combined)) return null;
  const urlSuffix = possibleUrlSuffixLength(combined);
  const safeEnd = combined.length - urlSuffix;
  const fadeCount = Math.min(fadeTail, safeEnd);
  const commitEnd = safeEnd - fadeCount;
  const committedText = combined.slice(0, commitEnd);
  cache.plainPending = combined.slice(commitEnd);
  cache.plainMode = true;
  cache.source = initial ? rawSource : cache.source + delta;
  cache.rawSource = rawSource;
  cache.normalizedLength = cache.source.length;
  cache.streamId = stream.id;
  cache.streamRevision = stream.revision;
  const fadeHtml = fadeTail > 0
    ? fadeTrailingText(escapeHtml(cache.plainPending), fadeTail)
    : escapeHtml(cache.plainPending);
  return { committedText, fadeHtml };
}

function resetAfterPlainFallback(
  cache: MarkdownStreamCache,
  rawSource: string,
  fadeTail: number,
  stream?: { id: string; revision: number },
): { stableHtml: string; tailHtml: string; reset: boolean } {
  const source = rawSource.replace(/\r\n?/g, "\n");
  cache.stablePrefixLength = 0;
  cache.tailSource = source;
  cache.plainMode = false;
  cache.plainPending = "";
  if (stream) rebuildIncrementalState(cache, source, rawSource, stream);
  else {
    cache.source = source;
    cache.rawSource = rawSource;
    cache.streamId = null;
    cache.streamRevision = 0;
  }
  return { stableHtml: "", tailHtml: renderMarkdown(source, 0, fadeTail), reset: true };
}

function advanceFenceScan(cache: MarkdownStreamCache, source: string, end: number): void {
  while (cache.fenceScanOffset < end) {
    const newline = source.indexOf("\n", cache.fenceScanOffset);
    if (newline < 0 || newline >= end) break;
    const fence = fenceInfo(source.slice(cache.fenceScanOffset, newline));
    if (fence) {
      if (cache.openFence === null) cache.openFence = fence.char;
      else if (cache.openFence === fence.char) cache.openFence = null;
    }
    cache.fenceScanOffset = newline + 1;
  }
}

function couldStartList(line: string): boolean {
  return isListItem(line) || /^\s*(?:[-*+]|\d{1,9}[.)]?)(?:\s+.*)?$/.test(line);
}

/** Returns only newly committed HTML plus the live tail. Callers append the
 * committed fragment once and replace just the live tail on later deltas. */
export function renderMarkdownStreamUpdate(
  cache: MarkdownStreamCache,
  input: string,
  fadeTail = 0,
  appendOnly = false,
  stream?: { id: string; revision: number; delta: string; fromRevision?: number },
): MarkdownStreamUpdate {
  const rawSource = String(input ?? "");
  const oldLength = cache.source.length;
  const oldRawLength = cache.rawSource.length;
  // `stream` is emitted only by appendStream(), whose revision is advanced in
  // the same state update as its delta. Avoid validating with startsWith or
  // endsWith here: on a large V8 cons string either operation can flatten the
  // complete response on every event. Length catches a missed/duplicated byte
  // range; revision and message key establish the reducer append invariant.
  const sequentialStreamAppend = appendOnly && stream !== undefined &&
    cache.streamId === stream.id &&
    (stream.fromRevision === undefined
      ? stream.revision === cache.streamRevision + 1
      : stream.fromRevision === cache.streamRevision && stream.revision > cache.streamRevision) &&
    rawSource.length === oldRawLength + stream.delta.length;
  if (cache.plainMode) {
    if (
      appendOnly && stream && fadeTail > 0 && cache.streamId === stream.id &&
      stream.revision === cache.streamRevision && rawSource.length === oldRawLength
    ) {
      return {
        stableHtml: "",
        tailHtml: "",
        reset: false,
        plainAppend: {
          committedText: "",
          fadeHtml: fadeTrailingText(escapeHtml(cache.plainPending), fadeTail),
        },
      };
    }
    if (sequentialStreamAppend && stream && fadeTail > 0) {
      const update = plainStreamAppend(cache, rawSource, stream.delta, stream, fadeTail, false);
      if (update) return { stableHtml: "", tailHtml: "", reset: false, plainAppend: update };
    }
    return resetAfterPlainFallback(cache, rawSource, fadeTail, stream);
  }
  if (cache.inline && fadeTail === 0 && rawSource === cache.rawSource) {
    const liveHtml = renderInline(cache.inline.pending.replace(/[ \t]+$/, ""));
    cache.inline = null;
    cache.inlineFinalized = true;
    return {
      stableHtml: "", tailHtml: renderMarkdown(cache.tailSource), reset: false,
      inlineFinal: { liveHtml },
    };
  }
  if (cache.inlineFinalized && fadeTail === 0 && rawSource === cache.rawSource) {
    return { stableHtml: "", tailHtml: renderMarkdown(cache.tailSource), reset: false, inlineFinal: {} };
  }
  cache.inlineFinalized = false;
  if (!oldRawLength && appendOnly && stream && fadeTail > 0 && isPlainStreamText(rawSource)) {
    cache.stablePrefixLength = 0;
    cache.tailSource = "";
    resetIncrementalScan(cache);
    const update = plainStreamAppend(cache, rawSource, rawSource, stream, fadeTail, true);
    if (update) return { stableHtml: "", tailHtml: "", reset: false, plainStart: update };
  }
  if (sequentialStreamAppend && stream) {
    return renderTrustedStreamAppend(cache, rawSource, stream.delta, stream, fadeTail);
  }
  cache.table = null;
  cache.inline = null;
  const reset = sequentialStreamAppend
    ? false
    : !rawSource.startsWith(cache.rawSource);
  const appended = sequentialStreamAppend
    ? stream.delta
    : rawSource.slice(reset ? 0 : oldRawLength);
  const normalizedAppend = appended.replace(/\r\n?/g, "\n");
  const source = reset
    ? rawSource.replace(/\r\n?/g, "\n")
    : oldLength !== oldRawLength || appended.includes("\r")
      ? cache.source + normalizedAppend
      : rawSource;
  if (reset) {
    cache.stablePrefixLength = 0;
    cache.lastBlankEnd = 0;
    cache.fenceScanOffset = 0;
    cache.openFence = null;
    cache.tailSource = "";
    resetIncrementalScan(cache);
  }
  const scanStart = reset ? 0 : Math.max(0, oldLength - 1);
  const local = source.slice(scanStart);
  const blank = local.lastIndexOf("\n\n");
  if (blank >= 0) cache.lastBlankEnd = scanStart + blank + 2;
  cache.source = source;
  cache.rawSource = rawSource;
  if (stream) {
    cache.streamId = stream.id;
    cache.streamRevision = stream.revision;
  } else if (reset) {
    cache.streamId = null;
    cache.streamRevision = 0;
  }

  const boundary = cache.lastBlankEnd;
  let stableHtml = "";
  if (boundary > cache.stablePrefixLength) {
    const hadStablePrefix = cache.stablePrefixLength > 0;
    const segment = source.slice(cache.stablePrefixLength, boundary);
    const rest = source.slice(boundary).replace(/^\n+/, "");
    const nextLine = rest.split("\n", 1)[0] ?? "";
    const nextMayContinueList = (!rest || couldStartList(nextLine)) &&
      segment.split("\n").some(isListItem);
    advanceFenceScan(cache, source, boundary);
    if (cache.openFence !== null || nextMayContinueList) {
      const tailHtml = renderMarkdown(source.slice(cache.stablePrefixLength), 0, fadeTail);
      if (stream) rebuildIncrementalState(cache, source, rawSource, stream);
      return {
        stableHtml,
        tailHtml: cache.stablePrefixLength && tailHtml ? `\n${tailHtml}` : tailHtml,
        reset,
      };
    }
    const candidateHtml = renderMarkdown(segment);
    stableHtml = hadStablePrefix ? `\n${candidateHtml}` : candidateHtml;
    cache.stablePrefixLength = boundary;
    cache.fenceScanOffset = boundary;
    cache.openFence = null;
  }

  const tail = source.slice(cache.stablePrefixLength);
  const tailHtml = renderMarkdown(tail, 0, fadeTail);
  if (stream) rebuildIncrementalState(cache, source, rawSource, stream);
  if (fadeTail > 0) {
    startTableStream(cache);
    startInlineStream(cache, fadeTail);
  }
  return {
    stableHtml,
    tailHtml: cache.stablePrefixLength && tailHtml ? `\n${tailHtml}` : tailHtml,
    reset,
  };
}
