import type { TodoDto } from "../types";

/** Human labels for the wire todo status values. */
export const TODO_STATUS_LABEL: Record<string, string> = {
  pending: "待办",
  in_progress: "进行中",
  done: "完成",
};

/**
 * Builds the exact core slash-command strings for a todo action. The core
 * indexes todos by their 1-based display position (`index`), not by the UUID,
 * so the TodoPanel must pass the array position + 1.
 */
export function todoCommand(action: "doing" | "done" | "undo" | "remove", index: number): string {
  return `/todo ${action} ${index}`;
}

export function todoEditCommand(index: number, title: string): string {
  return `/todo edit ${index} ${title}`;
}

/** Next status when toggling a task's checkbox (pending/in_progress → done,
 * done → pending). */
export function todoToggleCommand(todo: TodoDto, index: number): string {
  if (todo.status === "done") return todoCommand("undo", index);
  return todoCommand("done", index);
}

/** The primary "progress" action for a task that is not yet done. */
export function todoProgressCommand(todo: TodoDto, index: number): string {
  if (todo.status === "in_progress") return todoCommand("done", index);
  if (todo.status === "done") return todoCommand("undo", index);
  return todoCommand("doing", index);
}
