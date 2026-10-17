import { describe, expect, it } from "vitest";
import { restoreIndexedScrollAnchor, restoreScrollAnchor } from "../src/lib/scroll-anchor";

describe("anchor restoration after DOM writes", () => {
  it("skips geometry for absent or removed anchors and restores a surviving logical position", () => {
    const writes: number[] = [];
    const root = { get scrollTop(): number { throw Error("unexpected layout read"); },
      set scrollTop(value: number) { writes.push(value); } };
    const indices = new Map([["kept", 0]]);
    const unreadable = () => { throw Error("post-write geometry read"); };
    restoreIndexedScrollAnchor(root, null, indices, unreadable, unreadable);
    restoreIndexedScrollAnchor(root, { blockId: "removed", localOffset: 10, viewportOffset: 5 },
      indices, unreadable, unreadable);
    const anchor = { blockId: "kept", localOffset: 10, viewportOffset: 5 };
    restoreIndexedScrollAnchor(root, anchor, indices, () => 80,
      () => ({ hostTop: 20, rootTop: 10, scrollTop: 200 }));
    expect(writes).toEqual([295]);
  });
  it("does not read layout or write scroll when the anchor has not moved", () => {
    const writes: number[] = [];
    const root = { get scrollTop(): number { throw Error("post-write layout read"); },
      set scrollTop(value: number) { writes.push(value); } };
    restoreScrollAnchor(root, 200, 200);
    restoreScrollAnchor(root, 200, 200.4);
    expect(writes).toEqual([]);
    restoreScrollAnchor(root, 200, 235.75);
    restoreScrollAnchor(root, 235.75, -10);
    expect(writes).toEqual([235.75, 0]);
  });
});
