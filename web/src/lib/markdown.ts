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
  const rows: string[][] = [];
  while (j < blocks.length) {
    const line = blocks[j];
    const trimmed = line.trim();
    if (
      !trimmed ||
      line.startsWith("<pre") ||
      /^(#{1,6})\s/.test(trimmed) ||
      /^([-*_])(\s*\1){2,}$/.test(trimmed) ||
      trimmed.startsWith(">") ||
      isListItem(line) ||
      !hasUnescapedPipe(line)
    ) {
      break;
    }
    rows.push(splitRow(line));
    j++;
  }
  const head = header
    .map((c, k) => `${cellOpen("th", aligns[k])}${renderInline(c)}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${header
          .map((_, k) => `${cellOpen("td", aligns[k])}${renderInline(r[k] ?? "")}</td>`)
          .join("")}</tr>`,
    )
    .join("");
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
          ? renderMarkdown(inner.join("\n"), depth + 1)
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
export function renderMarkdown(text: string, depth = 0, fadeTail = 0): string {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = renderFenced(raw);
  const html = renderBlocks(blocks, depth);
  return fadeTail > 0 ? fadeTrailingText(html, fadeTail) : html;
}
