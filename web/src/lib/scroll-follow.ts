const followers = new WeakMap<object, () => boolean>();
export function bindScrollFollower(root: object, following: () => boolean): () => void {
  followers.set(root, following);
  return () => { if (followers.get(root) === following) followers.delete(root); };
}
export function followsScrollRoot(root: object): boolean { return followers.get(root)?.() ?? false; }
export function remainsFollowing(previous: boolean, top: number, lastApplied: number | null, extent: number, viewport: number): boolean {
  return previous && lastApplied !== null && Math.abs(top - lastApplied) < 1 || extent - top - viewport < 48;
}
