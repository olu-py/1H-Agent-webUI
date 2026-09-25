import { describe, expect, it } from "vitest";
import { sessionDotKind, sessionListStatus } from "../src/lib/session-status";
import { childSessionLabel } from "../src/lib/session-status";

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

describe("sessionDotKind", () => {
  it("approval wins over every other signal", () => {
    expect(sessionDotKind("", true, true)).toBe("approval");
    expect(sessionDotKind("请求失败", false, true)).toBe("approval");
  });

  it("failure and setup labels map to the steady error light", () => {
    expect(sessionDotKind("请求失败", false, false)).toBe("error");
    // A stale busy flag must not mask the fresher failure label.
    expect(sessionDotKind("请求失败", true, false)).toBe("error");
    expect(sessionDotKind("就绪，但刷新会话失败", false, false)).toBe("error");
    expect(sessionDotKind("需要配置提供商", false, false)).toBe("error");
  });

  it("live background labels keep the dot busy while the snapshot lags", () => {
    expect(sessionDotKind("正在生成回复", false, false)).toBe("busy");
    expect(sessionDotKind("Tokens: 1024", false, false)).toBe("busy");
    expect(sessionDotKind("子会话 搜索中（2/8）", false, false)).toBe("busy");
    expect(sessionDotKind("等待审批", false, false)).toBe("busy");
  });

  it("the snapshot busy flag alone is enough", () => {
    expect(sessionDotKind("", true, false)).toBe("busy");
    expect(sessionDotKind("就绪", true, false)).toBe("busy");
  });

  it("idle and terminal labels dim the dot", () => {
    expect(sessionDotKind("", false, false)).toBe("");
    expect(sessionDotKind("就绪", false, false)).toBe("");
    expect(sessionDotKind("新会话已就绪", false, false)).toBe("");
    expect(sessionDotKind("已完成", false, false)).toBe("");
    expect(sessionDotKind("已取消", false, false)).toBe("");
    expect(sessionDotKind("已允许", false, false)).toBe("");
    expect(sessionDotKind("已拒绝", false, false)).toBe("");
  });

  it("uses machine child status to stop terminal children showing busy", () => {
    expect(sessionDotKind("", false, false, "running")).toBe("busy");
    expect(sessionDotKind("正在执行工具", false, false, "completed")).toBe("");
    expect(sessionDotKind("", false, false, "cancelled")).toBe("");
    expect(sessionDotKind("", false, false, "failed")).toBe("error");
    expect(sessionDotKind("", false, false, "timed_out")).toBe("error");
    expect(sessionDotKind("", false, false, "turn_limit")).toBe("error");
  });
});

describe("childSessionLabel", () => {
  it("localizes progress, terminal states, and unlimited turn counts", () => {
    expect(childSessionLabel("running", "waiting_approval", 2, 4)).toBe("等待审批 第2/4轮");
    expect(childSessionLabel("running", "running_tool", 3, 0, "file_write")).toBe("执行工具 第3轮 ·file_write");
    expect(childSessionLabel("running", "queued", 0, 0)).toBe("排队中");
    expect(childSessionLabel("completed")).toBe("已完成");
    expect(childSessionLabel("failed")).toBe("失败");
  });
});
