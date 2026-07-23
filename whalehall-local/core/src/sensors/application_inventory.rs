//! Resident installed-application and running-process inventory sensor.
//!
//! The sensor periodically snapshots operating-system processes, persists their
//! lifecycle and latest resource usage in SQLite, and refreshes the installed
//! application catalog on a slower cadence.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use directories::ProjectDirs;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, TransactionBehavior, params, params_from_iter};
use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_APPLICATION_PROCESS_POLL_INTERVAL_MS: u64 = 2_000;
pub const DEFAULT_INSTALLED_APPLICATION_REFRESH_INTERVAL_MS: u64 = 6 * 60 * 60 * 1_000;
const APPLICATION_SCHEMA_VERSION: i64 = 1;
const MAX_INSTALLED_APPLICATIONS: usize = 20_000;
const MAX_QUERY_LIMIT: usize = 1_000;

#[derive(Debug, Error)]
pub enum ApplicationInventoryError {
    #[error("application inventory configuration error: {0}")]
    Configuration(String),
    #[error("application inventory I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("application inventory SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("application inventory collection error: {0}")]
    Collection(String),
}

#[derive(Clone, Debug)]
pub struct ApplicationInventoryConfig {
    pub database_path: PathBuf,
    pub process_poll_interval: Duration,
    pub installed_refresh_interval: Duration,
}

impl ApplicationInventoryConfig {
    pub fn from_environment() -> Result<Self, ApplicationInventoryError> {
        let data_dir = if let Some(path) = env::var_os("WHALEHALL_DATA_DIR") {
            PathBuf::from(path)
        } else {
            ProjectDirs::from("com", "seago", "whalehall")
                .ok_or_else(|| {
                    ApplicationInventoryError::Configuration(
                        "unable to resolve the operating system application data directory"
                            .to_owned(),
                    )
                })?
                .data_dir()
                .to_path_buf()
        };
        let process_poll_interval = duration_from_environment(
            "WHALEHALL_APPLICATION_POLL_MS",
            DEFAULT_APPLICATION_PROCESS_POLL_INTERVAL_MS,
            50,
            60_000,
        )?;
        let installed_refresh_interval = duration_from_environment(
            "WHALEHALL_INSTALLED_APPLICATION_REFRESH_MS",
            DEFAULT_INSTALLED_APPLICATION_REFRESH_INTERVAL_MS,
            1_000,
            7 * 24 * 60 * 60 * 1_000,
        )?;
        Ok(Self {
            database_path: data_dir.join("applications.sqlite3"),
            process_poll_interval,
            installed_refresh_interval,
        })
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApplicationInventoryState {
    Starting,
    Running,
    Degraded,
    Stopped,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationInventoryStatus {
    pub state: ApplicationInventoryState,
    pub database_path: String,
    pub process_poll_interval_ms: u64,
    pub installed_refresh_interval_ms: u64,
    pub installed_application_count: usize,
    pub running_process_count: usize,
    pub last_process_scan_at_ms: Option<i64>,
    pub last_process_scan_at: Option<String>,
    pub last_installed_scan_at_ms: Option<i64>,
    pub last_installed_scan_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedInstalledApplication {
    pub name: String,
    pub executable_path: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ObservedProcess {
    pub process_id: u64,
    pub name: String,
    pub executable_path: String,
    pub started_at_ms: i64,
    pub cpu_usage_percent: f32,
    pub memory_bytes: u64,
}

pub trait ApplicationInventoryProvider: Send + Sync + 'static {
    fn installed_applications(
        &self,
    ) -> Result<Vec<ObservedInstalledApplication>, ApplicationInventoryError>;

    fn running_processes(&self) -> Result<Vec<ObservedProcess>, ApplicationInventoryError>;
}

pub struct SystemApplicationInventoryProvider {
    system: Mutex<System>,
}

impl Default for SystemApplicationInventoryProvider {
    fn default() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }
}

impl ApplicationInventoryProvider for SystemApplicationInventoryProvider {
    fn installed_applications(
        &self,
    ) -> Result<Vec<ObservedInstalledApplication>, ApplicationInventoryError> {
        collect_installed_applications()
    }

    fn running_processes(&self) -> Result<Vec<ObservedProcess>, ApplicationInventoryError> {
        let mut system = self
            .system
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_exe(UpdateKind::OnlyIfNotSet)
                .without_tasks(),
        );
        let mut processes = system
            .processes()
            .values()
            .map(|process| {
                let executable_path = process
                    .exe()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let process_name = process.name().to_string_lossy().trim().to_owned();
                let name = if process_name.is_empty() {
                    Path::new(&executable_path)
                        .file_stem()
                        .map(|value| value.to_string_lossy().into_owned())
                        .unwrap_or_else(|| format!("pid-{}", process.pid()))
                } else {
                    process_name
                };
                ObservedProcess {
                    process_id: u64::from(process.pid().as_u32()),
                    name,
                    executable_path,
                    started_at_ms: i64::try_from(process.start_time())
                        .unwrap_or(i64::MAX)
                        .saturating_mul(1_000),
                    cpu_usage_percent: finite_cpu_usage(process.cpu_usage()),
                    memory_bytes: process.memory(),
                }
            })
            .collect::<Vec<_>>();
        processes.sort_by_key(|process| process.process_id);
        Ok(processes)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApplicationRecord {
    pub id: i64,
    pub name: String,
    pub executable_path: String,
    pub source: String,
    pub first_discovered_at_ms: i64,
    pub first_discovered_at: String,
    pub last_discovered_at_ms: i64,
    pub last_discovered_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRunRecord {
    pub id: i64,
    pub process_id: u64,
    pub name: String,
    pub executable_path: String,
    pub started_at_ms: i64,
    pub started_at: String,
    pub first_observed_at_ms: i64,
    pub first_observed_at: String,
    pub last_observed_at_ms: i64,
    pub last_observed_at: String,
    pub exited_at_ms: Option<i64>,
    pub exited_at: Option<String>,
    pub cpu_usage_percent: f32,
    pub memory_bytes: u64,
    pub is_running: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledApplicationQuery {
    #[serde(default = "default_query_limit")]
    pub limit: usize,
    #[serde(default)]
    pub name_contains: Option<String>,
}

impl Default for InstalledApplicationQuery {
    fn default() -> Self {
        Self {
            limit: default_query_limit(),
            name_contains: None,
        }
    }
}

impl InstalledApplicationQuery {
    pub fn validate(&self) -> Result<(), ApplicationInventoryError> {
        validate_query_limit("applications.installed", self.limit)?;
        validate_optional_search("applications.installed", self.name_contains.as_deref())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRunQuery {
    #[serde(default = "default_query_limit")]
    pub limit: usize,
    #[serde(default)]
    pub process_id: Option<u64>,
    #[serde(default)]
    pub name_contains: Option<String>,
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
    #[serde(default)]
    pub running_only: bool,
}

impl Default for ProcessRunQuery {
    fn default() -> Self {
        Self {
            limit: default_query_limit(),
            process_id: None,
            name_contains: None,
            from_ms: None,
            to_ms: None,
            running_only: false,
        }
    }
}

impl ProcessRunQuery {
    pub fn validate(&self) -> Result<(), ApplicationInventoryError> {
        validate_query_limit("applications.processes", self.limit)?;
        validate_optional_search("applications.processes", self.name_contains.as_deref())?;
        if matches!((self.from_ms, self.to_ms), (Some(from), Some(to)) if from > to) {
            return Err(ApplicationInventoryError::Configuration(
                "applications.processes fromMs cannot be greater than toMs".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct ApplicationInventoryService {
    inner: Arc<ApplicationInventoryInner>,
}

struct ApplicationInventoryInner {
    config: ApplicationInventoryConfig,
    store: ApplicationInventoryStore,
    status: Mutex<ApplicationInventoryStatus>,
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl ApplicationInventoryService {
    pub fn start(
        config: ApplicationInventoryConfig,
        provider: Arc<dyn ApplicationInventoryProvider>,
    ) -> Result<Self, ApplicationInventoryError> {
        let store = ApplicationInventoryStore::open(&config.database_path)?;
        store.recover_interrupted_processes()?;
        let inner = Arc::new(ApplicationInventoryInner {
            status: Mutex::new(ApplicationInventoryStatus {
                state: ApplicationInventoryState::Starting,
                database_path: config.database_path.to_string_lossy().into_owned(),
                process_poll_interval_ms: config.process_poll_interval.as_millis() as u64,
                installed_refresh_interval_ms: config.installed_refresh_interval.as_millis() as u64,
                installed_application_count: store.installed_application_count()?,
                running_process_count: 0,
                last_process_scan_at_ms: None,
                last_process_scan_at: None,
                last_installed_scan_at_ms: None,
                last_installed_scan_at: None,
                last_error: None,
            }),
            config,
            store,
            cancellation: CancellationToken::new(),
            task: Mutex::new(None),
        });
        let task = tokio::spawn(run_inventory_monitor(inner.clone(), provider));
        *inner.task.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
        Ok(Self { inner })
    }

    pub fn status(&self) -> ApplicationInventoryStatus {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn installed_applications(
        &self,
        query: &InstalledApplicationQuery,
    ) -> Result<Vec<InstalledApplicationRecord>, ApplicationInventoryError> {
        self.inner.store.query_installed_applications(query)
    }

    pub fn processes(
        &self,
        query: &ProcessRunQuery,
    ) -> Result<Vec<ProcessRunRecord>, ApplicationInventoryError> {
        self.inner.store.query_processes(query)
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

async fn run_inventory_monitor(
    inner: Arc<ApplicationInventoryInner>,
    provider: Arc<dyn ApplicationInventoryProvider>,
) {
    let mut ticker = interval(inner.config.process_poll_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last_installed_scan_at_ms = None;

    loop {
        tokio::select! {
            () = inner.cancellation.cancelled() => {
                update_inventory_status(
                    &inner,
                    ApplicationInventoryState::Stopped,
                    None,
                    None,
                    None,
                    None,
                );
                break;
            }
            _ = ticker.tick() => {
                let observed_at_ms = now_ms();
                let process_result = collect_running_processes(provider.clone()).await
                    .and_then(|processes| {
                        let count = processes.len();
                        inner.store.record_process_snapshot(&processes, observed_at_ms)?;
                        Ok(count)
                    });
                let (running_count, process_error) = match process_result {
                    Ok(count) => (Some(count), None),
                    Err(error) => (None, Some(error.to_string())),
                };
                update_inventory_status(
                    &inner,
                    if process_error.is_none() {
                        ApplicationInventoryState::Running
                    } else {
                        ApplicationInventoryState::Degraded
                    },
                    running_count.map(|count| (count, observed_at_ms)),
                    None,
                    process_error.clone(),
                    Some(observed_at_ms),
                );
                let installed_due = last_installed_scan_at_ms.is_none_or(|last_scan| {
                    observed_at_ms.saturating_sub(last_scan)
                        >= inner.config.installed_refresh_interval.as_millis() as i64
                });
                let installed_result = if installed_due {
                    let result = collect_installed(provider.clone()).await
                        .and_then(|applications| {
                            inner.store.record_installed_applications(&applications, observed_at_ms)?;
                            Ok(applications.len())
                        });
                    if result.is_ok() {
                        last_installed_scan_at_ms = Some(observed_at_ms);
                    }
                    Some(result)
                } else {
                    None
                };

                let mut errors = process_error.into_iter().collect::<Vec<_>>();
                let installed_count = match installed_result {
                    Some(Ok(count)) => Some(count),
                    Some(Err(error)) => {
                        errors.push(error.to_string());
                        None
                    }
                    None => None,
                };
                update_inventory_status(
                    &inner,
                    if errors.is_empty() {
                        ApplicationInventoryState::Running
                    } else {
                        ApplicationInventoryState::Degraded
                    },
                    None,
                    installed_count.map(|count| (count, observed_at_ms)),
                    (!errors.is_empty()).then(|| errors.join("; ")),
                    Some(observed_at_ms),
                );
            }
        }
    }
}

async fn collect_running_processes(
    provider: Arc<dyn ApplicationInventoryProvider>,
) -> Result<Vec<ObservedProcess>, ApplicationInventoryError> {
    tokio::task::spawn_blocking(move || provider.running_processes())
        .await
        .map_err(|error| {
            ApplicationInventoryError::Collection(format!(
                "process observation task failed: {error}"
            ))
        })?
}

async fn collect_installed(
    provider: Arc<dyn ApplicationInventoryProvider>,
) -> Result<Vec<ObservedInstalledApplication>, ApplicationInventoryError> {
    tokio::task::spawn_blocking(move || provider.installed_applications())
        .await
        .map_err(|error| {
            ApplicationInventoryError::Collection(format!(
                "installed-application observation task failed: {error}"
            ))
        })?
}

fn update_inventory_status(
    inner: &ApplicationInventoryInner,
    state: ApplicationInventoryState,
    process_scan: Option<(usize, i64)>,
    installed_scan: Option<(usize, i64)>,
    last_error: Option<String>,
    fallback_scan_at_ms: Option<i64>,
) {
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    status.state = state;
    if let Some((count, timestamp_ms)) = process_scan {
        status.running_process_count = count;
        status.last_process_scan_at_ms = Some(timestamp_ms);
        status.last_process_scan_at = Some(format_timestamp(timestamp_ms));
    } else if status.last_process_scan_at_ms.is_none() {
        status.last_process_scan_at_ms = fallback_scan_at_ms;
        status.last_process_scan_at = fallback_scan_at_ms.map(format_timestamp);
    }
    if let Some((count, timestamp_ms)) = installed_scan {
        status.installed_application_count = count;
        status.last_installed_scan_at_ms = Some(timestamp_ms);
        status.last_installed_scan_at = Some(format_timestamp(timestamp_ms));
    }
    status.last_error = last_error;
}

#[derive(Clone, Debug)]
struct ApplicationInventoryStore {
    path: PathBuf,
}

impl ApplicationInventoryStore {
    fn open(path: impl Into<PathBuf>) -> Result<Self, ApplicationInventoryError> {
        let path = path.into();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let store = Self { path };
        store.initialize()?;
        Ok(store)
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn record_installed_applications(
        &self,
        applications: &[ObservedInstalledApplication],
        observed_at_ms: i64,
    ) -> Result<(), ApplicationInventoryError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS current_installed_paths (
                executable_path TEXT PRIMARY KEY
             ) WITHOUT ROWID;
             DELETE FROM current_installed_paths;",
        )?;
        for application in applications {
            transaction.execute(
                "INSERT INTO current_installed_paths (executable_path) VALUES (?1)",
                [&application.executable_path],
            )?;
            transaction.execute(
                "INSERT INTO installed_applications (
                    name, executable_path, source, first_discovered_at_ms, last_discovered_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(executable_path) DO UPDATE SET
                    name = excluded.name,
                    source = excluded.source,
                    last_discovered_at_ms = excluded.last_discovered_at_ms",
                params![
                    application.name,
                    application.executable_path,
                    application.source,
                    observed_at_ms,
                ],
            )?;
        }
        transaction.execute(
            "DELETE FROM installed_applications
             WHERE NOT EXISTS (
                SELECT 1 FROM current_installed_paths current
                WHERE current.executable_path = installed_applications.executable_path
             )",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn record_process_snapshot(
        &self,
        processes: &[ObservedProcess],
        observed_at_ms: i64,
    ) -> Result<(), ApplicationInventoryError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS current_process_keys (
                process_id INTEGER NOT NULL,
                started_at_ms INTEGER NOT NULL,
                PRIMARY KEY (process_id, started_at_ms)
             ) WITHOUT ROWID;
             DELETE FROM current_process_keys;",
        )?;
        for process in processes {
            let process_id = i64::try_from(process.process_id).unwrap_or(i64::MAX);
            let memory_bytes = i64::try_from(process.memory_bytes).unwrap_or(i64::MAX);
            transaction.execute(
                "INSERT INTO current_process_keys (process_id, started_at_ms) VALUES (?1, ?2)",
                params![process_id, process.started_at_ms],
            )?;
            transaction.execute(
                "INSERT INTO process_runs (
                    process_id, name, executable_path, started_at_ms,
                    first_observed_at_ms, last_observed_at_ms,
                    cpu_usage_percent, memory_bytes
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)
                 ON CONFLICT(process_id, started_at_ms) DO UPDATE SET
                    name = excluded.name,
                    executable_path = excluded.executable_path,
                    last_observed_at_ms = excluded.last_observed_at_ms,
                    exited_at_ms = NULL,
                    cpu_usage_percent = excluded.cpu_usage_percent,
                    memory_bytes = excluded.memory_bytes",
                params![
                    process_id,
                    process.name,
                    process.executable_path,
                    process.started_at_ms,
                    observed_at_ms,
                    f64::from(finite_cpu_usage(process.cpu_usage_percent)),
                    memory_bytes,
                ],
            )?;
        }
        transaction.execute(
            "UPDATE process_runs
             SET exited_at_ms = ?1
             WHERE exited_at_ms IS NULL
               AND NOT EXISTS (
                    SELECT 1 FROM current_process_keys current
                    WHERE current.process_id = process_runs.process_id
                      AND current.started_at_ms = process_runs.started_at_ms
               )",
            [observed_at_ms],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn recover_interrupted_processes(&self) -> Result<usize, ApplicationInventoryError> {
        let connection = self.connect()?;
        Ok(connection.execute(
            "UPDATE process_runs
             SET exited_at_ms = last_observed_at_ms
             WHERE exited_at_ms IS NULL",
            [],
        )?)
    }

    fn installed_application_count(&self) -> Result<usize, ApplicationInventoryError> {
        let connection = self.connect()?;
        let count =
            connection.query_row("SELECT COUNT(*) FROM installed_applications", [], |row| {
                row.get::<_, i64>(0)
            })?;
        Ok(usize::try_from(count).unwrap_or(usize::MAX))
    }

    fn query_installed_applications(
        &self,
        query: &InstalledApplicationQuery,
    ) -> Result<Vec<InstalledApplicationRecord>, ApplicationInventoryError> {
        query.validate()?;
        let connection = self.connect()?;
        let (where_clause, mut values) = match &query.name_contains {
            Some(search) => (
                " WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE",
                vec![SqlValue::Text(format!("%{}%", escape_like(search)))],
            ),
            None => ("", Vec::new()),
        };
        values.push(SqlValue::Integer(query.limit as i64));
        let sql = format!(
            "SELECT id, name, executable_path, source,
                    first_discovered_at_ms, last_discovered_at_ms
             FROM installed_applications{where_clause}
             ORDER BY name COLLATE NOCASE, executable_path
             LIMIT ?"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| {
            let first_discovered_at_ms = row.get::<_, i64>(4)?;
            let last_discovered_at_ms = row.get::<_, i64>(5)?;
            Ok(InstalledApplicationRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                executable_path: row.get(2)?,
                source: row.get(3)?,
                first_discovered_at_ms,
                first_discovered_at: format_timestamp(first_discovered_at_ms),
                last_discovered_at_ms,
                last_discovered_at: format_timestamp(last_discovered_at_ms),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn query_processes(
        &self,
        query: &ProcessRunQuery,
    ) -> Result<Vec<ProcessRunRecord>, ApplicationInventoryError> {
        query.validate()?;
        let connection = self.connect()?;
        let mut clauses = Vec::new();
        let mut values = Vec::<SqlValue>::new();
        if query.running_only {
            clauses.push("exited_at_ms IS NULL");
        }
        if let Some(process_id) = query.process_id {
            clauses.push("process_id = ?");
            values.push(SqlValue::Integer(
                i64::try_from(process_id).unwrap_or(i64::MAX),
            ));
        }
        if let Some(search) = &query.name_contains {
            clauses.push("name LIKE ? ESCAPE '\\' COLLATE NOCASE");
            values.push(SqlValue::Text(format!("%{}%", escape_like(search))));
        }
        if let Some(from_ms) = query.from_ms {
            clauses.push("COALESCE(exited_at_ms, last_observed_at_ms) >= ?");
            values.push(SqlValue::Integer(from_ms));
        }
        if let Some(to_ms) = query.to_ms {
            clauses.push("started_at_ms <= ?");
            values.push(SqlValue::Integer(to_ms));
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        values.push(SqlValue::Integer(query.limit as i64));
        let sql = format!(
            "SELECT id, process_id, name, executable_path, started_at_ms,
                    first_observed_at_ms, last_observed_at_ms, exited_at_ms,
                    cpu_usage_percent, memory_bytes
             FROM process_runs{where_clause}
             ORDER BY last_observed_at_ms DESC, id DESC
             LIMIT ?"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| {
            let started_at_ms = row.get::<_, i64>(4)?;
            let first_observed_at_ms = row.get::<_, i64>(5)?;
            let last_observed_at_ms = row.get::<_, i64>(6)?;
            let exited_at_ms = row.get::<_, Option<i64>>(7)?;
            Ok(ProcessRunRecord {
                id: row.get(0)?,
                process_id: u64::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                name: row.get(2)?,
                executable_path: row.get(3)?,
                started_at_ms,
                started_at: format_timestamp(started_at_ms),
                first_observed_at_ms,
                first_observed_at: format_timestamp(first_observed_at_ms),
                last_observed_at_ms,
                last_observed_at: format_timestamp(last_observed_at_ms),
                exited_at_ms,
                exited_at: exited_at_ms.map(format_timestamp),
                cpu_usage_percent: row.get::<_, f64>(8)? as f32,
                memory_bytes: u64::try_from(row.get::<_, i64>(9)?).unwrap_or_default(),
                is_running: exited_at_ms.is_none(),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn initialize(&self) -> Result<(), ApplicationInventoryError> {
        let connection = self.connect()?;
        let version =
            connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
        if version > APPLICATION_SCHEMA_VERSION {
            return Err(ApplicationInventoryError::Configuration(format!(
                "application inventory database schema {version} is newer than supported schema {APPLICATION_SCHEMA_VERSION}"
            )));
        }
        if version == 0 {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS installed_applications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    executable_path TEXT NOT NULL UNIQUE,
                    source TEXT NOT NULL,
                    first_discovered_at_ms INTEGER NOT NULL,
                    last_discovered_at_ms INTEGER NOT NULL,
                    CHECK (last_discovered_at_ms >= first_discovered_at_ms)
                 );
                 CREATE INDEX IF NOT EXISTS installed_applications_name
                    ON installed_applications(name COLLATE NOCASE);
                 CREATE TABLE IF NOT EXISTS process_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    process_id INTEGER NOT NULL CHECK (process_id >= 0),
                    name TEXT NOT NULL,
                    executable_path TEXT NOT NULL,
                    started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
                    first_observed_at_ms INTEGER NOT NULL,
                    last_observed_at_ms INTEGER NOT NULL,
                    exited_at_ms INTEGER,
                    cpu_usage_percent REAL NOT NULL CHECK (cpu_usage_percent >= 0),
                    memory_bytes INTEGER NOT NULL CHECK (memory_bytes >= 0),
                    UNIQUE (process_id, started_at_ms),
                    CHECK (last_observed_at_ms >= first_observed_at_ms),
                    CHECK (exited_at_ms IS NULL OR exited_at_ms >= first_observed_at_ms)
                 );
                 CREATE INDEX IF NOT EXISTS process_runs_last_observed
                    ON process_runs(last_observed_at_ms DESC);
                 CREATE INDEX IF NOT EXISTS process_runs_running
                    ON process_runs(exited_at_ms) WHERE exited_at_ms IS NULL;
                 CREATE INDEX IF NOT EXISTS process_runs_name
                    ON process_runs(name COLLATE NOCASE, last_observed_at_ms DESC);
                 PRAGMA user_version = 1;",
            )?;
        }
        Ok(())
    }

    fn connect(&self) -> Result<Connection, ApplicationInventoryError> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(connection)
    }
}

#[cfg(target_os = "linux")]
fn collect_installed_applications()
-> Result<Vec<ObservedInstalledApplication>, ApplicationInventoryError> {
    let mut roots = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
    ];
    if let Some(data_home) = env::var_os("XDG_DATA_HOME") {
        roots.push(PathBuf::from(data_home).join("applications"));
    } else if let Some(home) = env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".local/share/applications"));
    }
    let mut applications = Vec::new();
    for root in roots {
        collect_linux_desktop_entries(&root, &mut applications)?;
    }
    normalize_installed_applications(applications)
}

#[cfg(target_os = "linux")]
fn collect_linux_desktop_entries(
    root: &Path,
    applications: &mut Vec<ObservedInstalledApplication>,
) -> Result<(), ApplicationInventoryError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries.flatten() {
        if applications.len() >= MAX_INSTALLED_APPLICATIONS {
            break;
        }
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("desktop") {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some(application) = parse_desktop_entry(&contents) {
            applications.push(application);
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn parse_desktop_entry(contents: &str) -> Option<ObservedInstalledApplication> {
    let mut in_desktop_entry = false;
    let mut name = None;
    let mut executable = None;
    let mut application_type = None;
    let mut hidden = false;
    for line in contents.lines().map(str::trim) {
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "Name" => name = non_empty(value),
            "Exec" => executable = desktop_entry_executable(value),
            "TryExec" if executable.is_none() => executable = non_empty(value),
            "Type" => application_type = non_empty(value),
            "Hidden" | "NoDisplay" if value.eq_ignore_ascii_case("true") => hidden = true,
            _ => {}
        }
    }
    if hidden
        || application_type
            .as_deref()
            .is_some_and(|value| value != "Application")
    {
        return None;
    }
    let executable_path = resolve_executable(&executable?);
    Some(ObservedInstalledApplication {
        name: name?,
        executable_path,
        source: "linuxDesktopEntry".to_owned(),
    })
}

#[cfg(target_os = "linux")]
fn desktop_entry_executable(value: &str) -> Option<String> {
    let value = value.trim();
    if let Some(quoted) = value.strip_prefix('"') {
        return quoted.split('"').next().and_then(non_empty);
    }
    value.split_whitespace().next().and_then(non_empty)
}

#[cfg(target_os = "linux")]
fn resolve_executable(value: &str) -> String {
    let path = Path::new(value);
    if path.is_absolute() {
        return path.to_string_lossy().into_owned();
    }
    env::var_os("PATH")
        .and_then(|paths| {
            env::split_paths(&paths)
                .map(|directory| directory.join(value))
                .find(|candidate| candidate.is_file())
        })
        .unwrap_or_else(|| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

#[cfg(target_os = "macos")]
fn collect_installed_applications()
-> Result<Vec<ObservedInstalledApplication>, ApplicationInventoryError> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    let mut applications = Vec::new();
    for root in roots {
        collect_application_files(&root, 4, "app", "macosBundle", &mut applications)?;
    }
    normalize_installed_applications(applications)
}

#[cfg(target_os = "windows")]
fn collect_installed_applications()
-> Result<Vec<ObservedInstalledApplication>, ApplicationInventoryError> {
    let mut roots = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(path) = env::var_os(variable) {
            roots.push(PathBuf::from(path));
        }
    }
    if let Some(path) = env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(path).join("Programs"));
    }
    let mut applications = Vec::new();
    for root in roots {
        collect_application_files(&root, 3, "exe", "windowsExecutable", &mut applications)?;
    }
    normalize_installed_applications(applications)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn collect_application_files(
    root: &Path,
    max_depth: usize,
    extension: &str,
    source: &str,
    applications: &mut Vec<ObservedInstalledApplication>,
) -> Result<(), ApplicationInventoryError> {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        if applications.len() >= MAX_INSTALLED_APPLICATIONS {
            break;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let matches_extension = path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(extension));
            if matches_extension {
                let name = path
                    .file_stem()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if !name.is_empty() {
                    applications.push(ObservedInstalledApplication {
                        name,
                        executable_path: path.to_string_lossy().into_owned(),
                        source: source.to_owned(),
                    });
                }
                if extension.eq_ignore_ascii_case("app") {
                    continue;
                }
            }
            if file_type.is_dir() && depth < max_depth {
                pending.push((path, depth + 1));
            }
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn collect_installed_applications()
-> Result<Vec<ObservedInstalledApplication>, ApplicationInventoryError> {
    Ok(Vec::new())
}

fn normalize_installed_applications(
    applications: Vec<ObservedInstalledApplication>,
) -> Result<Vec<ObservedInstalledApplication>, ApplicationInventoryError> {
    let mut seen = HashSet::new();
    let mut applications = applications
        .into_iter()
        .filter_map(|mut application| {
            application.name = application.name.trim().to_owned();
            application.executable_path = application.executable_path.trim().to_owned();
            if application.name.is_empty() || application.executable_path.is_empty() {
                return None;
            }
            let key = if cfg!(target_os = "windows") {
                application.executable_path.to_ascii_lowercase()
            } else {
                application.executable_path.clone()
            };
            seen.insert(key).then_some(application)
        })
        .collect::<Vec<_>>();
    applications.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then(left.executable_path.cmp(&right.executable_path))
    });
    applications.truncate(MAX_INSTALLED_APPLICATIONS);
    Ok(applications)
}

fn duration_from_environment(
    name: &str,
    default_ms: u64,
    minimum_ms: u64,
    maximum_ms: u64,
) -> Result<Duration, ApplicationInventoryError> {
    let value = match env::var(name) {
        Ok(value) => value.parse::<u64>().map_err(|error| {
            ApplicationInventoryError::Configuration(format!("{name} must be an integer: {error}"))
        })?,
        Err(_) => default_ms,
    };
    if !(minimum_ms..=maximum_ms).contains(&value) {
        return Err(ApplicationInventoryError::Configuration(format!(
            "{name} must be between {minimum_ms} and {maximum_ms}"
        )));
    }
    Ok(Duration::from_millis(value))
}

fn validate_query_limit(tool_name: &str, limit: usize) -> Result<(), ApplicationInventoryError> {
    if !(1..=MAX_QUERY_LIMIT).contains(&limit) {
        return Err(ApplicationInventoryError::Configuration(format!(
            "{tool_name} limit must be between 1 and {MAX_QUERY_LIMIT}"
        )));
    }
    Ok(())
}

fn validate_optional_search(
    tool_name: &str,
    search: Option<&str>,
) -> Result<(), ApplicationInventoryError> {
    if search.is_some_and(|value| value.trim().is_empty()) {
        return Err(ApplicationInventoryError::Configuration(format!(
            "{tool_name} nameContains cannot be empty"
        )));
    }
    Ok(())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn finite_cpu_usage(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

#[cfg(target_os = "linux")]
fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn format_timestamp(timestamp_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| "invalid-timestamp".to_owned())
}

fn default_query_limit() -> usize {
    100
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tempfile::TempDir;

    use super::*;

    struct FakeProvider {
        process_scan: AtomicUsize,
    }

    impl ApplicationInventoryProvider for FakeProvider {
        fn installed_applications(
            &self,
        ) -> Result<Vec<ObservedInstalledApplication>, ApplicationInventoryError> {
            Ok(vec![ObservedInstalledApplication {
                name: "Editor".to_owned(),
                executable_path: "/apps/editor".to_owned(),
                source: "test".to_owned(),
            }])
        }

        fn running_processes(&self) -> Result<Vec<ObservedProcess>, ApplicationInventoryError> {
            let scan = self.process_scan.fetch_add(1, Ordering::SeqCst);
            Ok(if scan < 2 {
                vec![ObservedProcess {
                    process_id: 42,
                    name: "Editor".to_owned(),
                    executable_path: "/apps/editor".to_owned(),
                    started_at_ms: 1_000,
                    cpu_usage_percent: 12.5 + scan as f32,
                    memory_bytes: 4_096 + scan as u64,
                }]
            } else {
                Vec::new()
            })
        }
    }

    fn test_store() -> (TempDir, ApplicationInventoryStore) {
        let directory = tempfile::tempdir().expect("create inventory test directory");
        let store = ApplicationInventoryStore::open(directory.path().join("applications.sqlite3"))
            .expect("open inventory database");
        (directory, store)
    }

    #[test]
    fn records_installed_applications_and_process_lifecycles() {
        let (_directory, store) = test_store();
        store
            .record_installed_applications(
                &[
                    ObservedInstalledApplication {
                        name: "Editor".to_owned(),
                        executable_path: "/apps/editor".to_owned(),
                        source: "test".to_owned(),
                    },
                    ObservedInstalledApplication {
                        name: "Browser".to_owned(),
                        executable_path: "/apps/browser".to_owned(),
                        source: "test".to_owned(),
                    },
                ],
                2_000,
            )
            .unwrap();
        store
            .record_installed_applications(
                &[ObservedInstalledApplication {
                    name: "Editor".to_owned(),
                    executable_path: "/apps/editor".to_owned(),
                    source: "test".to_owned(),
                }],
                2_500,
            )
            .unwrap();
        let process = ObservedProcess {
            process_id: 42,
            name: "Editor".to_owned(),
            executable_path: "/apps/editor".to_owned(),
            started_at_ms: 1_000,
            cpu_usage_percent: 10.5,
            memory_bytes: 4_096,
        };
        store
            .record_process_snapshot(std::slice::from_ref(&process), 2_000)
            .unwrap();
        store
            .record_process_snapshot(
                &[ObservedProcess {
                    cpu_usage_percent: 22.0,
                    memory_bytes: 8_192,
                    ..process
                }],
                3_000,
            )
            .unwrap();
        store.record_process_snapshot(&[], 4_000).unwrap();

        let installed = store
            .query_installed_applications(&InstalledApplicationQuery::default())
            .unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].name, "Editor");
        assert_eq!(installed[0].first_discovered_at_ms, 2_000);
        assert_eq!(installed[0].last_discovered_at_ms, 2_500);
        let processes = store.query_processes(&ProcessRunQuery::default()).unwrap();
        assert_eq!(processes.len(), 1);
        assert_eq!(processes[0].process_id, 42);
        assert_eq!(processes[0].started_at_ms, 1_000);
        assert_eq!(processes[0].last_observed_at_ms, 3_000);
        assert_eq!(processes[0].exited_at_ms, Some(4_000));
        assert_eq!(processes[0].cpu_usage_percent, 22.0);
        assert_eq!(processes[0].memory_bytes, 8_192);
        assert!(!processes[0].is_running);
    }

    #[tokio::test]
    async fn resident_service_persists_provider_snapshots() {
        let directory = tempfile::tempdir().expect("create inventory test directory");
        let service = ApplicationInventoryService::start(
            ApplicationInventoryConfig {
                database_path: directory.path().join("applications.sqlite3"),
                process_poll_interval: Duration::from_millis(50),
                installed_refresh_interval: Duration::from_secs(60),
            },
            Arc::new(FakeProvider {
                process_scan: AtomicUsize::new(0),
            }),
        )
        .expect("start application inventory service");
        tokio::time::sleep(Duration::from_millis(140)).await;

        let status = service.status();
        assert_eq!(status.state, ApplicationInventoryState::Running);
        assert_eq!(status.installed_application_count, 1);
        let processes = service.processes(&ProcessRunQuery::default()).unwrap();
        assert_eq!(processes.len(), 1);
        assert!(processes[0].exited_at_ms.is_some());
        service.shutdown().await;
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_linux_desktop_entries() {
        let application = parse_desktop_entry(
            "[Desktop Entry]\nType=Application\nName=WhaleHall\nExec=/opt/whalehall/bin/whalehall %U\n",
        )
        .expect("parse desktop entry");
        assert_eq!(application.name, "WhaleHall");
        assert_eq!(application.executable_path, "/opt/whalehall/bin/whalehall");
        assert_eq!(application.source, "linuxDesktopEntry");
    }
}
