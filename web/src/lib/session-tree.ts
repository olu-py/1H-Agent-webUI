import type { SessionStateDto } from "../types";

/** A session with its child (fork) sessions nested by `parent_id`. */
export interface SessionNode {
  session: SessionStateDto;
  children: SessionNode[];
}

export interface FlatSessionNode {
  session: SessionStateDto;
  depth: number;
  siblingIndex: number;
  siblingCount: number;
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

/** Flatten the visible hierarchy in the same depth-first order used by the
 * original nested renderer, retaining sibling metadata for accessible rows. */
export function flattenSessionTree(roots: SessionNode[]): FlatSessionNode[] {
  const rows: FlatSessionNode[] = [];
  const visit = (nodes: SessionNode[], depth: number) => {
    nodes.forEach((node, index) => {
      rows.push({ session: node.session, depth, siblingIndex: index + 1, siblingCount: nodes.length });
      visit(node.children, depth + 1);
    });
  };
  visit(roots, 0);
  return rows;
}

/** Return a clamped overscanned range for fixed-height virtual rows. */
export function sessionWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = 36,
  overscan = 8,
): { start: number; end: number } {
  return {
    start: Math.max(0, Math.floor(scrollTop / rowHeight) - overscan),
    end: Math.min(count, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan),
  };
}
