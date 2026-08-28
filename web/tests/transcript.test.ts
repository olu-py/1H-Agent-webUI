import { describe, expect, it } from "vitest";
import type { PartialDto } from "../src/types";
import type { ViewMessage } from "../src/state/reducer";
import { attachToolOutputs, withPartial } from "../src/lib/transcript";

function message(key: string, content = ""): ViewMessage {
  return {
    key,
    id: 1,
    kind: "assistant",
    role: "assistant",
    content,
    createdAt: "2025-01-01T00:00:00Z",
  };
}

const partial: PartialDto = { content: "未完成回复", created_at: "2025-01-01T00:00:00Z" };

describe("withPartial", () => {
  it("appends the persisted incomplete answer as a trailing '未完成' message", () => {
    const out = withPartial([message("m1", "hi")], partial);
    expect(out).toHaveLength(2);
    expect(out[1].partial).toBe(true);
    expect(out[1].content).toBe("未完成回复");
    expect(out[1].key).toBe("assistant-partial");
  });

  it("skips when the partial is null or blank", () => {
    expect(withPartial([message("m1")], null)).toHaveLength(1);
    expect(withPartial([message("m1")], { content: "   ", created_at: "" })).toHaveLength(1);
  });

  it("deduplicates when the transcript tail already carries the content", () => {
    expect(withPartial([message("m1", "未完成回复")], partial)).toHaveLength(1);
  });

  it("skips the partial while a live turn is in flight", () => {
    // Synthetic rows (streaming rows, the optimistic echo, live tool rows)
    // have negative ids; the partial is stale history then and must not be
    // appended below the streaming answer.
    const streaming: ViewMessage = { ...message("m1"), id: -1, streamingText: "流式正文" };
    expect(withPartial([streaming], partial)).toHaveLength(1);
    const echo: ViewMessage = { ...message("m2"), id: -2, kind: "user", role: "user", content: "问题" };
    expect(withPartial([echo], partial)).toHaveLength(1);
  });
});

const CREATED = "2025-01-01T00:00:00Z";

function toolCallsRow(calls: Array<{ id: string; name: string }>): ViewMessage {
  return {
    key: `m-${calls[0]?.id ?? "calls"}`,
    id: 2,
    kind: "tool_calls",
    role: "tool_calls",
    calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: null })),
    content: "",
    createdAt: CREATED,
  };
}

function toolOutputRow(callId: string, output: string): ViewMessage {
  return {
    key: `m-out-${callId}`,
    id: 3,
    kind: "tool_output",
    role: "tool_output",
    callId,
    output,
    content: "",
    createdAt: CREATED,
  };
}

describe("attachToolOutputs", () => {
  it("folds tool_output rows into their tool_calls row and drops the standalone blocks", () => {
    const calls = toolCallsRow([
      { id: "call_1", name: "read" },
      { id: "call_2", name: "bash" },
    ]);
    const out = attachToolOutputs([
      message("m1", "question"),
      calls,
      toolOutputRow("call_1", "first output"),
      toolOutputRow("call_2", "second output"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].outputs).toEqual({ call_1: "first output", call_2: "second output" });
    expect(out.filter((m) => m.role === "tool_output")).toHaveLength(0);
  });

  it("fills result on a tool row that has none", () => {
    const tool: ViewMessage = {
      key: "m-tool",
      id: 4,
      kind: "tool",
      role: "tool",
      callId: "call_9",
      name: "fetch",
      args: null,
      status: "done",
      result: null,
      content: "",
      createdAt: CREATED,
    };
    const out = attachToolOutputs([tool, toolOutputRow("call_9", "fetched bytes")]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe("fetched bytes");
  });

  it("keeps a live result and drops the duplicate persisted output row", () => {
    const tool: ViewMessage = {
      key: "m-tool",
      id: 4,
      kind: "tool",
      role: "tool",
      callId: "call_9",
      name: "fetch",
      args: null,
      status: "done",
      result: "live result",
      content: "",
      createdAt: CREATED,
    };
    const out = attachToolOutputs([tool, toolOutputRow("call_9", "persisted")]);
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe("live result");
  });

  it("keeps unmatched outputs standalone instead of dropping them", () => {
    const orphan = toolOutputRow("call_gone", "orphan");
    const out = attachToolOutputs([message("m1", "hi"), orphan]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(orphan);
  });

  it("returns the same reference when there is nothing to fold", () => {
    const messages = [message("m1", "hi"), toolCallsRow([{ id: "call_1", name: "read" }])];
    expect(attachToolOutputs(messages)).toBe(messages);
  });
});
