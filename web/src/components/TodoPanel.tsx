import { useState } from "react";
import type { TodoDto } from "../types";
import type { ChatActions } from "../hooks";
import {
  TODO_STATUS_LABEL,
  todoCommand,
  todoEditCommand,
  todoProgressCommand,
  todoToggleCommand,
} from "../lib/todo";
import { Icon } from "./icons";

/**
 * Todo panel. All mutations go through the core slash commands with the
 * 1-based display index (`/todo done|undo|remove|doing|edit <index>`), so the
 * panel never diverges from the server's task list.
 */
export function TodoPanel({ todos, actions, onClose }: { todos: TodoDto[]; actions: ChatActions; onClose: () => void }) {
  const [newTitle, setNewTitle] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  const add = () => {
    const title = newTitle.trim();
    if (!title) return;
    setNewTitle("");
    void actions.executeCommand(`/todo add ${title}`);
  };

  const allDone = todos.length > 0 && todos.every((t) => t.status === "done");

  const startEdit = (index: number, title: string) => {
    setEditing(index);
    setEditText(title);
  };

  const saveEdit = (index: number) => {
    const title = editText.trim();
    if (!title) return;
    setEditing(null);
    void actions.executeCommand(todoEditCommand(index, title));
  };

  const count = todos.filter((t) => t.status === "done").length;

  return (
    <div className="todo-panel">
      <header className="todo-header">
        <span>任务清单{todos.length ? ` · ${count}/${todos.length}` : ""}</span>
        <button type="button" className="icon-btn" onClick={onClose} title="关闭" aria-label="关闭任务清单">
          <Icon name="x" size={14} />
        </button>
      </header>
      {allDone ? (
        <p className="todo-done-banner">
          <Icon name="check" size={14} /> 全部完成
        </p>
      ) : (
        <ul className="todo-list">
          {todos.map((todo, index) => {
            const position = index + 1;
            if (editing === index) {
              return (
                <li key={todo.id} className="todo-edit-row">
                  <input
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveEdit(index);
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                  <button type="button" className="primary" onClick={() => saveEdit(index)}>
                    保存
                  </button>
                  <button type="button" className="ghost" onClick={() => setEditing(null)}>
                    取消
                  </button>
                </li>
              );
            }
            return (
              <li key={todo.id} className={`todo-item todo-${todo.status}`}>
                <button
                  type="button"
                  className="todo-toggle"
                  title={todo.status === "done" ? "恢复" : "完成"}
                  aria-label={todo.status === "done" ? "恢复任务" : "完成任务"}
                  onClick={() => void actions.executeCommand(todoToggleCommand(todo, position))}
                >
                  <Icon
                    name={todo.status === "done" ? "check" : todo.status === "in_progress" ? "play" : "chevronRight"}
                    size={14}
                  />
                </button>
                <span className="todo-title">{todo.title}</span>
                <span className={`todo-status ${todo.status}`}>
                  {TODO_STATUS_LABEL[todo.status] ?? todo.status}
                </span>
                <span className="todo-actions">
                  <button
                    type="button"
                    className="todo-mini"
                    title="进行中 / 完成"
                    aria-label="推进任务"
                    onClick={() => void actions.executeCommand(todoProgressCommand(todo, position))}
                  >
                    <Icon name={todo.status === "done" ? "undo" : "play"} size={13} />
                  </button>
                  <button
                    type="button"
                    className="todo-mini"
                    title="编辑"
                    aria-label="编辑任务"
                    onClick={() => startEdit(index, todo.title)}
                  >
                    <Icon name="edit" size={13} />
                  </button>
                  <button
                    type="button"
                    className="todo-mini"
                    title="删除"
                    aria-label="删除任务"
                    onClick={() => void actions.executeCommand(todoCommand("remove", position))}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="todo-add">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="添加任务…"
          aria-label="新任务标题"
        />
        <button type="button" className="icon-btn" onClick={add} title="添加" aria-label="添加任务">
          <Icon name="plus" size={15} />
        </button>
      </div>
    </div>
  );
}
