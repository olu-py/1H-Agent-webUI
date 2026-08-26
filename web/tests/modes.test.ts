import { describe, expect, it } from "vitest";
import { AGENT_MODES, modeCommand, modeInfo } from "../src/lib/modes";

describe("AGENT_MODES", () => {
  it("mirrors the core AgentMode order (build, plan, explore, cluster)", () => {
    expect(AGENT_MODES.map((m) => m.key)).toEqual(["build", "plan", "explore", "cluster"]);
  });

  it("provides a Chinese label, description and icon for every mode", () => {
    for (const mode of AGENT_MODES) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.description.length).toBeGreaterThan(0);
      expect(["build", "plan", "explore", "cluster"]).toContain(mode.icon);
      expect(["build", "plan", "explore", "cluster"]).toContain(mode.tone);
    }
  });

  it("maps each mode to exactly its core slash command", () => {
    expect(modeCommand("build")).toBe("/build");
    expect(modeCommand("plan")).toBe("/plan");
    expect(modeCommand("explore")).toBe("/explore");
    expect(modeCommand("cluster")).toBe("/cluster");
  });

  it("looks up metadata by key and tolerates unknown modes", () => {
    expect(modeInfo("plan")?.label).toBe("计划");
    expect(modeInfo("nope")).toBeUndefined();
  });
});
