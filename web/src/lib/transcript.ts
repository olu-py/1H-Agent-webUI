import type { PartialDto } from "../types";
import type { ViewMessage } from "../state/reducer";

/**
 * Appends the snapshot's persisted incomplete assistant answer ("未完成") as a
 * trailing message so an interrupted stream survives a restart. Skipped while
 * a live turn is in flight (synthetic rows present): the partial is then stale
 * history and would otherwise render below the streaming answer. Deduplicates
 * when the transcript tail already carries the same content (e.g. a refetched
 * partial row, or a completed turn not yet cleared).
 */
export function withPartial(messages: ViewMessage[], partial: PartialDto | null): ViewMessage[] {
  if (!partial) return messages;
  const content = partial.content;
  if (!content || !content.trim()) return messages;
  if (messages.some((m) => m.id < 0)) return messages;
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

/**
 * Folds persisted `tool_output` rows into the tool call that produced them so
 * the output renders inside the call's expanded body (after 参数, under the
 * 输出结果 header) instead of as a standalone block in the transcript.
 * Outputs are matched to calls by call id; an output whose call row is not in
 * the cached window stays standalone rather than being dropped.
 */
export function attachToolOutputs(messages: ViewMessage[]): ViewMessage[] {
  const outputs = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool_output" && m.callId) {
      const output = m.output ?? "";
      const prev = outputs.get(m.callId);
      outputs.set(m.callId, prev === undefined ? output : `${prev}\n${output}`);
    }
  }
  if (outputs.size === 0) return messages;
  const consumed = new Set<string>();
  const next: ViewMessage[] = [];
  let changed = false;
  for (const m of messages) {
    if (m.role === "tool") {
      if (m.callId && outputs.has(m.callId)) {
        consumed.add(m.callId);
        if (!m.result) {
          changed = true;
          next.push({ ...m, result: outputs.get(m.callId) });
          continue;
        }
      }
      next.push(m);
    } else if (m.role === "tool_calls") {
      const calls = m.calls ?? [];
      if (calls.some((c) => outputs.has(c.id))) {
        const merged: Record<string, string> = { ...m.outputs };
        for (const c of calls) {
          if (!outputs.has(c.id)) continue;
          merged[c.id] = outputs.get(c.id) as string;
          consumed.add(c.id);
        }
        changed = true;
        next.push({ ...m, outputs: merged });
        continue;
      }
      next.push(m);
    } else if (m.role === "tool_output") {
      // Drop the standalone row once its call row has absorbed the output.
      if (m.callId && consumed.has(m.callId)) {
        changed = true;
        continue;
      }
      next.push(m);
    } else {
      next.push(m);
    }
  }
  return changed ? next : messages;
}
