import { QUICK_STARTS } from "../lib/quick-start";
import { Icon } from "./icons";

/** First-run state of an empty session. The home screen only appears before a
 * session exists; opening an existing empty session otherwise leaves a blank
 * transcript. These suggestions submit directly, so the empty session has the
 * same affordance as the home card. */
export function ChatEmpty({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="chat-empty">
      <span className="chat-empty-mark" aria-hidden="true">
        <Icon name="sparkles" size={22} />
      </span>
      <h2>开始新的对话</h2>
      <p>描述你想完成的任务，或从下面的示例开始。</p>
      <div className="chips" aria-label="快捷开始">
        {QUICK_STARTS.map((item) => (
          <button
            key={item.label}
            type="button"
            className="chip"
            onClick={() => onPick(item.prompt)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
