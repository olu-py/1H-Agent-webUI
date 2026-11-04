import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthSession, isUnauthorized } from "../src/transport/auth-session";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("browser authentication", () => {
  it("logs in with a header, restores on refresh, and clears on logout", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const data = storage();
    const first = new AuthSession(data, true);
    await first.login("synthetic-secret");
    const refreshed = new AuthSession(data, true);
    expect(refreshed.saved()).toBe("synthetic-secret");
    await refreshed.verify(refreshed.saved());
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe("/api/v2/state");
      expect(url).not.toContain("synthetic-secret");
      expect(options.headers.Authorization).toBe("Bearer synthetic-secret");
    }
    refreshed.clear();
    expect(first.saved()).toBe("");
  });

  it("rejects invalid credentials without storing them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"kind":"unauthorized"}', { status: 401 })));
    const session = new AuthSession(storage(), true);
    const error = await session.login("bad-credential").catch((value) => value);
    expect(isUnauthorized(error)).toBe(true);
    expect(session.saved()).toBe("");
  });

  it("never sends saved or supplied credentials over an insecure origin", async () => {
    const data = storage();
    data.setItem("1h-web-token", "synthetic-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const session = new AuthSession(data, false);
    expect(session.saved()).toBe("");
    await expect(session.login("synthetic-secret")).rejects.toThrow("HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
