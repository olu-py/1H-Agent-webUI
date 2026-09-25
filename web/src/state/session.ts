import type { AppSnapshotV2 } from "../types";
import type { UiState } from "./reducer";
import { childSessionLabel } from "../lib/session-status";

export function reduceSnapshot(state: UiState, snapshot: AppSnapshotV2): UiState {
  const sessionChanged = snapshot.active_session !== state.activeSession;
  const childSessions = snapshot.sessions.filter((session) => session.child_status);
  return {
    ...state,
    protocolVersion: snapshot.protocol_version,
    cursor: snapshot.event_cursor,
    activeSession: snapshot.active_session,
    sessions: snapshot.sessions,
    childStatus: Object.fromEntries(childSessions.map((session) => [session.id, session.child_status!])),
    backgroundStatus: {
      ...(sessionChanged ? {} : state.backgroundStatus),
      ...Object.fromEntries(childSessions.map((session) => [
        session.id,
        childSessionLabel(
          session.child_status!,
          session.child_phase,
          session.child_turn,
          session.child_max_turns,
          session.child_tool,
        ),
      ])),
    },
    provider: snapshot.provider,
    model: snapshot.model,
    mode: snapshot.mode,
    approval: snapshot.approval,
    todos: snapshot.todos,
    context: snapshot.context,
    contextOverlayTokens: 0,
    assistantPartial: snapshot.assistant_partial,
    snapshotDirty: false,
    transcriptDirty: state.transcriptDirty || sessionChanged,
    messages: sessionChanged ? [] : state.messages,
    nextBefore: sessionChanged ? null : state.nextBefore,
    hasMore: sessionChanged ? false : state.hasMore,
    usage: sessionChanged ? null : state.usage,
    activity: sessionChanged ? { kind: "idle", text: "就绪" } : state.activity,
  };
}
