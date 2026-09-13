import { describe, expect, it } from "vitest";
import { AGENT_MODES, modeCommand } from "../src/lib/modes";
import {
  buildCommand,
  COMMAND_GROUPS,
  filterCommands,
  fuzzyScore,
  slashCommandToken,
} from "../src/lib/commands";

describe("slashCommandToken", () => {
  it("activates on a lone slash and on slash-prefixed single tokens", () => {
    expect(slashCommandToken("/")).toEqual({ query: "" });
    expect(slashCommandToken("/new")).toEqual({ query: "new" });
    expect(slashCommandToken("/todo")).toEqual({ query: "todo" });
  });

  it("stays inactive for invalid inputs (Codex #7704 guard)", () => {
    expect(slashCommandToken("")).toBeNull();
    expect(slashCommandToken("a/b")).toBeNull();
    expect(slashCommandToken(" /new")).toBeNull();
    expect(slashCommandToken("/new ")).toBeNull();
    expect(slashCommandToken("/rename x")).toBeNull();
    expect(slashCommandToken("!ls")).toBeNull();
    expect(slashCommandToken("@file")).toBeNull();
    expect(slashCommandToken("line\n/new")).toBeNull();
  });
});

describe("fuzzyScore", () => {
  it("scores an empty query as a full match", () => {
    expect(fuzzyScore("", "/new new")).toBe(0);
    expect(fuzzyScore("   ", "/new new")).toBe(0);
  });

  it("matches ordered subsequences and rejects misses", () => {
    expect(fuzzyScore("new", "新建会话 /new n")).not.toBeNull();
    expect(fuzzyScore("todo", "任务清单 /todo todos")).not.toBeNull();
    expect(fuzzyScore("zzz", "新建会话 /new n")).toBeNull();
  });

  it("prefers word-boundary hits over scattered ones", () => {
    const boundary = fuzzyScore("undo", "撤销 /undo");
    const scattered = fuzzyScore("undo", "撤销 /uncompact decompact");
    expect(boundary).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(boundary as number).toBeLessThan(scattered as number);
  });
});

describe("filterCommands", () => {
  it("lists the whole registry in group order for an empty query", () => {
    const all = filterCommands("");
    const total = COMMAND_GROUPS.reduce((n, g) => n + g.commands.length, 0);
    expect(all).toHaveLength(total);
    expect(all[0].group.id).toBe(COMMAND_GROUPS[0].id);
  });

  it("ranks direct command hits first", () => {
    const top = filterCommands("todo")[0];
    expect(top.command.command).toBe("/todo");
    const modeTop = filterCommands("plan")[0];
    expect(modeTop.command.command).toBe(modeCommand("plan"));
  });

  it("keeps command ids unique across groups", () => {
    const ids = COMMAND_GROUPS.flatMap((g) => g.commands.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("COMMAND_GROUPS mode group", () => {
  it("derives exactly one entry per AGENT_MODES mode", () => {
    const modeGroup = COMMAND_GROUPS.find((g) => g.id === "mode");
    expect(modeGroup).toBeDefined();
    expect(modeGroup?.commands.map((c) => c.command)).toEqual(
      AGENT_MODES.map((m) => modeCommand(m.key)),
    );
  });
});

describe("buildCommand", () => {
  it("joins trimmed arguments for parameterized commands", () => {
    const rename = COMMAND_GROUPS.flatMap((g) => g.commands).find((c) => c.id === "rename");
    expect(rename?.argument).toBeDefined();
    expect(buildCommand(rename!, "  新标题  ")).toBe("/rename 新标题");
    expect(buildCommand(rename!, "  ")).toBe("/rename");
  });

  it("ignores arguments for plain commands", () => {
    const help = COMMAND_GROUPS.flatMap((g) => g.commands).find((c) => c.id === "help");
    expect(help?.argument).toBeUndefined();
    expect(buildCommand(help!, "/dev/null")).toBe("/help");
  });
});
