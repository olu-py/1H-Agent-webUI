import type { SessionStateDto } from "../types";

/** A session with its child (fork) sessions nested by `parent_id`. */
export interface SessionNode {
  session: SessionStateDto;
  children: SessionNode[];
}

/** Builds a nested tree from the flat session list, preserving array order. */
export function buildSessionTree(sessions: SessionStateDto[]): SessionNode[] {
  const byId = new Map<string, SessionNode>();
  for (const session of sessions) {
    byId.set(session.id, { session, children: [] });
  }
  const roots: SessionNode[] = [];
  for (const session of sessions) {
    const node = byId.get(session.id)!;
    const parent = session.parent_id ? byId.get(session.parent_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
