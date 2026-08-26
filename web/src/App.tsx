import { useEffect, useState } from "react";
import type { Actions } from "./actions";
import type { Store } from "./state/store";
import { useChatActions, useUiState } from "./hooks";
import { applyTheme, getThemePreference, nextTheme } from "./lib/theme";
import type { ThemePreference } from "./lib/theme";
import { ChatScreen } from "./components/ChatScreen";
import { HomeScreen } from "./components/HomeScreen";
import { TodoPanel } from "./components/TodoPanel";
import { ApprovalModal } from "./components/ApprovalModal";
import { CommandPalette } from "./components/CommandPalette";
import { ProviderSettingsModal } from "./components/ProviderSettingsModal";

/**
 * Top-level app: home screen until a session is active, then the chat screen.
 * Both share the same store + actions; views never touch the transport.
 * Home/chat is derived purely from `activeSession` (home = no session yet).
 * The theme preference lives here and is applied to `<html data-theme>`.
 * The provider settings dialog is owned here so both the composer's switcher
 * trigger and the command palette open the same modal on either screen.
 */
export function App({ store, actions }: { store: Store; actions: Actions }) {
  const state = useUiState(store);
  const chatActions = useChatActions(actions);
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);
  const [showSessions, setShowSessions] = useState(false);
  const [showTodo, setShowTodo] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showProvider, setShowProvider] = useState(false);

  // Apply the theme on mount and whenever it cycles.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Ctrl/Cmd+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const cycleTheme = () => setTheme((t) => nextTheme(t));
  const active = state.activeSession !== null;
  return (
    <>
      {active ? (
        <ChatScreen
          state={state}
          actions={chatActions}
          theme={theme}
          onCycleTheme={cycleTheme}
          onToggleSessions={() => setShowSessions((v) => !v)}
          showSessions={showSessions}
          onToggleTodo={() => setShowTodo((v) => !v)}
          onTogglePalette={() => setShowPalette((v) => !v)}
          onOpenProvider={() => setShowProvider(true)}
        />
      ) : (
        <HomeScreen state={state} actions={chatActions} />
      )}
      {showTodo ? <TodoPanel todos={state.todos} actions={chatActions} onClose={() => setShowTodo(false)} /> : null}
      {showPalette ? (
        <CommandPalette
          actions={chatActions}
          mode={state.mode}
          onClose={() => setShowPalette(false)}
          onOpenProviderSettings={() => setShowProvider(true)}
        />
      ) : null}
      {showProvider ? (
        <ProviderSettingsModal
          state={state}
          actions={chatActions}
          onClose={() => setShowProvider(false)}
        />
      ) : null}
      <ApprovalModal approval={state.approval} actions={chatActions} />
    </>
  );
}
