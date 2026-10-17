import { bench, describe } from "vitest";
import { initialState, reduce, type UiState } from "../src/state/reducer";
import {
  createMarkdownStreamCache,
  renderMarkdown,
  renderMarkdownStreamUpdate,
} from "../src/lib/markdown";
import type { Envelope } from "../src/types";

const options = { time: 300, iterations: 5, warmupTime: 100, warmupIterations: 1 };
const payload = "## Benchmark 中文\n\nParagraph with **bold** and `code`.\n\n- item one\n- item two\n\n";

describe("scaling: 1k child progress events", () => {
  for (const children of [8, 64, 1000]) {
    const events = Array.from({ length: 1000 }, (_, i) => ({
      cursor: i + 1, session_id: `parent-${i % 8}`, type: "child_session_progress",
      child_session_id: `child-${i % children}`, status: "running", phase: "thinking",
      turn: i % 8, max_turns: 8, tool: null,
    }) as unknown as Envelope);
    bench(`${children} children`, () => {
      let state: UiState = { ...initialState, activeSession: "active" };
      for (const envelope of events) state = reduce(state, { type: "event", envelope });
      if (Object.keys(state.childStatus).length !== children) throw new Error("incomplete replay");
    }, options);
  }
});

describe("markdown: full streaming row rebuild", () => {
  for (const chars of [1024, 16 * 1024, 64 * 1024, 256 * 1024]) {
    const text = payload.repeat(Math.ceil(chars / payload.length)).slice(0, chars);
    bench(`${chars} characters`, () => {
      if (!renderMarkdown(text, 0, 72)) throw new Error("empty markdown");
    }, options);
  }
  const text = payload.repeat(Math.ceil(65536 / payload.length)).slice(0, 65536);
  bench("64k growing stream / 128 renders", () => {
    for (let i = 512; i <= text.length; i += 512) renderMarkdown(text.slice(0, i), 0, 72);
  }, options);
});

describe("markdown: stable-block streaming cache", () => {
  const delta512 = `${"x".repeat(510)}\n\n`;
  for (const chunks of [125, 500, 1000, 4096]) {
    bench(`incremental parse ${chunks} × 512 byte blocks`, () => {
      const cache = createMarkdownStreamCache();
      let text = "";
      let revision = 0;
      for (let i = 0; i < chunks; i++) {
        text += delta512;
        revision += 1;
        renderMarkdownStreamUpdate(cache, text, 18, true, {
          id: "bench-stream",
          revision,
          delta: delta512,
        });
      }
      if (cache.source !== text) throw new Error("incomplete stream");
    }, options);
    if (chunks === 125) {
      bench("baseline full parse 125 × 512 byte blocks", () => {
        let text = "";
        for (let i = 0; i < chunks; i++) {
          text += delta512;
          renderMarkdown(text, 0, 18);
        }
        if (text.length !== 64_000) throw new Error("incomplete baseline");
      }, options);
    }
  }
});

describe("stream: existing history copy cost / 1k deltas", () => {
  for (const rows of [0, 100, 500]) {
    const messages = Array.from({ length: rows }, (_, i) => ({
      key: `m-${i}`, id: i, kind: "assistant" as const, role: "assistant" as const,
      content: payload, createdAt: "2026-01-01T00:00:00Z",
    }));
    bench(`${rows} cached rows`, () => {
      let state: UiState = { ...initialState, activeSession: "active", messages };
      for (let i = 1; i <= 1000; i++) {
        state = reduce(state, { type: "event", envelope: {
          cursor: i, session_id: "active", type: "text_delta", delta: "abcdefgh",
        } as unknown as Envelope });
      }
      if (state.cursor !== 1000) throw new Error("incomplete stream");
    }, options);
  }
});
