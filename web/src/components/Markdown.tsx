import { useMemo } from "react";
import { renderMarkdown, STREAM_FADE_CHARS } from "../lib/markdown";

/** Renders markdown content. The renderer escapes all user input, so this is
 * safe for `dangerouslySetInnerHTML`. `fadeTail` enables the streaming
 * develop effect on the trailing characters. */
export function Markdown({ text, fadeTail }: { text: string; fadeTail?: boolean }) {
  const html = useMemo(
    () => renderMarkdown(text, 0, fadeTail ? STREAM_FADE_CHARS : 0),
    [text, fadeTail],
  );
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
