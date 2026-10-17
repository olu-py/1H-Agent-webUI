import { createMarkdownModelCache, updateMarkdownModel, type MarkdownModelCache } from "./markdown";

interface ParseMessage {
  type: "parse";
  clientId: string;
  generation: number;
  source: string;
  seed?: MarkdownModelCache;
  diagnostic?: boolean;
}
self.onmessage = (event: MessageEvent<ParseMessage>) => {
  const { clientId, generation, source, seed } = event.data;
  // The committed model survives termination in the component. Canceled
  // parses never advance its stable block IDs or revisions.
  const cache = seed ?? createMarkdownModelCache();
  try {
    const started = performance.now();
    const document = updateMarkdownModel(cache, source);
    const parseMs = performance.now() - started;
    let textBytes = 0;
    let legacyTextBytes = 0;
    if (event.data.diagnostic) {
      const encoder = new TextEncoder();
      legacyTextBytes = encoder.encode(cache.source).byteLength + encoder.encode(document.source).byteLength + encoder.encode(document.html).byteLength;
      for (const block of document.blocks) {
        textBytes += encoder.encode(block.source).byteLength + encoder.encode(block.html).byteLength;
        if (block.table) textBytes += encoder.encode(block.table.shell).byteLength + block.table.rows.reduce((sum, row) => sum + encoder.encode(row).byteLength, 0);
      }
    }
    self.postMessage({ type: "parsed", clientId, generation, nextId: cache.nextId, blocks: document.blocks,
      diagnostics: { parseMs, textBytes, legacyTextBytes: legacyTextBytes + textBytes, blocks: document.blocks.length } });
  } catch (error) {
    self.postMessage({ type: "failed", clientId, generation, error: String(error) });
  }
};
