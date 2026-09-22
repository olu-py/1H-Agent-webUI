import { bench, describe } from "vitest";
import type { Envelope } from "../src/types";
import { initialState, reduce, type UiState } from "../src/state/reducer";

const EVENT_COUNT = 10_000;
const SESSION_ID = "bench-session";

function envelope(cursor: number, event: Record<string, unknown>): Envelope {
  return { cursor, session_id: SESSION_ID, ...event } as unknown as Envelope;
}

const streamEvents = Array.from({ length: EVENT_COUNT }, (_, index) =>
  envelope(
    index + 1,
    index % 10 === 9
      ? { type: "completed" }
      : index % 10 === 0
        ? { type: "reasoning_delta", delta: `reasoning-${index}` }
        : { type: "text_delta", delta: `token-${index}` },
  ),
);

const backgroundEvents = Array.from({ length: EVENT_COUNT }, (_, index) =>
  ({
    cursor: index + 1,
    session_id: `background-${index % 100}`,
    type: "child_session_progress",
    child_session_id: `child-${index % 1_000}`,
    status: index % 2 === 0 ? "running" : "waiting",
    turn: index % 8,
    max_turns: 8,
    tool: null,
  }) as unknown as Envelope,
);

describe("10k event reducer replay", () => {
  bench("active transcript stream", () => {
    let state: UiState = { ...initialState, activeSession: SESSION_ID };
    for (const event of streamEvents) {
      state = reduce(state, { type: "event", envelope: event });
    }
    void state.cursor;
  });

  bench("background session progress", () => {
    let state: UiState = { ...initialState, activeSession: SESSION_ID };
    for (const event of backgroundEvents) {
      state = reduce(state, { type: "event", envelope: event });
    }
    void state.cursor;
  });
});
