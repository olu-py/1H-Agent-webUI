import { useEffect, useState } from "react";
import type { ChatActions } from "../hooks";
import type { MemoryDto } from "../types";
import { Icon } from "./icons";

/** Small, explicit memory manager. Nothing is auto-confirmed here: candidates
 * remain reviewable until the user confirms them. */
export function MemoryPanel({
  memories,
  actions,
  onClose,
}: {
  memories: MemoryDto[];
  actions: ChatActions;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [candidate, setCandidate] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);

  useEffect(() => {
    void actions.loadMemories(undefined, true);
    // The app-owned action facade is intentionally stable in behavior but is
    // recreated by the hook; load only when this modal mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = () => void actions.loadMemories(query, true);
  const save = async () => {
    if (!title.trim() || !content.trim()) return;
    if (editing === null) {
      await actions.saveMemory(title, content, candidate);
    } else {
      await actions.updateMemory(editing, title, content);
    }
    setTitle("");
    setContent("");
    setCandidate(false);
    setEditing(null);
  };
  const edit = (memory: MemoryDto) => {
    setEditing(memory.id);
    setTitle(memory.title);
    setContent(memory.content);
    setCandidate(memory.status === "candidate");
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card memory-modal" role="dialog" aria-modal="true" aria-label="工作区记忆">
        <div className="modal-head">
          <h3>工作区记忆</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="x" size={16} /></button>
        </div>
        <div className="memory-search">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆…" onKeyDown={(event) => event.key === "Enter" && search()} />
          <button type="button" className="ghost" onClick={search}><Icon name="search" size={14} />搜索</button>
        </div>
        <div className="memory-list">
          {memories.length === 0 ? <p className="dim">暂无记忆或候选。</p> : memories.map((memory) => (
            <article className={`memory-row ${memory.status === "candidate" ? "candidate" : ""}`} key={memory.id}>
              <div className="memory-row-head"><strong>#{memory.id} {memory.title}</strong><span className="meta">{memory.status === "candidate" ? "候选 · 待确认" : `${memory.status}${memory.recallable ? "" : " · 待核实来源"}`}</span></div>
              <p>{memory.content}</p>
              {memory.source_session_id || memory.evidence ? <div className="memory-source meta">
                来源：{memory.source_session_id ? memory.source_session_id.slice(0, 8) : "手动"}{memory.evidence ? ` · ${memory.evidence}` : ""}
              </div> : null}
              {memory.status !== "deleted" ? <div className="memory-actions">
                {memory.status === "candidate" ? <button type="button" className="primary" onClick={() => void actions.confirmMemory(memory.id)}>确认</button> : null}
                <button type="button" className="ghost" onClick={() => edit(memory)}>编辑</button>
                <button type="button" className="danger" onClick={() => void actions.deleteMemory(memory.id)}>删除</button>
              </div> : null}
            </article>
          ))}
        </div>
        <div className="memory-editor">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题" />
          <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="稳定事实、约定或决策" rows={3} />
          {editing === null ? <label className="memory-candidate"><input type="checkbox" checked={candidate} onChange={(event) => setCandidate(event.target.checked)} /> 保存为候选，稍后确认</label> : null}
          <div className="provider-modal-actions">
            <button type="button" className="ghost" onClick={() => { setEditing(null); setTitle(""); setContent(""); }}>清空</button>
            <button type="button" className="primary" disabled={!title.trim() || !content.trim()} onClick={() => void save()}>{editing === null ? "保存" : "更新"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
