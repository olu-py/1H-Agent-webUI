import type { TodoDto, TodoTask } from "../types";
import type { UiState } from "./reducer";

export function reduceTodoUpdated(state: UiState, tasks: TodoTask[]): UiState {
  const todos: TodoDto[] = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at,
  }));
  return { ...state, todos };
}
