const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** Split trusted renderer output without constructing a detached DOM for every
 * offscreen block. This is not an HTML sanitizer or a parser for user HTML.
 * Renderer attributes/text escape literal angles; unexpected shapes use the
 * browser parser fallback rather than risking a truncated block. */
export function splitRenderedBlocks(html: string): string[] | null {
  const blocks: string[] = [];
  const tags = /<\/?([a-z][a-z0-9-]*)(?:\s[^<>]*?)?\s*\/?>/gi;
  const stack: string[] = [];
  let start = 0;
  let end = 0;
  for (const match of html.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    const offset = match.index!;
    if (!stack.length) {
      if (html.slice(end, offset).trim()) return null;
      start = offset;
    }
    if (match[0].startsWith("</")) {
      if (stack.pop() !== tag) return null;
    } else if (!VOID_TAGS.has(tag) && !match[0].endsWith("/>")) {
      stack.push(tag);
    }
    if (!stack.length) {
      end = offset + match[0].length;
      blocks.push(html.slice(start, end));
    }
  }
  return stack.length || html.slice(end).trim() ? null : blocks;
}

export function renderedBlockEstimate(html: string): {
  textLength: number; kind: "bounded" | "heading" | "rule" | "text";
} {
  const opening = html.slice(0, html.indexOf(">") + 1);
  return {
    textLength: html.replace(/<[^>]*>/g, "").replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, "x").length,
    kind: /class="(?:table-wrap|code-block)"/.test(opening) ? "bounded"
      : /^<h[1-6](?:\s|>)/i.test(opening) ? "heading"
        : /^<hr(?:\s|\/?>)/i.test(opening) ? "rule" : "text",
  };
}
