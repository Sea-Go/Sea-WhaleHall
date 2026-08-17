use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;
pub const DESKTOP_EVENT_SCHEMA_VERSION: &str = "desktop-event.v1";
pub const RAW_OBSERVATION_SCHEMA_VERSION: &str = "raw-observation.v2";
pub const SEMANTIC_EVENT_SCHEMA_VERSION: &str = "semantic-event.v2";
pub const SEMANTIC_TAXONOMY_VERSION: &str = "activity-taxonomy.v2";
pub const SEMANTIC_PROJECTOR_VERSION: &str = "semantic-projector.v2";
pub const PLANNING_SCHEMA_VERSION: &str = "planning.v1";
pub const CALENDAR_SCHEMA_VERSION: &str = "calendar.v1";
pub const REDACTED_PLAN_CALENDAR_TITLE: &str = "计划任务";
pub const DEFAULT_EVENT_QUERY_LIMIT: usize = 100;
pub const MAX_EVENT_QUERY_LIMIT: usize = 1_000;
pub const DEFAULT_SEMANTIC_QUERY_LIMIT: usize = 100;
pub const MAX_SEMANTIC_QUERY_LIMIT: usize = 1_000;
pub const DEFAULT_PLANNING_LIST_LIMIT: usize = 100;
pub const MAX_PLANNING_LIST_LIMIT: usize = 1_000;
pub const DEFAULT_PLANNING_OUTBOX_LIMIT: usize = 100;
pub const MAX_PLANNING_OUTBOX_LIMIT: usize = 1_000;
pub const DEFAULT_VAULT_LIST_LIMIT: usize = 100;
pub const MAX_VAULT_LIST_LIMIT: usize = 1_000;
pub const DEFAULT_PLANNING_VAULT_REFERENCE_LIMIT: usize = 100;
pub const MAX_PLANNING_VAULT_REFERENCE_LIMIT: usize = 1_000;
pub const DEFAULT_CALENDAR_LIST_LIMIT: usize = 100;
pub const MAX_CALENDAR_LIST_LIMIT: usize = 1_000;
/// Leaves 128 KiB for the response envelope, request identifier, and future
/// protocol fields while keeping a calendar page below the JSONL line limit.
pub const MAX_CALENDAR_LIST_RESULT_BYTES: usize = MAX_JSONL_LINE_BYTES - 128 * 1024;

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
    pub const AUTHORIZATION_CHANGED: &str = "authorization.changed";
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
                details: None,
            },
        }
    }

    pub fn failure_with_details(
        id: Option<String>,
        code: impl Into<String>,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self::Failure {
            id,
            ok: false,
            error: ErrorPayload {
                code: code.into(),
                message: message.into(),
                details: Some(details),
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
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
#[serde(rename_all = "camelCase")]
pub struct EventTailCursorResult {
    pub cursor: String,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultDeleteBatchParams {
    pub namespace: String,
    pub record_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultDeleteResult {
    pub record_id: String,
    pub deleted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultDeleteBatchResult {
    pub records: Vec<VaultDeleteResult>,
}

/// Metadata-only inventory of one vault namespace. This intentionally omits
/// encrypted content, hashes, and key metadata so local GC can identify
/// candidates without widening the content-bearing vault boundary.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultListRecordsParams {
    pub namespace: String,
    /// Exclusive creation-time cutoff shared by every page in one inventory.
    pub created_before_ms: i64,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_vault_list_limit")]
    pub limit: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecordMetadata {
    pub record_id: String,
    pub schema_version: String,
    pub content_ref: String,
    pub created_at_ms: i64,
    pub expires_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultListRecordsResult {
    pub records: Vec<VaultRecordMetadata>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VaultKeyAvailability {
    Available,
    MigrationRequired,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VaultKeyStorageMode {
    DataProtectionKeychain,
    LocalLoginKeychain,
    LegacyDevelopmentKeychain,
    Custom,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeyStatusResult {
    pub availability: VaultKeyAvailability,
    pub storage_mode: Option<VaultKeyStorageMode>,
    pub key_version: Option<String>,
    pub interactive_migration_available: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultMigrateLegacyKeyParams {
    pub confirm: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultMigrateLegacyKeyResult {
    pub migrated: bool,
    pub status: VaultKeyStatusResult,
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MonitoringPermissionCheckState {
    Unchecked,
    Checking,
    Current,
    Failed,
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
    pub tap_ready: bool,
    pub last_callback_at_ms: Option<i64>,
    pub last_bucket_at_ms: Option<i64>,
    pub permissions: MonitoringPermissions,
    pub permission_check_state: MonitoringPermissionCheckState,
    pub permissions_checked_at_ms: Option<i64>,
    pub permission_setup_available: bool,
    pub permission_setup_attempted: bool,
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlanType {
    ShortTerm,
    LongTerm,
    Fuzzy,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlanStatus {
    Draft,
    AwaitingConfirmation,
    Active,
    Paused,
    Completed,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanCreateInput {
    pub goal: String,
    pub start_today: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanEstimate {
    pub estimated_completion_date: String,
    pub confidence: f64,
    pub assessed_at_ms: i64,
    #[serde(default)]
    pub evidence_through_ms: Option<i64>,
    pub basis: String,
    pub model_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanSchedulingWindow {
    pub start_date: String,
    pub end_date_inclusive: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlanTaskStatus {
    Pending,
    Completed,
    Skipped,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTask {
    pub task_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub dependency_task_ids: Vec<String>,
    pub estimated_effort_minutes: i64,
    pub status: PlanTaskStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlanConversationRole {
    User,
    Assistant,
    System,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlanConversationMessageStatus {
    PendingAnalysis,
    Analyzed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanConversationMessage {
    pub message_id: String,
    pub role: PlanConversationRole,
    pub status: PlanConversationMessageStatus,
    pub content: String,
    pub created_at_ms: i64,
    #[serde(default)]
    pub failure_category: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRevision {
    pub revision_id: String,
    pub plan_version: i64,
    pub created_at_ms: i64,
    pub reason: String,
    #[serde(default)]
    pub estimate: Option<PlanEstimate>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanEstimateSnapshot {
    pub estimate_id: String,
    pub plan_version: i64,
    pub estimate: PlanEstimate,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlanObservationAttribution {
    PendingConfirmation,
    Confirmed,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanObservationEvidence {
    pub evidence_id: String,
    #[serde(default)]
    pub task_id: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub relevance_confidence: f64,
    pub attribution: PlanObservationAttribution,
    #[serde(default)]
    pub source_event_ids: Vec<String>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarChangeSet {
    #[serde(default)]
    pub added_event_ids: Vec<String>,
    #[serde(default)]
    pub moved_event_ids: Vec<String>,
    #[serde(default)]
    pub cancelled_event_ids: Vec<String>,
    #[serde(default)]
    pub unscheduled_task_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlanAdjustmentStatus {
    Checkpoint,
    Applied,
    Conflict,
    Undone,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanAdjustment {
    pub adjustment_id: String,
    pub from_version: i64,
    pub to_version: i64,
    pub status: PlanAdjustmentStatus,
    pub reason: String,
    pub calendar_change_set: CalendarChangeSet,
    pub created_at_ms: i64,
    #[serde(default)]
    pub undo_of_adjustment_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlanMonitoringMode {
    Authorized,
    Paused,
    ManualOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlanAnalysisState {
    AwaitingAnalysis,
    AwaitingUser,
    Ready,
}

/// The full authoritative projection owned by the local planning store.
/// Goal and conversation content are content-sensitive and must never be
/// copied into log or push-event payloads.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanSnapshot {
    pub schema_version: String,
    pub plan_id: String,
    pub version: i64,
    #[serde(default)]
    pub plan_type: Option<PlanType>,
    pub status: PlanStatus,
    pub analysis_state: PlanAnalysisState,
    /// Stable, content-free failure/category code such as `model-unavailable`.
    #[serde(default)]
    pub analysis_diagnostic: Option<String>,
    /// Plaintext is supported by the owner-only v1 filesystem boundary. A
    /// future vault-backed writer may omit it and use `sealedContentRef`.
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub sealed_content_ref: Option<String>,
    #[serde(default)]
    pub redacted_content: bool,
    pub start_today: bool,
    pub time_zone: String,
    #[serde(default)]
    pub effective_start_date: Option<String>,
    #[serde(default)]
    pub scheduling_window: Option<PlanSchedulingWindow>,
    #[serde(default)]
    pub active_revision_id: Option<String>,
    #[serde(default)]
    pub proposed_revision_id: Option<String>,
    #[serde(default)]
    pub current_estimate: Option<PlanEstimate>,
    #[serde(default)]
    pub tasks: Vec<PlanTask>,
    #[serde(default)]
    pub conversation: Vec<PlanConversationMessage>,
    #[serde(default)]
    pub revisions: Vec<PlanRevision>,
    #[serde(default)]
    pub estimate_snapshots: Vec<PlanEstimateSnapshot>,
    #[serde(default)]
    pub observation_evidence: Vec<PlanObservationEvidence>,
    #[serde(default)]
    pub adjustments: Vec<PlanAdjustment>,
    /// Opaque JSON aggregate used by the TypeScript PlanningRuntime for
    /// forward-compatible local state not yet promoted to indexed fields.
    /// It is content-sensitive and follows the same owner-only/sealed-content
    /// boundary as the rest of this snapshot.
    #[serde(default = "default_object_value")]
    pub runtime_payload: Value,
    pub auto_schedule_authorized: bool,
    pub monitoring_mode: PlanMonitoringMode,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CalendarEventKind {
    Plan,
    ManualBlock,
    External,
    Break,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CalendarEventState {
    Proposed,
    Committed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarTimedSchedule {
    pub all_day: bool,
    pub start: String,
    pub end: String,
    pub time_zone: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarAllDaySchedule {
    pub all_day: bool,
    pub start_date: String,
    pub end_date_exclusive: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum CalendarSchedule {
    Timed(CalendarTimedSchedule),
    AllDay(CalendarAllDaySchedule),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarRecurrence {
    pub series_id: String,
    pub rrule: String,
    pub time_zone: String,
    #[serde(default)]
    pub exception_dates: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CalendarScheduleOrigin {
    Model,
    User,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningCalendarEvent {
    pub schema_version: String,
    pub event_id: String,
    pub title: String,
    /// Optional reference to title/details encrypted by the content vault.
    #[serde(default)]
    pub sealed_content_ref: Option<String>,
    /// True when only the fixed content-free placeholder title is persisted.
    #[serde(default)]
    pub redacted_content: bool,
    pub kind: CalendarEventKind,
    pub state: CalendarEventState,
    pub schedule: CalendarSchedule,
    #[serde(default)]
    pub recurrence: Option<CalendarRecurrence>,
    #[serde(default)]
    pub occurrence_id: Option<String>,
    #[serde(default)]
    pub source_plan_id: Option<String>,
    #[serde(default)]
    pub source_task_id: Option<String>,
    #[serde(default)]
    pub schedule_origin: Option<CalendarScheduleOrigin>,
    pub user_locked: bool,
    pub editable: bool,
    pub version: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlanningOutboxKind {
    PlanChanged,
    CalendarChanged,
    Notification,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningOutboxDraft {
    pub entry_id: String,
    pub kind: PlanningOutboxKind,
    pub aggregate_id: String,
    #[serde(default)]
    pub payload: Value,
    pub created_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlanningOutboxStatus {
    Pending,
    Delivered,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningOutboxEntry {
    pub entry_id: String,
    pub kind: PlanningOutboxKind,
    pub aggregate_id: String,
    pub payload: Value,
    pub status: PlanningOutboxStatus,
    pub created_at_ms: i64,
    pub delivered_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningListParams {
    #[serde(default)]
    pub statuses: Vec<PlanStatus>,
    #[serde(default = "default_planning_list_limit")]
    pub limit: usize,
}

impl Default for PlanningListParams {
    fn default() -> Self {
        Self {
            statuses: Vec::new(),
            limit: DEFAULT_PLANNING_LIST_LIMIT,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningListResult {
    pub plans: Vec<PlanSnapshot>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlanningVaultReferenceSource {
    Current,
    History,
    Operation,
}

/// Content-free references held by the complete authoritative planning
/// aggregate set. Consumers must finish every page successfully before using
/// the result as a GC reachability proof.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningVaultReference {
    pub source: PlanningVaultReferenceSource,
    pub plan_id: String,
    pub version: i64,
    pub sealed_content_ref: String,
    pub manifest_record_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningVaultReferencesParams {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_planning_vault_reference_limit")]
    pub limit: usize,
}

impl Default for PlanningVaultReferencesParams {
    fn default() -> Self {
        Self {
            cursor: None,
            limit: DEFAULT_PLANNING_VAULT_REFERENCE_LIMIT,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningVaultReferencesResult {
    pub references: Vec<PlanningVaultReference>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningGetParams {
    pub plan_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningGetResult {
    pub plan: Option<PlanSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningUpsertParams {
    pub operation_id: String,
    #[serde(default)]
    pub expected_version: Option<i64>,
    pub plan: PlanSnapshot,
    /// Missing preserves the current calendar projection; present replaces
    /// every event owned by this plan in the same transaction.
    #[serde(default)]
    pub calendar_events: Option<Vec<PlanningCalendarEvent>>,
    #[serde(default)]
    pub outbox: Vec<PlanningOutboxDraft>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningMutateParams {
    pub operation_id: String,
    pub expected_version: i64,
    pub plan: PlanSnapshot,
    #[serde(default)]
    pub calendar_events: Option<Vec<PlanningCalendarEvent>>,
    #[serde(default)]
    pub outbox: Vec<PlanningOutboxDraft>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningMutationResult {
    pub plan: PlanSnapshot,
    pub calendar_events: Vec<PlanningCalendarEvent>,
    pub outbox: Vec<PlanningOutboxEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningOperationGetParams {
    pub operation_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningOperationGetResult {
    pub operation_id: String,
    pub method: Option<String>,
    /// Convenience projection for planning.upsert/planning.mutate results.
    pub plan: Option<PlanSnapshot>,
    /// Exact committed result used to recover calendar and outbox operations.
    pub result: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarListParams {
    #[serde(default)]
    pub source_plan_id: Option<String>,
    #[serde(default)]
    pub source_task_id: Option<String>,
    /// Optional local/calendar date range. Both values must be present
    /// together and `toDateExclusive` is exclusive.
    #[serde(default)]
    pub from_date: Option<String>,
    #[serde(default)]
    pub to_date_exclusive: Option<String>,
    /// Opaque cursor returned by the preceding page. Callers must continue
    /// requesting pages with each `nextCursor` until the result returns null;
    /// an intermediate page may contain no matching events.
    #[serde(default)]
    pub cursor: Option<String>,
    /// Maximum number of stored rows scanned by one page. When omitted, one
    /// page scans `DEFAULT_CALENDAR_LIST_LIMIT` rows. The core validates an
    /// explicit value against `MAX_CALENDAR_LIST_LIMIT` before querying SQLite.
    #[serde(default = "default_calendar_list_limit")]
    pub limit: usize,
}

impl Default for CalendarListParams {
    fn default() -> Self {
        Self {
            source_plan_id: None,
            source_task_id: None,
            from_date: None,
            to_date_exclusive: None,
            cursor: None,
            limit: DEFAULT_CALENDAR_LIST_LIMIT,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarListResult {
    pub events: Vec<PlanningCalendarEvent>,
    /// Opaque continuation cursor. Callers must request the next page until
    /// this value is null, including after an empty page.
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarGetParams {
    pub event_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarGetResult {
    pub event: Option<PlanningCalendarEvent>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum CalendarMutation {
    Upsert {
        #[serde(default, rename = "expectedVersion")]
        expected_version: Option<i64>,
        event: Box<PlanningCalendarEvent>,
    },
    Delete {
        #[serde(rename = "eventId")]
        event_id: String,
        #[serde(rename = "expectedVersion")]
        expected_version: i64,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CalendarMutationActor {
    /// Interactive calendar mutations are the safe default. Editing a model
    /// event through this path locks it until the user explicitly unlocks it.
    #[default]
    User,
    /// Reserved for the trusted PlanningRuntime adapter. The core still
    /// validates model ownership, task state, and lock protection.
    PlanningRuntime,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarMutateParams {
    pub operation_id: String,
    #[serde(default)]
    pub actor: CalendarMutationActor,
    pub mutations: Vec<CalendarMutation>,
    #[serde(default)]
    pub outbox: Vec<PlanningOutboxDraft>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMutationOutcome {
    pub event_id: String,
    pub event: Option<PlanningCalendarEvent>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMutationResult {
    pub outcomes: Vec<CalendarMutationOutcome>,
    pub outbox: Vec<PlanningOutboxEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningOutboxListParams {
    #[serde(default)]
    pub status: Option<PlanningOutboxStatus>,
    #[serde(default = "default_planning_outbox_limit")]
    pub limit: usize,
}

impl Default for PlanningOutboxListParams {
    fn default() -> Self {
        Self {
            status: None,
            limit: DEFAULT_PLANNING_OUTBOX_LIMIT,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningOutboxListResult {
    pub entries: Vec<PlanningOutboxEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningOutboxAckParams {
    pub operation_id: String,
    pub entry_ids: Vec<String>,
    pub delivered_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanningOutboxAckResult {
    pub entries: Vec<PlanningOutboxEntry>,
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

const fn default_planning_list_limit() -> usize {
    DEFAULT_PLANNING_LIST_LIMIT
}

const fn default_planning_outbox_limit() -> usize {
    DEFAULT_PLANNING_OUTBOX_LIMIT
}

const fn default_vault_list_limit() -> usize {
    DEFAULT_VAULT_LIST_LIMIT
}

const fn default_planning_vault_reference_limit() -> usize {
    DEFAULT_PLANNING_VAULT_REFERENCE_LIMIT
}

const fn default_calendar_list_limit() -> usize {
    DEFAULT_CALENDAR_LIST_LIMIT
}

fn default_object_value() -> Value {
    Value::Object(serde_json::Map::new())
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
            semantic_event_kinds::AUTHORIZATION_CHANGED,
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

    #[test]
    fn vault_and_planning_reference_inventory_contracts_are_strict_and_content_free() {
        let vault: VaultListRecordsParams = serde_json::from_value(serde_json::json!({
            "namespace": "planning.runtime.v1",
            "createdBeforeMs": 1234,
            "cursor": null
        }))
        .expect("parse vault inventory request");
        assert_eq!(vault.limit, DEFAULT_VAULT_LIST_LIMIT);
        assert!(
            serde_json::from_value::<VaultListRecordsParams>(serde_json::json!({
                "namespace": "planning.runtime.v1",
                "createdBeforeMs": 1234,
                "content": "forbidden"
            }))
            .is_err()
        );

        let planning: PlanningVaultReferencesParams =
            serde_json::from_value(serde_json::json!({})).expect("parse planning inventory");
        assert_eq!(planning.limit, DEFAULT_PLANNING_VAULT_REFERENCE_LIMIT);
        let result = PlanningVaultReferencesResult {
            references: vec![PlanningVaultReference {
                source: PlanningVaultReferenceSource::History,
                plan_id: "plan-1".to_owned(),
                version: 2,
                sealed_content_ref: "vault-ref-1".to_owned(),
                manifest_record_id: Some("manifest-1".to_owned()),
            }],
            next_cursor: Some("opaque-cursor".to_owned()),
        };
        let encoded = serde_json::to_value(result).expect("encode reference inventory");
        assert_eq!(encoded["references"][0]["source"], "history");
        assert!(encoded["references"][0].get("runtimePayload").is_none());
        assert!(encoded["references"][0].get("goal").is_none());
    }

    #[test]
    fn calendar_list_pagination_defaults_and_wire_shape_are_stable() {
        let params: CalendarListParams = serde_json::from_value(serde_json::json!({}))
            .expect("parse backward-compatible calendar list request");
        assert_eq!(params.cursor, None);
        assert_eq!(params.limit, DEFAULT_CALENDAR_LIST_LIMIT);

        let explicit: CalendarListParams = serde_json::from_value(serde_json::json!({
            "cursor": "cl1_6576656e742d31",
            "limit": 7
        }))
        .expect("parse paginated calendar list request");
        assert_eq!(explicit.cursor.as_deref(), Some("cl1_6576656e742d31"));
        assert_eq!(explicit.limit, 7);

        let result = serde_json::to_value(CalendarListResult {
            events: Vec::new(),
            next_cursor: Some("cl1_6576656e742d31".to_owned()),
        })
        .expect("serialize paginated calendar list result");
        assert_eq!(result["events"], serde_json::json!([]));
        assert_eq!(result["nextCursor"], "cl1_6576656e742d31");
        assert!(
            serde_json::from_value::<CalendarListParams>(serde_json::json!({
                "cursor": null,
                "limit": 10,
                "offset": 1
            }))
            .is_err()
        );
    }

    #[test]
    fn calendar_mutation_actor_defaults_to_user_and_has_one_trusted_wire_value() {
        let default_user: CalendarMutateParams = serde_json::from_value(serde_json::json!({
            "operationId": "calendar-default-user",
            "mutations": [],
            "outbox": []
        }))
        .expect("parse backward-compatible calendar mutation");
        assert_eq!(default_user.actor, CalendarMutationActor::User);

        let trusted = serde_json::to_value(CalendarMutateParams {
            operation_id: "calendar-planning-runtime".to_owned(),
            actor: CalendarMutationActor::PlanningRuntime,
            mutations: Vec::new(),
            outbox: Vec::new(),
        })
        .expect("serialize trusted calendar actor");
        assert_eq!(trusted["actor"], "planning-runtime");
        assert!(
            serde_json::from_value::<CalendarMutateParams>(serde_json::json!({
                "operationId": "calendar-forged-actor",
                "actor": "renderer",
                "mutations": [],
                "outbox": []
            }))
            .is_err()
        );
    }

    #[test]
    fn unanalysed_plan_draft_keeps_model_fields_empty_and_defaults_runtime_payload() {
        let plan: PlanSnapshot = serde_json::from_value(serde_json::json!({
            "schemaVersion": PLANNING_SCHEMA_VERSION,
            "planId": "plan-1",
            "version": 1,
            "planType": null,
            "status": "draft",
            "analysisState": "awaiting-analysis",
            "goal": "先持久化再分析",
            "startToday": false,
            "timeZone": "Asia/Shanghai",
            "effectiveStartDate": null,
            "schedulingWindow": null,
            "currentEstimate": null,
            "autoScheduleAuthorized": false,
            "monitoringMode": "manual-only",
            "createdAtMs": 1,
            "updatedAtMs": 1
        }))
        .expect("parse unanalysed draft");
        assert_eq!(plan.analysis_state, PlanAnalysisState::AwaitingAnalysis);
        assert_eq!(plan.plan_type, None);
        assert_eq!(plan.effective_start_date, None);
        assert_eq!(plan.scheduling_window, None);
        assert_eq!(plan.current_estimate, None);
        assert_eq!(plan.runtime_payload, serde_json::json!({}));
    }

    #[test]
    fn non_plan_calendar_event_preserves_nullable_planning_metadata() {
        let event: PlanningCalendarEvent = serde_json::from_value(serde_json::json!({
            "schemaVersion": CALENDAR_SCHEMA_VERSION,
            "eventId": "manual-1",
            "title": "占用时间",
            "sealedContentRef": null,
            "redactedContent": false,
            "kind": "manual-block",
            "state": "committed",
            "schedule": {
                "allDay": false,
                "start": "2026-08-14T09:00:00+08:00",
                "end": "2026-08-14T10:00:00+08:00",
                "timeZone": "Asia/Shanghai"
            },
            "recurrence": null,
            "occurrenceId": null,
            "sourcePlanId": null,
            "sourceTaskId": null,
            "scheduleOrigin": null,
            "userLocked": false,
            "editable": true,
            "version": 1
        }))
        .expect("parse manual calendar event");
        assert_eq!(event.schedule_origin, None);
        assert_eq!(event.source_plan_id, None);
        assert_eq!(event.source_task_id, None);
    }

    #[test]
    fn structured_failure_details_are_optional_and_backward_compatible() {
        let ordinary = serde_json::to_value(Response::failure(
            Some("ordinary".to_owned()),
            error_codes::INVALID_ARGUMENTS,
            "invalid",
        ))
        .expect("serialize ordinary error");
        assert!(ordinary["error"].get("details").is_none());
        let stale = serde_json::to_value(Response::failure_with_details(
            Some("stale".to_owned()),
            error_codes::INVALID_ARGUMENTS,
            "stale version",
            serde_json::json!({"reason": "stale-version", "actualVersion": 2}),
        ))
        .expect("serialize structured error");
        assert_eq!(stale["error"]["details"]["reason"], "stale-version");
        assert_eq!(stale["error"]["details"]["actualVersion"], 2);
    }
}
