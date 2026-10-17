import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { appendStream } from "../src/state/transcript";
import { initialState, type UiState } from "../src/state/reducer";
import {
  createMarkdownStreamCache,
  renderMarkdown,
  renderMarkdownStreamUpdate,
} from "../src/lib/markdown";

const DELTA_CHARS = 512;
const SIZES = [16 * 1024, 64 * 1024, 256 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024];
const WORKLOADS = ["stable-block", "open-fence", "large-table", "no-break", "formatted-tail"] as const;

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function deltaFor(workload: typeof WORKLOADS[number]): string {
  switch (workload) {
    case "stable-block": return `${"x".repeat(510)}\n\n`;
    case "open-fence": return `${"x".repeat(511)}\n`;
    case "large-table": return `|${"x".repeat(509)}|\n`;
    case "no-break": return "x".repeat(DELTA_CHARS);
    case "formatted-tail": return "**text** 中文 benchmark. ".repeat(23).slice(0, DELTA_CHARS);
  }
}

function prefixFor(workload: typeof WORKLOADS[number]): string {
  switch (workload) {
    case "stable-block": return "";
    case "open-fence": return "```text\n";
    case "large-table": return `|${"h".repeat(509)}|\n|${"-".repeat(509)}|\n`;
    case "no-break": return "";
    case "formatted-tail": return "";
  }
}

function makeRow(kind: typeof WORKLOADS[number], seed: string): UiState {
  const state = { ...initialState, activeSession: "diagnostic" };
  return prefixFor(kind)
    ? { ...state, messages: [{
      key: "diagnostic-row", id: -1, kind: "assistant", role: "assistant", content: "",
      createdAt: new Date(0).toISOString(), streamingText: seed,
      streamRevision: seed ? 1 : 0, streamingDelta: "",
    }] }
    : state;
}

describe("M4 per-increment Markdown diagnostics", () => {
  it("records reducer and parser percentiles at each requested size and checks the full-parser oracle", () => {
    const maxBytes = Number(process.env.M4_DIAG_MAX_BYTES || 256 * 1024);
    const minBytes = Number(process.env.M4_DIAG_MIN_BYTES || 0);
    const sizes = SIZES.filter((size) => size <= maxBytes && size >= minBytes);
    const selectedWorkload = process.env.M4_DIAG_WORKLOAD;
    const workloads = selectedWorkload
      ? WORKLOADS.filter((workload) => workload === selectedWorkload)
      : WORKLOADS;
    if (sizes.length === 0 || workloads.length === 0) throw new Error("empty diagnostic selection");
    const results: Record<string, unknown> = {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      deltaChars: DELTA_CHARS,
      maxBytes,
      displayMetrics: null,
      browserDomLayoutMetrics: null,
      cases: [],
    };

    const evidenceDirectory = resolve(process.cwd(), "../design/performance");
    mkdirSync(evidenceDirectory, { recursive: true });
    const evidencePath = resolve(evidenceDirectory, `m4-markdown-diagnostic-${maxBytes}-${workloads.join("-")}.json`);

    for (const workload of workloads) {
      for (const targetSize of sizes) {
        const prefix = prefixFor(workload);
        const delta = deltaFor(workload);
        const count = Math.ceil(Math.max(0, targetSize - prefix.length) / delta.length);
        const expectedChars = prefix.length + count * delta.length;
        const reducerMs: number[] = [];
        const parserMs: number[] = [];
        const stateStartMemory = process.memoryUsage();
        let state = makeRow(workload, prefix);
        const cache = createMarkdownStreamCache();
        let stableHtml = "";

        if (prefix) {
          const seeded = renderMarkdownStreamUpdate(cache, prefix, 18, true, {
            id: "diagnostic-row", revision: 1, delta: prefix,
          });
          stableHtml += seeded.stableHtml;
        }

        const beforeMemory = process.memoryUsage();
        for (let index = 0; index < count; index += 1) {
          const deltaStarted = performance.now();
          state = appendStream(state, "text", delta);
          reducerMs.push(performance.now() - deltaStarted);

          const row = state.messages[state.messages.length - 1];
          const revision = row.streamRevision ?? index + 1;
          const streamDelta = row.streamingDelta ?? delta;
          const fullText = row.streamingText ?? "";
          const parseStarted = performance.now();
          const update = renderMarkdownStreamUpdate(cache, fullText, 18, true, {
            id: row.key, revision, delta: streamDelta,
          });
          parserMs.push(performance.now() - parseStarted);
          stableHtml += update.stableHtml;
        }
        const row = state.messages[state.messages.length - 1];
        const finalSource = row.streamingText ?? "";
        const afterStreamMemory = process.memoryUsage();
        const tail = renderMarkdownStreamUpdate(cache, finalSource, 0, true, {
          id: row.key,
          revision: row.streamRevision ?? 0,
          delta: row.streamingDelta ?? "",
        }).tailHtml;
        const oracleStarted = performance.now();
        const oracle = renderMarkdown(finalSource);
        const oracleMs = performance.now() - oracleStarted;
        const afterMemory = process.memoryUsage();
        const cacheMatches = stableHtml + tail === oracle;
        expect(cacheMatches, `${workload} ${targetSize} chars (${expectedChars} actual)`).toBe(true);

        (results.cases as object[]).push({
          workload,
          targetSizeBytes: targetSize,
          actualChars: expectedChars,
          increments: count,
          reducer: {
            p50Ms: percentile(reducerMs, 0.50), p95Ms: percentile(reducerMs, 0.95),
            p99Ms: percentile(reducerMs, 0.99), maxMs: Math.max(...reducerMs),
          },
          markdownUpdate: {
            p50Ms: percentile(parserMs, 0.50), p95Ms: percentile(parserMs, 0.95),
            p99Ms: percentile(parserMs, 0.99), maxMs: Math.max(...parserMs),
            totalMs: parserMs.reduce((sum, value) => sum + value, 0),
          },
          finalOracleMs: oracleMs,
          rssAtStartBytes: stateStartMemory.rss,
          rssBeforeParserBytes: beforeMemory.rss,
          rssAfterBytes: afterMemory.rss,
          rssGrowthBytes: afterMemory.rss - stateStartMemory.rss,
          heapUsedAtStartBytes: stateStartMemory.heapUsed,
          heapUsedBeforeParserBytes: beforeMemory.heapUsed,
          rssAfterStreamBytes: afterStreamMemory.rss,
          heapUsedAfterBytes: afterMemory.heapUsed,
          heapUsedGrowthBytes: afterMemory.heapUsed - stateStartMemory.heapUsed,
          heapUsedAfterStreamBytes: afterStreamMemory.heapUsed,
          heapUsedStreamGrowthBytes: afterStreamMemory.heapUsed - stateStartMemory.heapUsed,
          cacheMatchesFullParser: cacheMatches,
          domMutationMs: null,
          layoutPaintMs: null,
          note: "Node/Vitest only; DOM, style, layout, paint, GPU and display are measured separately in browser traces.",
        });
        writeFileSync(evidencePath, `${JSON.stringify(results, null, 2)}\n`);
      }
    }

    expect((results.cases as unknown[]).length).toBe(workloadsCount(workloads.length, sizes.length));
  }, 15 * 60 * 1000);
});

function workloadsCount(workloads: number, sizes: number): number {
  return workloads * sizes;
}
