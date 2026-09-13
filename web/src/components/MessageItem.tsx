import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ViewMessage } from "../state/reducer";
import { copyText } from "../lib/copy";
import { Collapse } from "./Collapse";
import { Markdown } from "./Markdown";
import { Icon } from "./icons";

const TOOL_STATUS_LABEL: Record<string, string> = {
  generating: "生成参数中…",
  running: "执行中",
  done: "完成",
  failed: "失败",
  rejected: "已拒绝",
  cancelled: "已取消",
};

/** Renders one transcript message (user / assistant / tool / etc.). Memoized:
 * the list re-renders on every scroll tick, but only rows whose message
 * actually changed (e.g. the streaming tail) need to re-render. */
export const MessageItem = memo(function MessageItem({
  message,
  liveThinking,
  isTail,
  onContentToggle,
}: {
  message: ViewMessage;
  /** True while this message is the one currently streaming reasoning. */
  liveThinking?: boolean;
  /** True while this message is the transcript tail (the auto-scroll
   * follower owns tail toggles; anything above suspends pinning). */
  isTail?: boolean;
  /** Notified when the user expands/collapses a tool or thinking box so the
   * list can suspend bottom-pinning for non-tail rows (keeps the clicked
   * header visually anchored instead of being scrolled out of view). */
  onContentToggle?: (key: string) => void;
}) {
  // Tail-row toggles keep the auto-scroll follower in charge (a tail box
  // opening is exactly the new content to follow); any box above the tail
  // suspends pinning so the clicked header stays visually anchored.
  const handleToggle = isTail ? undefined : () => onContentToggle?.(message.key);
  switch (message.role) {
    case "user":
      return <UserMessage content={message.content} />;
    case "assistant": {
      const thinking = message.streamingThinking ?? message.thinking;
      const text = message.content + (message.streamingText ?? "");
      const streaming = message.streamingText !== undefined;
      return (
        <div className="msg msg-assistant">
          {thinking ? (
            <ThinkingBlock text={thinking} live={!!liveThinking} onToggle={handleToggle} />
          ) : null}
          {message.partial ? <span className="badge partial">未完成</span> : null}
          {text ? (
            <Markdown text={text} fadeTail={streaming} />
          ) : message.streamingText === undefined && !message.thinking ? (
            <em className="dim">…</em>
          ) : null}
        </div>
      );
    }
    case "thinking":
      return (
        <div className="msg msg-thinking">
          <ThinkingBlock text={message.content} onToggle={handleToggle} />
        </div>
      );
    case "system":
      return (
        <div className="msg msg-system">
          <Markdown text={message.content} />
        </div>
      );
    case "compaction_summary":
      return (
        <div className="msg msg-compaction">
          <Markdown text={message.content} />
        </div>
      );
    case "context":
      return (
        <div className="msg msg-context">
          <span className="badge">@{message.label}</span> <Markdown text={message.content} />
        </div>
      );
    case "tool":
      return <ToolMessage message={message} onToggle={handleToggle} />;
    case "tool_calls":
      return (
        <div className="msg msg-tool">
          {(message.calls ?? []).map((call) => (
            <ToolCallRow
              key={call.id}
              name={call.name}
              args={call.arguments}
              status="done"
              result={message.outputs?.[call.id]}
              onToggle={handleToggle}
            />
          ))}
        </div>
      );
    case "tool_output":
      return (
        <div className="msg msg-tool-output">
          <pre>{message.output}</pre>
        </div>
      );
  }
});

/** Right-aligned emphasized user bubble with a copy action. */
function UserMessage({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void copyText(content).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="msg msg-user">
      <Markdown text={content} />
      <button
        type="button"
        className="user-copy"
        title={copied ? "已复制" : "复制"}
        aria-label="复制此消息"
        onClick={onCopy}
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
      </button>
    </div>
  );
}

/** Streaming thinking stays open while live, collapses when it completes, and
 * historical thinking messages can be toggled manually. Rendered as a button
 * plus a `Collapse` (instead of `<details>`) so the height change animates
 * cross-browser. */
function ThinkingBlock({
  text,
  live,
  onToggle,
}: {
  text: string;
  live?: boolean;
  onToggle?: () => void;
}) {
  const [open, setOpen] = useState<boolean>(!!live);
  const prevLive = useRef(!!live);
  useEffect(() => {
    if (prevLive.current !== live) {
      setOpen(!!live);
      prevLive.current = !!live;
    }
  }, [live]);
  return (
    <div className="thinking" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => {
          setOpen(!open);
          onToggle?.();
        }}
        aria-expanded={open}
      >
        {live ? (
          <span className="dot spin" />
        ) : (
          <span className="chev" aria-hidden="true">
            <Icon name="chevronRight" size={12} />
          </span>
        )}
        思考{live ? "…" : ""}
      </button>
      <Collapse open={open}>
        <pre>{text}</pre>
      </Collapse>
    </div>
  );
}

function ToolMessage({ message, onToggle }: { message: ViewMessage; onToggle?: () => void }) {
  if (message.status === "generating") {
    return (
      <div className="msg msg-tool">
        <div className="tool-call generating">
          <span className="dot spin" />
          <span className="tool-generating-text">
            正在生成工具调用：<code>{message.name ?? "…"}</code>
          </span>
        </div>
      </div>
    );
  }
  return (
    <ToolCallRow
      name={message.name ?? "tool"}
      args={message.args}
      status={message.status ?? "done"}
      result={message.result ?? undefined}
      onToggle={onToggle}
    />
  );
}

function ToolCallRow({
  name,
  args,
  status,
  result,
  onToggle,
}: {
  name: string;
  args?: unknown;
  status: string;
  result?: string;
  onToggle?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const running = status === "running" || status === "generating";
  const argsText = useMemo(
    () => (typeof args === "string" ? args : args !== undefined ? JSON.stringify(args, null, 2) : ""),
    [args],
  );
  return (
    <div className={`tool-call ${running ? "running" : ""}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => {
          setOpen(!open);
          onToggle?.();
        }}
        aria-expanded={open}
      >
        <span className={`dot ${running ? "spin" : status}`} />
        <code>{name}</code>
        <span className={`tool-status-pill ${status}`}>
          {TOOL_STATUS_LABEL[status] ?? status}
        </span>
      </button>
      <Collapse open={open}>
        <div className="tool-body">
          {argsText ? (
            <>
              <div className="dim">参数</div>
              <pre>{argsText}</pre>
            </>
          ) : null}
          {result !== undefined ? (
            <>
              <div className="dim">输出结果</div>
              <pre className="tool-result">{result}</pre>
            </>
          ) : null}
        </div>
      </Collapse>
    </div>
  );
}
