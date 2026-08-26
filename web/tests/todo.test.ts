import { describe, expect, it } from "vitest";
import type { TodoDto } from "../src/types";
import {
  TODO_STATUS_LABEL,
  todoCommand,
  todoEditCommand,
  todoProgressCommand,
  todoToggleCommand,
} from "../src/lib/todo";

function todo(status: string): TodoDto {
  return { id: "x", title: "t", status, created_at: "", updated_at: "" };
}

describe("todo command mapping", () => {
  it("maps actions to the core slash commands with a 1-based index", () => {
    expect(todoCommand("done", 1)).toBe("/todo done 1");
    expect(todoCommand("undo", 2)).toBe("/todo undo 2");
    expect(todoCommand("remove", 3)).toBe("/todo remove 3");
    expect(todoCommand("doing", 4)).toBe("/todo doing 4");
    expect(todoEditCommand(2, "new title")).toBe("/todo edit 2 new title");
  });

  it("toggles done → undo and everything else → done", () => {
    expect(todoToggleCommand(todo("done"), 1)).toBe("/todo undo 1");
    expect(todoToggleCommand(todo("pending"), 1)).toBe("/todo done 1");
    expect(todoToggleCommand(todo("in_progress"), 1)).toBe("/todo done 1");
  });

  it("maps the progress action per status (doing/done/undo)", () => {
    expect(todoProgressCommand(todo("pending"), 1)).toBe("/todo doing 1");
    expect(todoProgressCommand(todo("in_progress"), 1)).toBe("/todo done 1");
    expect(todoProgressCommand(todo("done"), 1)).toBe("/todo undo 1");
  });

  it("covers the core-supported status labels", () => {
    expect(TODO_STATUS_LABEL).toMatchObject({
      pending: "待办",
      in_progress: "进行中",
      done: "完成",
    });
  });
});
