import { useState } from "react";
import type { Actions } from "./actions";
import type { Store } from "./state/store";
import { useChatActions, useUiState } from "./hooks";
import { ChatScreen } from "./components/ChatScreen";
import { HomeScreen } from "./components/HomeScreen";
import { TodoPanel } from "./components/TodoPanel";
import { ApprovalModal } from "./components/ApprovalModal";

/**
 * Top-level app: home screen until a session is active, then the chat screen.
 * Both share the same store + actions; views never touch the transport.
 * Home/chat is derived purely from `activeSession` (home = no session yet).
 */
export function App({ store, actions }: { store: Store; actions: Actions }) {
  const state = useUiState(store);
  const chatActions = useChatActions(actions);
  const [showSessions, setShowSessions] = useState(false);
  const [showTodo, setShowTodo] = useState(false);

  const active = state.activeSession !== null;
  return (
    <>
      {active ? (
        <ChatScreen
          state={state}
          actions={chatActions}
          onToggleSessions={() => setShowSessions((v) => !v)}
          showSessions={showSessions}
          onToggleTodo={() => setShowTodo((v) => !v)}
        />
      ) : (
        <HomeScreen state={state} actions={chatActions} />
      )}
      {showTodo ? <TodoPanel todos={state.todos} actions={chatActions} onClose={() => setShowTodo(false)} /> : null}
      <ApprovalModal approval={state.approval} actions={chatActions} />
    </>
  );
}
