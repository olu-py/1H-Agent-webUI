import { useEffect, useMemo, useRef, useState } from "react";
import { App } from "./App";
import { createActions } from "./actions";
import { createStore } from "./state/store";
import { AuthSession, isUnauthorized } from "./transport/auth-session";
import type { Transport } from "./transport/transport";

function RunningApp({ transport, logout }: { transport: Transport; logout?: () => void }) {
  const { store, actions } = useMemo(() => {
    const store = createStore();
    return { store, actions: createActions(transport, store) };
  }, [transport]);
  useEffect(() => {
    void actions.init();
    return () => actions.stop();
  }, [actions]);
  return <><App store={store} actions={actions} />{logout && <button className="auth-logout" onClick={logout}>退出登录</button>}</>;
}

export function NativeApp({ transport }: { transport: Transport }) {
  return <RunningApp transport={transport} />;
}

export function AuthGate() {
  const session = useMemo(() => new AuthSession(window.sessionStorage, window.isSecureContext), []);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [checking, setChecking] = useState(true);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const generation = useRef(0);

  const open = async (token: string, cancelled: () => boolean = () => false) => {
    const current = ++generation.current;
    const stale = () => cancelled() || generation.current !== current;
    setChecking(true);
    try {
      await session.verify(token);
      if (stale()) return;
      session.remember(token);
      const next = session.transport(token, () => {
        if (stale()) return;
        generation.current++;
        session.clear();
        setTransport(null);
        setAuthenticated(false);
        setMessage("凭据已失效，请重新登录。");
      });
      setDraft("");
      setMessage("");
      setAuthenticated(Boolean(token));
      setTransport(next);
    } catch (error) {
      if (stale()) return;
      if (isUnauthorized(error)) {
        session.clear();
        setMessage(token ? "凭据无效，请重试。" : "请输入服务端 token。 ");
      } else {
        setMessage(error instanceof Error ? error.message : "连接失败，请重试。");
      }
    } finally {
      if (!stale()) setChecking(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void open(session.saved(), () => cancelled);
    return () => { cancelled = true; };
    // session is stable for the lifetime of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  if (transport) return <RunningApp transport={transport} logout={authenticated ? () => {
    generation.current++;
    session.clear();
    setTransport(null);
    setAuthenticated(false);
    setDraft("");
    setMessage("已退出登录。");
  } : undefined} />;

  return <main className="auth-screen"><form className="auth-form" onSubmit={(event) => {
    event.preventDefault();
    void open(draft.trim());
  }}>
    <h1>连接 1H-Agent</h1>
    <p>输入服务端 token。凭据仅保存在当前浏览器标签页。</p>
    {!window.isSecureContext && <p role="alert">当前连接不安全。请使用 HTTPS 或本机安全隧道。</p>}
    <label>服务端 token<input type="password" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
    {message && <p role="alert">{message}</p>}
    <button type="submit" disabled={checking || !draft.trim() || !window.isSecureContext}>{checking ? "正在连接…" : "登录"}</button>
  </form></main>;
}
