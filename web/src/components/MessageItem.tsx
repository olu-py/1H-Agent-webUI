import { useState } from "react";
import type { ViewMessage } from "../state/reducer";
import { Markdown } from "./Markdown";

/** Renders one transcript message (user / assistant / tool / etc.). */
export function MessageItem({ message }: { message: ViewMessage }) {
  switch (message.role) {
    case "user":
      return (
        <div className="msg msg-user">
          <Markdown text={message.content} />
        </div>
      );
    case "assistant": {
      const thinking = message.streamingThinking || (message as { thinking?: string }).thinking;
      const text = message.content + (message.streamingText ?? "");
      return (
        <div className="msg msg-assistant">
          {thinking ? <ThinkingBlock text={thinking} /> : null}
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
    case "compaction_summary":
      return (
        <div className="msg msg-system">
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

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="thinking" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>思考</summary>
      <pre>{text}</pre>
    </details>
  );
}

function ToolMessage({ message }: { message: ViewMessage }) {
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
  const running = status === "running";
  const argsText = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  return (
    <div className={`tool-call ${running ? "running" : ""}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`dot ${running ? "spin" : status}`} />
        <code>{name}</code>
        <span className="tool-status">{status}</span>
      </button>
      {open ? (
        <div className="tool-body">
          {argsText ? <pre>{argsText}</pre> : null}
          {result !== undefined ? <pre className="tool-result">{result}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
