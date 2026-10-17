export interface MeasuredViewport {
  heights: ReadonlyMap<string, number>;
  scrollTop: number;
  viewportH: number;
  revision: number;
}
export function measureViewport(previous: MeasuredViewport, rows: ReadonlyArray<readonly [string, number]>, scrollTop: number, viewportH: number): MeasuredViewport {
  let heights = previous.heights;
  for (const [key, height] of rows) {
    if (!Number.isFinite(height) || height < 0 || heights.get(key) === height) continue;
    if (heights === previous.heights) heights = new Map(heights);
    (heights as Map<string, number>).set(key, height);
  }
  if (heights === previous.heights && scrollTop === previous.scrollTop && viewportH === previous.viewportH) return previous;
  return { heights, scrollTop, viewportH, revision: previous.revision + 1 };
}
export function pruneMeasuredRows(previous: MeasuredViewport, liveKeys: ReadonlySet<string>): MeasuredViewport {
  if ([...previous.heights.keys()].every(key => liveKeys.has(key))) return previous;
  return { ...previous, heights: new Map([...previous.heights].filter(([key]) => liveKeys.has(key))), revision: previous.revision + 1 };
}
export function retainedAssistantIndex(messages: ReadonlyArray<{ role: string; content: string; streamingText?: string }>, following: boolean): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && (message.streamingText !== undefined || following && index === messages.length - 1 || message.content.length >= 96 * 1024)) return index;
  }
  return -1;
}
