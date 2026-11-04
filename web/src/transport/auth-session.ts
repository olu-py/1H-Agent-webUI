import { ApiRequestError, HttpSseTransport } from "./http-sse";

const STORAGE_KEY = "1h-web-token";

/** A tab-scoped bearer credential. It is never placed in a URL. */
export class AuthSession {
  constructor(private readonly storage: Storage, private readonly secure: boolean) {}

  saved(): string {
    if (!this.secure) return "";
    try { return this.storage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
  }

  clear(): void {
    try { this.storage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  }

  async verify(token: string): Promise<void> {
    if (token && !this.secure) throw new Error("请输入 HTTPS 地址或使用本机安全隧道后再登录。");
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    await new HttpSseTransport("", headers).snapshot();
  }

  async login(token: string): Promise<void> {
    await this.verify(token);
    this.remember(token);
  }

  remember(token: string): void {
    if (token) {
      try { this.storage.setItem(STORAGE_KEY, token); } catch { /* refresh will require login */ }
    } else {
      this.clear();
    }
  }

  transport(token: string, onUnauthorized: () => void): HttpSseTransport {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    return new HttpSseTransport("", headers, onUnauthorized);
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}
