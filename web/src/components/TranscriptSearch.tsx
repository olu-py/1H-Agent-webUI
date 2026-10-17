import { useEffect, useRef, useState } from "react";
import type { ChatActions } from "../hooks";
import type { ViewMessage } from "../state/transcript";
import { Icon } from "./icons";

type SearchHit = { message: ViewMessage; excerpt: string };

/** Searches every server page without retaining the full transcript in the UI cache. */
export function TranscriptSearch({
  actions,
  onClose,
  onLocate,
}: {
  actions: ChatActions;
  onClose: () => void;
  onLocate: (messageId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const visibleHits = hits.slice(0, 200);

  useEffect(() => () => controller.current?.abort(), []);
  const close = () => {
    controller.current?.abort();
    controller.current = null;
    onClose();
  };

  const search = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    setScanned(0);
    setHits([]);
    try {
      const result = await actions.searchTranscript(query, {
        signal: request.signal,
        onProgress: (count) => setScanned(count),
      });
      if (!request.signal.aborted) {
        setHits(result.results);
        setScanned(result.scanned);
      }
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="modal-card transcript-search-modal" role="dialog" aria-modal="true" aria-label="查找完整会话">
        <div className="modal-head">
          <h3>查找完整会话</h3>
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭"><Icon name="x" size={16} /></button>
        </div>
        <form className="memory-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索所有会话消息…" aria-label="搜索会话消息" />
          <button type="submit" className="ghost" disabled={!query.trim() || busy}><Icon name="search" size={14} />搜索</button>
          {busy ? <button type="button" className="ghost" onClick={() => controller.current?.abort()}>取消</button> : null}
        </form>
        <p className="meta transcript-search-status">{busy ? `已扫描 ${scanned} 条消息…` : `已扫描 ${scanned} 条消息 · ${hits.length} 个命中${hits.length > visibleHits.length ? ` · 当前显示前 ${visibleHits.length} 个` : ""}`}</p>
        {error ? <p className="error-banner">{error}</p> : null}
        <div className="transcript-search-results" aria-live="polite">
          {!busy && query && hits.length === 0 && !error ? <p className="dim">没有找到匹配消息。</p> : visibleHits.map(({ message, excerpt }) => (
            <button type="button" className="transcript-search-hit" key={`${message.id}:${message.key}`} onClick={() => onLocate(message.id)}>
              <span className="transcript-search-hit-head">#{message.id} · {message.role} · {message.createdAt}</span>
              <span className="transcript-search-hit-excerpt">{excerpt}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
