const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPE[ch] ?? ch);
}

/** Emphasis runs on already-escaped plain text (never inside code spans). */
function renderEmphasis(escaped: string): string {
  let out = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out;
}

// Single pass over raw text so tokens cannot corrupt each other (e.g. bold
// markers inside a code span, or a bare URL inside a link's href).
const INLINE_TOKEN_RE =
  /(`[^`\n]+`)|(!\[[^\]\n]*\]\(https?:\/\/[^)\s]+\))|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<()]*)*)/g;

const LINK_RE = /^(!?)\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)$/;

function linkTag(url: string, label: string): string {
  return (
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">` +
    `${renderEmphasis(escapeHtml(label))}</a>`
  );
}

export function renderInline(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE_TOKEN_RE)) {
    const tok = m[0];
    const idx = m.index ?? 0;
    out += renderEmphasis(escapeHtml(text.slice(last, idx)));
    if (tok.startsWith("`")) {
      out += `<code>${escapeHtml(tok.slice(1, -1))}</code>`;
    } else {
      const link = LINK_RE.exec(tok);
      if (link) {
        // Images render as plain links: a local UI should not fire requests
        // at arbitrary remote hosts just by displaying a message.
        const label = link[1] === "!" ? link[2] || link[3] : link[2];
        out += linkTag(link[3], label);
      } else {
        // Bare URL: trim trailing punctuation and keep it visible as text.
        const url = tok.replace(/[.,;:!?'"]+$/, "");
        out += linkTag(url, url);
        if (url.length < tok.length) out += escapeHtml(tok.slice(url.length));
      }
    }
    last = idx + tok.length;
  }
  out += renderEmphasis(escapeHtml(text.slice(last)));
  return out;
}
