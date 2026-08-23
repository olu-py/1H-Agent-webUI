import { useState } from "react";
import type { TodoDto } from "../types";
import type { ChatActions } from "../hooks";

const STATUS_LABEL: Record<string, string> = {
  pending: "待办",
  in_progress: "进行中",
  done: "完成",
};

export function TodoPanel({ todos, actions, onClose }: { todos: TodoDto[]; actions: ChatActions; onClose: () => void }) {
  const [newTitle, setNewTitle] = useState("");
  const add = () => {
    const title = newTitle.trim();
    if (!title) return;
    setNewTitle("");
    void actions.executeCommand(`/todo add ${title}`);
  };
  return (
    <div className="todo-panel">
      <header>
        <span>任务清单</span>
        <button type="button" className="ghost" onClick={onClose}>
          ×
        </button>
      </header>
      <ul className="todo-list">
        {todos.map((todo) => (
          <li key={todo.id} className={`todo-${todo.status}`}>
            <button
              type="button"
              className="todo-toggle"
              title="切换状态"
              onClick={() =>
                void actions.executeCommand(
                  todo.status === "done" ? `/todo uncomplete ${todo.id}` : `/todo complete ${todo.id}`,
                )
              }
            >
              {todo.status === "done" ? "☑" : "☐"}
            </button>
            <span className="todo-title">{todo.title}</span>
            <span className="todo-status">{STATUS_LABEL[todo.status] ?? todo.status}</span>
            <button type="button" className="todo-del" title="删除" onClick={() => void actions.executeCommand(`/todo delete ${todo.id}`)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="todo-add">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="添加任务…"
        />
        <button type="button" className="primary" onClick={add}>
          +
        </button>
      </div>
    </div>
  );
}
