use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;
pub const DESKTOP_EVENT_SCHEMA_VERSION: &str = "desktop-event.v1";
pub const RAW_OBSERVATION_SCHEMA_VERSION: &str = "raw-observation.v2";
pub const SEMANTIC_EVENT_SCHEMA_VERSION: &str = "semantic-event.v2";
pub const SEMANTIC_TAXONOMY_VERSION: &str = "activity-taxonomy.v2";
pub const SEMANTIC_PROJECTOR_VERSION: &str = "semantic-projector.v2";
pub const DEFAULT_EVENT_QUERY_LIMIT: usize = 100;
pub const MAX_EVENT_QUERY_LIMIT: usize = 1_000;
pub const DEFAULT_SEMANTIC_QUERY_LIMIT: usize = 100;
pub const MAX_SEMANTIC_QUERY_LIMIT: usize = 1_000;

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

pub mod semantic_event_kinds {
    pub const APPLICATION_FOREGROUND_CHANGED: &str = "application.foregroundChanged";
    pub const APPLICATION_VISIBLE_CONTENT_CHANGED: &str = "application.visibleContentChanged";
    pub const APPLICATION_TEXT_VALUE_CHANGED: &str = "application.textValueChanged";
    pub const BROWSER_VISIBLE_PAGE_CHANGED: &str = "browser.visiblePageChanged";
    pub const UI_FOCUS_CHANGED: &str = "ui.focusChanged";
    pub const UI_CONTROL_ACTIVATED: &str = "ui.controlActivated";
    pub const INPUT_ACTIVITY_BUCKET: &str = "input.activityBucket";
    pub const PRESENCE_CHANGED: &str = "presence.changed";
    pub const GOAL_CHANGED: &str = "goal.changed";
    pub const APPLICATION_PROCESS_OBSERVED_BATCH: &str = "application.processObservedBatch";
    pub const COVERAGE_GAP: &str = "coverage.gap";
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
    // Counting is deliberately allow-listed. A newly added lifecycle,
    // diagnostic, process-inventory, Tool, heartbeat, or model event must not
    // silently become user behaviour just because its name is unfamiliar.
    matches!(
        kind,
        desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED
            | desktop_event_kinds::BROWSER_TAB_OPENED
            | desktop_event_kinds::BROWSER_TAB_NAVIGATED
            | desktop_event_kinds::BROWSER_TAB_CLOSED
            | desktop_event_kinds::ACCESSIBILITY_FOCUS_CHANGED
            | desktop_event_kinds::ACCESSIBILITY_VALUE_CHANGED
            | desktop_event_kinds::ACCESSIBILITY_DOCUMENT_CHANGED
            | desktop_event_kinds::EDITOR_DOCUMENT_CHANGED
            | desktop_event_kinds::INPUT_ACTIVITY_AGGREGATED
            | semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED
            | semantic_event_kinds::APPLICATION_TEXT_VALUE_CHANGED
            | semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED
            | semantic_event_kinds::UI_FOCUS_CHANGED
            | semantic_event_kinds::UI_CONTROL_ACTIVATED
            | semantic_event_kinds::INPUT_ACTIVITY_BUCKET
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObservationSensorV2 {
    Workspace,
    Ax,
    Ocr,
    AppleEvents,
    CgActivity,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EvidenceReliabilityV2 {
    High,
    Medium,
    Low,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CoverageLevelV2 {
    Content,
    Metadata,
    Redacted,
    Denied,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SemanticContentStateV2 {
    Available,
    Redacted,
    Expired,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SemanticCountClassV2 {
    Effective,
    Boundary,
    Context,
    Ignored,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationIntervalV2 {
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationSourceV2 {
    pub sensor: ObservationSensorV2,
    pub adapter_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationSubjectV2 {
    pub app_id: String,
    pub app_name: String,
    #[serde(default)]
    pub opaque_window_id: Option<String>,
}

/// Trusted input emitted by the bundled native observer. Durable identity,
/// cursors, and content hashes are always assigned by the Rust journal.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawObservationInputV2 {
    pub schema_version: String,
    pub kind: String,
    pub interval: ObservationIntervalV2,
    pub source: ObservationSourceV2,
    pub subject: ObservationSubjectV2,
    pub reliability: EvidenceReliabilityV2,
    pub coverage: Vec<CoverageLevelV2>,
    #[serde(default)]
    pub redactions: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub content: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawObservationV2 {
    pub schema_version: String,
    pub observation_id: String,
    pub cursor: String,
    pub device_id: String,
    pub session_id: String,
    pub kind: String,
    pub interval: ObservationIntervalV2,
    pub source: ObservationSourceV2,
    pub subject: ObservationSubjectV2,
    pub reliability: EvidenceReliabilityV2,
    pub coverage: Vec<CoverageLevelV2>,
    pub redactions: Vec<String>,
    pub metadata: Value,
    pub content_state: SemanticContentStateV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    pub dedup_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticEventV2 {
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
    pub count_class: SemanticCountClassV2,
    pub reliability: EvidenceReliabilityV2,
    pub coverage: Vec<CoverageLevelV2>,
    pub content_state: SemanticContentStateV2,
    pub source_observation_ids: Vec<String>,
    pub taxonomy_version: String,
    pub projector_version: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticQueryParams {
    #[serde(default)]
    pub after_cursor: Option<String>,
    #[serde(default)]
    pub consumer_id: Option<String>,
    #[serde(default = "default_semantic_query_limit")]
    pub limit: usize,
    #[serde(default)]
    pub include_content: bool,
}

impl Default for SemanticQueryParams {
    fn default() -> Self {
        Self {
            after_cursor: None,
            consumer_id: None,
            limit: DEFAULT_SEMANTIC_QUERY_LIMIT,
            include_content: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticQueryResult {
    pub events: Vec<SemanticEventV2>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticCommitParams {
    pub consumer_id: String,
    pub cursor: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticCommitResult {
    pub consumer_id: String,
    pub cursor: String,
    pub advanced: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditQueryFiveMinutesParams {
    pub from_ms: i64,
    pub to_ms: i64,
    #[serde(default)]
    pub include_decrypted_content: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditQueryFiveMinutesResult {
    pub from_ms: i64,
    pub to_ms: i64,
    pub permissions: MonitoringPermissions,
    pub coverage: Vec<CoverageLevelV2>,
    pub raw_observations: Vec<RawObservationV2>,
    pub semantic_events: Vec<SemanticEventV2>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultSealRecord {
    pub record_id: String,
    pub schema_version: String,
    pub content: Value,
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultSealBatchParams {
    pub namespace: String,
    pub records: Vec<VaultSealRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultSealResult {
    pub record_id: String,
    pub content_ref: String,
    pub content_hash: String,
    pub key_version: String,
    pub inserted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultSealBatchResult {
    pub records: Vec<VaultSealResult>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultOpenBatchParams {
    pub namespace: String,
    pub content_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenResult {
    pub record_id: String,
    pub schema_version: String,
    pub content_ref: String,
    pub content_hash: String,
    pub content: Value,
    pub created_at_ms: i64,
    pub expires_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenBatchResult {
    pub records: Vec<VaultOpenResult>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MonitoringState {
    Disabled,
    Starting,
    Running,
    Paused,
    Degraded,
    Stopped,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MonitoringPermissionState {
    Unknown,
    Granted,
    Denied,
    NotDetermined,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringPermissions {
    pub accessibility: MonitoringPermissionState,
    pub screen_recording: MonitoringPermissionState,
    pub input_monitoring: MonitoringPermissionState,
    pub automation: MonitoringPermissionState,
}

impl Default for MonitoringPermissions {
    fn default() -> Self {
        Self {
            accessibility: MonitoringPermissionState::Unknown,
            screen_recording: MonitoringPermissionState::Unknown,
            input_monitoring: MonitoringPermissionState::Unknown,
            automation: MonitoringPermissionState::Unknown,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringStatusResult {
    pub state: MonitoringState,
    pub enabled: bool,
    pub capture_content: bool,
    pub excluded_bundle_ids: Vec<String>,
    pub helper_pid: Option<u32>,
    pub helper_path_available: bool,
    pub boot_id: Option<String>,
    pub last_sequence: Option<u64>,
    pub last_acked_sequence: Option<u64>,
    pub last_heartbeat_at_ms: Option<i64>,
    pub permissions: MonitoringPermissions,
    pub coverage: Vec<CoverageLevelV2>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitoringConfigureParams {
    pub enabled: bool,
    pub capture_content: bool,
    #[serde(default)]
    pub excluded_bundle_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitoringRefreshPermissionsParams {
    #[serde(default)]
    pub prompt: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalContext {
    pub goal_id: String,
    pub plan_id: Option<String>,
    pub version: i64,
    pub text: String,
    pub activated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventGoalChangeParams {
    pub previous: Option<GoalContext>,
    pub next: Option<GoalContext>,
    pub occurred_at_ms: i64,
    pub deduplication_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventGoalChangeResult {
    pub event: DesktopEvent,
    pub inserted: bool,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum SemanticEventFrameKind {
    #[serde(rename = "semantic.event")]
    SemanticEvent,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct SemanticEventFrame {
    pub event: SemanticEventFrameKind,
    pub data: SemanticEventV2,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum OutboundMessage {
    Response(Response),
    Event(ToolEvent),
    DesktopEvent(DesktopEventFrame),
    SemanticEvent(SemanticEventFrame),
}

const fn default_event_query_limit() -> usize {
    DEFAULT_EVENT_QUERY_LIMIT
}

const fn default_semantic_query_limit() -> usize {
    DEFAULT_SEMANTIC_QUERY_LIMIT
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
    fn shared_semantic_event_fixture_matches_protocol() {
        let messages = parse_lines(include_str!(
            "../../../tests/fixtures/local-protocol/semantic-event.jsonl"
        ));
        assert!(matches!(
            messages.as_slice(),
            [OutboundMessage::SemanticEvent(SemanticEventFrame { data, .. })]
                if data.count_class == SemanticCountClassV2::Effective
                    && data.source_observation_ids == ["ro2_fixture"]
        ));
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
            semantic_event_kinds::APPLICATION_PROCESS_OBSERVED_BATCH,
        ] {
            assert!(
                !event_kind_contributes_to_reflection_count(kind),
                "{kind} must not feed the reflection count"
            );
        }
    }

    #[test]
    fn audit_query_requires_explicit_fixed_range_and_defaults_to_redacted() {
        let params: AuditQueryFiveMinutesParams =
            serde_json::from_value(serde_json::json!({"fromMs": 0, "toMs": 300000}))
                .expect("parse audit query");
        assert!(!params.include_decrypted_content);
        assert!(
            serde_json::from_value::<AuditQueryFiveMinutesParams>(serde_json::json!({
                "fromMs": 0,
                "toMs": 300000,
                "includeDecryptedContent": false,
                "screenshotPath": "/tmp/forbidden.png"
            }))
            .is_err()
        );
    }
}
