/** Opt-in, bounded recorder supplied by the diagnostic harness. No timers,
 * source copies, DOM scans or allocations when disabled. Numeric columns:
 * event, timestamp, a, b, c, d. */
type Recorder = { record: (kind: number, a: number, b: number, c: number, d: number) => void };
export function p1Record(kind: number, a = 0, b = 0, c = 0, d = 0): void {
  (globalThis as typeof globalThis & { __p1Diagnostics?: Recorder }).__p1Diagnostics?.record(kind, a, b, c, d);
}
export function p1Enabled(): boolean {
  return !!(globalThis as typeof globalThis & { __p1Diagnostics?: Recorder }).__p1Diagnostics;
}
