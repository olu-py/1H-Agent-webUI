import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTree } from "../src/components/SessionTree";
import type { ChatActions } from "../src/hooks";
import { initialState } from "../src/state/reducer";
import type { Store } from "../src/state/store";
import type { SessionStateDto } from "../src/types";

vi.mock("../src/components/SessionMenu", () => ({
  SessionMenu: () => createElement("button", { type: "button", "aria-label": "会话操作" }),
}));

describe("SessionTree rendering", () => {
  it("keeps a 1,001 session tree within a bounded first viewport", () => {
    const sessions: SessionStateDto[] = Array.from({ length: 1001 }, (_, index) => ({
      id: `s${index}`,
      title: `Session ${index}`,
      parent_id: null,
      busy: false,
      phase: "IDLE",
      status: "",
    }));
    const state = { ...initialState, sessions, activeSession: "s1000" };
    const store: Store = {
      getState: () => state,
      getSnapshot: () => state,
      dispatch: () => undefined,
      subscribe: () => () => undefined,
    };
    const html = renderToStaticMarkup(createElement(SessionTree, {
      store,
      actions: {} as ChatActions,
      onActivate: () => undefined,
    }));
    const rows = html.match(/role="treeitem"/g) ?? [];
    const nodes = html.match(/<[a-z][^>]*>/gi) ?? [];
    expect(rows).toHaveLength(25);
    // Idle rows no longer render the always-on status dot.
    expect(nodes).toHaveLength(127);
    expect(nodes.length).toBeLessThan(2000);
    expect(html).not.toContain("Session 1000");
  });
});
