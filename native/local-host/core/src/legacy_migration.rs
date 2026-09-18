//! Fail-closed, one-shot migration from the legacy plaintext EventJournal.
//!
//! The migration intentionally accepts only metadata-only input buckets and
//! presence boundaries. Legacy browser, accessibility, editor, goal, process,
//! and foreground records do not carry enough provenance to satisfy the v2
//! foreground-only and privacy contracts, so they are reported but never
//! copied. The source database is never modified unless `cleanup_legacy_files`
//! is called after an independently confirmed report and migration receipt.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use thiserror::Error;
use whalehall_local_protocol::{
    CoverageLevelV2, EvidenceReliabilityV2, ObservationIntervalV2, ObservationSensorV2,
    ObservationSourceV2, ObservationSubjectV2, RAW_OBSERVATION_SCHEMA_VERSION,
    RawObservationInputV2,
};

use crate::observations::{ObservationJournal, ObservationJournalError};

pub const REPORT_SCHEMA_VERSION: &str = "legacy-event-migration-report.v1";
pub const RECEIPT_SCHEMA_VERSION: &str = "legacy-event-migration-receipt.v1";
pub const MIGRATION_ADAPTER_VERSION: &str = "legacy-event-journal.migration.v1";
pub const LEGACY_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const LEGACY_SCHEMA_VERSION: &str = "desktop-event.v1";
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Error)]
pub enum LegacyMigrationError {
    #[error("legacy migration configuration error: {0}")]
    Configuration(String),
    #[error("legacy migration confirmation did not match: {0}")]
    ConfirmationMismatch(String),
    #[error("legacy migration verification failed: {0}")]
    Verification(String),
    #[error("legacy migration file I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("legacy migration SQLite operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("legacy migration JSON operation failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("v2 ObservationJournal rejected the migration: {0}")]
    Observation(#[from] ObservationJournalError),
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRange {
    pub from_inclusive_ms: i64,
    pub to_inclusive_ms: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacySourceSummary {
    pub total_rows: usize,
    pub first_sequence: Option<i64>,
    pub last_sequence: Option<i64>,
    pub earliest_observed_at_ms: Option<i64>,
    pub latest_observed_at_ms: Option<i64>,
    pub dataset_hash: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyClassificationSummary {
    pub migratable_rows: usize,
    pub skipped_rows: usize,
    pub by_kind: BTreeMap<String, usize>,
    pub skipped_by_reason: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationSafety {
    pub source_read_only: bool,
    pub destination_must_be_empty_or_same_partial_migration: bool,
    pub migrates_content: bool,
    pub cleanup_default: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationReport {
    pub schema_version: String,
    pub snapshot_at_ms: i64,
    pub range: LegacyRange,
    pub source: LegacySourceSummary,
    pub classification: LegacyClassificationSummary,
    pub safety: LegacyMigrationSafety,
    pub report_hash: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationVerification {
    pub expected_rows: usize,
    pub matched_rows: usize,
    pub lineage_rows: usize,
    pub encrypted_content_rows: usize,
    pub decryption_checks: usize,
    pub decryption_status: String,
    pub key_available: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationReceipt {
    pub schema_version: String,
    pub report_hash: String,
    pub source_dataset_hash: String,
    pub migrated_rows: usize,
    pub already_present_rows: usize,
    pub verification: MigrationVerification,
    pub migration_hash: String,
    pub source_stable_after_migration: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCleanupReceipt {
    pub schema_version: String,
    pub report_hash: String,
    pub migration_hash: String,
    pub removed_files: Vec<String>,
    pub recoverable: bool,
}

#[derive(Clone, Debug)]
pub struct LegacyMigrationPlan {
    pub report: LegacyMigrationReport,
    records: Vec<MigratableRecord>,
}

#[derive(Clone, Debug)]
struct LegacyRow {
    sequence: i64,
    event_id: String,
    schema_version: String,
    device_id: String,
    session_id: String,
    kind: String,
    source: String,
    occurred_at_ms: i64,
    observed_at_ms: i64,
    goal_version: Option<i64>,
    sensitivity: String,
    payload_json: String,
}

#[derive(Clone, Debug)]
struct MigratableRecord {
    sequence: i64,
    legacy_event_id: String,
    input: RawObservationInputV2,
}

#[derive(Clone, Debug)]
enum Classification {
    Migrate(Box<RawObservationInputV2>),
    Skip(&'static str),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyInputBucket {
    key_count: u64,
    click_count: u64,
    scroll_delta: f64,
    mouse_distance: f64,
    bucket_started_at_ms: i64,
    bucket_ended_at_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyIdlePayload {
    idle_for_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyPayload {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportHashMaterial<'a> {
    schema_version: &'a str,
    snapshot_at_ms: i64,
    range: &'a LegacyRange,
    source: &'a LegacySourceSummary,
    classification: &'a LegacyClassificationSummary,
    safety: &'a LegacyMigrationSafety,
}

/// Scans exactly the seven days ending at `snapshot_at_ms`. The legacy
/// database is opened read-only and no payload text is included in the report.
pub fn build_legacy_migration_plan(
    legacy_database_path: &Path,
    snapshot_at_ms: i64,
) -> Result<LegacyMigrationPlan, LegacyMigrationError> {
    validate_snapshot(snapshot_at_ms)?;
    validate_regular_database_file(legacy_database_path, "legacy EventJournal")?;
    let from_ms = snapshot_at_ms
        .checked_sub(LEGACY_WINDOW_MS)
        .ok_or_else(|| {
            LegacyMigrationError::Configuration(
                "snapshotAtMs is earlier than the seven-day migration window".to_owned(),
            )
        })?;
    let connection = open_legacy_read_only(legacy_database_path)?;
    validate_legacy_schema(&connection)?;
    let mut statement = connection.prepare(
        "SELECT sequence, event_id, schema_version, device_id, session_id,
                kind, source, occurred_at_ms, observed_at_ms, goal_version,
                sensitivity, payload_json
         FROM desktop_events
         WHERE observed_at_ms >= ?1 AND observed_at_ms <= ?2
         ORDER BY sequence ASC",
    )?;
    let mut rows = statement.query(params![from_ms, snapshot_at_ms])?;
    let mut dataset_hasher = Sha256::new();
    let mut total_rows = 0_usize;
    let mut first_sequence = None;
    let mut last_sequence = None;
    let mut earliest_observed_at_ms = None;
    let mut latest_observed_at_ms = None;
    let mut migratable_rows = 0_usize;
    let mut skipped_rows = 0_usize;
    let mut by_kind = BTreeMap::new();
    let mut skipped_by_reason = BTreeMap::new();
    let mut records = Vec::new();

    while let Some(row) = rows.next()? {
        let row = LegacyRow {
            sequence: row.get(0)?,
            event_id: row.get(1)?,
            schema_version: row.get(2)?,
            device_id: row.get(3)?,
            session_id: row.get(4)?,
            kind: row.get(5)?,
            source: row.get(6)?,
            occurred_at_ms: row.get(7)?,
            observed_at_ms: row.get(8)?,
            goal_version: row.get(9)?,
            sensitivity: row.get(10)?,
            payload_json: row.get(11)?,
        };
        hash_legacy_row(&mut dataset_hasher, &row);
        total_rows += 1;
        first_sequence.get_or_insert(row.sequence);
        last_sequence = Some(row.sequence);
        earliest_observed_at_ms = Some(
            earliest_observed_at_ms.map_or(row.observed_at_ms, |value: i64| {
                value.min(row.observed_at_ms)
            }),
        );
        latest_observed_at_ms = Some(
            latest_observed_at_ms.map_or(row.observed_at_ms, |value: i64| {
                value.max(row.observed_at_ms)
            }),
        );
        *by_kind
            .entry(report_kind(&row.kind).to_owned())
            .or_insert(0) += 1;
        match classify_row(&row) {
            Classification::Migrate(input) => {
                migratable_rows += 1;
                records.push(MigratableRecord {
                    sequence: row.sequence,
                    legacy_event_id: row.event_id,
                    input: *input,
                });
            }
            Classification::Skip(reason) => {
                skipped_rows += 1;
                *skipped_by_reason.entry(reason.to_owned()).or_insert(0) += 1;
            }
        }
    }

    let source = LegacySourceSummary {
        total_rows,
        first_sequence,
        last_sequence,
        earliest_observed_at_ms,
        latest_observed_at_ms,
        dataset_hash: prefixed_hash(dataset_hasher.finalize().as_slice()),
    };
    let classification = LegacyClassificationSummary {
        migratable_rows,
        skipped_rows,
        by_kind,
        skipped_by_reason,
    };
    let safety = LegacyMigrationSafety {
        source_read_only: true,
        destination_must_be_empty_or_same_partial_migration: true,
        migrates_content: false,
        cleanup_default: "retain".to_owned(),
    };
    let range = LegacyRange {
        from_inclusive_ms: from_ms,
        to_inclusive_ms: snapshot_at_ms,
    };
    let report_hash =
        calculate_report_hash(snapshot_at_ms, &range, &source, &classification, &safety)?;
    Ok(LegacyMigrationPlan {
        report: LegacyMigrationReport {
            schema_version: REPORT_SCHEMA_VERSION.to_owned(),
            snapshot_at_ms,
            range,
            source,
            classification,
            safety,
            report_hash,
        },
        records,
    })
}

/// Migrates the report's conservative metadata-only subset. A freshly scanned
/// report must match the explicitly supplied hash before the destination is
/// opened. A destination with unrelated observations or a current goal is
/// rejected because replaying historical events would attach incorrect goal
/// context.
pub fn migrate_legacy_plan(
    legacy_database_path: &Path,
    observation_database_path: &Path,
    snapshot_at_ms: i64,
    confirmed_report_hash: &str,
    journal: &ObservationJournal,
) -> Result<LegacyMigrationReceipt, LegacyMigrationError> {
    reject_same_database(legacy_database_path, observation_database_path)?;
    let plan = build_legacy_migration_plan(legacy_database_path, snapshot_at_ms)?;
    confirm_hash(
        "report hash",
        confirmed_report_hash,
        &plan.report.report_hash,
    )?;
    if journal.database_path() != observation_database_path {
        return Err(LegacyMigrationError::Configuration(
            "opened ObservationJournal path does not match --observation-db".to_owned(),
        ));
    }
    if !journal.key_available() {
        return Err(LegacyMigrationError::Verification(
            "the v2 encryption key is unavailable; migration will not degrade to plaintext"
                .to_owned(),
        ));
    }
    preflight_destination(journal, &plan.records)?;

    let mut migrated_rows = 0_usize;
    let mut already_present_rows = 0_usize;
    for record in &plan.records {
        let result = journal.ingest(&legacy_deduplication_key(record), record.input.clone())?;
        if result.inserted {
            migrated_rows += 1;
        } else {
            already_present_rows += 1;
        }
    }
    let (verification, migration_hash) = verify_records(journal, &plan.records)?;
    let fresh = build_legacy_migration_plan(legacy_database_path, snapshot_at_ms)?;
    let source_stable_after_migration = fresh.report.report_hash == plan.report.report_hash;
    if !source_stable_after_migration {
        return Err(LegacyMigrationError::Verification(
            "legacy EventJournal changed during migration; migrated rows are idempotent, but cleanup is forbidden until a new report is confirmed"
                .to_owned(),
        ));
    }
    Ok(LegacyMigrationReceipt {
        schema_version: RECEIPT_SCHEMA_VERSION.to_owned(),
        report_hash: plan.report.report_hash,
        source_dataset_hash: plan.report.source.dataset_hash,
        migrated_rows,
        already_present_rows,
        verification,
        migration_hash,
        source_stable_after_migration,
    })
}

/// Re-verifies a completed migration without adding rows. This is the only
/// verification accepted by cleanup.
pub fn verify_legacy_migration(
    legacy_database_path: &Path,
    observation_database_path: &Path,
    snapshot_at_ms: i64,
    confirmed_report_hash: &str,
    confirmed_migration_hash: &str,
    journal: &ObservationJournal,
) -> Result<LegacyMigrationReceipt, LegacyMigrationError> {
    reject_same_database(legacy_database_path, observation_database_path)?;
    let plan = build_legacy_migration_plan(legacy_database_path, snapshot_at_ms)?;
    confirm_hash(
        "report hash",
        confirmed_report_hash,
        &plan.report.report_hash,
    )?;
    if journal.database_path() != observation_database_path {
        return Err(LegacyMigrationError::Configuration(
            "opened ObservationJournal path does not match --observation-db".to_owned(),
        ));
    }
    if !journal.key_available() {
        return Err(LegacyMigrationError::Verification(
            "the v2 encryption key is unavailable".to_owned(),
        ));
    }
    let (verification, migration_hash) = verify_records(journal, &plan.records)?;
    confirm_hash("migration hash", confirmed_migration_hash, &migration_hash)?;
    Ok(LegacyMigrationReceipt {
        schema_version: RECEIPT_SCHEMA_VERSION.to_owned(),
        report_hash: plan.report.report_hash,
        source_dataset_hash: plan.report.source.dataset_hash,
        migrated_rows: 0,
        already_present_rows: plan.records.len(),
        verification,
        migration_hash,
        source_stable_after_migration: true,
    })
}

/// Deletes only the explicitly named legacy database and its `-wal`/`-shm`
/// sidecars. Callers must first run `verify_legacy_migration`, pass both
/// confirmed hashes again, and assert that the source service is stopped.
/// Cleanup is deliberately macOS-only because it uses `lsof` as a final
/// fail-closed check for live SQLite handles.
pub fn cleanup_legacy_files(
    legacy_database_path: &Path,
    verified_receipt: &LegacyMigrationReceipt,
    confirmed_report_hash: &str,
    confirmed_migration_hash: &str,
    source_stopped_confirmation: &str,
) -> Result<LegacyCleanupReceipt, LegacyMigrationError> {
    confirm_hash(
        "report hash",
        confirmed_report_hash,
        &verified_receipt.report_hash,
    )?;
    confirm_hash(
        "migration hash",
        confirmed_migration_hash,
        &verified_receipt.migration_hash,
    )?;
    if source_stopped_confirmation != "SOURCE_STOPPED" {
        return Err(LegacyMigrationError::ConfirmationMismatch(
            "cleanup requires --confirm-source-stopped SOURCE_STOPPED".to_owned(),
        ));
    }
    validate_regular_database_file(legacy_database_path, "legacy EventJournal")?;
    ensure_no_open_legacy_handles(legacy_database_path)?;
    let mut candidates = legacy_sidecar_paths(legacy_database_path);
    candidates.push(legacy_database_path.to_path_buf());
    let mut removed_files = Vec::new();
    for path in candidates {
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                    return Err(LegacyMigrationError::Configuration(format!(
                        "refusing to delete non-regular legacy file {}",
                        path.display()
                    )));
                }
                fs::remove_file(&path)?;
                removed_files.push(
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("legacy-sqlite-file")
                        .to_owned(),
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(LegacyCleanupReceipt {
        schema_version: "legacy-event-migration-cleanup.v1".to_owned(),
        report_hash: verified_receipt.report_hash.clone(),
        migration_hash: verified_receipt.migration_hash.clone(),
        removed_files,
        recoverable: false,
    })
}

fn open_legacy_read_only(path: &Path) -> Result<Connection, LegacyMigrationError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "query_only", true)?;
    Ok(connection)
}

fn validate_legacy_schema(connection: &Connection) -> Result<(), LegacyMigrationError> {
    let table_exists = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_schema
            WHERE type = 'table' AND name = 'desktop_events'
         )",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    if !table_exists {
        return Err(LegacyMigrationError::Configuration(
            "legacy database does not contain desktop_events".to_owned(),
        ));
    }
    let required = [
        "sequence",
        "event_id",
        "schema_version",
        "device_id",
        "session_id",
        "kind",
        "source",
        "occurred_at_ms",
        "observed_at_ms",
        "goal_version",
        "sensitivity",
        "payload_json",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let mut statement = connection.prepare("PRAGMA table_info(desktop_events)")?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    let missing = required
        .iter()
        .filter(|column| !actual.contains(**column))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(LegacyMigrationError::Configuration(format!(
            "legacy desktop_events is missing required columns: {}",
            missing.join(", ")
        )));
    }
    Ok(())
}

fn classify_row(row: &LegacyRow) -> Classification {
    if row.schema_version != LEGACY_SCHEMA_VERSION {
        return Classification::Skip("invalid_legacy_schema");
    }
    if row.occurred_at_ms < 0
        || row.observed_at_ms < row.occurred_at_ms
        || row.observed_at_ms > MAX_SAFE_INTEGER
    {
        return Classification::Skip("invalid_time_range");
    }
    if row.goal_version.is_some() {
        return Classification::Skip("historical_goal_context_not_replayable");
    }
    match row.kind.as_str() {
        "input.activityAggregated" => classify_input_bucket(row),
        "presence.afkStarted" => classify_presence(row, "afk_started"),
        "presence.afkEnded" => classify_presence(row, "afk_ended"),
        "presence.locked" => classify_presence(row, "locked"),
        "presence.unlocked" => classify_presence(row, "unlocked"),
        "presence.sleep" => classify_presence(row, "sleep"),
        "presence.wake" => classify_presence(row, "wake"),
        "browser.tabOpened" | "browser.tabNavigated" | "browser.tabClosed" => {
            Classification::Skip("background_browser_scope_not_verifiable")
        }
        "accessibility.focusChanged"
        | "accessibility.valueChanged"
        | "accessibility.documentChanged"
        | "editor.documentChanged" => Classification::Skip("content_privacy_not_verifiable"),
        "application.foregroundChanged" => {
            Classification::Skip("foreground_process_identity_missing")
        }
        "goal.contextChanged" => Classification::Skip("goal_history_continuity_not_verifiable"),
        "application.processObservedBatch"
        | "reflection.completed"
        | "reflection.failed"
        | "system.heartbeat" => Classification::Skip("legacy_noise_kind"),
        "authorization.revoked" | "authorization.granted" => {
            Classification::Skip("authorization_boundary_not_mappable")
        }
        _ => Classification::Skip("unsupported_kind"),
    }
}

fn classify_input_bucket(row: &LegacyRow) -> Classification {
    if row.source != "input.activity.sensor" || row.sensitivity != "metadata" {
        return Classification::Skip("untrusted_input_source_or_sensitivity");
    }
    let Ok(payload) = serde_json::from_str::<LegacyInputBucket>(&row.payload_json) else {
        return Classification::Skip("invalid_input_payload");
    };
    let counts_fit = payload.key_count <= MAX_SAFE_INTEGER as u64
        && payload.click_count <= MAX_SAFE_INTEGER as u64;
    let numbers_fit = payload.scroll_delta.is_finite()
        && (-1e12..=1e12).contains(&payload.scroll_delta)
        && payload.mouse_distance.is_finite()
        && (0.0..=1e12).contains(&payload.mouse_distance);
    let interval_valid = payload.bucket_started_at_ms >= 0
        && payload.bucket_ended_at_ms <= MAX_SAFE_INTEGER
        && payload
            .bucket_ended_at_ms
            .checked_sub(payload.bucket_started_at_ms)
            == Some(5_000)
        && row.occurred_at_ms == payload.bucket_ended_at_ms;
    if !counts_fit || !numbers_fit || !interval_valid {
        return Classification::Skip("invalid_input_payload");
    }
    Classification::Migrate(Box::new(RawObservationInputV2 {
        schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
        kind: "input.activityBucket".to_owned(),
        interval: ObservationIntervalV2 {
            started_at_ms: payload.bucket_started_at_ms,
            ended_at_ms: payload.bucket_ended_at_ms,
        },
        source: ObservationSourceV2 {
            sensor: ObservationSensorV2::CgActivity,
            adapter_version: MIGRATION_ADAPTER_VERSION.to_owned(),
        },
        subject: ObservationSubjectV2 {
            app_id: "system.input".to_owned(),
            app_name: "macOS".to_owned(),
            opaque_window_id: None,
        },
        reliability: EvidenceReliabilityV2::High,
        coverage: vec![CoverageLevelV2::Metadata],
        redactions: Vec::new(),
        metadata: json!({
            "keyCount": payload.key_count,
            "clickCount": payload.click_count,
            "scrollDelta": payload.scroll_delta,
            "mouseDistance": payload.mouse_distance,
        }),
        content: None,
    }))
}

fn classify_presence(row: &LegacyRow, state: &'static str) -> Classification {
    if row.source != "presence.sensor" || row.sensitivity != "metadata" {
        return Classification::Skip("untrusted_presence_source_or_sensitivity");
    }
    let metadata = if matches!(state, "afk_started" | "afk_ended") {
        let Ok(payload) = serde_json::from_str::<LegacyIdlePayload>(&row.payload_json) else {
            return Classification::Skip("invalid_presence_payload");
        };
        if payload.idle_for_ms > MAX_SAFE_INTEGER as u64 {
            return Classification::Skip("invalid_presence_payload");
        }
        json!({ "state": state, "idleForMs": payload.idle_for_ms })
    } else {
        if serde_json::from_str::<EmptyPayload>(&row.payload_json).is_err() {
            return Classification::Skip("invalid_presence_payload");
        }
        json!({ "state": state })
    };
    Classification::Migrate(Box::new(RawObservationInputV2 {
        schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
        kind: "presence.changed".to_owned(),
        interval: ObservationIntervalV2 {
            started_at_ms: row.occurred_at_ms,
            ended_at_ms: row.observed_at_ms,
        },
        source: ObservationSourceV2 {
            sensor: ObservationSensorV2::Workspace,
            adapter_version: MIGRATION_ADAPTER_VERSION.to_owned(),
        },
        subject: ObservationSubjectV2 {
            app_id: "system.presence".to_owned(),
            app_name: "macOS".to_owned(),
            opaque_window_id: None,
        },
        reliability: EvidenceReliabilityV2::High,
        coverage: vec![CoverageLevelV2::Metadata],
        redactions: Vec::new(),
        metadata,
        content: None,
    }))
}

fn preflight_destination(
    journal: &ObservationJournal,
    records: &[MigratableRecord],
) -> Result<(), LegacyMigrationError> {
    let connection = Connection::open(journal.database_path())?;
    let current_goal = connection
        .query_row(
            "SELECT value FROM journal_meta WHERE key = 'current_goal_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if current_goal.is_some() {
        return Err(LegacyMigrationError::Verification(
            "destination has a current goal; historical legacy rows cannot be assigned correct goal versions"
                .to_owned(),
        ));
    }
    let expected = records
        .iter()
        .map(|record| expected_observation_id(journal.device_id(), record))
        .collect::<BTreeSet<_>>();
    let mut statement = connection.prepare("SELECT observation_id FROM observations")?;
    let actual = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    if !actual.is_subset(&expected) {
        return Err(LegacyMigrationError::Verification(
            "destination contains unrelated v2 observations; one-shot migration must run before v2 collection starts"
                .to_owned(),
        ));
    }
    Ok(())
}

fn verify_records(
    journal: &ObservationJournal,
    records: &[MigratableRecord],
) -> Result<(MigrationVerification, String), LegacyMigrationError> {
    let connection =
        Connection::open_with_flags(journal.database_path(), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut migration_hasher = Sha256::new();
    let mut matched_rows = 0_usize;
    let mut lineage_rows = 0_usize;
    for record in records {
        let observation_id = expected_observation_id(journal.device_id(), record);
        let expected_dedup_hash = raw_input_hash(&record.input)?;
        let stored = connection
            .query_row(
                "SELECT o.dedup_hash, o.content_ref, o.content_state,
                        e.event_id, e.content_ref
                 FROM observations o
                 JOIN semantic_event_lineage l
                   ON l.observation_id = o.observation_id
                 JOIN semantic_events e ON e.event_id = l.event_id
                 WHERE o.observation_id = ?1",
                [&observation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                LegacyMigrationError::Verification(format!(
                    "migrated observation for legacy sequence {} is missing",
                    record.sequence
                ))
            })?;
        if stored.0 != expected_dedup_hash {
            return Err(LegacyMigrationError::Verification(format!(
                "migrated observation for legacy sequence {} has a different hash",
                record.sequence
            )));
        }
        if stored.1.is_some() || stored.4.is_some() {
            return Err(LegacyMigrationError::Verification(
                "metadata-only migration unexpectedly produced encrypted content".to_owned(),
            ));
        }
        if stored.2 != "available" {
            return Err(LegacyMigrationError::Verification(format!(
                "migrated observation for legacy sequence {} is not available",
                record.sequence
            )));
        }
        hash_frame(&mut migration_hasher, record.legacy_event_id.as_bytes());
        hash_frame(&mut migration_hasher, observation_id.as_bytes());
        hash_frame(&mut migration_hasher, stored.0.as_bytes());
        hash_frame(&mut migration_hasher, stored.3.as_bytes());
        matched_rows += 1;
        lineage_rows += 1;
    }
    let verification = MigrationVerification {
        expected_rows: records.len(),
        matched_rows,
        lineage_rows,
        encrypted_content_rows: 0,
        decryption_checks: 0,
        decryption_status: "not_applicable_metadata_only_policy".to_owned(),
        key_available: journal.key_available(),
    };
    if matched_rows != records.len() || lineage_rows != records.len() {
        return Err(LegacyMigrationError::Verification(
            "not every migratable row has exactly one verified lineage".to_owned(),
        ));
    }
    Ok((
        verification,
        prefixed_hash(migration_hasher.finalize().as_slice()),
    ))
}

fn expected_observation_id(device_id: &str, record: &MigratableRecord) -> String {
    deterministic_id(
        "ro2",
        &[
            RAW_OBSERVATION_SCHEMA_VERSION,
            device_id,
            MIGRATION_ADAPTER_VERSION,
            &legacy_deduplication_key(record),
        ],
    )
}

fn legacy_deduplication_key(record: &MigratableRecord) -> String {
    format!("legacy-v1:{}", record.legacy_event_id)
}

fn raw_input_hash(input: &RawObservationInputV2) -> Result<String, LegacyMigrationError> {
    Ok(hex_hash(&serde_json::to_vec(input)?))
}

fn hash_legacy_row(hasher: &mut Sha256, row: &LegacyRow) {
    hash_frame(hasher, &row.sequence.to_be_bytes());
    for value in [
        row.event_id.as_bytes(),
        row.schema_version.as_bytes(),
        row.device_id.as_bytes(),
        row.session_id.as_bytes(),
        row.kind.as_bytes(),
        row.source.as_bytes(),
    ] {
        hash_frame(hasher, value);
    }
    hash_frame(hasher, &row.occurred_at_ms.to_be_bytes());
    hash_frame(hasher, &row.observed_at_ms.to_be_bytes());
    match row.goal_version {
        Some(value) => {
            hash_frame(hasher, &[1]);
            hash_frame(hasher, &value.to_be_bytes());
        }
        None => hash_frame(hasher, &[0]),
    }
    hash_frame(hasher, row.sensitivity.as_bytes());
    hash_frame(hasher, row.payload_json.as_bytes());
}

fn hash_frame(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
}

fn calculate_report_hash(
    snapshot_at_ms: i64,
    range: &LegacyRange,
    source: &LegacySourceSummary,
    classification: &LegacyClassificationSummary,
    safety: &LegacyMigrationSafety,
) -> Result<String, LegacyMigrationError> {
    let material = ReportHashMaterial {
        schema_version: REPORT_SCHEMA_VERSION,
        snapshot_at_ms,
        range,
        source,
        classification,
        safety,
    };
    Ok(hex_hash(&serde_json::to_vec(&material)?))
}

fn deterministic_id(prefix: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hash_frame(&mut hasher, value.as_bytes());
    }
    format!("{prefix}_{}", hex_hash(hasher.finalize().as_slice()))
}

fn hex_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn prefixed_hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex_hash(bytes))
}

fn confirm_hash(label: &str, confirmed: &str, actual: &str) -> Result<(), LegacyMigrationError> {
    if confirmed != actual {
        return Err(LegacyMigrationError::ConfirmationMismatch(format!(
            "{label} does not match the current read-only scan"
        )));
    }
    Ok(())
}

fn validate_snapshot(snapshot_at_ms: i64) -> Result<(), LegacyMigrationError> {
    if !(LEGACY_WINDOW_MS..=MAX_SAFE_INTEGER).contains(&snapshot_at_ms) {
        return Err(LegacyMigrationError::Configuration(
            "snapshotAtMs must be a safe integer at least seven days after epoch".to_owned(),
        ));
    }
    Ok(())
}

fn report_kind(kind: &str) -> &str {
    match kind {
        "application.foregroundChanged"
        | "application.processObservedBatch"
        | "browser.tabOpened"
        | "browser.tabNavigated"
        | "browser.tabClosed"
        | "accessibility.focusChanged"
        | "accessibility.valueChanged"
        | "accessibility.documentChanged"
        | "editor.documentChanged"
        | "input.activityAggregated"
        | "goal.contextChanged"
        | "presence.afkStarted"
        | "presence.afkEnded"
        | "presence.locked"
        | "presence.unlocked"
        | "presence.sleep"
        | "presence.wake"
        | "reflection.completed"
        | "reflection.failed"
        | "authorization.revoked"
        | "authorization.granted"
        | "system.heartbeat" => kind,
        _ => "other_unknown",
    }
}

fn validate_regular_database_file(path: &Path, label: &str) -> Result<(), LegacyMigrationError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        LegacyMigrationError::Configuration(format!(
            "{label} {} is not readable: {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(LegacyMigrationError::Configuration(format!(
            "{label} must be a regular non-symlink file"
        )));
    }
    Ok(())
}

fn reject_same_database(
    legacy_database_path: &Path,
    observation_database_path: &Path,
) -> Result<(), LegacyMigrationError> {
    let legacy = fs::canonicalize(legacy_database_path)?;
    let observation = if observation_database_path.exists() {
        fs::canonicalize(observation_database_path)?
    } else {
        let parent = observation_database_path.parent().ok_or_else(|| {
            LegacyMigrationError::Configuration(
                "observation database path has no parent directory".to_owned(),
            )
        })?;
        fs::canonicalize(parent)?.join(observation_database_path.file_name().ok_or_else(|| {
            LegacyMigrationError::Configuration(
                "observation database path has no file name".to_owned(),
            )
        })?)
    };
    if legacy == observation {
        return Err(LegacyMigrationError::Configuration(
            "legacy and v2 observation database paths must be different".to_owned(),
        ));
    }
    Ok(())
}

fn legacy_sidecar_paths(database_path: &Path) -> Vec<PathBuf> {
    let mut value = database_path.as_os_str().to_os_string();
    value.push("-wal");
    let wal = PathBuf::from(value);
    let mut value = database_path.as_os_str().to_os_string();
    value.push("-shm");
    vec![wal, PathBuf::from(value)]
}

fn ensure_no_open_legacy_handles(database_path: &Path) -> Result<(), LegacyMigrationError> {
    if !cfg!(target_os = "macos") {
        return Err(LegacyMigrationError::Verification(
            "legacy cleanup is supported only on macOS".to_owned(),
        ));
    }
    for path in std::iter::once(database_path.to_path_buf())
        .chain(legacy_sidecar_paths(database_path))
        .filter(|path| path.exists())
    {
        let output = Command::new("/usr/sbin/lsof")
            .arg("-t")
            .arg(&path)
            .output()?;
        match output.status.code() {
            Some(1) if output.stdout.is_empty() => {}
            Some(0) => {
                return Err(LegacyMigrationError::Verification(format!(
                    "legacy source is still open: {}",
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("SQLite file")
                )));
            }
            _ => {
                return Err(LegacyMigrationError::Verification(
                    "could not prove that legacy SQLite files have no open handles".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rusqlite::Connection;
    use serde_json::json;
    use tempfile::TempDir;
    use whalehall_local_protocol::DesktopEventSensitivity;

    use super::*;
    use crate::events::{DesktopEventDraft, EventJournal};
    use crate::observations::{MemoryObservationKeyProvider, ObservationJournalConfig};

    const SNAPSHOT_MS: i64 = 1_700_000_000_000;

    struct Harness {
        _directory: TempDir,
        legacy_path: PathBuf,
        observation_path: PathBuf,
        journal: ObservationJournal,
    }

    fn harness() -> Harness {
        let directory = tempfile::tempdir().expect("create migration test directory");
        let legacy_path = directory.path().join("events.sqlite3");
        let observation_path = directory.path().join("observation-journal.sqlite3");
        let legacy = EventJournal::open(&legacy_path).expect("open legacy journal");
        let input_end = SNAPSHOT_MS - 20_000;
        legacy
            .append(DesktopEventDraft {
                kind: "input.activityAggregated".to_owned(),
                source: "input.activity.sensor".to_owned(),
                occurred_at_ms: input_end,
                observed_at_ms: input_end + 10,
                goal_version: None,
                sensitivity: DesktopEventSensitivity::Metadata,
                payload: json!({
                    "keyCount": 12,
                    "clickCount": 3,
                    "scrollDelta": -4.5,
                    "mouseDistance": 90.0,
                    "bucketStartedAtMs": input_end - 5_000,
                    "bucketEndedAtMs": input_end,
                }),
                deduplication_key: "migration-input".to_owned(),
            })
            .expect("append input");
        legacy
            .append(DesktopEventDraft {
                kind: "presence.locked".to_owned(),
                source: "presence.sensor".to_owned(),
                occurred_at_ms: SNAPSHOT_MS - 10_000,
                observed_at_ms: SNAPSHOT_MS - 10_000,
                goal_version: None,
                sensitivity: DesktopEventSensitivity::Metadata,
                payload: json!({}),
                deduplication_key: "migration-presence".to_owned(),
            })
            .expect("append presence");
        legacy
            .append(DesktopEventDraft {
                kind: "browser.tabNavigated".to_owned(),
                source: "browser.activity.sensor".to_owned(),
                occurred_at_ms: SNAPSHOT_MS - 5_000,
                observed_at_ms: SNAPSHOT_MS - 5_000,
                goal_version: None,
                sensitivity: DesktopEventSensitivity::Content,
                payload: json!({
                    "browserId": "browser",
                    "tabId": "tab",
                    "url": "https://private.example/secret",
                    "title": "DO_NOT_LEAK_THIS_TITLE",
                }),
                deduplication_key: "migration-browser".to_owned(),
            })
            .expect("append browser");
        drop(legacy);

        let mut config = ObservationJournalConfig::new(
            &observation_path,
            Arc::new(MemoryObservationKeyProvider::new([9_u8; 32])),
        );
        config.device_id = Some("migration-device".to_owned());
        config.session_id = Some("migration-session".to_owned());
        let journal = ObservationJournal::open_with_config(config).expect("open observation");
        Harness {
            _directory: directory,
            legacy_path,
            observation_path,
            journal,
        }
    }

    #[test]
    fn report_is_deterministic_read_only_and_never_contains_payload_text() {
        let harness = harness();
        let before = fs::metadata(&harness.legacy_path)
            .expect("legacy metadata")
            .len();
        let first =
            build_legacy_migration_plan(&harness.legacy_path, SNAPSHOT_MS).expect("first report");
        let second =
            build_legacy_migration_plan(&harness.legacy_path, SNAPSHOT_MS).expect("second report");
        assert_eq!(first.report, second.report);
        assert_eq!(first.report.classification.migratable_rows, 2);
        assert_eq!(first.report.classification.skipped_rows, 1);
        let rendered = serde_json::to_string(&first.report).expect("serialize report");
        assert!(!rendered.contains("private.example"));
        assert!(!rendered.contains("DO_NOT_LEAK_THIS_TITLE"));
        assert_eq!(
            fs::metadata(&harness.legacy_path)
                .expect("legacy metadata after report")
                .len(),
            before
        );
    }

    #[test]
    fn migration_requires_exact_report_hash_and_verifies_idempotent_lineage() {
        let harness = harness();
        let plan = build_legacy_migration_plan(&harness.legacy_path, SNAPSHOT_MS).expect("report");
        let mismatch = migrate_legacy_plan(
            &harness.legacy_path,
            &harness.observation_path,
            SNAPSHOT_MS,
            "sha256:not-the-report",
            &harness.journal,
        );
        assert!(matches!(
            mismatch,
            Err(LegacyMigrationError::ConfirmationMismatch(_))
        ));
        let connection = Connection::open(&harness.observation_path).expect("open v2");
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM observations", [], |row| row
                    .get::<_, i64>(0))
                .expect("count observations"),
            0
        );
        drop(connection);

        let receipt = migrate_legacy_plan(
            &harness.legacy_path,
            &harness.observation_path,
            SNAPSHOT_MS,
            &plan.report.report_hash,
            &harness.journal,
        )
        .expect("migrate");
        assert_eq!(receipt.migrated_rows, 2);
        assert_eq!(receipt.already_present_rows, 0);
        assert_eq!(receipt.verification.matched_rows, 2);
        assert_eq!(receipt.verification.lineage_rows, 2);
        assert_eq!(receipt.verification.encrypted_content_rows, 0);
        assert!(receipt.verification.key_available);
        assert!(harness.legacy_path.exists());

        let verified = verify_legacy_migration(
            &harness.legacy_path,
            &harness.observation_path,
            SNAPSHOT_MS,
            &receipt.report_hash,
            &receipt.migration_hash,
            &harness.journal,
        )
        .expect("verify");
        assert_eq!(verified.migration_hash, receipt.migration_hash);

        let replay = migrate_legacy_plan(
            &harness.legacy_path,
            &harness.observation_path,
            SNAPSHOT_MS,
            &plan.report.report_hash,
            &harness.journal,
        )
        .expect("idempotent replay");
        assert_eq!(replay.migrated_rows, 0);
        assert_eq!(replay.already_present_rows, 2);
        assert_eq!(replay.migration_hash, receipt.migration_hash);
    }

    #[test]
    fn cleanup_is_disabled_without_all_explicit_confirmations() {
        let harness = harness();
        let plan = build_legacy_migration_plan(&harness.legacy_path, SNAPSHOT_MS).expect("report");
        let receipt = migrate_legacy_plan(
            &harness.legacy_path,
            &harness.observation_path,
            SNAPSHOT_MS,
            &plan.report.report_hash,
            &harness.journal,
        )
        .expect("migrate");
        let cleanup = cleanup_legacy_files(
            &harness.legacy_path,
            &receipt,
            &receipt.report_hash,
            &receipt.migration_hash,
            "not-confirmed",
        );
        assert!(matches!(
            cleanup,
            Err(LegacyMigrationError::ConfirmationMismatch(_))
        ));
        assert!(harness.legacy_path.exists());
    }
}
