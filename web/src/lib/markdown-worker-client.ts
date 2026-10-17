import { markdownWorkerSeed, receivedMarkdownDocument } from "./markdown-worker-wire";
import type { MarkdownDocument, MarkdownModelCache } from "./markdown";
import { p1Record, p1Enabled } from "./p1-diagnostics";

interface ParsedMessage {
  type: "parsed";
  clientId: string;
  generation: number;
  source: string;
  nextId: number;
  document: MarkdownDocument;
  diagnostics?: { parseMs: number; textBytes: number; legacyTextBytes?: number; blocks: number };
}
interface FailedMessage {
  type: "failed";
  clientId: string;
  generation: number;
  error: string;
}
type Reply = ParsedMessage | FailedMessage;
type WireReply = Reply | (Omit<ParsedMessage, "source" | "document"> & { blocks: MarkdownDocument["blocks"] });
type Listener = (reply: Reply) => void;
interface Job {
  type: "parse";
  clientId: string;
  generation: number;
  source: string;
  seed?: MarkdownModelCache;
  queuedAt?: number;
  diagnostic?: boolean;
}
let worker: Worker | null = null;
let active: Job | null = null;
let deadline: ReturnType<typeof setTimeout> | undefined;
let clientSequence = 0;
const listeners = new Map<string, Listener>();
const pending = new Map<string, Job>();
const MAX_PENDING_CLIENTS = 64;
const MAX_PENDING_CHARS = 16 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 15_000;

export function createMarkdownWorkerClientId(): string {
  return `markdown-${++clientSequence}`;
}
function stopWorker(): void {
  clearTimeout(deadline);
  deadline = undefined;
  worker?.terminate();
  worker = null;
  active = null;
}
function failActive(error: string): void {
  const failed = active;
  stopWorker();
  try {
    if (failed) listeners.get(failed.clientId)?.({ type: "failed", clientId: failed.clientId, generation: failed.generation, error });
  } finally { pump(); }
}
function pump(): void {
  if (active || pending.size === 0) return;
  const job = pending.values().next().value!;
  pending.delete(job.clientId);
  active = job;
  p1Record(4, job.generation, performance.now() - (job.queuedAt ?? performance.now()), pending.size, job.source.length * 2 + (job.seed?.source.length ?? 0) * 2);
  try {
    if (!worker) {
      const instance = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" });
      worker = instance;
      instance.addEventListener("message", (event: MessageEvent<WireReply>) => {
        const wire = event.data;
        if (worker !== instance || active?.clientId !== wire.clientId || active.generation !== wire.generation) return;
        const reply: Reply = wire.type === "parsed" && "blocks" in wire
          ? { ...wire, source: active.source, document: receivedMarkdownDocument(active.source, wire.blocks) }
          : wire;
        if (worker !== instance || active?.clientId !== reply.clientId || active.generation !== reply.generation) return;
        p1Record(5, reply.generation, performance.now() - (active.queuedAt ?? performance.now()), reply.type === "parsed" ? reply.diagnostics?.parseMs ?? -1 : -1, reply.type === "parsed" ? reply.diagnostics?.textBytes ?? -1 : 0);
        if (reply.type === "parsed") p1Record(55, reply.diagnostics?.legacyTextBytes ?? -1, reply.diagnostics?.textBytes ?? -1, reply.document?.blocks.length ?? 0);
        clearTimeout(deadline);
        deadline = undefined;
        active = null;
        try { listeners.get(reply.clientId)?.(reply); } finally { pump(); }
      });
      instance.addEventListener("error", () => {
        if (worker !== instance) return;
        failActive("Markdown worker failed");
      });
      instance.addEventListener("messageerror", () => {
        if (worker === instance) failActive("Markdown worker reply could not be decoded");
      });
    }
    deadline = setTimeout(() => failActive("Markdown parse timed out"), PARSE_TIMEOUT_MS);
    worker.postMessage(job);
  } catch (error) {
    stopWorker();
    try { listeners.get(job.clientId)?.({ type: "failed", clientId: job.clientId, generation: job.generation, error: String(error) }); }
    finally { pump(); }
  }
}
export function subscribeMarkdownWorker(clientId: string, listener: Listener): () => void {
  listeners.set(clientId, listener);
  return () => {
    listeners.delete(clientId);
    cancelMarkdownParse(clientId);
    if (listeners.size === 0 && pending.size === 0 && !active) stopWorker();
  };
}
export function requestMarkdownParse(clientId: string, generation: number, source: string, seed?: MarkdownModelCache): void {
  pending.delete(clientId);
  if (active?.clientId === clientId) stopWorker();
  const job: Job = { type: "parse", clientId, generation, source, seed: markdownWorkerSeed(seed) };
  job.queuedAt = performance.now();
  job.diagnostic = p1Enabled();
  p1Record(3, generation, pending.size, active ? 1 : 0, source.length);
  const chars = [...pending.values(), ...(active ? [active] : []), job]
    .reduce((total, item) => total + item.source.length + (item.seed?.source.length ?? 0), 0);
  if (pending.size >= MAX_PENDING_CLIENTS || chars > MAX_PENDING_CHARS) {
    listeners.get(clientId)?.({ type: "failed", clientId, generation, error: "Markdown parse queue capacity exceeded" });
  } else pending.set(clientId, job);
  pump();
}
export function cancelMarkdownParse(clientId: string): void {
  p1Record(6, pending.size, active?.clientId === clientId ? 1 : 0);
  pending.delete(clientId);
  // One dispatched parse: termination interrupts synchronous work without
  // losing another client's queued request.
  if (active?.clientId === clientId) stopWorker();
  pump();
}
