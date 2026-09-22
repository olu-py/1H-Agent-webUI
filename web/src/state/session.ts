import type { AppSnapshotV2 } from "../types";
import type { UiState } from "./reducer";

export function reduceSnapshot(state: UiState, snapshot: AppSnapshotV2): UiState {
  const sessionChanged = snapshot.active_session !== state.activeSession;
  return {
    ...state,
    protocolVersion: snapshot.protocol_version,
    cursor: snapshot.event_cursor,
    activeSession: snapshot.active_session,
    sessions: snapshot.sessions,
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
    backgroundStatus: sessionChanged ? {} : state.backgroundStatus,
  };
}
