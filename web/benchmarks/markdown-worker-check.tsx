import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Markdown } from "../src/components/Markdown";
import { cancelMarkdownParse, requestMarkdownParse, subscribeMarkdownWorker } from "../src/lib/markdown-worker-client";
import "../src/styles.css";

const NativeWorker = window.Worker;
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), userAgent: navigator.userAgent };
let mode: "normal" | "blocked" | "fail" = "normal";
let started = false;
let terminated = 0;
let created = 0;
class ObservedWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    if (mode === "fail") throw new Error("Injected constructor failure");
    super(mode === "blocked" ? new URL("./markdown-worker-blocked.ts", import.meta.url) : url, options);
    created++;
    super.addEventListener("message", (event) => { if (event.data?.probe === "entered") started = true; });
  }
  override terminate() { terminated++; super.terminate(); }
}
window.Worker = ObservedWorker;
const wait = async (check: () => boolean, timeout = 10_000) => {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error("Browser assertion timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const assert = (value: boolean, message: string) => { if (!value) throw new Error(message); };
async function run() {
  // A native worker deliberately remains in a synchronous infinite loop.
  // This measures the cancellation mechanism, not production parser timing.
  const replies: { clientId: string; generation: number; type: string }[] = [];
  const offA = subscribeMarkdownWorker("probe-a", (reply) => replies.push(reply));
  const offB = subscribeMarkdownWorker("probe-b", (reply) => replies.push(reply));
  mode = "blocked";
  requestMarkdownParse("probe-a", 1, "blocked");
  await wait(() => started);
  requestMarkdownParse("probe-b", 1, "# queued survivor\n");
  mode = "normal";
  const cancelStart = performance.now();
  requestMarkdownParse("probe-a", 2, "# replacement\n");
  await wait(() => replies.length === 2);
  evidence.nativeCancellation = { enteredSynchronousLoop: started, terminated, elapsedMs: performance.now() - cancelStart, replies };
  assert(terminated === 1 && replies.every((reply) => reply.type === "parsed") && !replies.some((reply) => reply.clientId === "probe-a" && reply.generation === 1), "Cancellation or queue preservation failed");
  offA(); offB(); cancelMarkdownParse("probe-a");

  const host = document.getElementById("root")!;
  host.style.cssText = "height:600px; overflow:auto; width:900px";
  const root = createRoot(host);
  const source = "# STRICT_READY\n\n" + "A paragraph with **bold text**.\n\n".repeat(180);
  const before = created;
  root.render(<StrictMode><Markdown text={source} /></StrictMode>);
  await wait(() => host.querySelector("h1")?.textContent === "STRICT_READY");
  evidence.strictMode = { rendered: true, workersCreated: created - before, domNodes: host.querySelectorAll("*").length };
  assert(created - before >= 2, "StrictMode effect remount was not exercised");
  root.unmount();

  const retryRoot = createRoot(host);
  mode = "fail";
  retryRoot.render(<Markdown text={source.replace("STRICT_READY", "RETRY_READY")} />);
  await wait(() => !!host.querySelector('[role="alert"] button'));
  const failureVisible = !!host.querySelector('[role="alert"]');
  mode = "normal";
  (host.querySelector('[role="alert"] button') as HTMLButtonElement).click();
  await wait(() => host.querySelector("h1")?.textContent === "RETRY_READY");
  evidence.retry = { failureVisible, rendered: true, alertCleared: !host.querySelector('[role="alert"]') };
  assert(!host.querySelector('[role="alert"]'), "Failure alert remained after retry");
  retryRoot.unmount();
  const streamingRoot = createRoot(host);
  const parts = ["a".repeat(4090) + "e", "\u0301".repeat(800), "🙂中文".repeat(1500)];
  let text = "";
  for (const [index, delta] of parts.entries()) {
    text += delta;
    flushSync(() => streamingRoot.render(<Markdown text={text} fadeTail stream={{ id: "plain-check", revision: index + 1, delta }} />));
    assert(host.textContent === text, "Plain stream text changed across chunk rotation");
  }
  const chunks = [...host.querySelectorAll('.markdown-inline-chunk')];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const boundaries = new Set([...segmenter.segment(text)].map((part) => part.index));
  boundaries.add(text.length);
  let offset = 0;
  for (const chunk of chunks) {
    offset += chunk.textContent?.length ?? 0;
    assert(boundaries.has(offset), "Plain stream split a grapheme between chunks");
  }
  evidence.plainStreaming = { exact: host.textContent === text, chunks: chunks.length, characters: text.length, graphemeBoundariesPreserved: true };
  assert(chunks.length > 1, "Plain stream chunk rotation was not exercised");
  (window as unknown as { physicalStep: (revision: number) => void }).physicalStep = (revision) => {
    streamingRoot.render(<Markdown text={`# Revision ${revision}\n\n` + "Measured Markdown paragraph 中文.\n\n".repeat(160)} />);
  };
  evidence.pass = true;
}
run().catch((error: unknown) => { evidence.pass = false; evidence.error = String(error); }).finally(() => {
  window.Worker = NativeWorker;
  (window as unknown as { workerCheck: unknown }).workerCheck = evidence;
  document.body.dataset.complete = "true";
});
