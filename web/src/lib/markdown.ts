// Minimal, dependency-free Markdown renderer (ported from the v1 web UI).
// Safe by construction: no raw HTML passes through; all user content is
// escaped before inline processing.

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPE[ch] ?? ch);
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return out;
}

function isFenceLine(line: string): boolean {
  return /^```/.test(line.trim());
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
  let inFence = false;
  let fenceLang = "";
  let codeBuf: string[] = [];
  for (const line of lines) {
    if (isFenceLine(line)) {
      if (!inFence) {
        inFence = true;
        fenceLang = line.trim().slice(3).trim();
        codeBuf = [];
      } else {
        html.push(codeBlock(fenceLang, codeBuf.join("\n")));
        inFence = false;
      }
    } else if (inFence) {
      codeBuf.push(line);
    } else {
      html.push(line);
    }
  }
  if (inFence) {
    html.push(codeBlock(fenceLang, codeBuf.join("\n")));
  }
  return html;
}

/** Renders markdown to an HTML string; safe for `dangerouslySetInnerHTML`. */
export function renderMarkdown(text: string): string {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = renderFenced(raw);
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length) {
      html.push(`<p>${renderInline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const block of blocks) {
    if (block.startsWith("<pre")) {
      flushPara();
      flushList();
      html.push(block);
      continue;
    }
    const trimmed = block.trim();
    if (!trimmed) {
      flushPara();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const ulItem = /^\s*[-*+]\s+(.*)$/.exec(trimmed);
    if (ulItem) {
      flushPara();
      if (list !== "ul") {
        flushList();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li>${renderInline(ulItem[1])}</li>`);
      continue;
    }
    const olItem = /^\s*\d+[.)]\s+(.*)$/.exec(trimmed);
    if (olItem) {
      flushPara();
      if (list !== "ol") {
        flushList();
        html.push("<ol>");
        list = "ol";
      }
      html.push(`<li>${renderInline(olItem[1])}</li>`);
      continue;
    }
    if (list) {
      flushList();
    }
    para.push(block);
  }
  flushPara();
  flushList();
  return html.join("\n");
}
