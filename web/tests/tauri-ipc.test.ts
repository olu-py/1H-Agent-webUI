import { describe, expect, it, vi } from "vitest";
import { TauriIpcTransport, type NativeIpc } from "../src/transport/tauri-ipc";
import type { Envelope } from "../src/types";

describe("native transport boundary", () => {
  it("retires completed receipts through core authority when capacity is reached", async () => {
    let queries = 0;
    const native: NativeIpc = { invoke: async <T>(command: string, args: Record<string, unknown>) => {
      if (command === "core_register_request") return 1 as T;
      const call = args.call as {method:string;sessionId:string};
      if (call.method === "submit") return {session_id:call.sessionId, request_seq:1} as T;
      if (call.method === "requestSequence") { queries += 1; return null as T; }
      return null as T;
    } };
    const transport = new TauriIpcTransport(native);
    for (let index = 0; index < 65; index++) await transport.submit(`s${index}`, "hello");
    expect(queries).toBe(64);
  });
  it("a delayed authority query cannot retire a newer submit receipt", async () => {
    let release!: (value: number | null) => void;
    let sequence = 1;
    const calls: Array<Record<string, unknown>> = [];
    const native: NativeIpc = { invoke: async <T>(command: string, args: Record<string, unknown>) => {
      if (command === "core_register_request") return 1 as T;
      const call = args.call as {method:string;sessionId:string};
      calls.push(call);
      if (call.method === "submit") return {session_id:call.sessionId, request_seq:sequence} as T;
      if (call.method === "requestSequence" && call.sessionId === "s0") return await new Promise<T>(resolve => { release = value => resolve(value as T); });
      return null as T;
    } };
    const transport = new TauriIpcTransport(native);
    for (let index = 0; index < 64; index++) await transport.submit(`s${index}`, "hello");
    const pending = transport.submit("s64", "hello");
    await vi.waitFor(() => expect(release).toBeDefined());
    sequence = 2;
    await transport.submit("s0", "new request");
    release(null);
    await pending;
    await transport.cancel("s0");
    expect(calls.at(-1)).toEqual({method:"cancel",sessionId:"s0",requestSeq:2});
  });
  it("keeps approval permissions and Agent sequence distinct from IPC cancellation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const native: NativeIpc = { invoke: async <T>(command: string, args: Record<string, unknown>) => {
      if (command === "core_register_request") return 1 as T;
      calls.push(args);
      return ((args.call as { method: string }).method === "submit" ? { session_id: "session-a", request_seq: 42 } : null) as T;
    } };
    const transport = new TauriIpcTransport(native);
    await transport.submit("session-a", "hello");
    await transport.approve("approval-a", true, true);
    await transport.cancel("session-a");
    expect(calls.map(value => value.call)).toEqual([
      { method: "submit", sessionId: "session-a", text: "hello" },
      { method: "approve", approvalId: "approval-a", accept: true, allowSession: true },
      { method: "cancel", sessionId: "session-a", requestSeq: 42 },
    ]);
    expect(new Set(calls.map(value => value.requestId)).size).toBe(3);
    await transport.cancel("other-session");
    expect(calls.at(-1)?.call).toEqual({ method: "requestSequence", sessionId: "other-session" });
    expect(calls).toHaveLength(4);
  });

  it("uses core authority when attaching to an already running Agent", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const native: NativeIpc = { invoke: async <T>(command: string, args: Record<string, unknown>) => {
      if (command === "core_register_request") return 1 as T;
      calls.push(args.call as Record<string, unknown>);
      return ((args.call as {method: string}).method === "requestSequence" ? 97 : null) as T;
    } };
    await new TauriIpcTransport(native).cancel("attached");
    expect(calls).toEqual([{method: "requestSequence", sessionId: "attached"}, {method: "cancel", sessionId: "attached", requestSeq: 97}]);
  });

  it("propagates request abort and rejects late message results", async () => {
    const cancelled: string[] = [];
    let requestId = "";
    let complete!: (value: unknown) => void;
    const native: NativeIpc = { invoke: <T>(command: string, args: Record<string, unknown>) => {
      if (command === "core_register_request") return Promise.resolve(1 as T);
      if (command === "core_cancel_request") {
        cancelled.push(String(args.requestId));
        return Promise.resolve(null as T);
      }
      requestId = String(args.requestId);
      return new Promise<T>(resolve => { complete = value => resolve(value as T); });
    } };
    const transport = new TauriIpcTransport(native);
    const controller = new AbortController();
    const request = transport.messages("session-a", { signal: controller.signal });
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(requestId).not.toBe(""));
    controller.abort();
    complete({ messages: [] });
    await rejection;
    expect(cancelled).toEqual([requestId]);
  });

  it("deduplicates replay and releases the idle event waiter on unsubscribe", async () => {
    let complete!: (value: Envelope[]) => void;
    const waiting: Array<{cursor: number; requestId: string}> = [];
    const cancelled: string[] = [];
    const native: NativeIpc = { invoke: <T>(command: string, args: Record<string, unknown>) => {
      if (command === "core_register_request") return Promise.resolve(1 as T);
      if (command === "core_cancel_request") {
        cancelled.push(String(args.requestId));
        return Promise.resolve(null as T);
      }
      waiting.push({ cursor: (args.call as { cursor: number }).cursor, requestId: String(args.requestId) });
      return new Promise<T>(resolve => { complete = batch => resolve(batch as T); });
    } };
    const delivered: Envelope[] = [];
    const transport = new TauriIpcTransport(native);
    const subscription = transport.subscribe(5, event => delivered.push(event));
    const event = (cursor: number): Envelope => ({ cursor, session_id: "session-a", type: "text_delta", delta: "x" });
    await vi.waitFor(() => expect(waiting.length).toBe(1));
    complete([event(5), event(6), event(6), event(7)]);
    await vi.waitFor(() => expect(waiting.length).toBe(2));
    expect(delivered.map(event => event.cursor)).toEqual([6, 7]);
    expect(waiting[1].cursor).toBe(7);
    subscription.unsubscribe();
    await vi.waitFor(() => expect(cancelled).toEqual([waiting[1].requestId]));
    complete([event(8)]);
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered.map(event => event.cursor)).toEqual([6, 7]);
  });
});
