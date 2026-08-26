import type { PartialDto } from "../types";
import type { ViewMessage } from "../state/reducer";

/**
 * Appends the snapshot's persisted incomplete assistant answer ("未完成") as a
 * trailing message so an interrupted stream survives a restart. Deduplicates
 * when the transcript tail already carries the same content (e.g. a live
 * stream whose text equals the partial, or a completed turn not yet cleared).
 */
export function withPartial(messages: ViewMessage[], partial: PartialDto | null): ViewMessage[] {
  if (!partial) return messages;
  const content = partial.content;
  if (!content || !content.trim()) return messages;
  const last = messages[messages.length - 1];
  if (
    last &&
    last.kind === "assistant" &&
    !last.streamingText &&
    !last.streamingThinking &&
    last.content === content
  ) {
    return messages;
  }
  return [
    ...messages,
    {
      key: "assistant-partial",
      id: -1,
      kind: "assistant",
      role: "assistant",
      content,
      createdAt: partial.created_at,
      partial: true,
    },
  ];
}
