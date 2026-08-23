import { useMemo } from "react";
import { renderMarkdown } from "../lib/markdown";

/** Renders markdown content. The renderer escapes all user input, so this is
 * safe for `dangerouslySetInnerHTML`. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
