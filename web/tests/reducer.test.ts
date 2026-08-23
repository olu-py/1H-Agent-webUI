import { describe, expect, it } from "vitest";
import type { AppSnapshotV2, Envelope, MessageDto, MessagePage, TodoTask, ToolCall } from "../src/types";
import { MAX_CACHE_MESSAGES, initialState, reduce } from "../src/state/reducer";

function env(cursor: number, session: string, event: Record<string, unknown>): Envelope {
  return { cursor, session_id: session, ...event } as unknown as Envelope;
}

function snapshot(overrides: Partial<AppSnapshotV2> = {}): AppSnapshotV2 {
  return {
    protocol_version: 2,
    event_cursor: 10,
    active_session: "s1",
    sessions: [{ id: "s1", title: "T1", parent_id: null, busy: false, phase: "IDLE", status: "" }],
    provider: "deepseek",
    model: "deepseek-v4-flash",
    mode: "build",
    approval: null,
    todos: [],
    ...overrides,
  };
}

function userMessage(id: number, content: string): MessageDto {
  return { kind: "user", id, content, created_at: "2025-01-01T00:00:00Z" };
}

function assistantMessage(id: number, content: string): MessageDto {
  return { kind: "assistant", id, content, created_at: "2025-01-01T00:00:00Z" };
}

describe("reducer", () => {
  it("applies a snapshot and clears its dirty flag", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    expect(s.activeSession).toBe("s1");
    expect(s.snapshotDirty).toBe(false);
    expect(s.cursor).toBe(10);
    s = reduce(s, { type: "event", envelope: env(11, "s1", { type: "sessions_changed" }) });
    expect(s.snapshotDirty).toBe(true);
  });

  it("streams text deltas into the last assistant message", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    const page: MessagePage = { messages: [userMessage(1, "hi")], next_before: null, has_more: false };
    s = reduce(s, { type: "messages", page, replace: true });
    s = reduce(s, { type: "event", envelope: env(11, "s1", { type: "text_delta", delta: "Hel" }) });
    s = reduce(s, { type: "event", envelope: env(12, "s1", { type: "text_delta", delta: "lo" }) });
    const last = s.messages[s.messages.length - 1];
    expect(last.kind).toBe("assistant");
    expect(last.streamingText).toBe("Hello");
    // completion flushes streaming into content
    s = reduce(s, { type: "event", envelope: env(13, "s1", { type: "completed" }) });
    const flushed = s.messages[s.messages.length - 1];
    expect(flushed.streamingText).toBeUndefined();
    expect(flushed.content).toBe("Hello");
    expect(s.busy).toBe(false);
    expect(s.transcriptDirty).toBe(true);
  });

  it("streams reasoning separately from text", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    s = reduce(s, { type: "event", envelope: env(11, "s1", { type: "reasoning_delta", delta: "think" }) });
    s = reduce(s, { type: "event", envelope: env(12, "s1", { type: "text_delta", delta: "out" }) });
    const last = s.messages[s.messages.length - 1];
    expect(last.streamingThinking).toBe("think");
    expect(last.streamingText).toBe("out");
  });

  it("tracks tool lifecycle", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    const call: ToolCall = { id: "t1", name: "read_file", arguments: { path: "a.txt" } };
    s = reduce(s, { type: "event", envelope: env(11, "s1", { type: "tool_started", call }) });
    const started = s.messages[s.messages.length - 1];
    expect(started.kind).toBe("tool");
    expect(started.status).toBe("running");
    expect(s.busy).toBe(true);
    s = reduce(s, {
      type: "event",
      envelope: env(12, "s1", { type: "tool_finished", call, result: "content" }),
    });
    const finished = s.messages[s.messages.length - 1];
    expect(finished.status).toBe("done");
    expect(finished.result).toBe("content");
  });

  it("sets and clears approvals", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    s = reduce(s, {
      type: "event",
      envelope: env(11, "s1", {
        type: "approval",
        approval_id: "a1",
        call: { id: "t1", name: "terminal_exec", arguments: { command: "ls" } },
        reason: "execute ls",
        source_session_id: null,
        source_title: null,
      }),
    });
    expect(s.approval?.approval_id).toBe("a1");
    s = reduce(s, { type: "event", envelope: env(12, "s1", { type: "approval_resolved", approval_id: "a1", approved: true }) });
    expect(s.approval).toBeNull();
  });

  it("updates todos", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    const tasks: TodoTask[] = [
      { id: "x", title: "do", status: "pending", created_at: "", updated_at: "" },
    ];
    s = reduce(s, { type: "event", envelope: env(11, "s1", { type: "todo_updated", tasks }) });
    expect(s.todos).toHaveLength(1);
    expect(s.todos[0].title).toBe("do");
  });

  it("marks transcript dirty on transcript_invalidated and resync_required", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    s = reduce(s, { type: "event", envelope: env(11, "s1", { type: "transcript_invalidated" }) });
    expect(s.transcriptDirty).toBe(true);
    s = reduce(s, { type: "messages", page: { messages: [], next_before: null, has_more: false }, replace: true });
    expect(s.transcriptDirty).toBe(false);
    s = reduce(s, { type: "event", envelope: env(12, "", { type: "resync_required" }) });
    expect(s.snapshotDirty).toBe(true);
    expect(s.transcriptDirty).toBe(true);
  });

  it("tolerates unknown (additive) event types", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    const before = s;
    s = reduce(s, { type: "event", envelope: env(11, "s1", { type: "future_event", data: 1 }) });
    expect(s.cursor).toBe(11);
    expect(s.sessions).toEqual(before.sessions);
    expect(s.messages).toEqual(before.messages);
  });

  it("prepends older pages and clears the transcript on session switch", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    const page: MessagePage = {
      messages: [userMessage(1, "m1"), userMessage(2, "m2")],
      next_before: 1,
      has_more: true,
    };
    s = reduce(s, { type: "messages", page, replace: true });
    expect(s.messages.map((m) => m.content)).toEqual(["m1", "m2"]);
    const older: MessagePage = { messages: [userMessage(0, "m0")], next_before: null, has_more: false };
    s = reduce(s, { type: "messages", page: older, replace: false });
    expect(s.messages.map((m) => m.content)).toEqual(["m0", "m1", "m2"]);
    // switch session
    s = reduce(s, { type: "snapshot", snapshot: snapshot({ active_session: "s2", sessions: [{ id: "s2", title: "T2", parent_id: null, busy: false, phase: "IDLE", status: "" }] }) });
    expect(s.messages).toEqual([]);
    expect(s.transcriptDirty).toBe(true);
  });

  it("evicts the transcript cache beyond the 500-message cap", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    const all: MessageDto[] = Array.from({ length: MAX_CACHE_MESSAGES + 50 }, (_, i) => userMessage(i + 1, `m${i}`));
    const page: MessagePage = { messages: all, next_before: null, has_more: false };
    s = reduce(s, { type: "messages", page, replace: true });
    expect(s.messages).toHaveLength(MAX_CACHE_MESSAGES);
    // keeps the newest (tail) messages
    expect(s.messages[0].content).toBe("m50");
  });

  it("treats completed/failed/cancelled as terminal states", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    s = reduce(s, { type: "event", envelope: env(11, "s1", { type: "failed", error: "boom" }) });
    expect(s.busy).toBe(false);
    expect(s.lastError).toBe("boom");
    expect(s.transcriptDirty).toBe(true);
    s = reduce(s, { type: "clearError" });
    expect(s.lastError).toBeNull();
    s = reduce(s, { type: "event", envelope: env(12, "s1", { type: "cancelled", reason: "user" }) });
    expect(s.busy).toBe(false);
  });

  it("keeps an assistant message when a tool runs before any text", () => {
    let s = reduce(initialState, { type: "snapshot", snapshot: snapshot() });
    s = reduce(s, { type: "event", envelope: env(11, "s1", { type: "text_delta", delta: "A" }) });
    const call: ToolCall = { id: "t1", name: "git_status", arguments: {} };
    s = reduce(s, { type: "event", envelope: env(12, "s1", { type: "tool_started", call }) });
    s = reduce(s, { type: "event", envelope: env(13, "s1", { type: "text_delta", delta: "B" }) });
    const assistant = [...s.messages].reverse().find((m) => m.kind === "assistant");
    expect(assistant?.streamingText).toBe("AB");
  });
});
