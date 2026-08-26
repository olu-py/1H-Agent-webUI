import { describe, expect, it } from "vitest";
import type { PartialDto } from "../src/types";
import type { ViewMessage } from "../src/state/reducer";
import { withPartial } from "../src/lib/transcript";

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

  it("keeps the partial while the tail is still streaming", () => {
    const streaming: ViewMessage = { ...message("m1"), streamingText: "未完成回复" };
    expect(withPartial([streaming], partial)).toHaveLength(2);
  });
});
