import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Posted = { type: string; clientId: string; generation: number; source?: string };
class FakeWorker extends EventTarget {
  static current: FakeWorker | null = null;
  posted: Posted[] = [];
  terminated = false;
  constructor() { super(); FakeWorker.current = this; }
  postMessage(message: Posted) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  reply(data: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe("markdown worker revision arbitration", () => {
  beforeEach(() => { vi.resetModules(); vi.stubGlobal("Worker", FakeWorker); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("cancels superseded generations and drops replies after cancellation", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const client = await import("../src/lib/markdown-worker-client");
    const id = client.createMarkdownWorkerClientId();
    const received: unknown[] = [];
    const unsubscribe = client.subscribeMarkdownWorker(id, (reply) => received.push(reply));

    client.requestMarkdownParse(id, 1, "old");
    const oldWorker = FakeWorker.current!;
    client.requestMarkdownParse(id, 2, "new");
    const worker = FakeWorker.current!;
    expect(oldWorker.terminated).toBe(true);
    expect(worker).not.toBe(oldWorker);
    expect(worker.posted.map(({ type, generation }) => [type, generation])).toEqual([
      ["parse", 2],
    ]);
    const reply = (generation: number, source: string) => ({
      type: "parsed", clientId: id, generation, source, nextId: 2,
      document: { source, blocks: [] },
    });
    oldWorker.reply(reply(1, "old"));
    worker.reply(reply(2, "new"));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ generation: 2, source: "new" });

    client.requestMarkdownParse(id, 3, "cancelled");
    client.cancelMarkdownParse(id);
    expect(worker.terminated).toBe(true);
    worker.reply(reply(3, "cancelled"));
    expect(received).toHaveLength(1);
    unsubscribe();
    vi.unstubAllGlobals();
  });

  it("interrupts a busy client while preserving other queued clients", async () => {
    const client = await import("../src/lib/markdown-worker-client");
    const a = client.createMarkdownWorkerClientId(), b = client.createMarkdownWorkerClientId();
    const received = vi.fn();
    const offA = client.subscribeMarkdownWorker(a, received), offB = client.subscribeMarkdownWorker(b, received);
    client.requestMarkdownParse(a, 1, "long synchronous parse");
    const blocked = FakeWorker.current!;
    client.requestMarkdownParse(b, 1, "queued");
    expect(blocked.posted).toHaveLength(1);
    client.requestMarkdownParse(a, 2, "latest");
    expect(blocked.terminated).toBe(true);
    const replacement = FakeWorker.current!;
    expect(replacement.posted[0]).toMatchObject({clientId: b, source: "queued"});
    blocked.reply({type: "parsed", clientId: a, generation: 1});
    expect(received).not.toHaveBeenCalled();
    replacement.reply({type: "parsed", clientId: b, generation: 1});
    expect(received).toHaveBeenCalledTimes(1);
    expect(replacement.posted[1]).toMatchObject({clientId: a, generation: 2});
    offA(); offB();
  });

  it("cancels queued work without interrupting another client's parse", async () => {
    const client = await import("../src/lib/markdown-worker-client");
    client.requestMarkdownParse("a", 1, "running");
    const running = FakeWorker.current!;
    client.requestMarkdownParse("b", 1, "queued");
    client.cancelMarkdownParse("b");
    expect(running.terminated).toBe(false);
    running.reply({type: "parsed", clientId: "a", generation: 1});
    expect(running.posted).toHaveLength(1);
    client.cancelMarkdownParse("a");
  });

  it("fails an errored active job and still services waiting work", async () => {
    const client = await import("../src/lib/markdown-worker-client");
    const failed = vi.fn(), off = client.subscribeMarkdownWorker("a", failed);
    client.requestMarkdownParse("a", 1, "bad");
    const broken = FakeWorker.current!;
    client.requestMarkdownParse("b", 1, "next");
    broken.dispatchEvent(new Event("error"));
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({type: "failed", generation: 1}));
    expect(broken.terminated).toBe(true);
    expect(FakeWorker.current!.posted[0]).toMatchObject({clientId: "b"});
    client.cancelMarkdownParse("b"); off();
  });

  it("times out stuck work and lets a queued parse finish", async () => {
    vi.useFakeTimers();
    const client = await import("../src/lib/markdown-worker-client");
    const failure = vi.fn(), success = vi.fn();
    const offA = client.subscribeMarkdownWorker("a", failure), offB = client.subscribeMarkdownWorker("b", success);
    client.requestMarkdownParse("a", 1, "stuck");
    const stuck = FakeWorker.current!;
    client.requestMarkdownParse("b", 1, "next");
    vi.advanceTimersByTime(15_000);
    expect(stuck.terminated).toBe(true);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({type: "failed", error: "Markdown parse timed out"}));
    FakeWorker.current!.reply({type: "parsed", clientId: "b", generation: 1});
    vi.advanceTimersByTime(30_000);
    expect(success).toHaveBeenCalledTimes(1);
    offA(); offB();
  });
  it("reconstructs a compact reply from the authoritative request and rejects old generations before delivery", async () => {
    const client = await import("../src/lib/markdown-worker-client");
    const received = vi.fn(), off = client.subscribeMarkdownWorker("compact", received);
    client.requestMarkdownParse("compact", 1, "old source");
    const old = FakeWorker.current!;
    client.requestMarkdownParse("compact", 2, "中文 😀");
    const current = FakeWorker.current!;
    const blocks = [{id:1,revision:0,kind:"paragraph",source:"中文 😀",sourceStart:0,sourceEnd:5,html:"<p>中文 😀</p>",children:[]}];
    old.reply({type:"parsed",clientId:"compact",generation:1,nextId:2,blocks});
    expect(received).not.toHaveBeenCalled();
    current.reply({type:"parsed",clientId:"compact",generation:2,nextId:2,blocks});
    expect(received).toHaveBeenCalledTimes(1);
    const reply = received.mock.calls[0][0];
    expect(reply.source).toBe("中文 😀");
    expect(reply.document.source).toBe(reply.source);
    expect(reply.document.html).toBe("<p>中文 😀</p>");
    expect(reply.document.blocks).toBe(blocks);
    off();
  });

});
