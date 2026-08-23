//! Event bridge: consumes the shared `router_rx` event stream and rebroadcasts
//! it to SSE clients.
//!
//! The bridge maintains a monotonic per-session sequence number and a bounded
//! replay ring so a reconnecting browser can resume from `Last-Event-ID`
//! without the server replaying events the client has already consumed (the
//! provider retry invariant "a broken stream is not retried" is preserved —
//! the server never replays a fully-consumed event more than once).

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, RwLock},
};

use tokio::sync::broadcast;

use super::dto::{self, EventDto};

/// A single SSE-deliverable event with its per-session sequence number.
#[derive(Clone, Debug)]
pub struct BridgeEvent {
    pub session_id: String,
    pub seq: u64,
    pub dto: EventDto,
}

/// How many past events per session the replay ring keeps. Bounded so a
/// long-idle browser never grows the server's memory without limit. The
/// config `server.event_buffer` clamps the ring on construction.
struct SessionLog {
    next_seq: u64,
    ring: VecDeque<BridgeEvent>,
    capacity: usize,
}

impl SessionLog {
    fn new(capacity: usize) -> Self {
        Self {
            next_seq: 0,
            ring: VecDeque::new(),
            capacity,
        }
    }

    fn push(&mut self, event: BridgeEvent) {
        self.next_seq += 1;
        if self.ring.len() >= self.capacity {
            self.ring.pop_front();
        }
        self.ring.push_back(event);
    }

    /// Returns events after `after_seq` in order, up to the ring capacity.
    fn events_after(&self, after_seq: u64) -> Vec<BridgeEvent> {
        self.ring
            .iter()
            .filter(|event| event.seq > after_seq)
            .cloned()
            .collect()
    }
}

/// Shared event fan-out. A single state-machine task calls [`EventBridge::push`]
/// for every routed event; SSE handlers subscribe to the broadcast channel and
/// can request a replay from a known sequence.
///
/// All methods are synchronous: `push` only touches an in-memory ring and a
/// broadcast channel, so the state-machine task never blocks on I/O.
#[derive(Clone)]
pub struct EventBridge {
    tx: broadcast::Sender<BridgeEvent>,
    logs: Arc<RwLock<HashMap<String, SessionLog>>>,
    capacity: usize,
}

impl EventBridge {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.clamp(16, 4096);
        let (tx, _) = broadcast::channel(256);
        Self {
            tx,
            logs: Arc::new(RwLock::new(HashMap::new())),
            capacity,
        }
    }

    /// Registers an event for a session: assigns the next per-session sequence,
    /// appends it to the replay ring, and broadcasts it live.
    pub fn push(&self, session_id: &str, event: EventDto) {
        let bridge_event = {
            let mut logs = self
                .logs
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let log = logs
                .entry(session_id.to_owned())
                .or_insert_with(|| SessionLog::new(self.capacity));
            let seq = log.next_seq;
            let bridge_event = BridgeEvent {
                session_id: session_id.to_owned(),
                seq,
                dto: event,
            };
            log.push(bridge_event.clone());
            bridge_event
        };
        // Receivers that lag the channel fall back to the replay ring on
        // reconnect.
        let _ = self.tx.send(bridge_event);
    }

    /// Replays buffered events after `after_seq`. When `session_id` is `Some`,
    /// only that session's ring is consulted; otherwise a best-effort global
    /// merge (per-session sequences are not globally ordered, so a multi-session
    /// replay may interleave; the frontend normally subscribes per session).
    pub fn replay(&self, session_id: Option<&str>, after_seq: u64) -> Vec<BridgeEvent> {
        let logs = self
            .logs
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match session_id {
            Some(id) => logs
                .get(id)
                .map(|log| log.events_after(after_seq))
                .unwrap_or_default(),
            None => logs
                .values()
                .flat_map(|log| log.events_after(after_seq))
                .collect(),
        }
    }

    /// Current next sequence for a session (used to bootstrap a fresh SSE
    /// connection's resume semantics on first subscribe).
    pub fn next_seq(&self, session_id: &str) -> u64 {
        let logs = self
            .logs
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        logs.get(session_id)
            .map(|log| log.next_seq)
            .unwrap_or_default()
    }

    /// Subscribes to live events.
    pub fn subscribe(&self) -> broadcast::Receiver<BridgeEvent> {
        self.tx.subscribe()
    }

    /// The maximum number of events retained per session.
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

/// Converts a routed agent event into its DTO shape, attaching the server-side
/// approval id when the event is an approval.
pub fn routed_to_dto(
    session_id: &str,
    event: &crate::agent::AgentEvent,
    approval: Option<&super::dto::ApprovalInfo>,
) -> Option<EventDto> {
    dto::to_dto(session_id, event, approval)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ToolCall;

    #[tokio::test]
    async fn sequences_are_monotonic_per_session_and_ring_is_bounded() {
        let bridge = EventBridge::new(16);
        for i in 0..20 {
            bridge.push(
                "a",
                EventDto::TextDelta {
                    session_id: "a".into(),
                    delta: format!("{i}"),
                },
            );
        }
        bridge.push(
            "b",
            EventDto::TextDelta {
                session_id: "b".into(),
                delta: "first-b".into(),
            },
        );

        assert_eq!(bridge.next_seq("a"), 20);
        assert_eq!(bridge.next_seq("b"), 1);

        // Replay only keeps the last 16 for session a.
        let replay = bridge.replay(Some("a"), 0);
        assert_eq!(replay.len(), 16);
        assert_eq!(replay.first().unwrap().seq, 4);
        assert_eq!(replay.last().unwrap().seq, 19);

        // Replay after a specific seq returns the tail.
        let tail = bridge.replay(Some("a"), 18);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].seq, 19);
    }

    #[tokio::test]
    async fn dto_conversion_carries_approval_id() {
        let (tx, _answer) = tokio::sync::oneshot::channel();
        let event = crate::agent::AgentEvent::Approval {
            call: ToolCall {
                id: "c".into(),
                name: "file_write".into(),
                arguments: serde_json::json!({}),
            },
            reason: "writes".into(),
            source_session_id: None,
            source_title: None,
            reply: tx,
        };
        let approval = crate::server::dto::ApprovalInfo {
            approval_id: "ap_xyz".into(),
            call: ToolCall {
                id: "c".into(),
                name: "file_write".into(),
                arguments: serde_json::json!({}),
            },
            reason: "writes".into(),
            source_session_id: None,
            source_title: None,
        };
        let dto = routed_to_dto("s", &event, Some(&approval)).unwrap();
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["type"], "approval");
        assert_eq!(json["approval_id"], "ap_xyz");
        assert_eq!(json["session_id"], "s");
        drop(_answer);
    }
}
