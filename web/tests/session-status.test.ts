import { describe, expect, it } from "vitest";
import { sessionListStatus } from "../src/lib/session-status";

describe("sessionListStatus", () => {
  it("shows the ready marker only on the active session", () => {
    expect(sessionListStatus("就绪", true)).toBe("就绪");
    expect(sessionListStatus("就绪", false)).toBe("");
  });

  it("keeps live/error statuses on background sessions", () => {
    expect(sessionListStatus("正在搜索：foo", false)).toBe("正在搜索：foo");
    expect(sessionListStatus("请求失败", false)).toBe("请求失败");
    expect(sessionListStatus("需要配置提供商", false)).toBe("需要配置提供商");
    expect(sessionListStatus("等待审批", false)).toBe("等待审批");
  });

  it("does not hide compound ready-ish error states", () => {
    expect(sessionListStatus("就绪，但刷新会话失败", false)).toBe("就绪，但刷新会话失败");
    expect(sessionListStatus("新会话已就绪", false)).toBe("新会话已就绪");
  });

  it("returns empty for a blank status", () => {
    expect(sessionListStatus("", false)).toBe("");
    expect(sessionListStatus("", true)).toBe("");
  });
});
