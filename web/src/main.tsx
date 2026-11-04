import { createRoot } from "react-dom/client";
import { AuthGate, NativeApp } from "./AuthGate";
import { nativeIpc, TauriIpcTransport } from "./transport/tauri-ipc";
import { applyTheme, getThemePreference } from "./lib/theme";
import "./styles.css";

// Theme bootstrap: apply the stored preference (also handled pre-paint by the
// inline script in index.html) so React state and the DOM never diverge.
applyTheme(getThemePreference());

// Track the input modality so pointer focus does not paint a ring on
// non-editable controls; keyboard navigation restores it (see focus.css rules).
document.documentElement.dataset.inputModality = "keyboard";
window.addEventListener("pointerdown", () => {
  document.documentElement.dataset.inputModality = "pointer";
}, true);
window.addEventListener("keydown", () => {
  document.documentElement.dataset.inputModality = "keyboard";
}, true);

const ipc = nativeIpc();
createRoot(document.getElementById("root")!).render(ipc ? <NativeApp transport={new TauriIpcTransport(ipc)} /> : <AuthGate />);
