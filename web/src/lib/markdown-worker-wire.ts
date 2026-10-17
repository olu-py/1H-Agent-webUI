import type { MarkdownBlock, MarkdownDocument, MarkdownModelCache } from "./markdown";
/** The source remains in the requesting client. Block HTML is authoritative;
 * the aggregate HTML is a derived compatibility view, never cloned twice. */
export function receivedMarkdownDocument(source: string, blocks: MarkdownBlock[]): MarkdownDocument {
  let combined: string | undefined;
  return { source, blocks, get html() { return combined ??= blocks.map(block => block.html).filter(Boolean).join("\n"); } };
}
/** updateMarkdownModel reads the previous blocks and cache.source, but never
 * the derived document HTML/source. Do not trigger the lazy aggregate getter. */
export function markdownWorkerSeed(seed: MarkdownModelCache | undefined): MarkdownModelCache | undefined {
  if (!seed) return undefined;
  return { source: seed.source, nextId: seed.nextId, document: { source: "", html: "", blocks: seed.document.blocks } };
}
