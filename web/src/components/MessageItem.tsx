import { useEffect, useRef, useState } from "react";
import type { ViewMessage } from "../state/reducer";
import { copyText } from "../lib/copy";
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

/** Renders one transcript message (user / assistant / tool / etc.). */
export function MessageItem({
  message,
  liveThinking,
}: {
  message: ViewMessage;
  /** True while this message is the one currently streaming reasoning. */
  liveThinking?: boolean;
}) {
  switch (message.role) {
    case "user":
      return <UserMessage content={message.content} />;
    case "assistant": {
      const thinking = message.streamingThinking || (message as { thinking?: string }).thinking;
      const text = message.content + (message.streamingText ?? "");
      return (
        <div className="msg msg-assistant">
          {thinking ? <ThinkingBlock text={thinking} live={!!liveThinking} /> : null}
          {message.partial ? <span className="badge partial">未完成</span> : null}
          {text ? <Markdown text={text} /> : message.streamingText === undefined ? <em className="dim">…</em> : null}
        </div>
      );
    }
    case "thinking":
      return (
        <div className="msg msg-thinking">
          <ThinkingBlock text={message.content} />
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
      return <ToolMessage message={message} />;
    case "tool_calls":
      return (
        <div className="msg msg-tool">
          {(message.calls ?? []).map((call) => (
            <ToolCallRow key={call.id} name={call.name} args={call.arguments} status="done" result={undefined} />
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
}

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
 * historical thinking messages can be toggled manually. */
function ThinkingBlock({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState<boolean>(!!live);
  const prevLive = useRef(!!live);
  useEffect(() => {
    if (prevLive.current !== live) {
      setOpen(!!live);
      prevLive.current = !!live;
    }
  }, [live]);
  return (
    <details className="thinking" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {live ? <span className="dot spin" /> : <Icon name="chevronRight" size={12} />}
        思考{live ? "…" : ""}
      </summary>
      <pre>{text}</pre>
    </details>
  );
}

function ToolMessage({ message }: { message: ViewMessage }) {
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
    />
  );
}

function ToolCallRow({
  name,
  args,
  status,
  result,
}: {
  name: string;
  args?: unknown;
  status: string;
  result?: string;
}) {
  const [open, setOpen] = useState(false);
  const running = status === "running" || status === "generating";
  const argsText = typeof args === "string" ? args : args !== undefined ? JSON.stringify(args, null, 2) : "";
  return (
    <div className={`tool-call ${running ? "running" : ""}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={`dot ${running ? "spin" : status}`} />
        <code>{name}</code>
        <span className={`tool-status-pill ${status}`}>
          {TOOL_STATUS_LABEL[status] ?? status}
        </span>
      </button>
      {open ? (
        <div className="tool-body">
          {argsText ? (
            <>
              <div className="dim">参数</div>
              <pre>{argsText}</pre>
            </>
          ) : null}
          {result !== undefined ? (
            <>
              <div className="dim tool-result">结果</div>
              <pre className="tool-result">{result}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
