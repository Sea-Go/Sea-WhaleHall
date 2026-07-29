//! Resident accessibility-tree sensor for the foreground application.
//!
//! The sensor samples a bounded platform accessibility tree, removes protected
//! input values, stores changed snapshots in SQLite, and exposes query methods
//! that keep control values and document text opt-in.

use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_ACCESSIBILITY_POLL_INTERVAL_MS: u64 = 2_000;
pub const DEFAULT_ACCESSIBILITY_BRIDGE_MAX_AGE_MS: u64 = 15_000;
pub const DEFAULT_ACCESSIBILITY_MAX_NODES: usize = 300;
pub const DEFAULT_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT: usize = 4_096;
pub const DEFAULT_ACCESSIBILITY_RETENTION_DAYS: u64 = 7;
const ACCESSIBILITY_SCHEMA_VERSION: i64 = 1;
const MAX_QUERY_LIMIT: usize = 1_000;
const MAX_NODE_NAME_CHARS: usize = 1_024;
const MAX_NODE_VALUE_CHARS: usize = 4_096;
const MAX_WARNING_CHARS: usize = 2_048;

#[derive(Debug, Error)]
pub enum AccessibilityError {
    #[error("accessibility sensor configuration error: {0}")]
    Configuration(String),
    #[error("accessibility sensor I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("accessibility sensor JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("accessibility sensor SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("accessibility sensor collection error: {0}")]
    Collection(String),
}

#[derive(Clone, Debug)]
pub struct AccessibilityConfig {
    pub database_path: PathBuf,
    pub bridge_path: PathBuf,
    pub monitoring_enabled: bool,
    pub content_monitoring_enabled: bool,
    pub poll_interval: Duration,
    pub bridge_max_age: Duration,
    pub max_nodes: usize,
    pub document_text_limit: usize,
    pub retention: Duration,
}

impl AccessibilityConfig {
    pub fn from_environment() -> Result<Self, AccessibilityError> {
        let data_dir = if let Some(path) = env::var_os("WHALEHALL_DATA_DIR") {
            PathBuf::from(path)
        } else {
            ProjectDirs::from("com", "seago", "whalehall")
                .ok_or_else(|| {
                    AccessibilityError::Configuration(
                        "unable to resolve the operating system application data directory"
                            .to_owned(),
                    )
                })?
                .data_dir()
                .to_path_buf()
        };
        let bridge_path = env::var_os("WHALEHALL_ACCESSIBILITY_SNAPSHOT_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("accessibility-current-tree.json"));
        Ok(Self {
            database_path: data_dir.join("accessibility.sqlite3"),
            bridge_path,
            monitoring_enabled: bool_from_environment(
                "WHALEHALL_ACCESSIBILITY_MONITORING_ENABLED",
                false,
            )?,
            content_monitoring_enabled: bool_from_environment(
                "WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED",
                false,
            )?,
            poll_interval: duration_from_environment(
                "WHALEHALL_ACCESSIBILITY_POLL_MS",
                DEFAULT_ACCESSIBILITY_POLL_INTERVAL_MS,
                50,
                60_000,
            )?,
            bridge_max_age: duration_from_environment(
                "WHALEHALL_ACCESSIBILITY_BRIDGE_MAX_AGE_MS",
                DEFAULT_ACCESSIBILITY_BRIDGE_MAX_AGE_MS,
                1_000,
                10 * 60 * 1_000,
            )?,
            max_nodes: usize_from_environment(
                "WHALEHALL_ACCESSIBILITY_MAX_NODES",
                DEFAULT_ACCESSIBILITY_MAX_NODES,
                1,
                1_000,
            )?,
            document_text_limit: usize_from_environment(
                "WHALEHALL_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT",
                DEFAULT_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT,
                0,
                16_384,
            )?,
            retention: Duration::from_secs(
                usize_from_environment(
                    "WHALEHALL_ACCESSIBILITY_RETENTION_DAYS",
                    DEFAULT_ACCESSIBILITY_RETENTION_DAYS as usize,
                    1,
                    30,
                )? as u64
                    * 24
                    * 60
                    * 60,
            ),
        })
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccessibilitySensorState {
    Disabled,
    Starting,
    Running,
    Degraded,
    Stopped,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityCapabilities {
    pub tree: bool,
    pub focused_control: bool,
    pub selection: bool,
    pub document_text: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityNode {
    pub node_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub depth: usize,
    pub role: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub selected: Option<bool>,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub document_text: Option<String>,
    #[serde(default)]
    pub protected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityObservation {
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub application_name: String,
    #[serde(default)]
    pub process_id: Option<u32>,
    #[serde(default)]
    pub window_title: String,
    #[serde(default)]
    pub capabilities: AccessibilityCapabilities,
    #[serde(default)]
    pub nodes: Vec<AccessibilityNode>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl AccessibilityObservation {
    fn unavailable(warning: impl Into<String>) -> Self {
        Self {
            available: false,
            application_name: String::new(),
            process_id: None,
            window_title: String::new(),
            capabilities: AccessibilityCapabilities::default(),
            nodes: Vec::new(),
            warnings: vec![warning.into()],
        }
    }

    fn sanitize(&mut self, config: &AccessibilityConfig) {
        self.application_name = truncate_chars(self.application_name.trim(), MAX_NODE_NAME_CHARS);
        self.window_title = truncate_chars(self.window_title.trim(), MAX_NODE_NAME_CHARS);
        self.nodes.truncate(config.max_nodes);
        for (index, node) in self.nodes.iter_mut().enumerate() {
            if node.node_id.trim().is_empty() {
                node.node_id = format!("node-{index}");
            } else {
                node.node_id = truncate_chars(node.node_id.trim(), MAX_NODE_NAME_CHARS);
            }
            node.parent_id = node
                .parent_id
                .take()
                .map(|value| truncate_chars(value.trim(), MAX_NODE_NAME_CHARS))
                .filter(|value| !value.is_empty());
            node.role = truncate_chars(node.role.trim(), MAX_NODE_NAME_CHARS);
            if node.role.is_empty() {
                node.role = "unknown".to_owned();
            }
            node.name = truncate_chars(node.name.trim(), MAX_NODE_NAME_CHARS);
            node.value = sanitize_optional_text(node.value.take(), MAX_NODE_VALUE_CHARS);
            node.document_text =
                sanitize_optional_text(node.document_text.take(), config.document_text_limit);
            if node.protected || role_is_protected(&node.role) {
                node.protected = true;
                node.value = None;
                node.document_text = None;
            } else if !config.content_monitoring_enabled {
                node.value = None;
                node.document_text = None;
            }
        }
        self.warnings = self
            .warnings
            .drain(..)
            .map(|warning| truncate_chars(warning.trim(), MAX_WARNING_CHARS))
            .filter(|warning| !warning.is_empty())
            .collect();
        if self.available {
            self.capabilities.tree = true;
            self.capabilities.focused_control |= self.nodes.iter().any(|node| node.focused);
            self.capabilities.selection |= self.nodes.iter().any(|node| node.selected.is_some());
            self.capabilities.document_text = config.content_monitoring_enabled
                && (self.capabilities.document_text
                    || self.nodes.iter().any(|node| node.document_text.is_some()));
        }
    }

    fn focused_control(&self) -> Option<AccessibilityControlSummary> {
        self.nodes
            .iter()
            .find(|node| node.focused)
            .map(AccessibilityControlSummary::from)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityControlSummary {
    pub node_id: String,
    pub role: String,
    pub name: String,
    pub selected: Option<bool>,
    pub enabled: Option<bool>,
    pub protected: bool,
}

impl From<&AccessibilityNode> for AccessibilityControlSummary {
    fn from(node: &AccessibilityNode) -> Self {
        Self {
            node_id: node.node_id.clone(),
            role: node.role.clone(),
            name: node.name.clone(),
            selected: node.selected,
            enabled: node.enabled,
            protected: node.protected,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilitySnapshotRecord {
    pub id: i64,
    pub observed_at_ms: i64,
    pub observed_at: String,
    pub application_name: String,
    pub process_id: Option<u32>,
    pub window_title: String,
    pub node_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityTreeResult {
    pub snapshot: Option<AccessibilitySnapshotRecord>,
    pub count: usize,
    pub nodes: Vec<AccessibilityNode>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessibilityTreeQuery {
    #[serde(default = "default_query_limit")]
    pub limit: usize,
    #[serde(default)]
    pub snapshot_id: Option<i64>,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub focused_only: bool,
    #[serde(default)]
    pub selected_only: bool,
    #[serde(default)]
    pub include_values: bool,
    #[serde(default)]
    pub include_document_text: bool,
}

impl Default for AccessibilityTreeQuery {
    fn default() -> Self {
        Self {
            limit: default_query_limit(),
            snapshot_id: None,
            roles: Vec::new(),
            focused_only: false,
            selected_only: false,
            include_values: false,
            include_document_text: false,
        }
    }
}

impl AccessibilityTreeQuery {
    pub fn validate(&self) -> Result<(), AccessibilityError> {
        if self.limit == 0 || self.limit > MAX_QUERY_LIMIT {
            return Err(AccessibilityError::Configuration(format!(
                "accessibility.tree limit must be between 1 and {MAX_QUERY_LIMIT}"
            )));
        }
        if self.snapshot_id.is_some_and(|snapshot_id| snapshot_id <= 0) {
            return Err(AccessibilityError::Configuration(
                "accessibility.tree snapshotId must be positive".to_owned(),
            ));
        }
        if self.roles.len() > 64 || self.roles.iter().any(|role| role.trim().is_empty()) {
            return Err(AccessibilityError::Configuration(
                "accessibility.tree roles must contain between 0 and 64 non-empty values"
                    .to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityStatus {
    pub state: AccessibilitySensorState,
    pub database_path: String,
    pub bridge_path: String,
    pub monitoring_enabled: bool,
    pub content_monitoring_enabled: bool,
    pub poll_interval_ms: u64,
    pub bridge_max_age_ms: u64,
    pub max_nodes: usize,
    pub document_text_limit: usize,
    pub retention_days: u64,
    pub observed_at_ms: Option<i64>,
    pub observed_at: Option<String>,
    pub application_name: Option<String>,
    pub process_id: Option<u32>,
    pub window_title: Option<String>,
    pub node_count: usize,
    pub snapshot_count: usize,
    pub current_control: Option<AccessibilityControlSummary>,
    pub capabilities: AccessibilityCapabilities,
    pub warnings: Vec<String>,
    pub last_error: Option<String>,
}

pub trait AccessibilityProvider: Send + Sync + 'static {
    fn observe(
        &self,
        config: &AccessibilityConfig,
    ) -> Result<AccessibilityObservation, AccessibilityError>;
}

#[derive(Default)]
pub struct SystemAccessibilityProvider;

impl AccessibilityProvider for SystemAccessibilityProvider {
    fn observe(
        &self,
        config: &AccessibilityConfig,
    ) -> Result<AccessibilityObservation, AccessibilityError> {
        let mut bridge_warnings = Vec::new();
        match read_bridge_snapshot(config) {
            Ok(Some(observation)) => return Ok(observation),
            Ok(None) => {}
            Err(error) => bridge_warnings.push(error.to_string()),
        }
        let mut observation = match platform::observe(config) {
            Ok(observation) => observation,
            Err(error) => AccessibilityObservation::unavailable(error.to_string()),
        };
        observation.warnings.splice(0..0, bridge_warnings);
        Ok(observation)
    }
}

#[derive(Clone)]
pub struct AccessibilityService {
    inner: Arc<AccessibilityInner>,
}

struct AccessibilityInner {
    config: AccessibilityConfig,
    store: AccessibilityStore,
    status: Mutex<AccessibilityStatus>,
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl AccessibilityService {
    pub fn start(
        config: AccessibilityConfig,
        provider: Arc<dyn AccessibilityProvider>,
    ) -> Result<Self, AccessibilityError> {
        let store = AccessibilityStore::open(&config.database_path)?;
        let snapshot_count = store.snapshot_count()?;
        let content_monitoring_enabled =
            config.monitoring_enabled && config.content_monitoring_enabled;
        let mut warnings = Vec::new();
        if config.content_monitoring_enabled && !config.monitoring_enabled {
            warnings.push(
                "accessibility content monitoring is ignored until accessibility monitoring is enabled"
                    .to_owned(),
            );
        }
        let inner = Arc::new(AccessibilityInner {
            status: Mutex::new(AccessibilityStatus {
                state: if config.monitoring_enabled {
                    AccessibilitySensorState::Starting
                } else {
                    AccessibilitySensorState::Disabled
                },
                database_path: config.database_path.to_string_lossy().into_owned(),
                bridge_path: config.bridge_path.to_string_lossy().into_owned(),
                monitoring_enabled: config.monitoring_enabled,
                content_monitoring_enabled,
                poll_interval_ms: config.poll_interval.as_millis() as u64,
                bridge_max_age_ms: config.bridge_max_age.as_millis() as u64,
                max_nodes: config.max_nodes,
                document_text_limit: config.document_text_limit,
                retention_days: config.retention.as_secs() / (24 * 60 * 60),
                observed_at_ms: None,
                observed_at: None,
                application_name: None,
                process_id: None,
                window_title: None,
                node_count: 0,
                snapshot_count,
                current_control: None,
                capabilities: AccessibilityCapabilities::default(),
                warnings,
                last_error: None,
            }),
            config,
            store,
            cancellation: CancellationToken::new(),
            task: Mutex::new(None),
        });
        if inner.config.monitoring_enabled {
            let task = tokio::spawn(run_accessibility_monitor(inner.clone(), provider));
            *inner.task.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
        }
        Ok(Self { inner })
    }

    pub fn status(&self) -> AccessibilityStatus {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn tree(
        &self,
        query: &AccessibilityTreeQuery,
    ) -> Result<AccessibilityTreeResult, AccessibilityError> {
        self.inner.store.query_tree(query)
    }

    pub fn database_path(&self) -> &Path {
        self.inner.store.path()
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
    }
}

async fn run_accessibility_monitor(
    inner: Arc<AccessibilityInner>,
    provider: Arc<dyn AccessibilityProvider>,
) {
    let mut ticker = interval(inner.config.poll_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last_fingerprint = None;

    loop {
        tokio::select! {
            () = inner.cancellation.cancelled() => {
                inner.status.lock().unwrap_or_else(|error| error.into_inner()).state =
                    AccessibilitySensorState::Stopped;
                break;
            }
            _ = ticker.tick() => {
                let config = inner.config.clone();
                let provider = provider.clone();
                let observed_at_ms = now_ms();
                let result = tokio::task::spawn_blocking(move || provider.observe(&config)).await;
                let observation = match result {
                    Ok(Ok(mut observation)) => {
                        observation.sanitize(&inner.config);
                        observation
                    }
                    Ok(Err(error)) => {
                        update_degraded_status(&inner, observed_at_ms, error.to_string());
                        continue;
                    }
                    Err(error) => {
                        update_degraded_status(
                            &inner,
                            observed_at_ms,
                            format!("accessibility observation task failed: {error}"),
                        );
                        continue;
                    }
                };
                if !observation.available {
                    let warning = observation.warnings.first().cloned().unwrap_or_else(|| {
                        "operating system accessibility tree is unavailable".to_owned()
                    });
                    update_unavailable_status(&inner, observed_at_ms, observation, warning);
                    continue;
                }

                let fingerprint = observation_fingerprint(&observation);
                let stored_snapshot = if last_fingerprint == Some(fingerprint) {
                    inner.store.latest_snapshot().ok().flatten()
                } else {
                    match inner.store.record_snapshot(
                        &observation,
                        observed_at_ms,
                        inner.config.retention,
                    ) {
                        Ok(snapshot) => {
                            last_fingerprint = Some(fingerprint);
                            Some(snapshot)
                        }
                        Err(error) => {
                            update_degraded_status(&inner, observed_at_ms, error.to_string());
                            continue;
                        }
                    }
                };
                let snapshot_count = inner.store.snapshot_count().unwrap_or_default();
                let mut status = inner
                    .status
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                status.state = AccessibilitySensorState::Running;
                status.observed_at_ms = Some(observed_at_ms);
                status.observed_at = Some(format_timestamp(observed_at_ms));
                status.application_name = non_empty_option(&observation.application_name);
                status.process_id = observation.process_id;
                status.window_title = non_empty_option(&observation.window_title);
                status.node_count = observation.nodes.len();
                status.snapshot_count = snapshot_count;
                status.current_control = observation.focused_control();
                status.capabilities = observation.capabilities;
                status.warnings = observation.warnings;
                status.last_error = stored_snapshot
                    .is_none()
                    .then(|| "accessibility snapshot was not persisted".to_owned());
            }
        }
    }
}

fn update_degraded_status(inner: &AccessibilityInner, observed_at_ms: i64, error_message: String) {
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    status.state = AccessibilitySensorState::Degraded;
    status.observed_at_ms = Some(observed_at_ms);
    status.observed_at = Some(format_timestamp(observed_at_ms));
    status.application_name = None;
    status.process_id = None;
    status.window_title = None;
    status.node_count = 0;
    status.current_control = None;
    status.capabilities = AccessibilityCapabilities::default();
    status.warnings = vec![error_message.clone()];
    status.last_error = Some(error_message);
}

fn update_unavailable_status(
    inner: &AccessibilityInner,
    observed_at_ms: i64,
    observation: AccessibilityObservation,
    warning: String,
) {
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    status.state = AccessibilitySensorState::Degraded;
    status.observed_at_ms = Some(observed_at_ms);
    status.observed_at = Some(format_timestamp(observed_at_ms));
    status.application_name = None;
    status.process_id = None;
    status.window_title = None;
    status.node_count = 0;
    status.current_control = None;
    status.capabilities = observation.capabilities;
    status.warnings = observation.warnings;
    status.last_error = Some(warning);
}

#[derive(Clone, Debug)]
struct AccessibilityStore {
    path: PathBuf,
}

impl AccessibilityStore {
    fn open(path: impl Into<PathBuf>) -> Result<Self, AccessibilityError> {
        let path = path.into();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(&path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS accessibility_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS accessibility_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                observed_at_ms INTEGER NOT NULL,
                application_name TEXT NOT NULL,
                process_id INTEGER,
                window_title TEXT NOT NULL,
                node_count INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_accessibility_snapshots_time
                 ON accessibility_snapshots(observed_at_ms DESC);
             CREATE TABLE IF NOT EXISTS accessibility_nodes (
                snapshot_id INTEGER NOT NULL,
                node_index INTEGER NOT NULL,
                node_id TEXT NOT NULL,
                parent_id TEXT,
                depth INTEGER NOT NULL,
                role TEXT NOT NULL,
                name TEXT NOT NULL,
                value TEXT,
                selected INTEGER,
                focused INTEGER NOT NULL,
                enabled INTEGER,
                document_text TEXT,
                protected INTEGER NOT NULL,
                PRIMARY KEY(snapshot_id, node_index),
                FOREIGN KEY(snapshot_id) REFERENCES accessibility_snapshots(id)
                    ON DELETE CASCADE
             );",
        )?;
        connection.execute(
            "INSERT INTO accessibility_meta(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [ACCESSIBILITY_SCHEMA_VERSION.to_string()],
        )?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn connect(&self) -> Result<Connection, AccessibilityError> {
        let connection = Connection::open(&self.path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(Duration::from_secs(2))?;
        Ok(connection)
    }

    fn record_snapshot(
        &self,
        observation: &AccessibilityObservation,
        observed_at_ms: i64,
        retention: Duration,
    ) -> Result<AccessibilitySnapshotRecord, AccessibilityError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO accessibility_snapshots(
                observed_at_ms, application_name, process_id, window_title, node_count
             ) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![
                observed_at_ms,
                observation.application_name,
                observation.process_id,
                observation.window_title,
                observation.nodes.len() as i64,
            ],
        )?;
        let snapshot_id = transaction.last_insert_rowid();
        {
            let mut statement = transaction.prepare(
                "INSERT INTO accessibility_nodes(
                    snapshot_id, node_index, node_id, parent_id, depth, role, name, value,
                    selected, focused, enabled, document_text, protected
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )?;
            for (index, node) in observation.nodes.iter().enumerate() {
                statement.execute(params![
                    snapshot_id,
                    index as i64,
                    node.node_id,
                    node.parent_id,
                    node.depth as i64,
                    node.role,
                    node.name,
                    node.value,
                    node.selected,
                    node.focused,
                    node.enabled,
                    node.document_text,
                    node.protected,
                ])?;
            }
        }
        let cutoff_at_ms =
            observed_at_ms.saturating_sub(retention.as_millis().min(i64::MAX as u128) as i64);
        transaction.execute(
            "DELETE FROM accessibility_snapshots WHERE observed_at_ms < ?1",
            [cutoff_at_ms],
        )?;
        transaction.commit()?;
        Ok(AccessibilitySnapshotRecord {
            id: snapshot_id,
            observed_at_ms,
            observed_at: format_timestamp(observed_at_ms),
            application_name: observation.application_name.clone(),
            process_id: observation.process_id,
            window_title: observation.window_title.clone(),
            node_count: observation.nodes.len(),
        })
    }

    fn latest_snapshot(&self) -> Result<Option<AccessibilitySnapshotRecord>, AccessibilityError> {
        self.snapshot_by_id(None)
    }

    fn snapshot_by_id(
        &self,
        snapshot_id: Option<i64>,
    ) -> Result<Option<AccessibilitySnapshotRecord>, AccessibilityError> {
        let connection = self.connect()?;
        let sql = if snapshot_id.is_some() {
            "SELECT id, observed_at_ms, application_name, process_id, window_title, node_count
             FROM accessibility_snapshots WHERE id = ?1"
        } else {
            "SELECT id, observed_at_ms, application_name, process_id, window_title, node_count
             FROM accessibility_snapshots ORDER BY observed_at_ms DESC, id DESC LIMIT 1"
        };
        let mut statement = connection.prepare(sql)?;
        let record = if let Some(snapshot_id) = snapshot_id {
            statement
                .query_row([snapshot_id], snapshot_from_row)
                .optional()?
        } else {
            statement.query_row([], snapshot_from_row).optional()?
        };
        Ok(record)
    }

    fn query_tree(
        &self,
        query: &AccessibilityTreeQuery,
    ) -> Result<AccessibilityTreeResult, AccessibilityError> {
        query.validate()?;
        let Some(snapshot) = self.snapshot_by_id(query.snapshot_id)? else {
            return Ok(AccessibilityTreeResult {
                snapshot: None,
                count: 0,
                nodes: Vec::new(),
            });
        };
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT node_id, parent_id, depth, role, name, value, selected, focused, enabled,
                    document_text, protected
             FROM accessibility_nodes
             WHERE snapshot_id = ?1
             ORDER BY node_index ASC",
        )?;
        let rows = statement.query_map([snapshot.id], |row| {
            Ok(AccessibilityNode {
                node_id: row.get(0)?,
                parent_id: row.get(1)?,
                depth: row.get::<_, i64>(2)? as usize,
                role: row.get(3)?,
                name: row.get(4)?,
                value: row.get(5)?,
                selected: row.get(6)?,
                focused: row.get(7)?,
                enabled: row.get(8)?,
                document_text: row.get(9)?,
                protected: row.get(10)?,
            })
        })?;
        let normalized_roles = query
            .roles
            .iter()
            .map(|role| role.trim().to_ascii_lowercase())
            .collect::<Vec<_>>();
        let mut nodes = Vec::new();
        for row in rows {
            let mut node = row?;
            if !normalized_roles.is_empty()
                && !normalized_roles
                    .iter()
                    .any(|role| node.role.eq_ignore_ascii_case(role))
            {
                continue;
            }
            if query.focused_only && !node.focused {
                continue;
            }
            if query.selected_only && node.selected != Some(true) {
                continue;
            }
            if !query.include_values {
                node.value = None;
            }
            if !query.include_document_text {
                node.document_text = None;
            }
            nodes.push(node);
            if nodes.len() == query.limit {
                break;
            }
        }
        Ok(AccessibilityTreeResult {
            snapshot: Some(snapshot),
            count: nodes.len(),
            nodes,
        })
    }

    fn snapshot_count(&self) -> Result<usize, AccessibilityError> {
        let connection = self.connect()?;
        Ok(
            connection.query_row("SELECT COUNT(*) FROM accessibility_snapshots", [], |row| {
                row.get::<_, i64>(0)
            })? as usize,
        )
    }
}

fn snapshot_from_row(
    row: &rusqlite::Row<'_>,
) -> Result<AccessibilitySnapshotRecord, rusqlite::Error> {
    let observed_at_ms = row.get(1)?;
    Ok(AccessibilitySnapshotRecord {
        id: row.get(0)?,
        observed_at_ms,
        observed_at: format_timestamp(observed_at_ms),
        application_name: row.get(2)?,
        process_id: row.get(3)?,
        window_title: row.get(4)?,
        node_count: row.get::<_, i64>(5)? as usize,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeSnapshot {
    observed_at_ms: i64,
    #[serde(flatten)]
    observation: AccessibilityObservation,
}

fn read_bridge_snapshot(
    config: &AccessibilityConfig,
) -> Result<Option<AccessibilityObservation>, AccessibilityError> {
    if !config.bridge_path.is_file() {
        return Ok(None);
    }
    let snapshot: BridgeSnapshot = serde_json::from_slice(&fs::read(&config.bridge_path)?)?;
    let age_ms = now_ms().saturating_sub(snapshot.observed_at_ms);
    if age_ms < 0 || age_ms > config.bridge_max_age.as_millis() as i64 {
        return Err(AccessibilityError::Collection(format!(
            "accessibility bridge snapshot {} is stale or from the future",
            config.bridge_path.display()
        )));
    }
    Ok(Some(snapshot.observation))
}

fn observation_fingerprint(observation: &AccessibilityObservation) -> u64 {
    let mut hasher = DefaultHasher::new();
    observation.application_name.hash(&mut hasher);
    observation.process_id.hash(&mut hasher);
    observation.window_title.hash(&mut hasher);
    serde_json::to_vec(&observation.nodes)
        .unwrap_or_default()
        .hash(&mut hasher);
    hasher.finish()
}

fn command_observation(
    mut command: Command,
    platform_name: &str,
) -> Result<AccessibilityObservation, AccessibilityError> {
    let output = command.output().map_err(|error| {
        AccessibilityError::Collection(format!(
            "{platform_name} accessibility collector could not start: {error}"
        ))
    })?;
    if !output.status.success() {
        let detail = truncate_chars(
            String::from_utf8_lossy(&output.stderr).trim(),
            MAX_WARNING_CHARS,
        );
        return Err(AccessibilityError::Collection(format!(
            "{platform_name} accessibility collector failed{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        )));
    }
    serde_json::from_slice(&output.stdout).map_err(AccessibilityError::from)
}

fn role_is_protected(role: &str) -> bool {
    let role = role.to_ascii_lowercase();
    role.contains("password") || role.contains("secure")
}

fn sanitize_optional_text(value: Option<String>, limit: usize) -> Option<String> {
    if limit == 0 {
        return None;
    }
    value
        .map(|value| truncate_chars(value.trim(), limit))
        .filter(|value| !value.is_empty())
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn non_empty_option(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

fn bool_from_environment(name: &str, default: bool) -> Result<bool, AccessibilityError> {
    match env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => Err(AccessibilityError::Configuration(format!(
                "{name} must be one of true, false, 1, 0, yes, no, on, or off"
            ))),
        },
        Err(env::VarError::NotPresent) => Ok(default),
        Err(env::VarError::NotUnicode(_)) => Err(AccessibilityError::Configuration(format!(
            "{name} must be valid Unicode"
        ))),
    }
}

fn duration_from_environment(
    name: &str,
    default_ms: u64,
    minimum_ms: u64,
    maximum_ms: u64,
) -> Result<Duration, AccessibilityError> {
    let value = env::var(name)
        .ok()
        .map(|value| {
            value.parse::<u64>().map_err(|_| {
                AccessibilityError::Configuration(format!("{name} must be an integer"))
            })
        })
        .transpose()?
        .unwrap_or(default_ms);
    if !(minimum_ms..=maximum_ms).contains(&value) {
        return Err(AccessibilityError::Configuration(format!(
            "{name} must be between {minimum_ms} and {maximum_ms}"
        )));
    }
    Ok(Duration::from_millis(value))
}

fn usize_from_environment(
    name: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize, AccessibilityError> {
    let value = env::var(name)
        .ok()
        .map(|value| {
            value.parse::<usize>().map_err(|_| {
                AccessibilityError::Configuration(format!("{name} must be an integer"))
            })
        })
        .transpose()?
        .unwrap_or(default);
    if !(minimum..=maximum).contains(&value) {
        return Err(AccessibilityError::Configuration(format!(
            "{name} must be between {minimum} and {maximum}"
        )));
    }
    Ok(value)
}

fn default_query_limit() -> usize {
    300
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn format_timestamp(timestamp_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    const JXA_COLLECTOR: &str = r#"
ObjC.import("stdlib");
function safe(f, fallback) { try { const value = f(); return value === undefined ? fallback : value; } catch (_) { return fallback; } }
const systemEvents = Application("System Events");
const processes = systemEvents.applicationProcesses.whose({frontmost: true})();
if (processes.length === 0) throw new Error("no frontmost accessibility process");
const process = processes[0];
const windows = safe(() => process.windows(), []);
const root = windows.length > 0 ? windows[0] : process;
const nodes = [];
const maxNodes = Number($.getenv("WHALEHALL_ACCESSIBILITY_MAX_NODES") || "300");
const textLimit = Number($.getenv("WHALEHALL_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT") || "4096");
const captureContent = String($.getenv("WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED") || "false").toLowerCase() === "true";
function visit(element, parentId, depth) {
  if (nodes.length >= maxNodes) return;
  const id = "node-" + nodes.length;
  const role = String(safe(() => element.role(), "unknown"));
  const subrole = String(safe(() => element.subrole(), ""));
  const protectedInput = /password|secure/i.test(role + " " + subrole);
  let value = (!captureContent || protectedInput) ? null : safe(() => element.value(), null);
  if (value !== null && typeof value !== "string") value = String(value);
  if (value !== null) value = value.slice(0, 4096);
  const documentRole = /document|text area|AXTextArea|AXDocument/i.test(role + " " + subrole);
  nodes.push({
    nodeId: id,
    parentId: parentId,
    depth: depth,
    role: subrole || role,
    name: String(safe(() => element.name(), safe(() => element.description(), ""))),
    value: value,
    selected: safe(() => Boolean(element.selected()), null),
    focused: Boolean(safe(() => element.focused(), false)),
    enabled: safe(() => Boolean(element.enabled()), null),
    documentText: (captureContent && !protectedInput && documentRole && value !== null) ? value.slice(0, textLimit) : null,
    protected: protectedInput
  });
  const children = safe(() => element.uiElements(), []);
  for (let i = 0; i < children.length && nodes.length < maxNodes; i++) visit(children[i], id, depth + 1);
}
visit(root, null, 0);
JSON.stringify({
  available: true,
  applicationName: String(safe(() => process.name(), "")),
  processId: Number(safe(() => process.unixId(), 0)) || null,
  windowTitle: windows.length > 0 ? String(safe(() => windows[0].name(), "")) : "",
  capabilities: {tree: true, focusedControl: nodes.some(n => n.focused), selection: true, documentText: captureContent},
  nodes: nodes,
  warnings: nodes.length >= maxNodes ? ["accessibility tree was truncated at the configured node limit"] : []
});
"#;

    pub(super) fn observe(
        config: &AccessibilityConfig,
    ) -> Result<AccessibilityObservation, AccessibilityError> {
        let mut command = Command::new("osascript");
        command
            .args(["-l", "JavaScript", "-e", JXA_COLLECTOR])
            .env(
                "WHALEHALL_ACCESSIBILITY_MAX_NODES",
                config.max_nodes.to_string(),
            )
            .env(
                "WHALEHALL_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT",
                config.document_text_limit.to_string(),
            )
            .env(
                "WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED",
                config.content_monitoring_enabled.to_string(),
            );
        command_observation(command, "macOS")
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    const POWERSHELL_COLLECTOR: &str = r#"
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WhaleHallNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$root = [System.Windows.Automation.AutomationElement]::FromHandle([WhaleHallNative]::GetForegroundWindow())
if ($null -eq $root) { throw "no foreground automation element" }
$script:nodes = [System.Collections.Generic.List[object]]::new()
$maxNodesValue = $env:WHALEHALL_ACCESSIBILITY_MAX_NODES
if ([string]::IsNullOrWhiteSpace($maxNodesValue)) { $maxNodesValue = "300" }
$textLimitValue = $env:WHALEHALL_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT
if ([string]::IsNullOrWhiteSpace($textLimitValue)) { $textLimitValue = "4096" }
$script:maxNodes = [int]$maxNodesValue
$script:textLimit = [int]$textLimitValue
$script:captureContent = $env:WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED -eq "true"
function Visit-Element($element, $parentId, [int]$depth) {
  if ($script:nodes.Count -ge $script:maxNodes) { return }
  $id = "node-$($script:nodes.Count)"
  $current = $element.Current
  $role = $current.ControlType.ProgrammaticName -replace "^ControlType\\.", ""
  $protectedInput = $current.IsPassword -or $role -match "Password|Secure"
  $value = $null
  if ($script:captureContent -and -not $protectedInput) {
    try {
      $pattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $value = [string]$pattern.Current.Value
      }
    } catch {}
  }
  $selected = $null
  try {
    $selectionItem = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionItem)) {
      $selected = [bool]$selectionItem.Current.IsSelected
    }
  } catch {}
  $documentText = $null
  if ($script:captureContent -and -not $protectedInput -and $role -match "Document|Edit") {
    try {
      $textPattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
        $documentText = [string]$textPattern.DocumentRange.GetText($script:textLimit)
      }
    } catch {}
  }
  $script:nodes.Add([pscustomobject]@{
    nodeId = $id
    parentId = $parentId
    depth = $depth
    role = $role
    name = [string]$current.Name
    value = $value
    selected = $selected
    focused = [bool]$current.HasKeyboardFocus
    enabled = [bool]$current.IsEnabled
    documentText = $documentText
    protected = [bool]$protectedInput
  })
  $children = $element.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($child in $children) {
    if ($script:nodes.Count -ge $script:maxNodes) { break }
    Visit-Element $child $id ($depth + 1)
  }
}
Visit-Element $root $null 0
$processId = [int]$root.Current.ProcessId
$applicationName = try { (Get-Process -Id $processId).ProcessName } catch { "" }
[pscustomobject]@{
  available = $true
  applicationName = [string]$applicationName
  processId = $processId
  windowTitle = [string]$root.Current.Name
  capabilities = [pscustomobject]@{
    tree = $true
    focusedControl = [bool]($script:nodes | Where-Object focused | Select-Object -First 1)
    selection = $true
    documentText = [bool]$script:captureContent
  }
  nodes = $script:nodes
  warnings = @($(if ($script:nodes.Count -ge $script:maxNodes) { "accessibility tree was truncated at the configured node limit" }))
} | ConvertTo-Json -Compress -Depth 6
"#;

    pub(super) fn observe(
        config: &AccessibilityConfig,
    ) -> Result<AccessibilityObservation, AccessibilityError> {
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
            .arg(POWERSHELL_COLLECTOR)
            .env(
                "WHALEHALL_ACCESSIBILITY_MAX_NODES",
                config.max_nodes.to_string(),
            )
            .env(
                "WHALEHALL_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT",
                config.document_text_limit.to_string(),
            )
            .env(
                "WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED",
                config.content_monitoring_enabled.to_string(),
            );
        command_observation(command, "Windows")
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    const PYATSPI_COLLECTOR: &str = r#"
import json, os
import pyatspi
max_nodes = int(os.environ.get("WHALEHALL_ACCESSIBILITY_MAX_NODES", "300"))
text_limit = int(os.environ.get("WHALEHALL_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT", "4096"))
capture_content = os.environ.get("WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED", "false").lower() == "true"
desktop = pyatspi.Registry.getDesktop(0)
active_app = None
for app in desktop:
    states = app.getState()
    if states.contains(pyatspi.STATE_ACTIVE):
        active_app = app
        break
if active_app is None:
    for app in desktop:
        for child in app:
            states = child.getState()
            if states.contains(pyatspi.STATE_ACTIVE) or states.contains(pyatspi.STATE_FOCUSED):
                active_app = app
                break
        if active_app is not None:
            break
if active_app is None:
    raise RuntimeError("no active AT-SPI application")
nodes = []
window_title = ""
def visit(element, parent_id, depth):
    global window_title
    if len(nodes) >= max_nodes:
        return
    node_id = "node-" + str(len(nodes))
    role = element.getRoleName() or "unknown"
    name = element.name or ""
    states = element.getState()
    protected = "password" in role.lower()
    value = None
    document_text = None
    if capture_content and not protected and any(token in role.lower() for token in ("text", "document", "entry")):
        try:
            text = element.queryText()
            value = text.getText(0, min(text.characterCount, text_limit))
            if "document" in role.lower() or "text" in role.lower():
                document_text = value
        except Exception:
            pass
    if not window_title and ("frame" in role.lower() or "window" in role.lower()):
        window_title = name
    nodes.append({
        "nodeId": node_id,
        "parentId": parent_id,
        "depth": depth,
        "role": role,
        "name": name,
        "value": value,
        "selected": bool(states.contains(pyatspi.STATE_SELECTED)),
        "focused": bool(states.contains(pyatspi.STATE_FOCUSED)),
        "enabled": bool(states.contains(pyatspi.STATE_ENABLED)),
        "documentText": document_text,
        "protected": protected,
    })
    for child in element:
        if len(nodes) >= max_nodes:
            break
        visit(child, node_id, depth + 1)
visit(active_app, None, 0)
print(json.dumps({
    "available": True,
    "applicationName": active_app.name or "",
    "processId": None,
    "windowTitle": window_title,
    "capabilities": {
        "tree": True,
        "focusedControl": any(node["focused"] for node in nodes),
        "selection": True,
        "documentText": capture_content,
    },
    "nodes": nodes,
    "warnings": ["accessibility tree was truncated at the configured node limit"] if len(nodes) >= max_nodes else [],
}, separators=(",", ":")))
"#;

    pub(super) fn observe(
        config: &AccessibilityConfig,
    ) -> Result<AccessibilityObservation, AccessibilityError> {
        let mut command = Command::new("python3");
        command
            .args(["-c", PYATSPI_COLLECTOR])
            .env(
                "WHALEHALL_ACCESSIBILITY_MAX_NODES",
                config.max_nodes.to_string(),
            )
            .env(
                "WHALEHALL_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT",
                config.document_text_limit.to_string(),
            )
            .env(
                "WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED",
                config.content_monitoring_enabled.to_string(),
            );
        command_observation(command, "Linux AT-SPI")
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::*;

    pub(super) fn observe(
        _config: &AccessibilityConfig,
    ) -> Result<AccessibilityObservation, AccessibilityError> {
        Ok(AccessibilityObservation::unavailable(
            "accessibility tree collection is unsupported on this operating system",
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tempfile::TempDir;

    use super::*;

    fn sample_observation() -> AccessibilityObservation {
        AccessibilityObservation {
            available: true,
            application_name: "Editor".to_owned(),
            process_id: Some(42),
            window_title: "Document".to_owned(),
            capabilities: AccessibilityCapabilities {
                tree: true,
                focused_control: true,
                selection: true,
                document_text: true,
            },
            nodes: vec![
                AccessibilityNode {
                    node_id: "root".to_owned(),
                    parent_id: None,
                    depth: 0,
                    role: "window".to_owned(),
                    name: "Document".to_owned(),
                    value: None,
                    selected: None,
                    focused: false,
                    enabled: Some(true),
                    document_text: None,
                    protected: false,
                },
                AccessibilityNode {
                    node_id: "editor".to_owned(),
                    parent_id: Some("root".to_owned()),
                    depth: 1,
                    role: "textBox".to_owned(),
                    name: "Body".to_owned(),
                    value: Some("draft body".to_owned()),
                    selected: Some(true),
                    focused: true,
                    enabled: Some(true),
                    document_text: Some("Partial document text".to_owned()),
                    protected: false,
                },
                AccessibilityNode {
                    node_id: "password".to_owned(),
                    parent_id: Some("root".to_owned()),
                    depth: 1,
                    role: "passwordText".to_owned(),
                    name: "Password".to_owned(),
                    value: Some("secret".to_owned()),
                    selected: None,
                    focused: false,
                    enabled: Some(true),
                    document_text: Some("secret".to_owned()),
                    protected: true,
                },
            ],
            warnings: Vec::new(),
        }
    }

    fn test_config(directory: &TempDir) -> AccessibilityConfig {
        AccessibilityConfig {
            database_path: directory.path().join("accessibility.sqlite3"),
            bridge_path: directory.path().join("accessibility-current-tree.json"),
            monitoring_enabled: true,
            content_monitoring_enabled: true,
            poll_interval: Duration::from_millis(20),
            bridge_max_age: Duration::from_secs(60),
            max_nodes: 100,
            document_text_limit: 1_024,
            retention: Duration::from_secs(7 * 24 * 60 * 60),
        }
    }

    #[test]
    fn stores_filters_and_redacts_accessibility_nodes() {
        let directory = tempfile::tempdir().expect("create accessibility test directory");
        let config = test_config(&directory);
        let store =
            AccessibilityStore::open(&config.database_path).expect("open accessibility store");
        let mut observation = sample_observation();
        observation.sanitize(&config);
        store
            .record_snapshot(&observation, 2_000, config.retention)
            .expect("record accessibility snapshot");

        let redacted = store
            .query_tree(&AccessibilityTreeQuery::default())
            .expect("query redacted tree");
        assert_eq!(redacted.count, 3);
        assert!(redacted.nodes.iter().all(|node| node.value.is_none()));
        assert!(
            redacted
                .nodes
                .iter()
                .all(|node| node.document_text.is_none())
        );

        let selected = store
            .query_tree(&AccessibilityTreeQuery {
                selected_only: true,
                include_values: true,
                include_document_text: true,
                ..AccessibilityTreeQuery::default()
            })
            .expect("query selected controls");
        assert_eq!(selected.count, 1);
        assert_eq!(selected.nodes[0].value.as_deref(), Some("draft body"));
        assert_eq!(
            selected.nodes[0].document_text.as_deref(),
            Some("Partial document text")
        );

        let password = store
            .query_tree(&AccessibilityTreeQuery {
                roles: vec!["passwordText".to_owned()],
                include_values: true,
                include_document_text: true,
                ..AccessibilityTreeQuery::default()
            })
            .expect("query protected control");
        assert!(password.nodes[0].value.is_none());
        assert!(password.nodes[0].document_text.is_none());
    }

    struct FakeProvider {
        calls: AtomicUsize,
    }

    impl AccessibilityProvider for FakeProvider {
        fn observe(
            &self,
            _config: &AccessibilityConfig,
        ) -> Result<AccessibilityObservation, AccessibilityError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(sample_observation())
        }
    }

    #[tokio::test]
    async fn resident_service_persists_and_reports_current_control() {
        let directory = tempfile::tempdir().expect("create accessibility test directory");
        let config = test_config(&directory);
        let service = AccessibilityService::start(
            config,
            Arc::new(FakeProvider {
                calls: AtomicUsize::new(0),
            }),
        )
        .expect("start accessibility service");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = service.status();
                if status.state == AccessibilitySensorState::Running
                    && status.snapshot_count == 1
                    && status.current_control.is_some()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("accessibility service should become ready");

        let status = service.status();
        assert_eq!(status.application_name.as_deref(), Some("Editor"));
        assert_eq!(
            status
                .current_control
                .as_ref()
                .map(|control| control.role.as_str()),
            Some("textBox")
        );
        assert!(service.database_path().exists());
        service.shutdown().await;
    }

    #[test]
    fn metadata_only_accessibility_storage_removes_values_and_document_text() {
        let directory = tempfile::tempdir().expect("create accessibility privacy directory");
        let mut config = test_config(&directory);
        config.content_monitoring_enabled = false;
        let store =
            AccessibilityStore::open(&config.database_path).expect("open accessibility store");
        let mut observation = sample_observation();
        observation.sanitize(&config);
        store
            .record_snapshot(&observation, 2_000, config.retention)
            .expect("record metadata-only snapshot");

        let result = store
            .query_tree(&AccessibilityTreeQuery {
                include_values: true,
                include_document_text: true,
                ..AccessibilityTreeQuery::default()
            })
            .expect("query stored metadata");
        assert!(result.nodes.iter().all(|node| node.value.is_none()));
        assert!(result.nodes.iter().all(|node| node.document_text.is_none()));
        assert!(!observation.capabilities.document_text);
    }

    #[tokio::test]
    async fn disabled_accessibility_service_never_calls_resident_provider() {
        let directory = tempfile::tempdir().expect("create accessibility disabled directory");
        let mut config = test_config(&directory);
        config.monitoring_enabled = false;
        config.content_monitoring_enabled = false;
        let provider = Arc::new(FakeProvider {
            calls: AtomicUsize::new(0),
        });
        let service = AccessibilityService::start(config, provider.clone())
            .expect("start disabled accessibility service");
        tokio::time::sleep(Duration::from_millis(100)).await;

        let status = service.status();
        assert_eq!(status.state, AccessibilitySensorState::Disabled);
        assert!(!status.monitoring_enabled);
        assert!(!status.content_monitoring_enabled);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
        assert!(
            service
                .tree(&AccessibilityTreeQuery::default())
                .expect("query disabled history")
                .snapshot
                .is_none()
        );
        service.shutdown().await;
    }

    #[test]
    fn reads_fresh_bridge_and_rejects_stale_bridge() {
        let directory = tempfile::tempdir().expect("create accessibility test directory");
        let config = test_config(&directory);
        let mut value = serde_json::to_value(sample_observation()).expect("serialize observation");
        value
            .as_object_mut()
            .expect("observation object")
            .insert("observedAtMs".to_owned(), serde_json::json!(now_ms()));
        fs::write(
            &config.bridge_path,
            serde_json::to_vec(&value).expect("serialize bridge"),
        )
        .expect("write bridge");
        assert!(
            read_bridge_snapshot(&config)
                .expect("read fresh bridge")
                .is_some()
        );

        value
            .as_object_mut()
            .expect("observation object")
            .insert("observedAtMs".to_owned(), serde_json::json!(0));
        fs::write(
            &config.bridge_path,
            serde_json::to_vec(&value).expect("serialize stale bridge"),
        )
        .expect("write stale bridge");
        assert!(read_bridge_snapshot(&config).is_err());
    }
}
