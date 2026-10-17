import { followsScrollRoot } from "./scroll-follow";
/** Restore from geometry captured before DOM writes; avoid a synchronous
 * scroll read/write when measurements below the anchor changed nothing. */
export function restoreScrollAnchor(
  root: Pick<HTMLElement, "scrollTop">,
  previousScrollTop: number,
  targetScrollTop: number,
): void {
  const next = Math.max(0, targetScrollTop);
  if (Math.abs(next - previousScrollTop) > 0.5) root.scrollTop = next;
}

/** Resolve the anchor before reading geometry, especially after DOM writes. */
export function restoreIndexedScrollAnchor(
  root: Pick<HTMLElement, "scrollTop">,
  anchor: { blockId: string; localOffset: number; viewportOffset: number } | null,
  indices: ReadonlyMap<string, number>,
  prefix: (index: number) => number,
  geometry: () => { hostTop: number; rootTop: number; scrollTop: number },
): void {
  if (!anchor || followsScrollRoot(root)) return;
  const index = indices.get(anchor.blockId);
  if (index === undefined) return;
  const { hostTop, rootTop, scrollTop } = geometry();
  restoreScrollAnchor(root, scrollTop,
    scrollTop + hostTop - rootTop + prefix(index) + anchor.localOffset - anchor.viewportOffset);
}
