import { useCallback, useEffect, useRef, useState } from "react";
import type { Actions } from "./actions";
import type { Store } from "./state/store";
import { useChatActions, useUiState } from "./hooks";
import { applyTheme, applyThemeAnimated, getThemePreference, nextTheme } from "./lib/theme";
import type { ThemePreference } from "./lib/theme";
import { ChatScreen } from "./components/ChatScreen";
import { HomeScreen } from "./components/HomeScreen";
import { TodoPanel } from "./components/TodoPanel";
import { ApprovalModal } from "./components/ApprovalModal";
import { CommandPalette } from "./components/CommandPalette";
import { ProviderSettingsModal } from "./components/ProviderSettingsModal";
import { MemoryPanel } from "./components/MemoryPanel";
import { Presence } from "./components/Presence";
import { TranscriptSearch } from "./components/TranscriptSearch";

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
  const [showMemory, setShowMemory] = useState(false);
  const [showTranscriptSearch, setShowTranscriptSearch] = useState(false);
  const [jumpRequest, setJumpRequest] = useState<{ id: number; nonce: number } | null>(null);
  const jumpNonce = useRef(0);
  const toggleSessions = useCallback(() => setShowSessions((v) => !v), []);
  const toggleTodo = useCallback(() => setShowTodo((v) => !v), []);
  const togglePalette = useCallback(() => setShowPalette((v) => !v), []);
  const openProvider = useCallback(() => setShowProvider(true), []);
  const openMemory = useCallback(() => setShowMemory(true), []);
  const closeTodo = useCallback(() => setShowTodo(false), []);
  const closePalette = useCallback(() => setShowPalette(false), []);
  const closeProvider = useCallback(() => setShowProvider(false), []);
  const closeMemory = useCallback(() => setShowMemory(false), []);
  const closeTranscriptSearch = useCallback(() => setShowTranscriptSearch(false), []);
  const locateTranscriptMessage = useCallback(async (id: number) => {
    if (!await chatActions.locateMessage(id)) return;
    jumpNonce.current += 1;
    setJumpRequest({ id, nonce: jumpNonce.current });
    setShowTranscriptSearch(false);
  }, [chatActions]);

  // Apply the theme on mount and whenever it cycles (the effect is the
  // bootstrap safety net; user cycles go through `applyThemeAnimated`, which
  // cross-fades and then lands on the same attribute).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Ctrl/Cmd+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && state.activeSession) {
        e.preventDefault();
        setShowTranscriptSearch(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.activeSession]);

  const cycleTheme = () => {
    const next = nextTheme(theme);
    applyThemeAnimated(next);
    setTheme(next);
  };
  const active = state.activeSession !== null;
  return (
    <>
      {active ? (
        <ChatScreen
          state={state}
          store={store}
          actions={chatActions}
          theme={theme}
          onCycleTheme={cycleTheme}
          onToggleSessions={toggleSessions}
          showSessions={showSessions}
          onToggleTodo={toggleTodo}
          onTogglePalette={togglePalette}
          onOpenProvider={openProvider}
          onOpenMemory={openMemory}
          onSearchTranscript={() => setShowTranscriptSearch(true)}
          jumpRequest={jumpRequest}
        />
      ) : (
        <HomeScreen
          state={state}
          actions={chatActions}
          theme={theme}
          onCycleTheme={cycleTheme}
          onTogglePalette={togglePalette}
          onOpenProvider={openProvider}
          onOpenMemory={openMemory}
        />
      )}
      <Presence open={showTodo}>
        <TodoPanel todos={state.todos} actions={chatActions} onClose={closeTodo} />
      </Presence>
      <Presence open={showPalette}>
        <CommandPalette
          actions={chatActions}
          mode={state.mode}
          onClose={closePalette}
          onOpenProviderSettings={openProvider}
        />
      </Presence>
      <Presence open={showProvider}>
        <ProviderSettingsModal
          store={store}
          actions={chatActions}
          onClose={closeProvider}
        />
      </Presence>
      <Presence open={showMemory}>
        <MemoryPanel memories={state.memories} actions={chatActions} onClose={closeMemory} />
      </Presence>
      {active ? <Presence open={showTranscriptSearch}>
        <TranscriptSearch actions={chatActions} onClose={closeTranscriptSearch} onLocate={(id) => void locateTranscriptMessage(id)} />
      </Presence> : null}
      <Presence open={state.approval !== null}>
        <ApprovalModal key={state.approval?.approval_id} approval={state.approval} actions={chatActions} />
      </Presence>
    </>
  );
}
