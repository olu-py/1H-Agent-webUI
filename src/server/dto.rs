//! Web-facing event DTOs.
//!
//! `AgentEvent` carries non-serializable payloads (notably the
//! `oneshot::Sender<bool>` on `Approval`), so the server converts it into this
//! serde-tagged shape before broadcasting over SSE. The approval sender never
//! leaves the server: it is replaced by an `approval_id` that the frontend
//! sends back to `POST /api/approvals/:id`, and the sender is stored in the
//! server pending-approval table instead.

use serde::Serialize;

use crate::{agent::AgentEvent, model::TodoTask, provider::ToolCall};

/// One agent event, serialized for the browser. The `type` field is the event
/// discriminator; the event's owning `session_id` is always included so a
/// single global SSE stream can be routed client-side.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventDto {
    ReasoningDelta {
        session_id: String,
        delta: String,
    },
    ProviderRetry {
        session_id: String,
        attempt: u32,
        reason: String,
        delay_ms: u64,
    },
    ModelStreaming {
        session_id: String,
    },
    WebSearchStarted {
        session_id: String,
        query: String,
    },
    WebSearchResult {
        session_id: String,
        title: String,
        url: String,
        snippet: String,
    },
    WebSearchCompleted {
        session_id: String,
        count: usize,
    },
    Cancelled {
        session_id: String,
        reason: String,
    },
    TextDelta {
        session_id: String,
        delta: String,
    },
    /// The agent is waiting for a tool approval. `approval_id` is the token
    /// the frontend must echo back to `POST /api/approvals/:id`.
    Approval {
        session_id: String,
        approval_id: String,
        call: ToolCall,
        reason: String,
        source_session_id: Option<String>,
        source_title: Option<String>,
    },
    /// A previously broadcast approval was decided (by the user or by the
    /// server-side timeout). The frontend closes its modal on this.
    ApprovalResolved {
        session_id: String,
        approval_id: String,
        approved: bool,
    },
    ToolStarted {
        session_id: String,
        call: ToolCall,
    },
    ToolFinished {
        session_id: String,
        call: ToolCall,
        result: String,
    },
    Usage {
        session_id: String,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
    },
    Completed {
        session_id: String,
    },
    Failed {
        session_id: String,
        error: String,
    },
    SessionsChanged {
        session_id: String,
    },
    ChildSessionProgress {
        session_id: String,
        child_session_id: String,
        status: String,
        turn: usize,
        max_turns: usize,
        tool: Option<String>,
    },
    LocalCommandFinished {
        session_id: String,
        command: String,
        result: String,
    },
    CompactionStarted {
        session_id: String,
    },
    CompactionCompleted {
        session_id: String,
        hidden: usize,
    },
    CompactionFailed {
        session_id: String,
        error: String,
    },
    TodoUpdated {
        session_id: String,
        tasks: Vec<TodoTask>,
    },
}

/// The pieces of an `AgentEvent::Approval` that can cross the wire. The
/// `oneshot::Sender<bool>` is deliberately absent; the server keeps it in its
/// pending-approval table keyed by `approval_id`.
#[derive(Clone, Debug)]
pub struct ApprovalInfo {
    pub approval_id: String,
    pub call: ToolCall,
    pub reason: String,
    pub source_session_id: Option<String>,
    pub source_title: Option<String>,
}

/// Converts an agent event into its web shape.
///
/// `approval` must be `Some` exactly when `event` is `AgentEvent::Approval`;
/// the sender inside the event cannot be serialized, so the bridge supplies the
/// id and keeps the sender itself.
pub fn to_dto(
    session_id: &str,
    event: &AgentEvent,
    approval: Option<&ApprovalInfo>,
) -> Option<EventDto> {
    let session_id = session_id.to_owned();
    Some(match event {
        AgentEvent::ReasoningDelta(delta) => EventDto::ReasoningDelta {
            session_id,
            delta: delta.clone(),
        },
        AgentEvent::ProviderRetry {
            attempt,
            reason,
            delay_ms,
        } => EventDto::ProviderRetry {
            session_id,
            attempt: *attempt,
            reason: reason.clone(),
            delay_ms: *delay_ms,
        },
        AgentEvent::ModelStreaming => EventDto::ModelStreaming { session_id },
        AgentEvent::WebSearchStarted { query } => EventDto::WebSearchStarted {
            session_id,
            query: query.clone(),
        },
        AgentEvent::WebSearchResult {
            title,
            url,
            snippet,
        } => EventDto::WebSearchResult {
            session_id,
            title: title.clone(),
            url: url.clone(),
            snippet: snippet.clone(),
        },
        AgentEvent::WebSearchCompleted { count } => EventDto::WebSearchCompleted {
            session_id,
            count: *count,
        },
        AgentEvent::Cancelled(reason) => EventDto::Cancelled {
            session_id,
            reason: reason.clone(),
        },
        AgentEvent::TextDelta(delta) => EventDto::TextDelta {
            session_id,
            delta: delta.clone(),
        },
        AgentEvent::Approval { .. } => {
            // Without a server-side approval id there is nothing the frontend
            // can act on, so the event is dropped rather than delivered with a
            // dangling id.
            let approval = approval?;
            EventDto::Approval {
                session_id,
                approval_id: approval.approval_id.clone(),
                call: approval.call.clone(),
                reason: approval.reason.clone(),
                source_session_id: approval.source_session_id.clone(),
                source_title: approval.source_title.clone(),
            }
        }
        AgentEvent::ToolStarted(call) => EventDto::ToolStarted {
            session_id,
            call: call.clone(),
        },
        AgentEvent::ToolFinished { call, result } => EventDto::ToolFinished {
            session_id,
            call: call.clone(),
            result: result.clone(),
        },
        AgentEvent::Usage(usage) => EventDto::Usage {
            session_id,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
        },
        AgentEvent::Completed { .. } => EventDto::Completed { session_id },
        AgentEvent::Failed(error) => EventDto::Failed {
            session_id,
            error: error.clone(),
        },
        AgentEvent::SessionsChanged => EventDto::SessionsChanged { session_id },
        AgentEvent::ChildSessionProgress {
            session_id: child_id,
            progress,
        } => EventDto::ChildSessionProgress {
            session_id,
            child_session_id: child_id.clone(),
            status: progress.status.wire_name().to_owned(),
            turn: progress.turn,
            max_turns: progress.max_turns,
            tool: progress.tool.clone(),
        },
        AgentEvent::LocalCommandFinished { command, result } => EventDto::LocalCommandFinished {
            session_id,
            command: command.clone(),
            result: result.clone(),
        },
        AgentEvent::CompactionStarted => EventDto::CompactionStarted { session_id },
        AgentEvent::CompactionCompleted { hidden } => EventDto::CompactionCompleted {
            session_id,
            hidden: *hidden,
        },
        AgentEvent::CompactionFailed(error) => EventDto::CompactionFailed {
            session_id,
            error: error.clone(),
        },
        AgentEvent::TodoUpdated { tasks } => EventDto::TodoUpdated {
            session_id,
            tasks: tasks.clone(),
        },
    })
}

/// Serialized form of a session used by `GET /api/state`.
#[derive(Clone, Debug, Serialize)]
pub struct SessionStateDto {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub busy: bool,
    pub phase: String,
    pub status: String,
}

/// Serialized form of the whole application state used by `GET /api/state`.
#[derive(Clone, Debug, Serialize)]
pub struct AppStateDto {
    pub active_session: Option<String>,
    pub sessions: Vec<SessionStateDto>,
    pub provider: String,
    pub model: String,
    pub mode: String,
    /// Serialized pending approval of the oldest waiting session, if any.
    pub approval: Option<ApprovalDto>,
    pub todos: Vec<TodoDto>,
}

/// A pending approval exposed to the frontend. `approval_id` is echoed back on
/// decision; the server-side sender is never serialized.
#[derive(Clone, Debug, Serialize)]
pub struct ApprovalDto {
    pub approval_id: String,
    pub session_id: String,
    pub call: ToolCall,
    pub reason: String,
    pub source_session_id: Option<String>,
    pub source_title: Option<String>,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct TodoDto {
    pub id: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<&TodoTask> for TodoDto {
    fn from(task: &TodoTask) -> Self {
        Self {
            id: task.id.clone(),
            title: task.title.clone(),
            status: task.status.as_str().to_owned(),
            created_at: task.created_at.clone(),
            updated_at: task.updated_at.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::Usage;

    fn sample_approval() -> AgentEvent {
        let (_tx, _rx) = tokio::sync::oneshot::channel();
        AgentEvent::Approval {
            call: ToolCall {
                id: "call_1".into(),
                name: "file_write".into(),
                arguments: serde_json::json!({"path": "a.txt"}),
            },
            reason: "writes a file".into(),
            source_session_id: None,
            source_title: None,
            reply: _tx,
        }
    }

    #[test]
    fn every_event_maps_to_a_dto_variant() {
        let session = "s1";
        let cases = vec![
            AgentEvent::ReasoningDelta("thinking".into()),
            AgentEvent::ProviderRetry {
                attempt: 2,
                reason: "429".into(),
                delay_ms: 1000,
            },
            AgentEvent::ModelStreaming,
            AgentEvent::WebSearchStarted {
                query: "rust".into(),
            },
            AgentEvent::WebSearchResult {
                title: "t".into(),
                url: "https://e.com".into(),
                snippet: "s".into(),
            },
            AgentEvent::WebSearchCompleted { count: 3 },
            AgentEvent::Cancelled("user".into()),
            AgentEvent::TextDelta("hi".into()),
            sample_approval(),
            AgentEvent::ToolStarted(ToolCall {
                id: "c".into(),
                name: "file_read".into(),
                arguments: serde_json::json!({}),
            }),
            AgentEvent::ToolFinished {
                call: ToolCall {
                    id: "c".into(),
                    name: "file_read".into(),
                    arguments: serde_json::json!({}),
                },
                result: "ok".into(),
            },
            AgentEvent::Usage(Usage {
                input_tokens: 1,
                output_tokens: 2,
                total_tokens: 3,
            }),
            AgentEvent::Completed { items: Vec::new() },
            AgentEvent::Failed("boom".into()),
            AgentEvent::SessionsChanged,
            AgentEvent::CompactionStarted,
            AgentEvent::CompactionCompleted { hidden: 4 },
            AgentEvent::CompactionFailed("oops".into()),
            AgentEvent::TodoUpdated { tasks: Vec::new() },
            AgentEvent::ChildSessionProgress {
                session_id: "child_1".into(),
                progress: crate::agent::ChildSessionProgress {
                    status: crate::agent::ChildSessionStatus::Streaming,
                    turn: 2,
                    max_turns: 5,
                    tool: Some("file_write".into()),
                    updated_at: std::time::Instant::now(),
                },
            },
        ];
        for event in cases {
            let is_approval = matches!(event, AgentEvent::Approval { .. });
            let approval = if is_approval {
                Some(ApprovalInfo {
                    approval_id: "ap_1".into(),
                    call: ToolCall {
                        id: "c".into(),
                        name: "file_write".into(),
                        arguments: serde_json::json!({}),
                    },
                    reason: "writes".into(),
                    source_session_id: None,
                    source_title: None,
                })
            } else {
                None
            };
            let dto = to_dto(session, &event, approval.as_ref());
            assert!(dto.is_some(), "event must map to a dto");
            let json = serde_json::to_value(dto.unwrap()).unwrap();
            assert!(json.get("type").is_some(), "dto must carry a type tag");
            assert_eq!(json["session_id"], "s1");
        }
    }

    #[test]
    fn approval_dto_requires_approval_info() {
        let event = sample_approval();
        let dto = to_dto("s1", &event, None);
        assert!(dto.is_none());
    }

    #[test]
    fn child_progress_dto_carries_child_fields() {
        let event = AgentEvent::ChildSessionProgress {
            session_id: "child_1".into(),
            progress: crate::agent::ChildSessionProgress {
                status: crate::agent::ChildSessionStatus::RunningTool,
                turn: 3,
                max_turns: 5,
                tool: Some("file_write".into()),
                updated_at: std::time::Instant::now(),
            },
        };
        let dto = to_dto("parent", &event, None).expect("child progress maps");
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["type"], "child_session_progress");
        // The DTO keeps the *parent* session as the routing target and the
        // child id in a dedicated field, so a single SSE stream can render the
        // batch on the parent while tracking each child individually.
        assert_eq!(json["session_id"], "parent");
        assert_eq!(json["child_session_id"], "child_1");
        // Non-terminal statuses are intentionally coalesced to "running" (the
        // stable wire contract); turn/tool carry the finer-grained detail.
        assert_eq!(json["status"], "running");
        assert_eq!(json["turn"], 3);
        assert_eq!(json["max_turns"], 5);
        assert_eq!(json["tool"], "file_write");
    }
}
