use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;
pub const DESKTOP_EVENT_SCHEMA_VERSION: &str = "desktop-event.v1";
pub const DEFAULT_EVENT_QUERY_LIMIT: usize = 100;
pub const MAX_EVENT_QUERY_LIMIT: usize = 1_000;

pub mod error_codes {
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    pub const METHOD_NOT_FOUND: &str = "METHOD_NOT_FOUND";
    pub const TOOL_NOT_FOUND: &str = "TOOL_NOT_FOUND";
    pub const INVALID_ARGUMENTS: &str = "INVALID_ARGUMENTS";
    pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
    pub const CANCELLED: &str = "CANCELLED";
    pub const BUSY: &str = "BUSY";
    pub const INVALID_CURSOR: &str = "INVALID_CURSOR";
    pub const CURSOR_EXPIRED: &str = "CURSOR_EXPIRED";
    pub const CURSOR_REGRESSION: &str = "CURSOR_REGRESSION";
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
}

pub mod desktop_event_kinds {
    pub const APPLICATION_FOREGROUND_CHANGED: &str = "application.foregroundChanged";
    pub const APPLICATION_PROCESS_OBSERVED_BATCH: &str = "application.processObservedBatch";
    pub const BROWSER_TAB_OPENED: &str = "browser.tabOpened";
    pub const BROWSER_TAB_NAVIGATED: &str = "browser.tabNavigated";
    pub const BROWSER_TAB_CLOSED: &str = "browser.tabClosed";
    pub const ACCESSIBILITY_FOCUS_CHANGED: &str = "accessibility.focusChanged";
    pub const ACCESSIBILITY_VALUE_CHANGED: &str = "accessibility.valueChanged";
    pub const ACCESSIBILITY_DOCUMENT_CHANGED: &str = "accessibility.documentChanged";
    pub const EDITOR_DOCUMENT_CHANGED: &str = "editor.documentChanged";
    pub const INPUT_ACTIVITY_AGGREGATED: &str = "input.activityAggregated";
    pub const GOAL_CONTEXT_CHANGED: &str = "goal.contextChanged";
    pub const PRESENCE_AFK_STARTED: &str = "presence.afkStarted";
    pub const PRESENCE_AFK_ENDED: &str = "presence.afkEnded";
    pub const PRESENCE_LOCKED: &str = "presence.locked";
    pub const PRESENCE_UNLOCKED: &str = "presence.unlocked";
    pub const PRESENCE_SLEEP: &str = "presence.sleep";
    pub const PRESENCE_WAKE: &str = "presence.wake";
    pub const REFLECTION_COMPLETED: &str = "reflection.completed";
    pub const REFLECTION_FAILED: &str = "reflection.failed";
    pub const AUTHORIZATION_REVOKED: &str = "authorization.revoked";
    pub const AUTHORIZATION_GRANTED: &str = "authorization.granted";
    pub const SYSTEM_HEARTBEAT: &str = "system.heartbeat";
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Request {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Response {
    Success {
        id: String,
        ok: bool,
        result: Value,
    },
    Failure {
        id: Option<String>,
        ok: bool,
        error: ErrorPayload,
    },
}

impl Response {
    pub fn success(id: String, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self::Success {
                id,
                ok: true,
                result,
            },
            Err(error) => Self::failure(
                Some(id),
                "INTERNAL_ERROR",
                format!("Failed serializing local result: {error}"),
            ),
        }
    }

    pub fn failure(
        id: Option<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::Failure {
            id,
            ok: false,
            error: ErrorPayload {
                code: code.into(),
                message: message.into(),
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolRisk {
    Read,
    Write,
    Control,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub risk: ToolRisk,
    pub required_permissions: Vec<String>,
    pub supports_cancellation: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub service: String,
    pub version: String,
    pub pid: u32,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolListResult {
    pub tools: Vec<ToolDescriptor>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallParams {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResult {
    pub call_id: String,
    pub output: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCancelParams {
    pub call_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCancelResult {
    pub call_id: String,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopEventSensitivity {
    Metadata,
    Content,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEvent {
    pub schema_version: String,
    pub event_id: String,
    pub cursor: String,
    pub device_id: String,
    pub session_id: String,
    pub kind: String,
    pub source: String,
    pub occurred_at_ms: i64,
    pub observed_at_ms: i64,
    pub goal_version: Option<i64>,
    pub sensitivity: DesktopEventSensitivity,
    pub payload: Value,
}

impl DesktopEvent {
    pub fn contributes_to_reflection_count(&self) -> bool {
        event_kind_contributes_to_reflection_count(&self.kind)
    }
}

pub fn event_kind_contributes_to_reflection_count(kind: &str) -> bool {
    !kind.starts_with("reflection.")
        && !kind.starts_with("tool.")
        && kind != desktop_event_kinds::SYSTEM_HEARTBEAT
        && kind != desktop_event_kinds::AUTHORIZATION_REVOKED
        && kind != desktop_event_kinds::AUTHORIZATION_GRANTED
        && kind != desktop_event_kinds::GOAL_CONTEXT_CHANGED
        && !matches!(
            kind,
            desktop_event_kinds::PRESENCE_AFK_STARTED
                | desktop_event_kinds::PRESENCE_AFK_ENDED
                | desktop_event_kinds::PRESENCE_LOCKED
                | desktop_event_kinds::PRESENCE_UNLOCKED
                | desktop_event_kinds::PRESENCE_SLEEP
                | desktop_event_kinds::PRESENCE_WAKE
        )
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventQueryParams {
    #[serde(default)]
    pub after_cursor: Option<String>,
    #[serde(default)]
    pub consumer_id: Option<String>,
    #[serde(default = "default_event_query_limit")]
    pub limit: usize,
}

impl Default for EventQueryParams {
    fn default() -> Self {
        Self {
            after_cursor: None,
            consumer_id: None,
            limit: DEFAULT_EVENT_QUERY_LIMIT,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventQueryResult {
    pub events: Vec<DesktopEvent>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventCommitParams {
    pub consumer_id: String,
    pub cursor: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventCommitResult {
    pub consumer_id: String,
    pub cursor: String,
    pub advanced: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ToolEventKind {
    #[serde(rename = "tool.started")]
    Started,
    #[serde(rename = "tool.progress")]
    Progress,
    #[serde(rename = "tool.completed")]
    Completed,
    #[serde(rename = "tool.failed")]
    Failed,
    #[serde(rename = "tool.cancelled")]
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolEvent {
    pub event: ToolEventKind,
    pub call_id: String,
    pub data: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum DesktopEventFrameKind {
    #[serde(rename = "desktop.event")]
    DesktopEvent,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct DesktopEventFrame {
    pub event: DesktopEventFrameKind,
    pub data: DesktopEvent,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum OutboundMessage {
    Response(Response),
    Event(ToolEvent),
    DesktopEvent(DesktopEventFrame),
}

const fn default_event_query_limit() -> usize {
    DEFAULT_EVENT_QUERY_LIMIT
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_lines(value: &str) -> Vec<OutboundMessage> {
        value
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).expect("fixture must match Rust protocol"))
            .collect()
    }

    #[test]
    fn shared_success_fixture_matches_protocol() {
        let messages = parse_lines(include_str!(
            "../../../tests/fixtures/local-protocol/success.jsonl"
        ));
        assert!(matches!(
            messages.as_slice(),
            [OutboundMessage::Response(Response::Success { .. })]
        ));
    }

    #[test]
    fn shared_failure_fixture_matches_protocol() {
        let messages = parse_lines(include_str!(
            "../../../tests/fixtures/local-protocol/failure.jsonl"
        ));
        assert!(matches!(
            messages.as_slice(),
            [OutboundMessage::Response(Response::Failure { .. })]
        ));
    }

    #[test]
    fn shared_event_fixture_matches_protocol() {
        let messages = parse_lines(include_str!(
            "../../../tests/fixtures/local-protocol/events.jsonl"
        ));
        assert_eq!(messages.len(), 5);
        assert!(
            messages
                .iter()
                .all(|message| matches!(message, OutboundMessage::Event(_)))
        );
    }

    #[test]
    fn desktop_event_frame_round_trips_without_looking_like_a_tool_event() {
        let event = DesktopEvent {
            schema_version: DESKTOP_EVENT_SCHEMA_VERSION.to_owned(),
            event_id: "de1_example".to_owned(),
            cursor: "ec1_0000000000000001".to_owned(),
            device_id: "device_example".to_owned(),
            session_id: "session_example".to_owned(),
            kind: desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED.to_owned(),
            source: "activity.sensor".to_owned(),
            occurred_at_ms: 1_000,
            observed_at_ms: 1_001,
            goal_version: None,
            sensitivity: DesktopEventSensitivity::Metadata,
            payload: serde_json::json!({ "appId": "editor" }),
        };
        let message = OutboundMessage::DesktopEvent(DesktopEventFrame {
            event: DesktopEventFrameKind::DesktopEvent,
            data: event.clone(),
        });
        let encoded = serde_json::to_string(&message).expect("serialize desktop event");
        assert!(encoded.contains("\"event\":\"desktop.event\""));
        let decoded: OutboundMessage =
            serde_json::from_str(&encoded).expect("deserialize desktop event");
        assert_eq!(decoded, message);
        assert!(event.contributes_to_reflection_count());
    }

    #[test]
    fn reflection_tool_heartbeat_and_boundary_events_never_count_as_behavior() {
        for kind in [
            desktop_event_kinds::REFLECTION_COMPLETED,
            desktop_event_kinds::REFLECTION_FAILED,
            "tool.started",
            "tool.completed",
            desktop_event_kinds::SYSTEM_HEARTBEAT,
            desktop_event_kinds::AUTHORIZATION_REVOKED,
            desktop_event_kinds::AUTHORIZATION_GRANTED,
            desktop_event_kinds::GOAL_CONTEXT_CHANGED,
            desktop_event_kinds::PRESENCE_LOCKED,
        ] {
            assert!(
                !event_kind_contributes_to_reflection_count(kind),
                "{kind} must not feed the reflection count"
            );
        }
    }
}
