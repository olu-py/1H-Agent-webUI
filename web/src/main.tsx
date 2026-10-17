import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createStore } from "./state/store";
import { createActions } from "./actions";
import { HttpSseTransport } from "./transport/http-sse";
import { nativeIpc, TauriIpcTransport } from "./transport/tauri-ipc";
import { applyTheme, getThemePreference } from "./lib/theme";
import "./styles.css";

// Theme bootstrap: apply the stored preference (also handled pre-paint by the
// inline script in index.html) so React state and the DOM never diverge.
applyTheme(getThemePreference());

// Native hosts expose the Tauri API; browsers use HTTP+SSE.
function makeTransport() {
  const ipc = nativeIpc();
  if (ipc) return new TauriIpcTransport(ipc);
  // Remote deployments gate the API behind a bearer token; pass it via the
  // ?token= query for the SSE connection and store it for REST calls.
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new HttpSseTransport("", headers);
}

const store = createStore();
const transport = makeTransport();
const actions = createActions(transport, store);

// Boot: fetch snapshot + subscribe to events. On unload, close the stream.
void actions.init();
window.addEventListener("beforeunload", () => actions.stop());

createRoot(document.getElementById("root")!).render(<App store={store} actions={actions} />);
