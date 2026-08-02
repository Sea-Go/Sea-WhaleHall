//! Explicit-consent VS Code edit bridge consumer.
//!
//! The VS Code extension publishes immutable JSONL segments into a local spool.
//! This sensor claims and validates those segments, keeps active edit bursts in
//! a private SQLite database, and publishes only completed two-second/ten-second
//! semantic bursts to the Desktop EventJournal. Raw editor deltas are never
//! appended to the EventJournal.

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::str;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;
use whalehall_local_protocol::{DesktopEventSensitivity, desktop_event_kinds};

use crate::events::{DesktopEventDraft, EventJournal, EventJournalError};

pub const DEFAULT_VSCODE_EDIT_POLL_INTERVAL_MS: u64 = 250;
pub const EDIT_SILENCE_MS: i64 = 2_000;
pub const EDIT_MAX_BURST_MS: i64 = 10_000;

const BRIDGE_DIRECTORY_ENVIRONMENT_VARIABLE: &str = "WHALEHALL_VSCODE_BRIDGE_DIRECTORY";
const SPOOL_DIRECTORY_NAME: &str = ".whalehall-vscode-spool-v1";
const CLAIMED_PREFIX: &str = ".claimed-";
const RECORD_SCHEMA_VERSION: &str = "whalehall-vscode-edit.v1";
const RECORD_KIND: &str = "editor.documentChanged";
const RECORD_SOURCE: &str = "vscode.extension";
const MAX_EVENT_LINE_BYTES: usize = 64 * 1024;
const MAX_EVENTS_PER_SEGMENT: usize = 128;
const MAX_SEGMENT_BYTES: u64 = 256 * 1024;
const MAX_RELATIVE_PATH_CHARS: usize = 1_024;
const MAX_LANGUAGE_CHARS: usize = 128;
const MAX_INSERTED_TEXT_CHARS: usize = 2_048;
const MAX_INSERTED_TEXT_BYTES_PER_EVENT: usize = 16 * 1_024;
const MAX_BURST_TEXT_CHARS: usize = 4_096;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_FUTURE_EVENT_SKEW_MS: i64 = 60_000;
const SOURCE_DEDUP_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_SOURCE_DEDUP_ROWS: usize = 1_000_000;
const SCHEMA_VERSION: i64 = 2;
const LAST_OCCURRED_META_KEY: &str = "last_ingested_occurred_at_ms";
const LAST_IMPORTED_META_KEY: &str = "last_imported_at_ms";
const LAST_PUBLISHED_META_KEY: &str = "last_published_at_ms";

#[derive(Clone, Debug)]
pub struct VscodeEditBridgeConfig {
    pub bridge_root: Option<PathBuf>,
    pub database_path: PathBuf,
    pub poll_interval: Duration,
}

impl VscodeEditBridgeConfig {
    pub fn from_environment() -> Result<Self, VscodeEditBridgeError> {
        let bridge_root = match env::var_os(BRIDGE_DIRECTORY_ENVIRONMENT_VARIABLE) {
            Some(value) => {
                let path = PathBuf::from(value);
                validate_configured_bridge_root(&path)?;
                Some(path)
            }
            None => None,
        };
        let data_dir = if let Some(path) = env::var_os("WHALEHALL_DATA_DIR") {
            PathBuf::from(path)
        } else {
            ProjectDirs::from("com", "seago", "whalehall")
                .ok_or_else(|| {
                    VscodeEditBridgeError::Configuration(
                        "unable to resolve the operating system application data directory"
                            .to_owned(),
                    )
                })?
                .data_dir()
                .to_path_buf()
        };
        Ok(Self {
            bridge_root,
            database_path: data_dir.join("editor-bridge").join("editor.sqlite3"),
            poll_interval: Duration::from_millis(DEFAULT_VSCODE_EDIT_POLL_INTERVAL_MS),
        })
    }

    pub fn enabled(&self) -> bool {
        self.bridge_root.is_some()
    }

    fn validate(&self) -> Result<(), VscodeEditBridgeError> {
        if self.poll_interval.is_zero() {
            return Err(VscodeEditBridgeError::Configuration(
                "VS Code edit bridge poll interval must be greater than zero".to_owned(),
            ));
        }
        if self.database_path.file_name().is_none() || self.database_path.parent().is_none() {
            return Err(VscodeEditBridgeError::Configuration(
                "VS Code edit bridge database path must name a file in a directory".to_owned(),
            ));
        }
        if let Some(root) = self.bridge_root.as_deref() {
            validate_configured_bridge_root(root)?;
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum VscodeEditBridgeError {
    #[error("VS Code edit bridge configuration error: {0}")]
    Configuration(String),
    #[error("VS Code edit bridge I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("VS Code edit bridge SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("VS Code edit bridge JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("VS Code edit event publication failed: {0}")]
    EventJournal(#[from] EventJournalError),
    #[error("invalid VS Code spool segment: {0}")]
    InvalidSegment(String),
}

impl VscodeEditBridgeError {
    fn is_invalid_segment(&self) -> bool {
        matches!(self, Self::InvalidSegment(_))
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VscodeEditBridgeState {
    Starting,
    Disabled,
    Running,
    Degraded,
    Stopped,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VscodeEditBridgeStatus {
    pub state: VscodeEditBridgeState,
    pub enabled: bool,
    pub bridge_root: Option<String>,
    pub spool_directory: Option<String>,
    pub database_path: String,
    pub poll_interval_ms: u64,
    pub pending_segments: usize,
    pub rejected_segments: usize,
    pub open_bursts: usize,
    pub pending_bursts: usize,
    pub last_imported_at_ms: Option<i64>,
    pub last_published_at_ms: Option<i64>,
    pub warnings: Vec<String>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct VscodeEditBridgeService {
    inner: Arc<VscodeEditBridgeInner>,
}

struct VscodeEditBridgeInner {
    config: VscodeEditBridgeConfig,
    store: Option<VscodeEditStore>,
    paths: Option<BridgePaths>,
    event_journal: EventJournal,
    status: Mutex<VscodeEditBridgeStatus>,
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl VscodeEditBridgeService {
    pub fn start(
        config: VscodeEditBridgeConfig,
        event_journal: EventJournal,
    ) -> Result<Self, VscodeEditBridgeError> {
        config.validate()?;
        let enabled = config.enabled();
        let (paths, store) = if let Some(root) = config.bridge_root.as_deref() {
            let paths = BridgePaths::prepare(root)?;
            let store = VscodeEditStore::open(&config.database_path)?;
            (Some(paths), Some(store))
        } else {
            (None, None)
        };
        let status = VscodeEditBridgeStatus {
            state: if enabled {
                VscodeEditBridgeState::Starting
            } else {
                VscodeEditBridgeState::Disabled
            },
            enabled,
            bridge_root: paths
                .as_ref()
                .map(|paths| paths.root.to_string_lossy().into_owned()),
            spool_directory: paths
                .as_ref()
                .map(|paths| paths.spool.to_string_lossy().into_owned()),
            database_path: config.database_path.to_string_lossy().into_owned(),
            poll_interval_ms: duration_ms_u64(config.poll_interval),
            pending_segments: 0,
            rejected_segments: 0,
            open_bursts: 0,
            pending_bursts: 0,
            last_imported_at_ms: None,
            last_published_at_ms: None,
            warnings: Vec::new(),
            last_error: None,
        };
        let inner = Arc::new(VscodeEditBridgeInner {
            config,
            store,
            paths,
            event_journal,
            status: Mutex::new(status),
            cancellation: CancellationToken::new(),
            task: Mutex::new(None),
        });
        if enabled {
            let task = tokio::spawn(run_vscode_edit_bridge(inner.clone()));
            *inner.task.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
        }
        Ok(Self { inner })
    }

    pub fn status(&self) -> VscodeEditBridgeStatus {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn database_path(&self) -> &Path {
        &self.inner.config.database_path
    }

    pub async fn shutdown(&self) {
        self.inner.cancellation.cancel();
        let task = self
            .inner
            .task
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(task) = task {
            let _ = task.await;
        }
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .state = VscodeEditBridgeState::Stopped;
    }
}

async fn run_vscode_edit_bridge(inner: Arc<VscodeEditBridgeInner>) {
    let mut ticker = interval(inner.config.poll_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = inner.cancellation.cancelled() => break,
            _ = ticker.tick() => {
                run_bridge_cycle(&inner);
            }
        }
    }
}

fn run_bridge_cycle(inner: &VscodeEditBridgeInner) {
    let Some(store) = inner.store.as_ref() else {
        return;
    };
    let Some(paths) = inner.paths.as_ref() else {
        return;
    };
    let now = now_ms();
    let mut first_error = None;
    if let Err(error) = store.process_spool(paths, now) {
        first_error = Some(error.to_string());
    }
    if let Err(error) = store.seal_due(now) {
        first_error.get_or_insert_with(|| error.to_string());
    }
    if let Err(error) = store.flush_outbox(&inner.event_journal, now) {
        first_error.get_or_insert_with(|| error.to_string());
    }
    let snapshot = store.status_snapshot(paths).unwrap_or_else(|error| {
        first_error.get_or_insert_with(|| error.to_string());
        StoreStatusSnapshot::default()
    });
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    status.pending_segments = snapshot.pending_segments;
    status.rejected_segments = snapshot.rejected_segments;
    status.open_bursts = snapshot.open_bursts;
    status.pending_bursts = snapshot.pending_bursts;
    status.last_imported_at_ms = snapshot.last_imported_at_ms;
    status.last_published_at_ms = snapshot.last_published_at_ms;
    status.warnings = if snapshot.rejected_segments > 0 {
        vec![
            "One or more claimed VS Code segments are quarantined; remove each quarantined file and republish corrected data to clear the warning."
                .to_owned(),
        ]
    } else {
        Vec::new()
    };
    if first_error.is_none() && snapshot.rejected_segments > 0 {
        first_error = snapshot.last_rejection_error;
    }
    status.last_error = first_error;
    status.state = if status.last_error.is_some() || snapshot.rejected_segments > 0 {
        VscodeEditBridgeState::Degraded
    } else {
        VscodeEditBridgeState::Running
    };
}

#[derive(Clone, Debug)]
struct BridgePaths {
    root: PathBuf,
    spool: PathBuf,
}

impl BridgePaths {
    fn prepare(configured_root: &Path) -> Result<Self, VscodeEditBridgeError> {
        validate_configured_bridge_root(configured_root)?;
        if !configured_root.exists() {
            fs::create_dir_all(configured_root)?;
            harden_directory_permissions(configured_root)?;
        }
        reject_symlink_or_non_directory(configured_root, "bridge root")?;
        let root = fs::canonicalize(configured_root)?;
        let configured_spool = root.join(SPOOL_DIRECTORY_NAME);
        if !configured_spool.exists() {
            fs::create_dir(&configured_spool)?;
        }
        reject_symlink_or_non_directory(&configured_spool, "VS Code spool directory")?;
        harden_directory_permissions(&configured_spool)?;
        let spool = fs::canonicalize(&configured_spool)?;
        if spool.parent() != Some(root.as_path()) {
            return Err(VscodeEditBridgeError::Configuration(
                "VS Code spool must be a direct child of the canonical bridge root".to_owned(),
            ));
        }
        Ok(Self { root, spool })
    }

    fn verify_unchanged(&self) -> Result<(), VscodeEditBridgeError> {
        reject_symlink_or_non_directory(&self.root, "bridge root")?;
        reject_symlink_or_non_directory(&self.spool, "VS Code spool directory")?;
        if fs::canonicalize(&self.root)? != self.root
            || fs::canonicalize(&self.spool)? != self.spool
            || self.spool.parent() != Some(self.root.as_path())
        {
            return Err(VscodeEditBridgeError::Configuration(
                "VS Code bridge path target changed after startup".to_owned(),
            ));
        }
        Ok(())
    }
}

fn validate_configured_bridge_root(path: &Path) -> Result<(), VscodeEditBridgeError> {
    if !path.is_absolute() {
        return Err(VscodeEditBridgeError::Configuration(format!(
            "{BRIDGE_DIRECTORY_ENVIRONMENT_VARIABLE} must be an absolute path"
        )));
    }
    let Some(text) = path.to_str() else {
        return Err(VscodeEditBridgeError::Configuration(format!(
            "{BRIDGE_DIRECTORY_ENVIRONMENT_VARIABLE} must be valid UTF-8"
        )));
    };
    if text.is_empty() || text.contains('\0') {
        return Err(VscodeEditBridgeError::Configuration(format!(
            "{BRIDGE_DIRECTORY_ENVIRONMENT_VARIABLE} must not be empty or contain NUL"
        )));
    }
    if path.parent().is_none()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(VscodeEditBridgeError::Configuration(format!(
            "{BRIDGE_DIRECTORY_ENVIRONMENT_VARIABLE} must not be a filesystem root or contain '..'"
        )));
    }
    Ok(())
}

fn reject_symlink_or_non_directory(path: &Path, label: &str) -> Result<(), VscodeEditBridgeError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(VscodeEditBridgeError::Configuration(format!(
            "{label} must be a real local directory, not a symlink"
        )));
    }
    Ok(())
}

#[derive(Clone)]
struct VscodeEditStore {
    path: PathBuf,
}

#[derive(Default)]
struct StoreStatusSnapshot {
    pending_segments: usize,
    rejected_segments: usize,
    open_bursts: usize,
    pending_bursts: usize,
    last_imported_at_ms: Option<i64>,
    last_published_at_ms: Option<i64>,
    last_rejection_error: Option<String>,
}

impl VscodeEditStore {
    fn open(path: &Path) -> Result<Self, VscodeEditBridgeError> {
        let parent = path.parent().ok_or_else(|| {
            VscodeEditBridgeError::Configuration(
                "VS Code edit database must have a parent directory".to_owned(),
            )
        })?;
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
        reject_symlink_or_non_directory(parent, "VS Code edit state directory")?;
        harden_directory_permissions(parent)?;
        if path.exists() {
            let metadata = fs::symlink_metadata(path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(VscodeEditBridgeError::Configuration(
                    "VS Code edit database must be a regular file, not a symlink".to_owned(),
                ));
            }
        }
        let store = Self {
            path: path.to_path_buf(),
        };
        let mut connection = store.connect()?;
        store.initialize(&mut connection)?;
        Ok(store)
    }

    fn process_spool(
        &self,
        paths: &BridgePaths,
        imported_at_ms: i64,
    ) -> Result<(), VscodeEditBridgeError> {
        paths.verify_unchanged()?;
        let mut candidates = scan_segment_candidates(&paths.spool)?;
        let claimed_names = candidates
            .iter()
            .filter(|candidate| candidate.claimed)
            .map(|candidate| candidate.file_name.clone())
            .collect::<HashSet<_>>();
        self.clear_missing_segment_records(&claimed_names)?;
        candidates.sort_by(|left, right| {
            left.original_name
                .cmp(&right.original_name)
                .then_with(|| right.claimed.cmp(&left.claimed))
        });

        for candidate in candidates {
            let state = self.segment_state(&candidate.original_name)?;
            if state.as_deref() == Some("rejected") {
                // Keep the claimed file as an explicit quarantine artifact,
                // but do not let one bad/late segment stall newer independent
                // work. Removing the claimed file clears the durable rejection
                // record on the next scan, after which a corrected segment can
                // be published under its content-derived filename.
                continue;
            }
            let claimed_path = if candidate.claimed {
                candidate.path
            } else {
                let claimed_name = format!("{CLAIMED_PREFIX}{}", candidate.original_name);
                let claimed_path = paths.spool.join(&claimed_name);
                match fs::rename(&candidate.path, &claimed_path) {
                    Ok(()) => claimed_path,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                }
            };
            let claimed_name = claimed_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| {
                    VscodeEditBridgeError::InvalidSegment(
                        "claimed filename is not valid UTF-8".to_owned(),
                    )
                })?
                .to_owned();

            if state.as_deref() == Some("imported") {
                remove_imported_claim(self, &candidate.original_name, &claimed_path)?;
                continue;
            }

            let records = match read_and_validate_segment(&claimed_path, &candidate.original_name) {
                Ok(records) => records,
                Err(error) if error.is_invalid_segment() => {
                    self.mark_rejected(
                        &candidate.original_name,
                        &claimed_name,
                        &error.to_string(),
                        imported_at_ms,
                    )?;
                    continue;
                }
                Err(error) => return Err(error),
            };
            match self.ingest_segment(
                &candidate.original_name,
                &claimed_name,
                &records,
                imported_at_ms,
            ) {
                Ok(()) => {
                    remove_imported_claim(self, &candidate.original_name, &claimed_path)?;
                }
                Err(error) if error.is_invalid_segment() => {
                    self.mark_rejected(
                        &candidate.original_name,
                        &claimed_name,
                        &error.to_string(),
                        imported_at_ms,
                    )?;
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn ingest_segment(
        &self,
        segment_name: &str,
        claimed_name: &str,
        records: &[ValidatedRecord],
        imported_at_ms: i64,
    ) -> Result<(), VscodeEditBridgeError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if transaction
            .query_row(
                "SELECT state FROM segments WHERE segment_name = ?1",
                [segment_name],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .as_deref()
            == Some("imported")
        {
            transaction.commit()?;
            return Ok(());
        }

        let last_occurred = read_meta_i64(&transaction, LAST_OCCURRED_META_KEY)?;
        let mut new_records = Vec::new();
        for record in records {
            let existing_hash = transaction
                .query_row(
                    "SELECT record_hash FROM source_event_dedup
                     WHERE event_id = ?1",
                    [&record.event.event_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            match existing_hash {
                Some(existing_hash) if existing_hash != record.record_hash => {
                    return Err(VscodeEditBridgeError::InvalidSegment(
                        "an eventId was reused for different content".to_owned(),
                    ));
                }
                Some(_) => {}
                None => new_records.push(record),
            }
        }
        for record in new_records.iter().copied() {
            if record.event.occurred_at_ms > imported_at_ms.saturating_add(MAX_FUTURE_EVENT_SKEW_MS)
            {
                return Err(VscodeEditBridgeError::InvalidSegment(format!(
                    "event {} is more than {MAX_FUTURE_EVENT_SKEW_MS}ms in the future",
                    record.event.event_id
                )));
            }
            transaction.execute(
                "INSERT INTO source_event_dedup (
                    event_id, record_hash, occurred_at_ms, first_seen_at_ms
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    record.event.event_id,
                    record.record_hash,
                    record.event.occurred_at_ms,
                    imported_at_ms,
                ],
            )?;
            transaction.execute(
                "INSERT INTO source_events (event_id, record_json)
                 VALUES (?1, ?2)",
                params![record.event.event_id, record.canonical_json],
            )?;
            seal_due_in_transaction(&transaction, record.event.occurred_at_ms)?;
            reject_event_older_than_document_seal(&transaction, &record.event)?;
            apply_event_to_burst(&transaction, &record.event)?;
            transaction.execute(
                "DELETE FROM source_events WHERE event_id = ?1",
                [&record.event.event_id],
            )?;
        }
        if let Some(last_new) = new_records.last() {
            write_meta_i64(
                &transaction,
                LAST_OCCURRED_META_KEY,
                last_occurred
                    .unwrap_or_default()
                    .max(last_new.event.occurred_at_ms),
            )?;
        }
        gc_source_event_dedup(
            &transaction,
            imported_at_ms,
            SOURCE_DEDUP_RETENTION_MS,
            MAX_SOURCE_DEDUP_ROWS,
        )?;
        write_meta_i64(&transaction, LAST_IMPORTED_META_KEY, imported_at_ms)?;
        transaction.execute(
            "INSERT INTO segments (
                segment_name, claimed_name, state, error, updated_at_ms
             ) VALUES (?1, ?2, 'imported', NULL, ?3)
             ON CONFLICT(segment_name) DO UPDATE SET
                claimed_name = excluded.claimed_name,
                state = 'imported',
                error = NULL,
                updated_at_ms = excluded.updated_at_ms",
            params![segment_name, claimed_name, imported_at_ms],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn seal_due(&self, at_ms: i64) -> Result<(), VscodeEditBridgeError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        seal_due_in_transaction(&transaction, at_ms)?;
        transaction.commit()?;
        Ok(())
    }

    fn flush_outbox(
        &self,
        event_journal: &EventJournal,
        published_at_ms: i64,
    ) -> Result<(), VscodeEditBridgeError> {
        loop {
            let connection = self.connect()?;
            let pending = connection
                .query_row(
                    "SELECT burst_id, occurred_at_ms, observed_at_ms,
                            sensitivity, deduplication_key, payload_json
                     FROM burst_outbox
                     ORDER BY id
                     LIMIT 1",
                    [],
                    |row| {
                        Ok(PendingBurst {
                            burst_id: row.get(0)?,
                            occurred_at_ms: row.get(1)?,
                            observed_at_ms: row.get(2)?,
                            sensitivity: row.get(3)?,
                            deduplication_key: row.get(4)?,
                            payload_json: row.get(5)?,
                        })
                    },
                )
                .optional()?;
            let Some(pending) = pending else {
                return Ok(());
            };
            let sensitivity = match pending.sensitivity.as_str() {
                "metadata" => DesktopEventSensitivity::Metadata,
                "content" => DesktopEventSensitivity::Content,
                _ => {
                    return Err(VscodeEditBridgeError::Configuration(
                        "burst outbox contains an invalid sensitivity".to_owned(),
                    ));
                }
            };
            let payload = serde_json::from_str::<JsonValue>(&pending.payload_json)?;
            event_journal.append(DesktopEventDraft {
                kind: desktop_event_kinds::EDITOR_DOCUMENT_CHANGED.to_owned(),
                source: RECORD_SOURCE.to_owned(),
                occurred_at_ms: pending.occurred_at_ms,
                observed_at_ms: pending.observed_at_ms,
                goal_version: None,
                sensitivity,
                payload,
                deduplication_key: pending.deduplication_key,
            })?;
            let mut connection = self.connect()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute(
                "DELETE FROM burst_outbox WHERE burst_id = ?1",
                [&pending.burst_id],
            )?;
            write_meta_i64(&transaction, LAST_PUBLISHED_META_KEY, published_at_ms)?;
            transaction.commit()?;
        }
    }

    fn status_snapshot(
        &self,
        paths: &BridgePaths,
    ) -> Result<StoreStatusSnapshot, VscodeEditBridgeError> {
        paths.verify_unchanged()?;
        let connection = self.connect()?;
        let rejected_segments = count_table_where(
            &connection,
            "SELECT COUNT(*) FROM segments WHERE state = 'rejected'",
        )?;
        let open_bursts = count_table_where(&connection, "SELECT COUNT(*) FROM open_bursts")?;
        let pending_bursts = count_table_where(&connection, "SELECT COUNT(*) FROM burst_outbox")?;
        let last_rejection_error = connection
            .query_row(
                "SELECT error FROM segments
                 WHERE state = 'rejected'
                 ORDER BY updated_at_ms
                 LIMIT 1",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(StoreStatusSnapshot {
            pending_segments: scan_segment_candidates(&paths.spool)?.len(),
            rejected_segments,
            open_bursts,
            pending_bursts,
            last_imported_at_ms: read_meta_i64(&connection, LAST_IMPORTED_META_KEY)?,
            last_published_at_ms: read_meta_i64(&connection, LAST_PUBLISHED_META_KEY)?,
            last_rejection_error,
        })
    }

    fn mark_rejected(
        &self,
        segment_name: &str,
        claimed_name: &str,
        error: &str,
        rejected_at_ms: i64,
    ) -> Result<(), VscodeEditBridgeError> {
        let connection = self.connect()?;
        let bounded_error: String = error.chars().take(512).collect();
        connection.execute(
            "INSERT INTO segments (
                segment_name, claimed_name, state, error, updated_at_ms
             ) VALUES (?1, ?2, 'rejected', ?3, ?4)
             ON CONFLICT(segment_name) DO UPDATE SET
                claimed_name = excluded.claimed_name,
                state = 'rejected',
                error = excluded.error,
                updated_at_ms = excluded.updated_at_ms",
            params![segment_name, claimed_name, bounded_error, rejected_at_ms],
        )?;
        Ok(())
    }

    fn clear_missing_segment_records(
        &self,
        claimed_names: &HashSet<String>,
    ) -> Result<(), VscodeEditBridgeError> {
        let connection = self.connect()?;
        let mut statement =
            connection.prepare("SELECT segment_name, claimed_name FROM segments")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let missing = rows
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|(_, claimed_name)| !claimed_names.contains(claimed_name))
            .map(|(segment_name, _)| segment_name)
            .collect::<Vec<_>>();
        drop(statement);
        for segment_name in missing {
            connection.execute(
                "DELETE FROM segments WHERE segment_name = ?1",
                [segment_name],
            )?;
        }
        Ok(())
    }

    fn segment_state(&self, segment_name: &str) -> Result<Option<String>, VscodeEditBridgeError> {
        let connection = self.connect()?;
        Ok(connection
            .query_row(
                "SELECT state FROM segments WHERE segment_name = ?1",
                [segment_name],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn delete_segment_record(&self, segment_name: &str) -> Result<(), VscodeEditBridgeError> {
        let connection = self.connect()?;
        connection.execute(
            "DELETE FROM segments
             WHERE segment_name = ?1 AND state = 'imported'",
            [segment_name],
        )?;
        Ok(())
    }

    fn initialize(&self, connection: &mut Connection) -> Result<(), VscodeEditBridgeError> {
        let current_version =
            connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
        if current_version > SCHEMA_VERSION {
            return Err(VscodeEditBridgeError::Configuration(format!(
                "VS Code edit database schema {current_version} is newer than supported {SCHEMA_VERSION}"
            )));
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if current_version < 1 {
            // IF NOT EXISTS also makes this recover a database created by the
            // old non-transactional v1 initializer that stopped between DDL
            // statements while user_version was still zero.
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS bridge_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS segments (
                    segment_name TEXT PRIMARY KEY,
                    claimed_name TEXT NOT NULL,
                    state TEXT NOT NULL
                        CHECK (state IN ('imported', 'rejected')),
                    error TEXT,
                    updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS source_event_dedup (
                    event_id TEXT PRIMARY KEY,
                    record_hash TEXT NOT NULL,
                    occurred_at_ms INTEGER NOT NULL,
                    first_seen_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS source_events (
                    event_id TEXT PRIMARY KEY
                        REFERENCES source_event_dedup(event_id),
                    record_json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS open_bursts (
                    document_key TEXT PRIMARY KEY,
                    editor_id TEXT NOT NULL,
                    document_id TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    language TEXT NOT NULL,
                    sensitivity TEXT NOT NULL
                        CHECK (sensitivity IN ('metadata', 'content')),
                    started_at_ms INTEGER NOT NULL,
                    last_changed_at_ms INTEGER NOT NULL,
                    latest_observed_at_ms INTEGER NOT NULL,
                    inserted_chars INTEGER NOT NULL,
                    deleted_chars INTEGER NOT NULL,
                    text TEXT,
                    source_ids_json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS burst_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    burst_id TEXT NOT NULL UNIQUE,
                    occurred_at_ms INTEGER NOT NULL,
                    observed_at_ms INTEGER NOT NULL,
                    sensitivity TEXT NOT NULL
                        CHECK (sensitivity IN ('metadata', 'content')),
                    deduplication_key TEXT NOT NULL UNIQUE,
                    payload_json TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS burst_outbox_order ON burst_outbox(id);",
            )?;
        }
        if current_version < 2 {
            if !table_has_column(&transaction, "open_bursts", "components_json")? {
                transaction.execute_batch(
                    "ALTER TABLE open_bursts
                     ADD COLUMN components_json TEXT NOT NULL DEFAULT '[]';",
                )?;
            }
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS document_seal_state (
                    document_key TEXT PRIMARY KEY,
                    sealed_through_ms INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS source_event_dedup_first_seen
                    ON source_event_dedup(first_seen_at_ms, event_id);",
            )?;
            migrate_open_burst_components(&transaction)?;
        }
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
        Ok(())
    }

    fn connect(&self) -> Result<Connection, VscodeEditBridgeError> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;",
        )?;
        harden_sqlite_permissions(&self.path)?;
        Ok(connection)
    }
}

fn table_has_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, VscodeEditBridgeError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn migrate_open_burst_components(
    transaction: &Transaction<'_>,
) -> Result<(), VscodeEditBridgeError> {
    let mut statement = transaction.prepare(
        "SELECT document_key, relative_path, language, sensitivity,
                started_at_ms, last_changed_at_ms, latest_observed_at_ms,
                inserted_chars, deleted_chars, text, source_ids_json
         FROM open_bursts
         WHERE components_json = '[]'
         ORDER BY document_key",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, String>(10)?,
        ))
    })?;
    let pending = rows.collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    for (
        document_key,
        relative_path,
        language,
        sensitivity,
        started_at_ms,
        last_changed_at_ms,
        latest_observed_at_ms,
        inserted_chars,
        deleted_chars,
        text,
        source_ids_json,
    ) in pending
    {
        let source_ids = serde_json::from_str::<Vec<String>>(&source_ids_json)?;
        let source_sensitivity = SourceSensitivity::from_str(&sensitivity)?;
        let first_id = source_ids
            .first()
            .map(String::as_str)
            .unwrap_or(document_key.as_str());
        let mut components = vec![BurstComponent {
            event_id: format!("migration-start:{first_id}"),
            occurred_at_ms: started_at_ms,
            observed_at_ms: started_at_ms,
            sensitivity: source_sensitivity,
            relative_path: relative_path.clone(),
            language: language.clone(),
            inserted_chars,
            deleted_chars,
            text,
        }];
        if last_changed_at_ms != started_at_ms {
            components.push(BurstComponent {
                event_id: format!("migration-end:{document_key}"),
                occurred_at_ms: last_changed_at_ms,
                observed_at_ms: latest_observed_at_ms.max(last_changed_at_ms),
                sensitivity: SourceSensitivity::Metadata,
                relative_path,
                language,
                inserted_chars: 0,
                deleted_chars: 0,
                text: None,
            });
        } else {
            components[0].observed_at_ms = latest_observed_at_ms.max(started_at_ms);
        }
        transaction.execute(
            "UPDATE open_bursts
             SET components_json = ?2
             WHERE document_key = ?1",
            params![document_key, serde_json::to_string(&components)?],
        )?;
    }
    Ok(())
}

fn remove_imported_claim(
    store: &VscodeEditStore,
    original_name: &str,
    claimed_path: &Path,
) -> Result<(), VscodeEditBridgeError> {
    match fs::remove_file(claimed_path) {
        Ok(()) => store.delete_segment_record(original_name),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            store.delete_segment_record(original_name)
        }
        Err(error) => Err(error.into()),
    }
}

#[derive(Clone, Debug)]
struct SegmentCandidate {
    original_name: String,
    file_name: String,
    path: PathBuf,
    claimed: bool,
}

fn scan_segment_candidates(spool: &Path) -> Result<Vec<SegmentCandidate>, VscodeEditBridgeError> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(spool)? {
        let entry = entry?;
        let file_name = match entry.file_name().into_string() {
            Ok(file_name) => file_name,
            Err(_) => continue,
        };
        let (original_name, claimed) = if is_sealed_segment_name(&file_name) {
            (file_name.clone(), false)
        } else if let Some(original) = claimed_original_name(&file_name) {
            (original.to_owned(), true)
        } else {
            continue;
        };
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_file() {
            return Err(VscodeEditBridgeError::Configuration(format!(
                "matching VS Code segment {file_name} is not a regular file"
            )));
        }
        candidates.push(SegmentCandidate {
            original_name,
            file_name,
            path: entry.path(),
            claimed,
        });
    }
    Ok(candidates)
}

fn is_sealed_segment_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("segment-") else {
        return false;
    };
    let Some((timestamp, digest_with_suffix)) = rest.split_once('-') else {
        return false;
    };
    let Some(digest) = digest_with_suffix.strip_suffix(".jsonl") else {
        return false;
    };
    timestamp.len() == 13
        && timestamp.bytes().all(|byte| byte.is_ascii_digit())
        && digest.len() == 32
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn claimed_original_name(name: &str) -> Option<&str> {
    let original = name.strip_prefix(CLAIMED_PREFIX)?;
    is_sealed_segment_name(original).then_some(original)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VscodeEditEventV1 {
    schema_version: String,
    event_id: String,
    kind: String,
    source: String,
    occurred_at_ms: u64,
    observed_at_ms: u64,
    sensitivity: SourceSensitivity,
    payload: VscodeEditPayloadV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SourceSensitivity {
    Metadata,
    Content,
}

impl SourceSensitivity {
    fn from_str(value: &str) -> Result<Self, VscodeEditBridgeError> {
        match value {
            "metadata" => Ok(Self::Metadata),
            "content" => Ok(Self::Content),
            _ => Err(VscodeEditBridgeError::Configuration(
                "open edit burst contains an invalid sensitivity".to_owned(),
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VscodeEditPayloadV1 {
    workspace_id: String,
    document: VscodeDocumentV1,
    change_count: u64,
    emitted_change_count: u64,
    changes_truncated: bool,
    changes: Vec<VscodeChangeV1>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VscodeDocumentV1 {
    relative_path: String,
    language_id: String,
    version: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VscodeChangeV1 {
    range_offset: u64,
    deleted_chars: u64,
    inserted_chars: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inserted_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inserted_text_truncated: Option<bool>,
}

#[derive(Clone, Debug)]
struct NormalizedEditEvent {
    event_id: String,
    occurred_at_ms: i64,
    observed_at_ms: i64,
    sensitivity: SourceSensitivity,
    workspace_id: String,
    relative_path: String,
    language: String,
    inserted_chars: i64,
    deleted_chars: i64,
    text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BurstComponent {
    event_id: String,
    occurred_at_ms: i64,
    observed_at_ms: i64,
    sensitivity: SourceSensitivity,
    relative_path: String,
    language: String,
    inserted_chars: i64,
    deleted_chars: i64,
    text: Option<String>,
}

impl From<&NormalizedEditEvent> for BurstComponent {
    fn from(event: &NormalizedEditEvent) -> Self {
        Self {
            event_id: event.event_id.clone(),
            occurred_at_ms: event.occurred_at_ms,
            observed_at_ms: event.observed_at_ms,
            sensitivity: event.sensitivity,
            relative_path: event.relative_path.clone(),
            language: event.language.clone(),
            inserted_chars: event.inserted_chars,
            deleted_chars: event.deleted_chars,
            text: event.text.clone(),
        }
    }
}

#[derive(Clone, Debug)]
struct ValidatedRecord {
    event: NormalizedEditEvent,
    canonical_json: String,
    record_hash: String,
}

fn read_and_validate_segment(
    path: &Path,
    original_name: &str,
) -> Result<Vec<ValidatedRecord>, VscodeEditBridgeError> {
    let path_metadata = fs::symlink_metadata(path)?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "claimed segment is not a regular file".to_owned(),
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return VscodeEditBridgeError::InvalidSegment(
                "claimed segment became a symlink while it was being opened".to_owned(),
            );
        }
        VscodeEditBridgeError::Io(error)
    })?;
    // Validate and size the opened inode, not only the directory entry that
    // was inspected before open. O_NOFOLLOW closes the final-component
    // lstat/open race on the macOS-first production path.
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "claimed segment is not a regular file".to_owned(),
        ));
    }
    if metadata.len() > MAX_SEGMENT_BYTES {
        return Err(VscodeEditBridgeError::InvalidSegment(format!(
            "segment exceeds {MAX_SEGMENT_BYTES} bytes"
        )));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
    file.take(MAX_SEGMENT_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SEGMENT_BYTES {
        return Err(VscodeEditBridgeError::InvalidSegment(format!(
            "segment exceeds {MAX_SEGMENT_BYTES} bytes"
        )));
    }
    let text = str::from_utf8(&bytes).map_err(|_| {
        VscodeEditBridgeError::InvalidSegment("segment is not valid UTF-8".to_owned())
    })?;
    let mut records = Vec::new();
    let mut event_ids = HashSet::new();
    let lines = text.split('\n').collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        if line.is_empty() && index + 1 == lines.len() {
            continue;
        }
        if line.is_empty() {
            return Err(VscodeEditBridgeError::InvalidSegment(
                "segment contains an empty JSONL record".to_owned(),
            ));
        }
        let framed_bytes = line.len() + usize::from(index + 1 < lines.len());
        if framed_bytes > MAX_EVENT_LINE_BYTES {
            return Err(VscodeEditBridgeError::InvalidSegment(format!(
                "record exceeds {MAX_EVENT_LINE_BYTES} bytes"
            )));
        }
        let source_event = serde_json::from_str::<VscodeEditEventV1>(line).map_err(|_| {
            VscodeEditBridgeError::InvalidSegment("record is not valid strict v1 JSON".to_owned())
        })?;
        validate_source_event(&source_event)?;
        if !event_ids.insert(source_event.event_id.clone()) {
            return Err(VscodeEditBridgeError::InvalidSegment(
                "segment contains a duplicate eventId".to_owned(),
            ));
        }
        let canonical_json = serde_json::to_string(&source_event)?;
        let record_hash = hash_hex32(canonical_json.as_bytes());
        records.push(ValidatedRecord {
            event: normalize_source_event(source_event)?,
            canonical_json,
            record_hash,
        });
    }
    if records.is_empty() {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "segment contains no records".to_owned(),
        ));
    }
    if records.len() > MAX_EVENTS_PER_SEGMENT {
        return Err(VscodeEditBridgeError::InvalidSegment(format!(
            "segment contains more than {MAX_EVENTS_PER_SEGMENT} records"
        )));
    }
    validate_segment_filename(original_name, &bytes, &records)?;
    records.sort_by(|left, right| {
        left.event
            .occurred_at_ms
            .cmp(&right.event.occurred_at_ms)
            .then_with(|| left.event.event_id.cmp(&right.event.event_id))
    });
    Ok(records)
}

fn validate_segment_filename(
    original_name: &str,
    bytes: &[u8],
    records: &[ValidatedRecord],
) -> Result<(), VscodeEditBridgeError> {
    let rest = original_name
        .strip_prefix("segment-")
        .and_then(|rest| rest.strip_suffix(".jsonl"))
        .ok_or_else(|| {
            VscodeEditBridgeError::InvalidSegment(
                "segment filename does not match the protocol".to_owned(),
            )
        })?;
    let (timestamp, digest) = rest.split_once('-').ok_or_else(|| {
        VscodeEditBridgeError::InvalidSegment(
            "segment filename does not match the protocol".to_owned(),
        )
    })?;
    let filename_timestamp = timestamp.parse::<i64>().map_err(|_| {
        VscodeEditBridgeError::InvalidSegment("segment filename timestamp is invalid".to_owned())
    })?;
    let first_timestamp = records
        .iter()
        .map(|record| record.event.occurred_at_ms)
        .min()
        .ok_or_else(|| {
            VscodeEditBridgeError::InvalidSegment("segment contains no records".to_owned())
        })?;
    if filename_timestamp != first_timestamp {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "segment filename timestamp does not match its first event".to_owned(),
        ));
    }
    if digest != hash_hex32(bytes) {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "segment filename digest does not match its contents".to_owned(),
        ));
    }
    Ok(())
}

fn validate_source_event(event: &VscodeEditEventV1) -> Result<(), VscodeEditBridgeError> {
    if event.schema_version != RECORD_SCHEMA_VERSION
        || event.kind != RECORD_KIND
        || event.source != RECORD_SOURCE
    {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "record schema, kind, or source is not the supported v1 contract".to_owned(),
        ));
    }
    if !has_identifier_shape(&event.event_id, "vse1_")
        || !has_identifier_shape(&event.payload.workspace_id, "wsp1_")
    {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "record eventId or workspaceId has an invalid shape".to_owned(),
        ));
    }
    validate_safe_integer(event.occurred_at_ms, "occurredAtMs")?;
    validate_safe_integer(event.observed_at_ms, "observedAtMs")?;
    if event.observed_at_ms < event.occurred_at_ms {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "observedAtMs must not precede occurredAtMs".to_owned(),
        ));
    }
    validate_safe_integer(event.payload.document.version, "document.version")?;
    validate_safe_integer(event.payload.change_count, "changeCount")?;
    validate_safe_integer(event.payload.emitted_change_count, "emittedChangeCount")?;
    validate_relative_path(&event.payload.document.relative_path)?;
    let language_chars = event.payload.document.language_id.chars().count();
    if !(1..=MAX_LANGUAGE_CHARS).contains(&language_chars) {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "document.languageId is outside the v1 length bound".to_owned(),
        ));
    }
    if event.payload.changes.len() > MAX_EVENTS_PER_SEGMENT
        || event.payload.emitted_change_count != event.payload.changes.len() as u64
        || event.payload.emitted_change_count > event.payload.change_count
        || event.payload.changes_truncated
            != (event.payload.change_count > event.payload.emitted_change_count)
    {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "change counts are inconsistent with the v1 payload".to_owned(),
        ));
    }
    let mut inserted_text_bytes = 0usize;
    for change in &event.payload.changes {
        validate_safe_integer(change.range_offset, "change.rangeOffset")?;
        validate_safe_integer(change.deleted_chars, "change.deletedChars")?;
        validate_safe_integer(change.inserted_chars, "change.insertedChars")?;
        if event.sensitivity == SourceSensitivity::Metadata
            && (change.inserted_text.is_some() || change.inserted_text_truncated.is_some())
        {
            return Err(VscodeEditBridgeError::InvalidSegment(
                "metadata records must not contain inserted text fields".to_owned(),
            ));
        }
        if let Some(text) = change.inserted_text.as_deref() {
            if text.chars().count() > MAX_INSERTED_TEXT_CHARS {
                return Err(VscodeEditBridgeError::InvalidSegment(
                    "insertedText exceeds the v1 length bound".to_owned(),
                ));
            }
            inserted_text_bytes = inserted_text_bytes.saturating_add(text.len());
        }
    }
    if inserted_text_bytes > MAX_INSERTED_TEXT_BYTES_PER_EVENT {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "record exceeds the inserted-text byte budget".to_owned(),
        ));
    }
    Ok(())
}

fn normalize_source_event(
    event: VscodeEditEventV1,
) -> Result<NormalizedEditEvent, VscodeEditBridgeError> {
    let mut inserted_chars = 0u64;
    let mut deleted_chars = 0u64;
    let mut text = None;
    for change in event.payload.changes {
        inserted_chars = checked_safe_sum(inserted_chars, change.inserted_chars)?;
        deleted_chars = checked_safe_sum(deleted_chars, change.deleted_chars)?;
        if event.sensitivity == SourceSensitivity::Content {
            text = append_bounded_text(
                text.as_deref(),
                change.inserted_text.as_deref(),
                MAX_BURST_TEXT_CHARS,
            );
        }
    }
    Ok(NormalizedEditEvent {
        event_id: event.event_id,
        occurred_at_ms: i64::try_from(event.occurred_at_ms).map_err(|_| {
            VscodeEditBridgeError::InvalidSegment(
                "occurredAtMs does not fit the local timestamp type".to_owned(),
            )
        })?,
        observed_at_ms: i64::try_from(event.observed_at_ms).map_err(|_| {
            VscodeEditBridgeError::InvalidSegment(
                "observedAtMs does not fit the local timestamp type".to_owned(),
            )
        })?,
        sensitivity: event.sensitivity,
        workspace_id: event.payload.workspace_id,
        relative_path: event.payload.document.relative_path,
        language: event.payload.document.language_id,
        inserted_chars: i64::try_from(inserted_chars).map_err(|_| {
            VscodeEditBridgeError::InvalidSegment(
                "inserted character count is too large".to_owned(),
            )
        })?,
        deleted_chars: i64::try_from(deleted_chars).map_err(|_| {
            VscodeEditBridgeError::InvalidSegment("deleted character count is too large".to_owned())
        })?,
        text,
    })
}

fn reject_event_older_than_document_seal(
    transaction: &Transaction<'_>,
    event: &NormalizedEditEvent,
) -> Result<(), VscodeEditBridgeError> {
    let document_key = stable_identifier("document-key", &event.workspace_id, &event.relative_path);
    let sealed_through_ms = transaction
        .query_row(
            "SELECT sealed_through_ms
             FROM document_seal_state
             WHERE document_key = ?1",
            [&document_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if sealed_through_ms.is_some_and(|sealed_through_ms| event.occurred_at_ms < sealed_through_ms) {
        return Err(VscodeEditBridgeError::InvalidSegment(format!(
            "event {} at {}ms would rewrite an already sealed burst for {}; \
             remove the quarantined claimed segment and republish corrected data",
            event.event_id, event.occurred_at_ms, event.relative_path
        )));
    }
    Ok(())
}

fn gc_source_event_dedup(
    transaction: &Transaction<'_>,
    imported_at_ms: i64,
    retention_ms: i64,
    maximum_rows: usize,
) -> Result<(), VscodeEditBridgeError> {
    let retention_cutoff = imported_at_ms.saturating_sub(retention_ms);
    transaction.execute(
        "DELETE FROM source_event_dedup
         WHERE first_seen_at_ms < ?1
           AND NOT EXISTS (
               SELECT 1 FROM source_events
               WHERE source_events.event_id = source_event_dedup.event_id
           )",
        [retention_cutoff],
    )?;

    let row_count =
        transaction.query_row("SELECT COUNT(*) FROM source_event_dedup", [], |row| {
            row.get::<_, i64>(0)
        })?;
    let maximum_rows = i64::try_from(maximum_rows).map_err(|_| {
        VscodeEditBridgeError::Configuration(
            "source event deduplication row bound is too large".to_owned(),
        )
    })?;
    let excess = row_count.saturating_sub(maximum_rows);
    if excess > 0 {
        // Never evict identities that could still belong to a live ten-second
        // burst. A temporary overshoot is allowed during that safety horizon;
        // the next ingest deterministically trims the oldest eligible rows.
        let safe_cutoff = imported_at_ms.saturating_sub(EDIT_MAX_BURST_MS + EDIT_SILENCE_MS);
        transaction.execute(
            "DELETE FROM source_event_dedup
             WHERE rowid IN (
                 SELECT dedup.rowid
                 FROM source_event_dedup AS dedup
                 WHERE dedup.first_seen_at_ms < ?1
                   AND NOT EXISTS (
                       SELECT 1 FROM source_events
                       WHERE source_events.event_id = dedup.event_id
                   )
                 ORDER BY dedup.first_seen_at_ms, dedup.event_id
                 LIMIT ?2
             )",
            params![safe_cutoff, excess],
        )?;
    }
    Ok(())
}

fn apply_event_to_burst(
    transaction: &Transaction<'_>,
    event: &NormalizedEditEvent,
) -> Result<(), VscodeEditBridgeError> {
    let document_key = stable_identifier("document-key", &event.workspace_id, &event.relative_path);
    let existing = transaction
        .query_row(
            "SELECT editor_id, document_id, relative_path, language,
                    sensitivity, started_at_ms, last_changed_at_ms,
                    latest_observed_at_ms, inserted_chars, deleted_chars,
                    text, source_ids_json, components_json
             FROM open_bursts
             WHERE document_key = ?1",
            [&document_key],
            |row| {
                Ok(OpenBurst {
                    editor_id: row.get(0)?,
                    document_id: row.get(1)?,
                    relative_path: row.get(2)?,
                    language: row.get(3)?,
                    sensitivity: row.get(4)?,
                    started_at_ms: row.get(5)?,
                    last_changed_at_ms: row.get(6)?,
                    latest_observed_at_ms: row.get(7)?,
                    inserted_chars: row.get(8)?,
                    deleted_chars: row.get(9)?,
                    text: row.get(10)?,
                    source_ids_json: row.get(11)?,
                    components_json: row.get(12)?,
                })
            },
        )
        .optional()?;
    let editor_id = existing
        .as_ref()
        .map(|burst| burst.editor_id.clone())
        .unwrap_or_else(|| stable_identifier("edt1", &event.workspace_id, RECORD_SOURCE));
    let document_id = existing
        .as_ref()
        .map(|burst| burst.document_id.clone())
        .unwrap_or_else(|| stable_identifier("doc1", &event.workspace_id, &event.relative_path));
    let mut components = existing
        .as_ref()
        .map(|burst| serde_json::from_str::<Vec<BurstComponent>>(&burst.components_json))
        .transpose()?
        .unwrap_or_default();
    if existing.is_some() && components.is_empty() {
        return Err(VscodeEditBridgeError::Configuration(
            "open edit burst is missing its deterministic components".to_owned(),
        ));
    }
    components.push(BurstComponent::from(event));
    components.sort_by(|left, right| {
        left.occurred_at_ms
            .cmp(&right.occurred_at_ms)
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    let mut source_ids = existing
        .as_ref()
        .map(|burst| serde_json::from_str::<Vec<String>>(&burst.source_ids_json))
        .transpose()?
        .unwrap_or_default();
    source_ids.push(event.event_id.clone());
    source_ids.sort();
    source_ids.dedup();
    let aggregate = aggregate_burst_components(&components)?;

    transaction.execute(
        "INSERT INTO open_bursts (
            document_key, editor_id, document_id, relative_path, language,
            sensitivity, started_at_ms, last_changed_at_ms,
            latest_observed_at_ms, inserted_chars, deleted_chars, text,
            source_ids_json, components_json
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
         )
         ON CONFLICT(document_key) DO UPDATE SET
            editor_id = excluded.editor_id,
            document_id = excluded.document_id,
            relative_path = excluded.relative_path,
            language = excluded.language,
            sensitivity = excluded.sensitivity,
            started_at_ms = excluded.started_at_ms,
            last_changed_at_ms = excluded.last_changed_at_ms,
            latest_observed_at_ms = excluded.latest_observed_at_ms,
            inserted_chars = excluded.inserted_chars,
            deleted_chars = excluded.deleted_chars,
            text = excluded.text,
            source_ids_json = excluded.source_ids_json,
            components_json = excluded.components_json",
        params![
            document_key,
            editor_id,
            document_id,
            aggregate.relative_path,
            aggregate.language,
            aggregate.sensitivity,
            aggregate.started_at_ms,
            aggregate.last_changed_at_ms,
            aggregate.latest_observed_at_ms,
            aggregate.inserted_chars,
            aggregate.deleted_chars,
            aggregate.text,
            serde_json::to_string(&source_ids)?,
            serde_json::to_string(&components)?,
        ],
    )?;
    Ok(())
}

fn aggregate_burst_components(
    components: &[BurstComponent],
) -> Result<OpenBurstAggregate, VscodeEditBridgeError> {
    let first = components.first().ok_or_else(|| {
        VscodeEditBridgeError::Configuration("open edit burst has no components".to_owned())
    })?;
    let latest = components.last().expect("non-empty components");
    let mut inserted_chars = 0;
    let mut deleted_chars = 0;
    let mut latest_observed_at_ms = 0;
    let mut sensitivity = "metadata";
    let mut text = None;
    for component in components {
        inserted_chars = checked_sql_sum(inserted_chars, component.inserted_chars)?;
        deleted_chars = checked_sql_sum(deleted_chars, component.deleted_chars)?;
        latest_observed_at_ms = latest_observed_at_ms.max(component.observed_at_ms);
        if component.sensitivity == SourceSensitivity::Content {
            sensitivity = "content";
            text = append_bounded_text(
                text.as_deref(),
                component.text.as_deref(),
                MAX_BURST_TEXT_CHARS,
            );
        }
    }
    Ok(OpenBurstAggregate {
        relative_path: latest.relative_path.clone(),
        language: latest.language.clone(),
        sensitivity,
        started_at_ms: first.occurred_at_ms,
        last_changed_at_ms: latest.occurred_at_ms,
        latest_observed_at_ms,
        inserted_chars,
        deleted_chars,
        text,
    })
}

struct OpenBurstAggregate {
    relative_path: String,
    language: String,
    sensitivity: &'static str,
    started_at_ms: i64,
    last_changed_at_ms: i64,
    latest_observed_at_ms: i64,
    inserted_chars: i64,
    deleted_chars: i64,
    text: Option<String>,
}

struct OpenBurst {
    editor_id: String,
    document_id: String,
    relative_path: String,
    language: String,
    sensitivity: String,
    started_at_ms: i64,
    last_changed_at_ms: i64,
    latest_observed_at_ms: i64,
    inserted_chars: i64,
    deleted_chars: i64,
    text: Option<String>,
    source_ids_json: String,
    components_json: String,
}

fn seal_due_in_transaction(
    transaction: &Transaction<'_>,
    at_ms: i64,
) -> Result<(), VscodeEditBridgeError> {
    let mut statement = transaction.prepare(
        "SELECT document_key, editor_id, document_id, relative_path, language,
                sensitivity, started_at_ms, last_changed_at_ms,
                latest_observed_at_ms, inserted_chars, deleted_chars, text,
                source_ids_json, components_json
         FROM open_bursts
         WHERE MIN(last_changed_at_ms + ?1, started_at_ms + ?2) <= ?3
         ORDER BY document_key",
    )?;
    let rows = statement.query_map(params![EDIT_SILENCE_MS, EDIT_MAX_BURST_MS, at_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,
            OpenBurst {
                editor_id: row.get(1)?,
                document_id: row.get(2)?,
                relative_path: row.get(3)?,
                language: row.get(4)?,
                sensitivity: row.get(5)?,
                started_at_ms: row.get(6)?,
                last_changed_at_ms: row.get(7)?,
                latest_observed_at_ms: row.get(8)?,
                inserted_chars: row.get(9)?,
                deleted_chars: row.get(10)?,
                text: row.get(11)?,
                source_ids_json: row.get(12)?,
                components_json: row.get(13)?,
            },
        ))
    })?;
    let due = rows.collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (document_key, burst) in due {
        seal_burst(transaction, &document_key, burst)?;
    }
    Ok(())
}

fn seal_burst(
    transaction: &Transaction<'_>,
    document_key: &str,
    burst: OpenBurst,
) -> Result<(), VscodeEditBridgeError> {
    let ended_at_ms =
        (burst.last_changed_at_ms + EDIT_SILENCE_MS).min(burst.started_at_ms + EDIT_MAX_BURST_MS);
    let source_ids = serde_json::from_str::<Vec<String>>(&burst.source_ids_json)?;
    let mut payload = json!({
        "editorId": burst.editor_id,
        "documentId": burst.document_id,
        "relativePath": burst.relative_path,
        "language": burst.language,
        "insertedChars": burst.inserted_chars,
        "deletedChars": burst.deleted_chars,
        "burstStartedAtMs": burst.started_at_ms,
        "burstEndedAtMs": ended_at_ms,
    });
    if burst.sensitivity == "content"
        && let Some(text) = burst.text.filter(|text| !text.is_empty())
    {
        payload
            .as_object_mut()
            .expect("edit burst payload is an object")
            .insert("text".to_owned(), JsonValue::String(text));
    }
    let identity_material = serde_json::to_vec(&json!({
        "documentKey": document_key,
        "sourceEventIds": source_ids,
        "startedAtMs": burst.started_at_ms,
        "endedAtMs": ended_at_ms,
    }))?;
    let burst_id = format!("veb1_{}", hash_hex32(&identity_material));
    let deduplication_key = format!("vscode-edit-burst-v1:{burst_id}");
    transaction.execute(
        "INSERT INTO burst_outbox (
            burst_id, occurred_at_ms, observed_at_ms, sensitivity,
            deduplication_key, payload_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            burst_id,
            ended_at_ms,
            burst.latest_observed_at_ms.max(ended_at_ms),
            burst.sensitivity,
            deduplication_key,
            serde_json::to_string(&payload)?,
        ],
    )?;
    transaction.execute(
        "DELETE FROM open_bursts WHERE document_key = ?1",
        [document_key],
    )?;
    transaction.execute(
        "INSERT INTO document_seal_state (document_key, sealed_through_ms)
         VALUES (?1, ?2)
         ON CONFLICT(document_key) DO UPDATE SET
            sealed_through_ms = MAX(
                document_seal_state.sealed_through_ms,
                excluded.sealed_through_ms
            )",
        params![document_key, ended_at_ms],
    )?;
    Ok(())
}

struct PendingBurst {
    burst_id: String,
    occurred_at_ms: i64,
    observed_at_ms: i64,
    sensitivity: String,
    deduplication_key: String,
    payload_json: String,
}

fn validate_relative_path(path: &str) -> Result<(), VscodeEditBridgeError> {
    let char_count = path.chars().count();
    if !(1..=MAX_RELATIVE_PATH_CHARS).contains(&char_count)
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains('\0')
        || path.split('/').any(|component| component == "..")
    {
        return Err(VscodeEditBridgeError::InvalidSegment(
            "document.relativePath violates the v1 path policy".to_owned(),
        ));
    }
    Ok(())
}

fn has_identifier_shape(value: &str, prefix: &str) -> bool {
    let Some(digest) = value.strip_prefix(prefix) else {
        return false;
    };
    digest.len() == 32
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_safe_integer(value: u64, field: &str) -> Result<(), VscodeEditBridgeError> {
    if value > MAX_SAFE_INTEGER {
        return Err(VscodeEditBridgeError::InvalidSegment(format!(
            "{field} exceeds the JavaScript safe-integer bound"
        )));
    }
    Ok(())
}

fn checked_safe_sum(left: u64, right: u64) -> Result<u64, VscodeEditBridgeError> {
    left.checked_add(right)
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| {
            VscodeEditBridgeError::InvalidSegment(
                "edit character count exceeds the safe-integer bound".to_owned(),
            )
        })
}

fn checked_sql_sum(left: i64, right: i64) -> Result<i64, VscodeEditBridgeError> {
    left.checked_add(right)
        .filter(|value| *value >= 0 && (*value as u64) <= MAX_SAFE_INTEGER)
        .ok_or_else(|| {
            VscodeEditBridgeError::InvalidSegment(
                "edit burst character count exceeds the safe-integer bound".to_owned(),
            )
        })
}

fn append_bounded_text(current: Option<&str>, next: Option<&str>, limit: usize) -> Option<String> {
    let mut output = current.unwrap_or_default().to_owned();
    let remaining = limit.saturating_sub(output.chars().count());
    if remaining > 0
        && let Some(next) = next
    {
        output.extend(next.chars().take(remaining));
    }
    (!output.is_empty()).then_some(output)
}

fn stable_identifier(prefix: &str, left: &str, right: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    hasher.update([0]);
    hasher.update(left.as_bytes());
    hasher.update([0]);
    hasher.update(right.as_bytes());
    let digest = hasher.finalize();
    format!("{prefix}_{}", hex_prefix(&digest, 16))
}

fn hash_hex32(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    hex_prefix(&digest, 16)
}

fn hex_prefix(bytes: &[u8], byte_count: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(byte_count * 2);
    for byte in bytes.iter().take(byte_count) {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn read_meta_i64(connection: &Connection, key: &str) -> Result<Option<i64>, VscodeEditBridgeError> {
    let value = connection
        .query_row(
            "SELECT value FROM bridge_meta WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    value
        .map(|value| {
            value.parse::<i64>().map_err(|_| {
                VscodeEditBridgeError::Configuration(format!(
                    "VS Code edit database metadata {key} is invalid"
                ))
            })
        })
        .transpose()
}

fn write_meta_i64(
    transaction: &Transaction<'_>,
    key: &str,
    value: i64,
) -> Result<(), VscodeEditBridgeError> {
    transaction.execute(
        "INSERT INTO bridge_meta (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(())
}

fn count_table_where(connection: &Connection, query: &str) -> Result<usize, VscodeEditBridgeError> {
    let value = connection.query_row(query, [], |row| row.get::<_, i64>(0))?;
    usize::try_from(value).map_err(|_| {
        VscodeEditBridgeError::Configuration(
            "VS Code edit database returned an invalid row count".to_owned(),
        )
    })
}

fn duration_ms_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

#[cfg(unix)]
fn harden_directory_permissions(path: &Path) -> Result<(), VscodeEditBridgeError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn harden_directory_permissions(_path: &Path) -> Result<(), VscodeEditBridgeError> {
    Ok(())
}

#[cfg(unix)]
fn harden_sqlite_permissions(path: &Path) -> Result<(), VscodeEditBridgeError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = OsString::from(path.as_os_str());
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        match fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_sqlite_permissions(_path: &Path) -> Result<(), VscodeEditBridgeError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{Value, json};
    use tempfile::TempDir;
    use whalehall_local_protocol::EventQueryParams;

    use super::*;

    struct Harness {
        _directory: TempDir,
        paths: BridgePaths,
        store: VscodeEditStore,
        journal: EventJournal,
    }

    impl Harness {
        fn new() -> Self {
            let directory = tempfile::tempdir().expect("create editor bridge test directory");
            let bridge_root = directory.path().join("bridge");
            fs::create_dir(&bridge_root).expect("create bridge root");
            let paths = BridgePaths::prepare(&bridge_root).expect("prepare bridge");
            let store = VscodeEditStore::open(
                &directory
                    .path()
                    .join("private-editor-state")
                    .join("editor.sqlite3"),
            )
            .expect("open editor store");
            let journal = EventJournal::open(directory.path().join("events.sqlite3"))
                .expect("open event journal");
            Self {
                _directory: directory,
                paths,
                store,
                journal,
            }
        }

        fn publish(&self, events: &[Value]) -> PathBuf {
            publish_segment(&self.paths.spool, events)
        }

        fn ingest(&self, at_ms: i64) {
            self.store
                .process_spool(&self.paths, at_ms)
                .expect("process editor spool");
        }

        fn flush(&self, at_ms: i64) {
            self.store.seal_due(at_ms).expect("seal due bursts");
            self.store
                .flush_outbox(&self.journal, at_ms)
                .expect("flush editor outbox");
        }

        fn events(&self) -> Vec<whalehall_local_protocol::DesktopEvent> {
            self.journal
                .query(&EventQueryParams {
                    limit: 100,
                    ..EventQueryParams::default()
                })
                .expect("query desktop events")
                .events
        }
    }

    fn edit_event(
        suffix: u64,
        occurred_at_ms: u64,
        relative_path: &str,
        sensitivity: &str,
        inserted_text: Option<&str>,
    ) -> Value {
        let mut change = json!({
            "rangeOffset": 0,
            "deletedChars": 1,
            "insertedChars": inserted_text.map(str::len).unwrap_or(2),
        });
        if let Some(text) = inserted_text {
            change.as_object_mut().expect("change object").insert(
                "insertedText".to_owned(),
                JsonValue::String(text.to_owned()),
            );
        }
        json!({
            "schemaVersion": RECORD_SCHEMA_VERSION,
            "eventId": format!("vse1_{suffix:032x}"),
            "kind": RECORD_KIND,
            "source": RECORD_SOURCE,
            "occurredAtMs": occurred_at_ms,
            "observedAtMs": occurred_at_ms + 1,
            "sensitivity": sensitivity,
            "payload": {
                "workspaceId": "wsp1_0123456789abcdef0123456789abcdef",
                "document": {
                    "relativePath": relative_path,
                    "languageId": "rust",
                    "version": suffix,
                },
                "changeCount": 1,
                "emittedChangeCount": 1,
                "changesTruncated": false,
                "changes": [change],
            },
        })
    }

    fn publish_segment(spool: &Path, events: &[Value]) -> PathBuf {
        let mut data = String::new();
        let mut first_occurred = u64::MAX;
        for event in events {
            first_occurred =
                first_occurred.min(event["occurredAtMs"].as_u64().expect("event timestamp"));
            data.push_str(&serde_json::to_string(event).expect("serialize event"));
            data.push('\n');
        }
        let name = format!(
            "segment-{first_occurred:013}-{}.jsonl",
            hash_hex32(data.as_bytes())
        );
        let path = spool.join(name);
        fs::write(&path, data).expect("write sealed segment");
        path
    }

    fn table_count(store: &VscodeEditStore, table: &str) -> usize {
        let connection = store.connect().expect("connect editor store");
        let query = format!("SELECT COUNT(*) FROM {table}");
        count_table_where(&connection, &query).expect("count table")
    }

    #[tokio::test]
    async fn absent_bridge_configuration_stays_disabled_without_opening_storage() {
        let directory = tempfile::tempdir().expect("create disabled bridge directory");
        let database_path = directory
            .path()
            .join("editor-private")
            .join("editor.sqlite3");
        let journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open journal");
        let service = VscodeEditBridgeService::start(
            VscodeEditBridgeConfig {
                bridge_root: None,
                database_path: database_path.clone(),
                poll_interval: Duration::from_millis(10),
            },
            journal,
        )
        .expect("start disabled editor bridge");

        assert_eq!(service.status().state, VscodeEditBridgeState::Disabled);
        assert!(!service.status().enabled);
        assert!(!database_path.exists());
        assert!(!database_path.parent().expect("database parent").exists());
        service.shutdown().await;
        assert_eq!(service.status().state, VscodeEditBridgeState::Stopped);
    }

    #[tokio::test]
    async fn resident_service_drains_an_enabled_spool_and_updates_status() {
        let directory = tempfile::tempdir().expect("create resident bridge directory");
        let bridge_root = directory.path().join("bridge");
        fs::create_dir(&bridge_root).expect("create bridge root");
        let journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open journal");
        let service = VscodeEditBridgeService::start(
            VscodeEditBridgeConfig {
                bridge_root: Some(bridge_root.clone()),
                database_path: directory
                    .path()
                    .join("editor-private")
                    .join("editor.sqlite3"),
                poll_interval: Duration::from_millis(10),
            },
            journal.clone(),
        )
        .expect("start enabled editor bridge");
        publish_segment(
            &bridge_root.join(SPOOL_DIRECTORY_NAME),
            &[edit_event(1, 1_000, "src/main.rs", "metadata", None)],
        );

        let mut published = false;
        for _ in 0..50 {
            if !journal
                .query(&EventQueryParams::default())
                .expect("query journal")
                .events
                .is_empty()
                && service.status().state == VscodeEditBridgeState::Running
            {
                published = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(published);
        let status = service.status();
        assert_eq!(status.state, VscodeEditBridgeState::Running);
        assert!(status.enabled);
        assert_eq!(status.pending_segments, 0);
        assert_eq!(status.open_bursts, 0);
        assert_eq!(status.pending_bursts, 0);
        assert_eq!(status.rejected_segments, 0);
        assert!(status.last_imported_at_ms.is_some());
        assert!(status.last_published_at_ms.is_some());
        assert!(status.last_error.is_none());
        service.shutdown().await;
    }

    #[test]
    fn two_second_silence_publishes_one_privacy_safe_burst_and_gc_raw_source() {
        let harness = Harness::new();
        harness.publish(&[
            edit_event(1, 1_000, "src/main.rs", "metadata", None),
            edit_event(2, 2_000, "src/main.rs", "metadata", None),
        ]);
        harness.ingest(2_100);

        assert_eq!(table_count(&harness.store, "open_bursts"), 1);
        assert_eq!(table_count(&harness.store, "source_events"), 0);
        harness.flush(3_999);
        assert!(harness.events().is_empty());

        harness.flush(4_000);
        let events = harness.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, RECORD_KIND);
        assert_eq!(events[0].source, RECORD_SOURCE);
        assert_eq!(events[0].sensitivity, DesktopEventSensitivity::Metadata);
        assert_eq!(events[0].payload["relativePath"], "src/main.rs");
        assert_eq!(events[0].payload["language"], "rust");
        assert_eq!(events[0].payload["insertedChars"], 4);
        assert_eq!(events[0].payload["deletedChars"], 2);
        assert_eq!(events[0].payload["burstStartedAtMs"], 1_000);
        assert_eq!(events[0].payload["burstEndedAtMs"], 4_000);
        assert!(events[0].payload.get("text").is_none());
        assert_eq!(table_count(&harness.store, "source_events"), 0);
        assert_eq!(table_count(&harness.store, "source_event_dedup"), 2);
    }

    #[test]
    fn continuous_editing_force_closes_at_ten_seconds_and_starts_a_new_burst() {
        let harness = Harness::new();
        let first = (0..10)
            .map(|second| edit_event(second + 1, second * 1_000, "src/lib.rs", "metadata", None))
            .collect::<Vec<_>>();
        harness.publish(&first);
        harness.ingest(9_500);
        harness.flush(9_999);
        assert!(harness.events().is_empty());

        harness.publish(&[edit_event(11, 10_000, "src/lib.rs", "metadata", None)]);
        harness.ingest(10_100);
        harness
            .store
            .flush_outbox(&harness.journal, 10_100)
            .expect("flush forced burst");
        let first_burst = harness.events();
        assert_eq!(first_burst.len(), 1);
        assert_eq!(
            first_burst[0].payload["burstEndedAtMs"],
            JsonValue::from(10_000)
        );
        assert_eq!(first_burst[0].payload["insertedChars"], 20);

        harness.flush(12_000);
        let events = harness.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].payload["burstStartedAtMs"], 10_000);
        assert_eq!(events[1].payload["burstEndedAtMs"], 12_000);
        assert_eq!(events[1].payload["insertedChars"], 2);
    }

    #[test]
    fn documents_mature_independently_and_content_is_bounded_to_content_mode() {
        let harness = Harness::new();
        harness.publish(&[
            edit_event(1, 1_000, "src/a.rs", "content", Some("alpha")),
            edit_event(2, 1_500, "src/b.rs", "metadata", None),
        ]);
        harness.ingest(1_600);
        harness.flush(3_000);
        let first = harness.events();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].payload["relativePath"], "src/a.rs");
        assert_eq!(first[0].payload["text"], "alpha");
        assert_eq!(first[0].sensitivity, DesktopEventSensitivity::Content);

        harness.flush(3_500);
        let events = harness.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].payload["relativePath"], "src/b.rs");
        assert!(events[1].payload.get("text").is_none());
        assert_eq!(events[1].sensitivity, DesktopEventSensitivity::Metadata);
    }

    #[test]
    fn imported_claim_recovery_and_event_journal_replay_are_idempotent() {
        let harness = Harness::new();
        let sealed = harness.publish(&[edit_event(
            1,
            1_000,
            "src/main.rs",
            "content",
            Some("hello"),
        )]);
        let original_name = sealed
            .file_name()
            .and_then(|name| name.to_str())
            .expect("sealed filename")
            .to_owned();
        let claimed_name = format!("{CLAIMED_PREFIX}{original_name}");
        let claimed = harness.paths.spool.join(&claimed_name);
        fs::rename(&sealed, &claimed).expect("simulate claim");
        let records =
            read_and_validate_segment(&claimed, &original_name).expect("validate claimed segment");
        harness
            .store
            .ingest_segment(&original_name, &claimed_name, &records, 1_100)
            .expect("commit claimed segment without deleting it");
        assert!(claimed.exists());

        harness.ingest(1_200);
        assert!(!claimed.exists());
        assert_eq!(table_count(&harness.store, "source_events"), 0);
        assert_eq!(table_count(&harness.store, "open_bursts"), 1);
        harness.publish(&[edit_event(
            1,
            1_000,
            "src/main.rs",
            "content",
            Some("hello"),
        )]);
        harness.ingest(1_300);
        harness.store.seal_due(3_000).expect("seal burst");

        let connection = harness.store.connect().expect("connect store");
        let pending = connection
            .query_row(
                "SELECT burst_id, occurred_at_ms, observed_at_ms,
                        sensitivity, deduplication_key, payload_json
                 FROM burst_outbox LIMIT 1",
                [],
                |row| {
                    Ok(PendingBurst {
                        burst_id: row.get(0)?,
                        occurred_at_ms: row.get(1)?,
                        observed_at_ms: row.get(2)?,
                        sensitivity: row.get(3)?,
                        deduplication_key: row.get(4)?,
                        payload_json: row.get(5)?,
                    })
                },
            )
            .expect("pending burst");
        harness
            .journal
            .append(DesktopEventDraft {
                kind: RECORD_KIND.to_owned(),
                source: RECORD_SOURCE.to_owned(),
                occurred_at_ms: pending.occurred_at_ms,
                observed_at_ms: pending.observed_at_ms,
                goal_version: None,
                sensitivity: DesktopEventSensitivity::Content,
                payload: serde_json::from_str(&pending.payload_json).expect("payload"),
                deduplication_key: pending.deduplication_key.clone(),
            })
            .expect("simulate journal append before local commit");
        assert_eq!(table_count(&harness.store, "burst_outbox"), 1);

        harness
            .store
            .flush_outbox(&harness.journal, 3_100)
            .expect("replay pending burst");
        let events = harness.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["insertedChars"], 5);
        assert_eq!(events[0].payload["text"], "hello");
        assert_eq!(table_count(&harness.store, "burst_outbox"), 0);
        assert_eq!(table_count(&harness.store, "source_events"), 0);
    }

    #[test]
    fn cross_segment_overlap_and_duplicates_merge_in_event_time_order() {
        let harness = Harness::new();
        let event_b = edit_event(2, 2_000, "src/main.rs", "content", Some("B"));
        harness.publish(&[
            event_b.clone(),
            edit_event(4, 3_000, "src/main.rs", "content", Some("C")),
        ]);
        harness.ingest(3_100);
        harness.publish(&[
            edit_event(1, 1_000, "src/main.rs", "content", Some("A")),
            event_b,
            edit_event(3, 2_500, "src/main.rs", "content", Some("X")),
        ]);
        harness.ingest(3_200);
        harness.flush(5_000);

        let events = harness.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["burstStartedAtMs"], 1_000);
        assert_eq!(events[0].payload["burstEndedAtMs"], 5_000);
        assert_eq!(events[0].payload["insertedChars"], 4);
        assert_eq!(events[0].payload["deletedChars"], 4);
        assert_eq!(events[0].payload["text"], "ABXC");
        assert_eq!(table_count(&harness.store, "source_event_dedup"), 4);
        assert_eq!(
            harness
                .store
                .status_snapshot(&harness.paths)
                .expect("overlap status")
                .rejected_segments,
            0
        );
    }

    #[test]
    fn truly_late_segment_is_quarantined_without_blocking_newer_segments() {
        let harness = Harness::new();
        harness.publish(&[edit_event(1, 1_000, "src/main.rs", "metadata", None)]);
        harness.ingest(1_100);
        harness.flush(3_000);

        let late = harness.publish(&[edit_event(2, 2_000, "src/main.rs", "metadata", None)]);
        harness.publish(&[edit_event(3, 3_000, "src/main.rs", "metadata", None)]);
        harness.ingest(3_100);
        let claimed_late = harness.paths.spool.join(format!(
            "{CLAIMED_PREFIX}{}",
            late.file_name()
                .and_then(|name| name.to_str())
                .expect("late filename")
        ));
        assert!(claimed_late.exists());
        let snapshot = harness
            .store
            .status_snapshot(&harness.paths)
            .expect("quarantine status");
        assert_eq!(snapshot.rejected_segments, 1);
        assert_eq!(snapshot.open_bursts, 1);
        assert_eq!(table_count(&harness.store, "source_event_dedup"), 2);

        harness.flush(5_000);
        assert_eq!(harness.events().len(), 2);
        fs::remove_file(&claimed_late).expect("remove quarantined segment for recovery");
        harness.ingest(5_100);
        assert_eq!(
            harness
                .store
                .status_snapshot(&harness.paths)
                .expect("recovered status")
                .rejected_segments,
            0
        );
    }

    #[test]
    fn reused_event_id_with_different_content_is_quarantined() {
        let harness = Harness::new();
        harness.publish(&[edit_event(1, 1_000, "src/main.rs", "metadata", None)]);
        harness.ingest(1_100);

        harness.publish(&[edit_event(1, 1_000, "src/other.rs", "metadata", None)]);
        harness.ingest(1_200);
        let snapshot = harness
            .store
            .status_snapshot(&harness.paths)
            .expect("status snapshot");
        assert_eq!(snapshot.rejected_segments, 1);
        assert_eq!(table_count(&harness.store, "source_event_dedup"), 1);
        assert_eq!(table_count(&harness.store, "open_bursts"), 1);
    }

    #[test]
    fn strict_validation_rejects_metadata_text_and_reversed_observation_time() {
        let harness = Harness::new();
        let metadata_with_text = edit_event(1, 1_000, "src/main.rs", "metadata", Some("secret"));
        let path = harness.publish(&[metadata_with_text]);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("segment filename");
        assert!(matches!(
            read_and_validate_segment(&path, name),
            Err(VscodeEditBridgeError::InvalidSegment(_))
        ));

        fs::remove_file(path).expect("remove invalid segment");
        let mut reversed = edit_event(2, 2_000, "src/main.rs", "content", Some("safe"));
        reversed["observedAtMs"] = JsonValue::from(1_999);
        let path = harness.publish(&[reversed]);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("segment filename");
        assert!(matches!(
            read_and_validate_segment(&path, name),
            Err(VscodeEditBridgeError::InvalidSegment(_))
        ));
    }

    #[test]
    fn partial_v0_schema_initialization_is_reentrant_and_upgrades_atomically() {
        let directory = tempfile::tempdir().expect("create migration directory");
        let database_path = directory.path().join("editor.sqlite3");
        let connection = Connection::open(&database_path).expect("open partial database");
        connection
            .execute_batch(
                "CREATE TABLE bridge_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                 );
                 PRAGMA user_version = 0;",
            )
            .expect("create interrupted v0 database");
        drop(connection);

        let store = VscodeEditStore::open(&database_path).expect("recover partial schema");
        let connection = store.connect().expect("connect recovered schema");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert!(table_has_column(&connection, "open_bursts", "components_json").unwrap());
        assert_eq!(
            count_table_where(&connection, "SELECT COUNT(*) FROM document_seal_state").unwrap(),
            0
        );
    }

    #[test]
    fn source_event_deduplication_gc_respects_a_hard_row_target_after_safety_horizon() {
        let harness = Harness::new();
        let mut connection = harness.store.connect().expect("connect store");
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("begin dedup transaction");
        for index in 0..4 {
            transaction
                .execute(
                    "INSERT INTO source_event_dedup (
                        event_id, record_hash, occurred_at_ms, first_seen_at_ms
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        format!("old-{index}"),
                        format!("hash-{index}"),
                        index,
                        index,
                    ],
                )
                .expect("insert old dedup identity");
        }
        gc_source_event_dedup(&transaction, 100_000, 1_000_000, 2).expect("bound dedup identities");
        transaction.commit().expect("commit dedup GC");
        assert_eq!(table_count(&harness.store, "source_event_dedup"), 2);
    }

    #[cfg(unix)]
    #[test]
    fn private_state_permissions_and_symlinked_spool_are_enforced() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let harness = Harness::new();
        let state_directory = harness.store.path.parent().expect("state directory");
        assert_eq!(
            fs::metadata(state_directory)
                .expect("state directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&harness.store.path)
                .expect("database metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        for suffix in ["-wal", "-shm"] {
            let mut path = OsString::from(harness.store.path.as_os_str());
            path.push(suffix);
            let path = PathBuf::from(path);
            if path.exists() {
                assert_eq!(
                    fs::metadata(path)
                        .expect("sidecar metadata")
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        }

        let directory = tempfile::tempdir().expect("create symlink test directory");
        let root = directory.path().join("root");
        let target = directory.path().join("target");
        fs::create_dir(&root).expect("create root");
        fs::create_dir(&target).expect("create target");
        symlink(&target, root.join(SPOOL_DIRECTORY_NAME)).expect("create spool symlink");
        assert!(matches!(
            BridgePaths::prepare(&root),
            Err(VscodeEditBridgeError::Configuration(_))
        ));
    }
}
