// ---------- Streaming fade tail ----------

/** Trailing characters that get the position-based opacity/blur ramp. */
export const STREAM_FADE_CHARS = 18;

const FADE_MIN_OPACITY = 0.15;
const FADE_MAX_BLUR = 1.4;

/** Splits an HTML text run (no tags) into visible characters; entities such
 * as `&amp;` or `&#39;` stay whole so wrapping cannot break them. */
function visibleChars(run: string): string[] {
  return run.match(/&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+);|[\s\S]/g) ?? [];
}

/** Wraps the trailing `fadeWindow` visible characters of the final text run
 * in graded spans: opacity climbs toward the window edge while blur recedes
 * (newest = faintest + most blurred, "developing" into solid text). The run
 * sits just before the block's closing tags, so list items, table cells,
 * code bodies and link labels fade uniformly — no per-block plumbing. */
export function fadeTrailingText(html: string, fadeWindow: number): string {
  if (!html || fadeWindow <= 0) return html;
  // Block tags are joined with newlines (lists emit <li>/</li> as separate
  // parts), so the closing run allows whitespace between and before tags.
  const closings = /(?:<\/[a-zA-Z][^<>]*>\s*)+$/.exec(html)?.[0] ?? "";
  let head = html.slice(0, html.length - closings.length);
  const gap = /\s*$/.exec(head)?.[0] ?? "";
  head = head.slice(0, head.length - gap.length);
  const run = /[^<>]*$/.exec(head)?.[0] ?? "";
  if (!run.trim()) return html;
  const chars = visibleChars(run);
  const start = Math.max(0, chars.length - fadeWindow);
  let faded = "";
  for (let i = start; i < chars.length; i++) {
    const t = Math.min(1, (chars.length - 1 - i) / fadeWindow);
    const opacity = FADE_MIN_OPACITY + (1 - FADE_MIN_OPACITY) * t;
    const blur = FADE_MAX_BLUR * (1 - t);
    faded += `<span class="fch" style="opacity:${opacity.toFixed(3)};filter:blur(${blur.toFixed(2)}px)">${chars[i]}</span>`;
  }
  return (
    head.slice(0, head.length - run.length) +
    chars.slice(0, start).join("") +
    faded +
    gap +
    closings
  );
}
