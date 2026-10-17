import { describe, expect, it } from "vitest";
import type { SessionStateDto } from "../src/types";
import { buildSessionTree, flattenSessionTree, sessionWindow } from "../src/lib/session-tree";

function session(id: string, parent_id: string | null = null): SessionStateDto {
  return { id, title: id, parent_id, busy: false, phase: "IDLE", status: "" };
}

describe("virtual session tree", () => {
  it("preserves depth-first session and sibling order", () => {
    const sessions = [session("root-a"), session("child-a", "root-a"), session("root-b"), session("child-b", "root-a")];
    const rows = flattenSessionTree(buildSessionTree(sessions));
    expect(rows.map((row) => [row.session.id, row.depth, row.siblingIndex, row.siblingCount])).toEqual([
      ["root-a", 0, 1, 2],
      ["child-a", 1, 1, 2],
      ["child-b", 1, 2, 2],
      ["root-b", 0, 2, 2],
    ]);
  });

  it("keeps the mounted window bounded for 1,001 sessions", () => {
    const { start, end } = sessionWindow(1001, 0, 720);
    expect(start).toBe(0);
    expect(end).toBeLessThan(100);
    expect(end - start).toBeGreaterThan(20);
    const middle = sessionWindow(1001, 500 * 36, 720);
    expect(middle.start).toBeLessThan(500);
    expect(middle.end).toBeGreaterThan(500);
    expect(middle.end - middle.start).toBeLessThan(50);
  });
});
