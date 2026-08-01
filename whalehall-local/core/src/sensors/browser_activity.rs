//! Resident browser tab, history, search, and download sensor.
//!
//! Browser profile databases are copied with their WAL companions before they
//! are opened read-only. Current-tab observations come from a short-lived local
//! bridge snapshot on every platform, with a macOS front-browser fallback.

use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use directories::{BaseDirs, ProjectDirs};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_BROWSER_TAB_POLL_INTERVAL_MS: u64 = 1_000;
pub const DEFAULT_BROWSER_HISTORY_REFRESH_INTERVAL_MS: u64 = 5 * 60 * 1_000;
pub const DEFAULT_BROWSER_BRIDGE_MAX_AGE_MS: u64 = 15_000;
const BROWSER_SCHEMA_VERSION: i64 = 1;
const MAX_IMPORTED_RECORDS_PER_PROFILE: usize = 100_000;
const MAX_QUERY_LIMIT: usize = 1_000;
const CHROMIUM_TO_UNIX_EPOCH_MICROSECONDS: i64 = 11_644_473_600_000_000;
#[cfg(target_os = "macos")]
const SAFARI_TO_UNIX_EPOCH_SECONDS: i64 = 978_307_200;
static SNAPSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Error)]
pub enum BrowserActivityError {
    #[error("browser sensor configuration error: {0}")]
    Configuration(String),
    #[error("browser sensor I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("browser sensor SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("browser sensor collection error: {0}")]
    Collection(String),
}

#[derive(Clone, Debug)]
pub struct BrowserActivityConfig {
    pub database_path: PathBuf,
    pub bridge_path: PathBuf,
    pub snapshot_directory: PathBuf,
    pub custom_profile_root: Option<PathBuf>,
    pub tab_poll_interval: Duration,
    pub history_refresh_interval: Duration,
    pub bridge_max_age: Duration,
}

impl BrowserActivityConfig {
    pub fn from_environment() -> Result<Self, BrowserActivityError> {
        let data_dir = if let Some(path) = env::var_os("WHALEHALL_DATA_DIR") {
            PathBuf::from(path)
        } else {
            ProjectDirs::from("com", "seago", "whalehall")
                .ok_or_else(|| {
                    BrowserActivityError::Configuration(
                        "unable to resolve the operating system application data directory"
                            .to_owned(),
                    )
                })?
                .data_dir()
                .to_path_buf()
        };
        Ok(Self {
            database_path: data_dir.join("browser.sqlite3"),
            bridge_path: data_dir.join("browser-current-tabs.json"),
            snapshot_directory: data_dir.join(".browser-snapshots"),
            custom_profile_root: env::var_os("WHALEHALL_BROWSER_PROFILE_ROOT").map(PathBuf::from),
            tab_poll_interval: duration_from_environment(
                "WHALEHALL_BROWSER_TAB_POLL_MS",
                DEFAULT_BROWSER_TAB_POLL_INTERVAL_MS,
                50,
                60_000,
            )?,
            history_refresh_interval: duration_from_environment(
                "WHALEHALL_BROWSER_HISTORY_REFRESH_MS",
                DEFAULT_BROWSER_HISTORY_REFRESH_INTERVAL_MS,
                1_000,
                24 * 60 * 60 * 1_000,
            )?,
            bridge_max_age: duration_from_environment(
                "WHALEHALL_BROWSER_BRIDGE_MAX_AGE_MS",
                DEFAULT_BROWSER_BRIDGE_MAX_AGE_MS,
                1_000,
                5 * 60 * 1_000,
            )?,
        })
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BrowserSensorState {
    Starting,
    Running,
    Degraded,
    Stopped,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    pub current_tabs: bool,
    pub history: bool,
    pub downloads: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActivityStatus {
    pub state: BrowserSensorState,
    pub database_path: String,
    pub bridge_path: String,
    pub tab_poll_interval_ms: u64,
    pub history_refresh_interval_ms: u64,
    pub bridge_max_age_ms: u64,
    pub last_tab_scan_at_ms: Option<i64>,
    pub last_tab_scan_at: Option<String>,
    pub last_history_scan_at_ms: Option<i64>,
    pub last_history_scan_at: Option<String>,
    pub current_tab_count: usize,
    pub history_count: usize,
    pub search_count: usize,
    pub download_count: usize,
    pub profiles_scanned: usize,
    pub capabilities: BrowserCapabilities,
    pub current_tabs: Vec<BrowserTabSessionRecord>,
    pub warnings: Vec<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedBrowserTab {
    pub browser: String,
    pub profile: String,
    pub window_id: String,
    pub tab_id: String,
    pub title: String,
    pub url: String,
    pub audible: Option<bool>,
}

impl ObservedBrowserTab {
    fn session_key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            self.browser, self.profile, self.window_id, self.tab_id
        )
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrowserTabSnapshot {
    pub available: bool,
    pub tabs: Vec<ObservedBrowserTab>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedBrowserHistory {
    pub browser: String,
    pub profile: String,
    pub url: String,
    pub title: String,
    pub last_visited_at_ms: i64,
    pub visit_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedBrowserSearch {
    pub browser: String,
    pub profile: String,
    pub search_term: String,
    pub url: String,
    pub title: String,
    pub searched_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedBrowserDownload {
    pub browser: String,
    pub profile: String,
    pub source_id: String,
    pub url: String,
    pub target_path: String,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub state: String,
}

#[derive(Clone, Debug, Default)]
pub struct BrowserRecordsSnapshot {
    pub profiles_scanned: usize,
    pub history_supported: bool,
    pub downloads_supported: bool,
    pub history: Vec<ObservedBrowserHistory>,
    pub searches: Vec<ObservedBrowserSearch>,
    pub downloads: Vec<ObservedBrowserDownload>,
    pub warnings: Vec<String>,
}

pub trait BrowserActivityProvider: Send + Sync + 'static {
    fn current_tabs(&self) -> Result<BrowserTabSnapshot, BrowserActivityError>;
    fn browser_records(&self) -> Result<BrowserRecordsSnapshot, BrowserActivityError>;
}

pub struct SystemBrowserActivityProvider {
    config: BrowserActivityConfig,
}

impl SystemBrowserActivityProvider {
    pub fn new(config: BrowserActivityConfig) -> Self {
        Self { config }
    }
}

impl BrowserActivityProvider for SystemBrowserActivityProvider {
    fn current_tabs(&self) -> Result<BrowserTabSnapshot, BrowserActivityError> {
        if self.config.bridge_path.exists() {
            let bridge =
                read_bridge_snapshot(&self.config.bridge_path, self.config.bridge_max_age)?;
            if bridge.available {
                return Ok(bridge);
            }
            let mut fallback = platform_current_tabs()?;
            fallback.warnings.extend(bridge.warnings);
            fallback.warnings.sort();
            fallback.warnings.dedup();
            return Ok(fallback);
        }
        platform_current_tabs()
    }

    fn browser_records(&self) -> Result<BrowserRecordsSnapshot, BrowserActivityError> {
        collect_browser_records(&self.config)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabSessionRecord {
    pub id: i64,
    pub browser: String,
    pub profile: String,
    pub title: String,
    pub url: String,
    pub domain: String,
    pub audible: Option<bool>,
    pub started_at_ms: i64,
    pub started_at: String,
    pub last_seen_at_ms: i64,
    pub last_seen_at: String,
    pub ended_at_ms: Option<i64>,
    pub ended_at: Option<String>,
    pub is_current: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHistoryRecord {
    pub id: i64,
    pub browser: String,
    pub profile: String,
    pub url: String,
    pub domain: String,
    pub title: String,
    pub last_visited_at_ms: i64,
    pub last_visited_at: String,
    pub visit_count: u64,
    pub first_imported_at_ms: i64,
    pub first_imported_at: String,
    pub last_imported_at_ms: i64,
    pub last_imported_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSearchRecord {
    pub id: i64,
    pub browser: String,
    pub profile: String,
    pub search_term: String,
    pub url: String,
    pub domain: String,
    pub title: String,
    pub searched_at_ms: i64,
    pub searched_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadRecord {
    pub id: i64,
    pub browser: String,
    pub profile: String,
    pub url: String,
    pub domain: String,
    pub target_path: String,
    pub started_at_ms: i64,
    pub started_at: String,
    pub ended_at_ms: Option<i64>,
    pub ended_at: Option<String>,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub state: String,
    pub last_imported_at_ms: i64,
    pub last_imported_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserTabQuery {
    #[serde(default = "default_query_limit")]
    pub limit: usize,
    #[serde(default = "default_true")]
    pub current_only: bool,
    #[serde(default)]
    pub browser: Option<String>,
    #[serde(default)]
    pub domain_contains: Option<String>,
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
}

impl Default for BrowserTabQuery {
    fn default() -> Self {
        Self {
            limit: default_query_limit(),
            current_only: true,
            browser: None,
            domain_contains: None,
            from_ms: None,
            to_ms: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserHistoryQuery {
    #[serde(default = "default_query_limit")]
    pub limit: usize,
    #[serde(default)]
    pub browser: Option<String>,
    #[serde(default)]
    pub domain_contains: Option<String>,
    #[serde(default)]
    pub url_contains: Option<String>,
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
}

impl Default for BrowserHistoryQuery {
    fn default() -> Self {
        Self {
            limit: default_query_limit(),
            browser: None,
            domain_contains: None,
            url_contains: None,
            from_ms: None,
            to_ms: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSearchQuery {
    #[serde(default = "default_query_limit")]
    pub limit: usize,
    #[serde(default)]
    pub browser: Option<String>,
    #[serde(default)]
    pub term_contains: Option<String>,
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
}

impl Default for BrowserSearchQuery {
    fn default() -> Self {
        Self {
            limit: default_query_limit(),
            browser: None,
            term_contains: None,
            from_ms: None,
            to_ms: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserDownloadQuery {
    #[serde(default = "default_query_limit")]
    pub limit: usize,
    #[serde(default)]
    pub browser: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
}

impl Default for BrowserDownloadQuery {
    fn default() -> Self {
        Self {
            limit: default_query_limit(),
            browser: None,
            state: None,
            from_ms: None,
            to_ms: None,
        }
    }
}

trait ValidatedBrowserQuery {
    fn limit(&self) -> usize;
    fn range_start_ms(&self) -> Option<i64>;
    fn range_end_ms(&self) -> Option<i64>;
    fn optional_filters(&self) -> Vec<(&'static str, Option<&str>)>;

    fn validate(&self, tool: &str) -> Result<(), BrowserActivityError> {
        if self.limit() == 0 || self.limit() > MAX_QUERY_LIMIT {
            return Err(BrowserActivityError::Configuration(format!(
                "{tool} limit must be between 1 and {MAX_QUERY_LIMIT}"
            )));
        }
        if matches!((self.range_start_ms(), self.range_end_ms()), (Some(from), Some(to)) if from > to)
        {
            return Err(BrowserActivityError::Configuration(format!(
                "{tool} fromMs cannot be greater than toMs"
            )));
        }
        for (name, value) in self.optional_filters() {
            if value.is_some_and(|value| value.trim().is_empty()) {
                return Err(BrowserActivityError::Configuration(format!(
                    "{tool} {name} cannot be empty"
                )));
            }
        }
        Ok(())
    }
}

impl ValidatedBrowserQuery for BrowserTabQuery {
    fn limit(&self) -> usize {
        self.limit
    }
    fn range_start_ms(&self) -> Option<i64> {
        self.from_ms
    }
    fn range_end_ms(&self) -> Option<i64> {
        self.to_ms
    }
    fn optional_filters(&self) -> Vec<(&'static str, Option<&str>)> {
        vec![
            ("browser", self.browser.as_deref()),
            ("domainContains", self.domain_contains.as_deref()),
        ]
    }
}

impl ValidatedBrowserQuery for BrowserHistoryQuery {
    fn limit(&self) -> usize {
        self.limit
    }
    fn range_start_ms(&self) -> Option<i64> {
        self.from_ms
    }
    fn range_end_ms(&self) -> Option<i64> {
        self.to_ms
    }
    fn optional_filters(&self) -> Vec<(&'static str, Option<&str>)> {
        vec![
            ("browser", self.browser.as_deref()),
            ("domainContains", self.domain_contains.as_deref()),
            ("urlContains", self.url_contains.as_deref()),
        ]
    }
}

impl ValidatedBrowserQuery for BrowserSearchQuery {
    fn limit(&self) -> usize {
        self.limit
    }
    fn range_start_ms(&self) -> Option<i64> {
        self.from_ms
    }
    fn range_end_ms(&self) -> Option<i64> {
        self.to_ms
    }
    fn optional_filters(&self) -> Vec<(&'static str, Option<&str>)> {
        vec![
            ("browser", self.browser.as_deref()),
            ("termContains", self.term_contains.as_deref()),
        ]
    }
}

impl ValidatedBrowserQuery for BrowserDownloadQuery {
    fn limit(&self) -> usize {
        self.limit
    }
    fn range_start_ms(&self) -> Option<i64> {
        self.from_ms
    }
    fn range_end_ms(&self) -> Option<i64> {
        self.to_ms
    }
    fn optional_filters(&self) -> Vec<(&'static str, Option<&str>)> {
        vec![
            ("browser", self.browser.as_deref()),
            ("state", self.state.as_deref()),
        ]
    }
}

impl BrowserTabQuery {
    pub fn validate(&self) -> Result<(), BrowserActivityError> {
        ValidatedBrowserQuery::validate(self, "browser.tabs")
    }
}

impl BrowserHistoryQuery {
    pub fn validate(&self) -> Result<(), BrowserActivityError> {
        ValidatedBrowserQuery::validate(self, "browser.history")
    }
}

impl BrowserSearchQuery {
    pub fn validate(&self) -> Result<(), BrowserActivityError> {
        ValidatedBrowserQuery::validate(self, "browser.searches")
    }
}

impl BrowserDownloadQuery {
    pub fn validate(&self) -> Result<(), BrowserActivityError> {
        ValidatedBrowserQuery::validate(self, "browser.downloads")
    }
}

#[derive(Clone)]
pub struct BrowserActivityService {
    inner: Arc<BrowserActivityInner>,
}

struct BrowserActivityInner {
    config: BrowserActivityConfig,
    store: BrowserActivityStore,
    status: Mutex<BrowserActivityStatus>,
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl BrowserActivityService {
    pub fn start(
        config: BrowserActivityConfig,
        provider: Arc<dyn BrowserActivityProvider>,
    ) -> Result<Self, BrowserActivityError> {
        let store = BrowserActivityStore::open(&config.database_path)?;
        store.recover_open_tabs()?;
        let status = BrowserActivityStatus {
            state: BrowserSensorState::Starting,
            database_path: config.database_path.to_string_lossy().into_owned(),
            bridge_path: config.bridge_path.to_string_lossy().into_owned(),
            tab_poll_interval_ms: duration_ms_u64(config.tab_poll_interval),
            history_refresh_interval_ms: duration_ms_u64(config.history_refresh_interval),
            bridge_max_age_ms: duration_ms_u64(config.bridge_max_age),
            last_tab_scan_at_ms: None,
            last_tab_scan_at: None,
            last_history_scan_at_ms: None,
            last_history_scan_at: None,
            current_tab_count: 0,
            history_count: store.count("browser_history")?,
            search_count: store.count("browser_searches")?,
            download_count: store.count("browser_downloads")?,
            profiles_scanned: 0,
            capabilities: BrowserCapabilities::default(),
            current_tabs: Vec::new(),
            warnings: Vec::new(),
            last_error: None,
        };
        let inner = Arc::new(BrowserActivityInner {
            config,
            store,
            status: Mutex::new(status),
            cancellation: CancellationToken::new(),
            task: Mutex::new(None),
        });
        let task = tokio::spawn(run_browser_monitor(inner.clone(), provider));
        *inner.task.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
        Ok(Self { inner })
    }

    pub fn status(&self) -> BrowserActivityStatus {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn tabs(
        &self,
        query: &BrowserTabQuery,
    ) -> Result<Vec<BrowserTabSessionRecord>, BrowserActivityError> {
        self.inner.store.query_tabs(query)
    }

    pub fn history(
        &self,
        query: &BrowserHistoryQuery,
    ) -> Result<Vec<BrowserHistoryRecord>, BrowserActivityError> {
        self.inner.store.query_history(query)
    }

    pub fn searches(
        &self,
        query: &BrowserSearchQuery,
    ) -> Result<Vec<BrowserSearchRecord>, BrowserActivityError> {
        self.inner.store.query_searches(query)
    }

    pub fn downloads(
        &self,
        query: &BrowserDownloadQuery,
    ) -> Result<Vec<BrowserDownloadRecord>, BrowserActivityError> {
        self.inner.store.query_downloads(query)
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
        let _ = self.inner.store.close_open_tabs(now_ms());
    }
}

#[derive(Default)]
struct BrowserRuntimeStatus {
    tab_warnings: Vec<String>,
    record_warnings: Vec<String>,
    capabilities: BrowserCapabilities,
    profiles_scanned: usize,
}

async fn run_browser_monitor(
    inner: Arc<BrowserActivityInner>,
    provider: Arc<dyn BrowserActivityProvider>,
) {
    let mut tab_ticker = interval(inner.config.tab_poll_interval);
    tab_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut history_ticker = interval(inner.config.history_refresh_interval);
    history_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut runtime = BrowserRuntimeStatus::default();

    loop {
        tokio::select! {
            () = inner.cancellation.cancelled() => {
                inner.status
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .state = BrowserSensorState::Stopped;
                break;
            }
            _ = tab_ticker.tick() => {
                let observed_at_ms = now_ms();
                let result = tokio::task::spawn_blocking({
                    let provider = provider.clone();
                    move || provider.current_tabs()
                })
                .await
                .map_err(|error| BrowserActivityError::Collection(
                    format!("browser tab observation task failed: {error}")
                ))
                .and_then(|result| result);
                match result {
                    Ok(snapshot) => {
                        runtime.capabilities.current_tabs = snapshot.available;
                        runtime.tab_warnings = snapshot.warnings.clone();
                        if snapshot.available
                            && let Err(error) = inner.store.record_tab_snapshot(
                                &snapshot.tabs,
                                observed_at_ms,
                            )
                        {
                            runtime.tab_warnings.push(error.to_string());
                        }
                        update_browser_status(
                            &inner,
                            &runtime,
                            Some(observed_at_ms),
                            None,
                        );
                    }
                    Err(error) => {
                        runtime.capabilities.current_tabs = false;
                        runtime.tab_warnings = vec![error.to_string()];
                        update_browser_status(&inner, &runtime, Some(observed_at_ms), None);
                    }
                }
            }
            _ = history_ticker.tick() => {
                let observed_at_ms = now_ms();
                let result = tokio::task::spawn_blocking({
                    let provider = provider.clone();
                    move || provider.browser_records()
                })
                .await
                .map_err(|error| BrowserActivityError::Collection(
                    format!("browser record collection task failed: {error}")
                ))
                .and_then(|result| result);
                match result {
                    Ok(snapshot) => {
                        runtime.capabilities.history = snapshot.history_supported;
                        runtime.capabilities.downloads = snapshot.downloads_supported;
                        runtime.profiles_scanned = snapshot.profiles_scanned;
                        runtime.record_warnings = snapshot.warnings.clone();
                        if let Err(error) = inner.store.import_records(&snapshot, observed_at_ms) {
                            runtime.record_warnings.push(error.to_string());
                        }
                        update_browser_status(
                            &inner,
                            &runtime,
                            None,
                            Some(observed_at_ms),
                        );
                    }
                    Err(error) => {
                        runtime.capabilities.history = false;
                        runtime.capabilities.downloads = false;
                        runtime.record_warnings = vec![error.to_string()];
                        update_browser_status(&inner, &runtime, None, Some(observed_at_ms));
                    }
                }
            }
        }
    }
}

fn update_browser_status(
    inner: &BrowserActivityInner,
    runtime: &BrowserRuntimeStatus,
    tab_scan_at_ms: Option<i64>,
    history_scan_at_ms: Option<i64>,
) {
    let mut warnings = runtime.tab_warnings.clone();
    warnings.extend(runtime.record_warnings.clone());
    warnings.sort();
    warnings.dedup();
    let current_tabs = inner
        .store
        .query_tabs(&BrowserTabQuery {
            limit: MAX_QUERY_LIMIT,
            ..BrowserTabQuery::default()
        })
        .unwrap_or_default();
    let counts = (
        inner.store.count("browser_history").unwrap_or_default(),
        inner.store.count("browser_searches").unwrap_or_default(),
        inner.store.count("browser_downloads").unwrap_or_default(),
    );
    let fully_available = runtime.capabilities.current_tabs
        && runtime.capabilities.history
        && runtime.capabilities.downloads;
    let last_error = (!warnings.is_empty()).then(|| warnings.join("; "));
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    status.state = if fully_available {
        BrowserSensorState::Running
    } else {
        BrowserSensorState::Degraded
    };
    if let Some(value) = tab_scan_at_ms {
        status.last_tab_scan_at_ms = Some(value);
        status.last_tab_scan_at = Some(format_timestamp(value));
    }
    if let Some(value) = history_scan_at_ms {
        status.last_history_scan_at_ms = Some(value);
        status.last_history_scan_at = Some(format_timestamp(value));
    }
    status.current_tab_count = current_tabs.len();
    status.history_count = counts.0;
    status.search_count = counts.1;
    status.download_count = counts.2;
    status.profiles_scanned = runtime.profiles_scanned;
    status.capabilities = runtime.capabilities.clone();
    status.current_tabs = current_tabs;
    status.warnings = warnings;
    status.last_error = last_error;
}

#[derive(Clone, Debug)]
struct BrowserActivityStore {
    path: PathBuf,
}

impl BrowserActivityStore {
    fn open(path: impl Into<PathBuf>) -> Result<Self, BrowserActivityError> {
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

    fn record_tab_snapshot(
        &self,
        tabs: &[ObservedBrowserTab],
        observed_at_ms: i64,
    ) -> Result<(), BrowserActivityError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut open = {
            let mut statement = transaction.prepare(
                "SELECT id, session_key, url FROM browser_tab_sessions WHERE ended_at_ms IS NULL",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            let mut open = HashMap::new();
            for row in rows {
                let (id, session_key, url) = row?;
                open.insert(session_key.clone(), (id, session_key, url));
            }
            open
        };
        let mut observed_keys = HashSet::new();
        for tab in tabs
            .iter()
            .filter(|tab| !tab.url.trim().is_empty())
            .take(MAX_QUERY_LIMIT)
        {
            let session_key = tab.session_key();
            observed_keys.insert(session_key.clone());
            match open.remove(&session_key) {
                Some((id, _, open_url)) if open_url == tab.url => {
                    transaction.execute(
                        "UPDATE browser_tab_sessions
                         SET title = ?1, domain = ?2, audible = ?3, last_seen_at_ms = ?4
                         WHERE id = ?5",
                        params![
                            tab.title,
                            domain_from_url(&tab.url),
                            tab.audible,
                            observed_at_ms,
                            id
                        ],
                    )?;
                }
                Some((id, _, _)) => {
                    transaction.execute(
                        "UPDATE browser_tab_sessions
                         SET ended_at_ms = ?1, last_seen_at_ms = ?1 WHERE id = ?2",
                        params![observed_at_ms, id],
                    )?;
                    insert_tab_session(&transaction, tab, &session_key, observed_at_ms)?;
                }
                None => insert_tab_session(&transaction, tab, &session_key, observed_at_ms)?,
            }
        }
        for (_, (id, session_key, _)) in open {
            if !observed_keys.contains(&session_key) {
                transaction.execute(
                    "UPDATE browser_tab_sessions
                     SET ended_at_ms = ?1, last_seen_at_ms = ?1 WHERE id = ?2",
                    params![observed_at_ms, id],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    fn import_records(
        &self,
        snapshot: &BrowserRecordsSnapshot,
        imported_at_ms: i64,
    ) -> Result<(), BrowserActivityError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for record in &snapshot.history {
            transaction.execute(
                "INSERT INTO browser_history (
                    browser, profile, url, domain, title, last_visited_at_ms,
                    visit_count, first_imported_at_ms, last_imported_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT(browser, profile, url) DO UPDATE SET
                    domain = excluded.domain,
                    title = excluded.title,
                    last_visited_at_ms = excluded.last_visited_at_ms,
                    visit_count = excluded.visit_count,
                    last_imported_at_ms = excluded.last_imported_at_ms",
                params![
                    record.browser,
                    record.profile,
                    record.url,
                    domain_from_url(&record.url),
                    record.title,
                    record.last_visited_at_ms,
                    i64::try_from(record.visit_count).unwrap_or(i64::MAX),
                    imported_at_ms,
                ],
            )?;
        }
        for record in &snapshot.searches {
            transaction.execute(
                "INSERT INTO browser_searches (
                    browser, profile, search_term, url, domain, title, searched_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(browser, profile, search_term, url, searched_at_ms)
                 DO UPDATE SET title = excluded.title, domain = excluded.domain",
                params![
                    record.browser,
                    record.profile,
                    record.search_term,
                    record.url,
                    domain_from_url(&record.url),
                    record.title,
                    record.searched_at_ms,
                ],
            )?;
        }
        for record in &snapshot.downloads {
            transaction.execute(
                "INSERT INTO browser_downloads (
                    browser, profile, source_id, url, domain, target_path,
                    started_at_ms, ended_at_ms, received_bytes, total_bytes,
                    state, last_imported_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(browser, profile, source_id) DO UPDATE SET
                    url = excluded.url,
                    domain = excluded.domain,
                    target_path = excluded.target_path,
                    started_at_ms = excluded.started_at_ms,
                    ended_at_ms = excluded.ended_at_ms,
                    received_bytes = excluded.received_bytes,
                    total_bytes = excluded.total_bytes,
                    state = excluded.state,
                    last_imported_at_ms = excluded.last_imported_at_ms",
                params![
                    record.browser,
                    record.profile,
                    record.source_id,
                    record.url,
                    domain_from_url(&record.url),
                    record.target_path,
                    record.started_at_ms,
                    record.ended_at_ms,
                    i64::try_from(record.received_bytes).unwrap_or(i64::MAX),
                    i64::try_from(record.total_bytes).unwrap_or(i64::MAX),
                    record.state,
                    imported_at_ms,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn query_tabs(
        &self,
        query: &BrowserTabQuery,
    ) -> Result<Vec<BrowserTabSessionRecord>, BrowserActivityError> {
        query.validate()?;
        let connection = self.connect()?;
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        if query.current_only {
            clauses.push("ended_at_ms IS NULL");
        }
        add_text_filter(
            &mut clauses,
            &mut values,
            "browser = ? COLLATE NOCASE",
            query.browser.as_deref(),
            false,
        );
        add_text_filter(
            &mut clauses,
            &mut values,
            "domain LIKE ? ESCAPE '\\' COLLATE NOCASE",
            query.domain_contains.as_deref(),
            true,
        );
        add_time_filters(
            &mut clauses,
            &mut values,
            "COALESCE(ended_at_ms, last_seen_at_ms)",
            "started_at_ms",
            query.from_ms,
            query.to_ms,
        );
        values.push(SqlValue::Integer(query.limit as i64));
        let sql = format!(
            "SELECT id, browser, profile, title, url, domain, audible,
                    started_at_ms, last_seen_at_ms, ended_at_ms
             FROM browser_tab_sessions{}
             ORDER BY last_seen_at_ms DESC, id DESC LIMIT ?",
            where_clause(&clauses)
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), map_tab_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn query_history(
        &self,
        query: &BrowserHistoryQuery,
    ) -> Result<Vec<BrowserHistoryRecord>, BrowserActivityError> {
        query.validate()?;
        let connection = self.connect()?;
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        add_text_filter(
            &mut clauses,
            &mut values,
            "browser = ? COLLATE NOCASE",
            query.browser.as_deref(),
            false,
        );
        add_text_filter(
            &mut clauses,
            &mut values,
            "domain LIKE ? ESCAPE '\\' COLLATE NOCASE",
            query.domain_contains.as_deref(),
            true,
        );
        add_text_filter(
            &mut clauses,
            &mut values,
            "url LIKE ? ESCAPE '\\' COLLATE NOCASE",
            query.url_contains.as_deref(),
            true,
        );
        add_time_filters(
            &mut clauses,
            &mut values,
            "last_visited_at_ms",
            "last_visited_at_ms",
            query.from_ms,
            query.to_ms,
        );
        values.push(SqlValue::Integer(query.limit as i64));
        let sql = format!(
            "SELECT id, browser, profile, url, domain, title, last_visited_at_ms,
                    visit_count, first_imported_at_ms, last_imported_at_ms
             FROM browser_history{}
             ORDER BY last_visited_at_ms DESC, id DESC LIMIT ?",
            where_clause(&clauses)
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| {
            let last_visited_at_ms = row.get::<_, i64>(6)?;
            let first_imported_at_ms = row.get::<_, i64>(8)?;
            let last_imported_at_ms = row.get::<_, i64>(9)?;
            Ok(BrowserHistoryRecord {
                id: row.get(0)?,
                browser: row.get(1)?,
                profile: row.get(2)?,
                url: row.get(3)?,
                domain: row.get(4)?,
                title: row.get(5)?,
                last_visited_at_ms,
                last_visited_at: format_timestamp(last_visited_at_ms),
                visit_count: u64::try_from(row.get::<_, i64>(7)?).unwrap_or_default(),
                first_imported_at_ms,
                first_imported_at: format_timestamp(first_imported_at_ms),
                last_imported_at_ms,
                last_imported_at: format_timestamp(last_imported_at_ms),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn query_searches(
        &self,
        query: &BrowserSearchQuery,
    ) -> Result<Vec<BrowserSearchRecord>, BrowserActivityError> {
        query.validate()?;
        let connection = self.connect()?;
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        add_text_filter(
            &mut clauses,
            &mut values,
            "browser = ? COLLATE NOCASE",
            query.browser.as_deref(),
            false,
        );
        add_text_filter(
            &mut clauses,
            &mut values,
            "search_term LIKE ? ESCAPE '\\' COLLATE NOCASE",
            query.term_contains.as_deref(),
            true,
        );
        add_time_filters(
            &mut clauses,
            &mut values,
            "searched_at_ms",
            "searched_at_ms",
            query.from_ms,
            query.to_ms,
        );
        values.push(SqlValue::Integer(query.limit as i64));
        let sql = format!(
            "SELECT id, browser, profile, search_term, url, domain, title, searched_at_ms
             FROM browser_searches{}
             ORDER BY searched_at_ms DESC, id DESC LIMIT ?",
            where_clause(&clauses)
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| {
            let searched_at_ms = row.get::<_, i64>(7)?;
            Ok(BrowserSearchRecord {
                id: row.get(0)?,
                browser: row.get(1)?,
                profile: row.get(2)?,
                search_term: row.get(3)?,
                url: row.get(4)?,
                domain: row.get(5)?,
                title: row.get(6)?,
                searched_at_ms,
                searched_at: format_timestamp(searched_at_ms),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn query_downloads(
        &self,
        query: &BrowserDownloadQuery,
    ) -> Result<Vec<BrowserDownloadRecord>, BrowserActivityError> {
        query.validate()?;
        let connection = self.connect()?;
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        add_text_filter(
            &mut clauses,
            &mut values,
            "browser = ? COLLATE NOCASE",
            query.browser.as_deref(),
            false,
        );
        add_text_filter(
            &mut clauses,
            &mut values,
            "state = ? COLLATE NOCASE",
            query.state.as_deref(),
            false,
        );
        add_time_filters(
            &mut clauses,
            &mut values,
            "COALESCE(ended_at_ms, started_at_ms)",
            "started_at_ms",
            query.from_ms,
            query.to_ms,
        );
        values.push(SqlValue::Integer(query.limit as i64));
        let sql = format!(
            "SELECT id, browser, profile, url, domain, target_path, started_at_ms,
                    ended_at_ms, received_bytes, total_bytes, state, last_imported_at_ms
             FROM browser_downloads{}
             ORDER BY started_at_ms DESC, id DESC LIMIT ?",
            where_clause(&clauses)
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| {
            let started_at_ms = row.get::<_, i64>(6)?;
            let ended_at_ms = row.get::<_, Option<i64>>(7)?;
            let last_imported_at_ms = row.get::<_, i64>(11)?;
            Ok(BrowserDownloadRecord {
                id: row.get(0)?,
                browser: row.get(1)?,
                profile: row.get(2)?,
                url: row.get(3)?,
                domain: row.get(4)?,
                target_path: row.get(5)?,
                started_at_ms,
                started_at: format_timestamp(started_at_ms),
                ended_at_ms,
                ended_at: ended_at_ms.map(format_timestamp),
                received_bytes: u64::try_from(row.get::<_, i64>(8)?).unwrap_or_default(),
                total_bytes: u64::try_from(row.get::<_, i64>(9)?).unwrap_or_default(),
                state: row.get(10)?,
                last_imported_at_ms,
                last_imported_at: format_timestamp(last_imported_at_ms),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn recover_open_tabs(&self) -> Result<usize, BrowserActivityError> {
        let connection = self.connect()?;
        Ok(connection.execute(
            "UPDATE browser_tab_sessions
             SET ended_at_ms = last_seen_at_ms
             WHERE ended_at_ms IS NULL",
            [],
        )?)
    }

    fn close_open_tabs(&self, ended_at_ms: i64) -> Result<usize, BrowserActivityError> {
        let connection = self.connect()?;
        Ok(connection.execute(
            "UPDATE browser_tab_sessions
             SET ended_at_ms = ?1, last_seen_at_ms = ?1
             WHERE ended_at_ms IS NULL",
            [ended_at_ms],
        )?)
    }

    fn count(&self, table: &str) -> Result<usize, BrowserActivityError> {
        let allowed = ["browser_history", "browser_searches", "browser_downloads"];
        if !allowed.contains(&table) {
            return Err(BrowserActivityError::Configuration(format!(
                "unsupported browser count table: {table}"
            )));
        }
        let connection = self.connect()?;
        let count = connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })?;
        Ok(usize::try_from(count).unwrap_or(usize::MAX))
    }

    fn initialize(&self) -> Result<(), BrowserActivityError> {
        let connection = self.connect()?;
        let current_version =
            connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
        if current_version > BROWSER_SCHEMA_VERSION {
            return Err(BrowserActivityError::Configuration(format!(
                "browser database schema version {current_version} is newer than supported version {BROWSER_SCHEMA_VERSION}"
            )));
        }
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS browser_tab_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_key TEXT NOT NULL,
                browser TEXT NOT NULL,
                profile TEXT NOT NULL,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                domain TEXT NOT NULL,
                audible INTEGER,
                started_at_ms INTEGER NOT NULL,
                last_seen_at_ms INTEGER NOT NULL,
                ended_at_ms INTEGER
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_tab_open_key
                ON browser_tab_sessions(session_key) WHERE ended_at_ms IS NULL;
             CREATE INDEX IF NOT EXISTS idx_browser_tab_time
                ON browser_tab_sessions(started_at_ms DESC, ended_at_ms);
             CREATE TABLE IF NOT EXISTS browser_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                browser TEXT NOT NULL,
                profile TEXT NOT NULL,
                url TEXT NOT NULL,
                domain TEXT NOT NULL,
                title TEXT NOT NULL,
                last_visited_at_ms INTEGER NOT NULL,
                visit_count INTEGER NOT NULL,
                first_imported_at_ms INTEGER NOT NULL,
                last_imported_at_ms INTEGER NOT NULL,
                UNIQUE(browser, profile, url)
             );
             CREATE INDEX IF NOT EXISTS idx_browser_history_visit
                ON browser_history(last_visited_at_ms DESC);
             CREATE INDEX IF NOT EXISTS idx_browser_history_domain
                ON browser_history(domain, last_visited_at_ms DESC);
             CREATE TABLE IF NOT EXISTS browser_searches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                browser TEXT NOT NULL,
                profile TEXT NOT NULL,
                search_term TEXT NOT NULL,
                url TEXT NOT NULL,
                domain TEXT NOT NULL,
                title TEXT NOT NULL,
                searched_at_ms INTEGER NOT NULL,
                UNIQUE(browser, profile, search_term, url, searched_at_ms)
             );
             CREATE INDEX IF NOT EXISTS idx_browser_search_time
                ON browser_searches(searched_at_ms DESC);
             CREATE TABLE IF NOT EXISTS browser_downloads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                browser TEXT NOT NULL,
                profile TEXT NOT NULL,
                source_id TEXT NOT NULL,
                url TEXT NOT NULL,
                domain TEXT NOT NULL,
                target_path TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL,
                ended_at_ms INTEGER,
                received_bytes INTEGER NOT NULL,
                total_bytes INTEGER NOT NULL,
                state TEXT NOT NULL,
                last_imported_at_ms INTEGER NOT NULL,
                UNIQUE(browser, profile, source_id)
             );
             CREATE INDEX IF NOT EXISTS idx_browser_download_time
                ON browser_downloads(started_at_ms DESC);
             PRAGMA user_version = 1;",
        )?;
        Ok(())
    }

    fn connect(&self) -> Result<Connection, BrowserActivityError> {
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

fn insert_tab_session(
    transaction: &Transaction<'_>,
    tab: &ObservedBrowserTab,
    session_key: &str,
    observed_at_ms: i64,
) -> Result<(), rusqlite::Error> {
    transaction.execute(
        "INSERT INTO browser_tab_sessions (
            session_key, browser, profile, title, url, domain, audible,
            started_at_ms, last_seen_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            session_key,
            tab.browser,
            tab.profile,
            tab.title,
            tab.url,
            domain_from_url(&tab.url),
            tab.audible,
            observed_at_ms,
        ],
    )?;
    Ok(())
}

fn map_tab_row(row: &rusqlite::Row<'_>) -> Result<BrowserTabSessionRecord, rusqlite::Error> {
    let started_at_ms = row.get::<_, i64>(7)?;
    let last_seen_at_ms = row.get::<_, i64>(8)?;
    let ended_at_ms = row.get::<_, Option<i64>>(9)?;
    Ok(BrowserTabSessionRecord {
        id: row.get(0)?,
        browser: row.get(1)?,
        profile: row.get(2)?,
        title: row.get(3)?,
        url: row.get(4)?,
        domain: row.get(5)?,
        audible: row.get(6)?,
        started_at_ms,
        started_at: format_timestamp(started_at_ms),
        last_seen_at_ms,
        last_seen_at: format_timestamp(last_seen_at_ms),
        ended_at_ms,
        ended_at: ended_at_ms.map(format_timestamp),
        is_current: ended_at_ms.is_none(),
    })
}

fn add_text_filter(
    clauses: &mut Vec<&'static str>,
    values: &mut Vec<SqlValue>,
    clause: &'static str,
    value: Option<&str>,
    contains: bool,
) {
    if let Some(value) = value {
        clauses.push(clause);
        values.push(SqlValue::Text(if contains {
            format!("%{}%", escape_like(value))
        } else {
            value.to_owned()
        }));
    }
}

fn add_time_filters(
    clauses: &mut Vec<&'static str>,
    values: &mut Vec<SqlValue>,
    from_column: &'static str,
    to_column: &'static str,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
) {
    if let Some(from_ms) = from_ms {
        clauses.push(match from_column {
            "COALESCE(ended_at_ms, last_seen_at_ms)" => {
                "COALESCE(ended_at_ms, last_seen_at_ms) >= ?"
            }
            "COALESCE(ended_at_ms, started_at_ms)" => "COALESCE(ended_at_ms, started_at_ms) >= ?",
            "last_visited_at_ms" => "last_visited_at_ms >= ?",
            "searched_at_ms" => "searched_at_ms >= ?",
            _ => "started_at_ms >= ?",
        });
        values.push(SqlValue::Integer(from_ms));
    }
    if let Some(to_ms) = to_ms {
        clauses.push(match to_column {
            "last_visited_at_ms" => "last_visited_at_ms <= ?",
            "searched_at_ms" => "searched_at_ms <= ?",
            _ => "started_at_ms <= ?",
        });
        values.push(SqlValue::Integer(to_ms));
    }
}

fn where_clause(clauses: &[&str]) -> String {
    if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeSnapshot {
    #[serde(default)]
    observed_at_ms: Option<i64>,
    tabs: Vec<BridgeTab>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeTab {
    browser: String,
    #[serde(default = "default_profile")]
    profile: String,
    #[serde(default)]
    window_id: String,
    #[serde(default)]
    tab_id: String,
    #[serde(default)]
    title: String,
    url: String,
    #[serde(default)]
    audible: Option<bool>,
}

fn read_bridge_snapshot(
    path: &Path,
    maximum_age: Duration,
) -> Result<BrowserTabSnapshot, BrowserActivityError> {
    let bytes = fs::read(path)?;
    let snapshot: BridgeSnapshot = serde_json::from_slice(&bytes).map_err(|error| {
        BrowserActivityError::Collection(format!(
            "browser bridge snapshot {} is invalid: {error}",
            path.display()
        ))
    })?;
    let observed_at_ms = snapshot.observed_at_ms.unwrap_or_else(|| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .map(system_time_ms)
            .unwrap_or_default()
    });
    let age_ms = now_ms().saturating_sub(observed_at_ms);
    if age_ms > duration_ms_i64(maximum_age) {
        return Ok(BrowserTabSnapshot {
            available: false,
            tabs: Vec::new(),
            warnings: vec![format!(
                "browser bridge snapshot is stale by {age_ms} milliseconds"
            )],
        });
    }
    let tabs = snapshot
        .tabs
        .into_iter()
        .enumerate()
        .filter(|(_, tab)| !tab.url.trim().is_empty())
        .map(|(index, tab)| ObservedBrowserTab {
            browser: non_empty_or(tab.browser, "unknown"),
            profile: non_empty_or(tab.profile, "Default"),
            window_id: non_empty_or(tab.window_id, "window"),
            tab_id: non_empty_or(tab.tab_id, &index.to_string()),
            title: tab.title,
            url: tab.url,
            audible: tab.audible,
        })
        .collect();
    Ok(BrowserTabSnapshot {
        available: true,
        tabs,
        warnings: Vec::new(),
    })
}

#[derive(Clone, Copy, Debug)]
enum BrowserProfileKind {
    Chromium,
    Firefox,
    #[cfg(target_os = "macos")]
    Safari,
}

#[derive(Clone, Debug)]
struct BrowserProfile {
    browser: String,
    profile: String,
    kind: BrowserProfileKind,
    history_path: PathBuf,
    firefox_downloads_path: Option<PathBuf>,
}

fn collect_browser_records(
    config: &BrowserActivityConfig,
) -> Result<BrowserRecordsSnapshot, BrowserActivityError> {
    let profiles = discover_browser_profiles(config);
    let mut snapshot = BrowserRecordsSnapshot::default();
    if profiles.is_empty() {
        snapshot
            .warnings
            .push("no supported browser profiles were discovered".to_owned());
        return Ok(snapshot);
    }
    for profile in profiles {
        match collect_profile_records(&profile, &config.snapshot_directory) {
            Ok(records) => {
                snapshot.profiles_scanned += 1;
                snapshot.history_supported |= records.history_supported;
                snapshot.downloads_supported |= records.downloads_supported;
                snapshot.history.extend(records.history);
                snapshot.searches.extend(records.searches);
                snapshot.downloads.extend(records.downloads);
                snapshot.warnings.extend(records.warnings);
            }
            Err(error) => snapshot.warnings.push(format!(
                "{} profile {} could not be imported: {error}",
                profile.browser, profile.profile
            )),
        }
    }
    if snapshot.profiles_scanned == 0 {
        snapshot
            .warnings
            .push("all discovered browser profiles failed to import".to_owned());
    }
    Ok(snapshot)
}

fn collect_profile_records(
    profile: &BrowserProfile,
    snapshot_root: &Path,
) -> Result<BrowserRecordsSnapshot, BrowserActivityError> {
    let database_snapshot = DatabaseSnapshot::copy(&profile.history_path, snapshot_root)?;
    let connection = Connection::open_with_flags(
        database_snapshot.path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(2))?;
    let mut records = match profile.kind {
        BrowserProfileKind::Chromium => collect_chromium_records(&connection, profile)?,
        BrowserProfileKind::Firefox => collect_firefox_records(&connection, profile)?,
        #[cfg(target_os = "macos")]
        BrowserProfileKind::Safari => collect_safari_records(&connection, profile)?,
    };
    drop(connection);
    if matches!(profile.kind, BrowserProfileKind::Firefox)
        && let Some(path) = &profile.firefox_downloads_path
        && path.exists()
    {
        match collect_firefox_downloads(path, profile) {
            Ok(downloads) => {
                records.downloads_supported = true;
                records.downloads.extend(downloads);
            }
            Err(error) => records.warnings.push(format!(
                "{} profile {} downloads could not be imported: {error}",
                profile.browser, profile.profile
            )),
        }
    }
    Ok(records)
}

fn collect_chromium_records(
    connection: &Connection,
    profile: &BrowserProfile,
) -> Result<BrowserRecordsSnapshot, BrowserActivityError> {
    if !table_exists(connection, "urls")? {
        return Err(BrowserActivityError::Collection(
            "Chromium History database does not contain urls".to_owned(),
        ));
    }
    let mut snapshot = BrowserRecordsSnapshot {
        profiles_scanned: 1,
        history_supported: true,
        downloads_supported: table_exists(connection, "downloads")?,
        ..BrowserRecordsSnapshot::default()
    };
    let mut statement = connection.prepare(
        "SELECT url, COALESCE(title, ''), visit_count, last_visit_time
         FROM urls WHERE url <> '' ORDER BY last_visit_time DESC LIMIT ?1",
    )?;
    let rows = statement.query_map([MAX_IMPORTED_RECORDS_PER_PROFILE as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;
    for row in rows {
        let (url, title, visit_count, chrome_time) = row?;
        let last_visited_at_ms = chromium_time_ms(chrome_time);
        snapshot.history.push(ObservedBrowserHistory {
            browser: profile.browser.clone(),
            profile: profile.profile.clone(),
            url: url.clone(),
            title: title.clone(),
            last_visited_at_ms,
            visit_count: u64::try_from(visit_count).unwrap_or_default(),
        });
        if let Some(search_term) = search_term_from_url(&url) {
            snapshot.searches.push(ObservedBrowserSearch {
                browser: profile.browser.clone(),
                profile: profile.profile.clone(),
                search_term,
                url,
                title,
                searched_at_ms: last_visited_at_ms,
            });
        }
    }
    if snapshot.downloads_supported {
        let url_expression = if table_exists(connection, "downloads_url_chains")? {
            "COALESCE(
                (SELECT chain.url FROM downloads_url_chains chain
                 WHERE chain.id = downloads.id
                 ORDER BY chain.chain_index DESC LIMIT 1),
                NULLIF(downloads.tab_url, ''),
                NULLIF(downloads.site_url, ''),
                ''
             )"
        } else {
            "COALESCE(NULLIF(downloads.tab_url, ''), NULLIF(downloads.site_url, ''), '')"
        };
        let sql = format!(
            "SELECT CAST(id AS TEXT), {url_expression}, target_path, start_time,
                    end_time, received_bytes, total_bytes, state
             FROM downloads ORDER BY start_time DESC LIMIT ?1"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map([MAX_IMPORTED_RECORDS_PER_PROFILE as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })?;
        for row in rows {
            let (source_id, url, target_path, start, end, received, total, state) = row?;
            snapshot.downloads.push(ObservedBrowserDownload {
                browser: profile.browser.clone(),
                profile: profile.profile.clone(),
                source_id,
                url,
                target_path,
                started_at_ms: chromium_time_ms(start),
                ended_at_ms: (end > 0).then(|| chromium_time_ms(end)),
                received_bytes: u64::try_from(received).unwrap_or_default(),
                total_bytes: u64::try_from(total).unwrap_or_default(),
                state: chromium_download_state(state).to_owned(),
            });
        }
    }
    Ok(snapshot)
}

fn collect_firefox_records(
    connection: &Connection,
    profile: &BrowserProfile,
) -> Result<BrowserRecordsSnapshot, BrowserActivityError> {
    if !table_exists(connection, "moz_places")? {
        return Err(BrowserActivityError::Collection(
            "Firefox places database does not contain moz_places".to_owned(),
        ));
    }
    let mut snapshot = BrowserRecordsSnapshot {
        profiles_scanned: 1,
        history_supported: true,
        ..BrowserRecordsSnapshot::default()
    };
    let mut statement = connection.prepare(
        "SELECT url, COALESCE(title, ''), visit_count, COALESCE(last_visit_date, 0)
         FROM moz_places WHERE url <> '' ORDER BY last_visit_date DESC LIMIT ?1",
    )?;
    let rows = statement.query_map([MAX_IMPORTED_RECORDS_PER_PROFILE as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;
    for row in rows {
        let (url, title, visit_count, firefox_time) = row?;
        let last_visited_at_ms = firefox_time.div_euclid(1_000);
        snapshot.history.push(ObservedBrowserHistory {
            browser: profile.browser.clone(),
            profile: profile.profile.clone(),
            url: url.clone(),
            title: title.clone(),
            last_visited_at_ms,
            visit_count: u64::try_from(visit_count).unwrap_or_default(),
        });
        if let Some(search_term) = search_term_from_url(&url) {
            snapshot.searches.push(ObservedBrowserSearch {
                browser: profile.browser.clone(),
                profile: profile.profile.clone(),
                search_term,
                url,
                title,
                searched_at_ms: last_visited_at_ms,
            });
        }
    }
    Ok(snapshot)
}

#[cfg(target_os = "macos")]
fn collect_safari_records(
    connection: &Connection,
    profile: &BrowserProfile,
) -> Result<BrowserRecordsSnapshot, BrowserActivityError> {
    if !table_exists(connection, "history_items")? || !table_exists(connection, "history_visits")? {
        return Err(BrowserActivityError::Collection(
            "Safari History database is missing history tables".to_owned(),
        ));
    }
    let mut snapshot = BrowserRecordsSnapshot {
        profiles_scanned: 1,
        history_supported: true,
        downloads_supported: false,
        ..BrowserRecordsSnapshot::default()
    };
    let mut statement = connection.prepare(
        "SELECT item.url,
                COALESCE((
                    SELECT visit.title FROM history_visits visit
                    WHERE visit.history_item = item.id
                    ORDER BY visit.visit_time DESC LIMIT 1
                ), ''),
                item.visit_count,
                COALESCE(MAX(visit.visit_time), 0)
         FROM history_items item
         LEFT JOIN history_visits visit ON visit.history_item = item.id
         WHERE item.url <> ''
         GROUP BY item.id
         ORDER BY MAX(visit.visit_time) DESC
         LIMIT ?1",
    )?;
    let rows = statement.query_map([MAX_IMPORTED_RECORDS_PER_PROFILE as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, f64>(3)?,
        ))
    })?;
    for row in rows {
        let (url, title, visit_count, safari_time) = row?;
        let last_visited_at_ms =
            ((safari_time + SAFARI_TO_UNIX_EPOCH_SECONDS as f64) * 1_000.0) as i64;
        snapshot.history.push(ObservedBrowserHistory {
            browser: profile.browser.clone(),
            profile: profile.profile.clone(),
            url: url.clone(),
            title: title.clone(),
            last_visited_at_ms,
            visit_count: u64::try_from(visit_count).unwrap_or_default(),
        });
        if let Some(search_term) = search_term_from_url(&url) {
            snapshot.searches.push(ObservedBrowserSearch {
                browser: profile.browser.clone(),
                profile: profile.profile.clone(),
                search_term,
                url,
                title,
                searched_at_ms: last_visited_at_ms,
            });
        }
    }
    snapshot
        .warnings
        .push("Safari download import is unavailable; history import remains active".to_owned());
    Ok(snapshot)
}

fn collect_firefox_downloads(
    path: &Path,
    profile: &BrowserProfile,
) -> Result<Vec<ObservedBrowserDownload>, BrowserActivityError> {
    let bytes = fs::read(path)?;
    let value: JsonValue = serde_json::from_slice(&bytes).map_err(|error| {
        BrowserActivityError::Collection(format!(
            "Firefox downloads JSON {} is invalid: {error}",
            path.display()
        ))
    })?;
    let entries = value
        .get("list")
        .and_then(JsonValue::as_array)
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut downloads = Vec::new();
    for (index, entry) in entries
        .iter()
        .take(MAX_IMPORTED_RECORDS_PER_PROFILE)
        .enumerate()
    {
        let source = entry.get("source").unwrap_or(&JsonValue::Null);
        let target = entry.get("target").unwrap_or(&JsonValue::Null);
        let url = source
            .get("url")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned();
        let target_path = target
            .get("path")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned();
        let started_at_ms = entry
            .get("startTime")
            .and_then(JsonValue::as_str)
            .and_then(parse_rfc3339_ms)
            .unwrap_or_default();
        let ended_at_ms = entry
            .get("endTime")
            .and_then(JsonValue::as_str)
            .and_then(parse_rfc3339_ms);
        let source_id = entry
            .get("guid")
            .and_then(JsonValue::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("{started_at_ms}:{index}:{target_path}"));
        let succeeded = entry
            .get("succeeded")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        let canceled = entry
            .get("canceled")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        downloads.push(ObservedBrowserDownload {
            browser: profile.browser.clone(),
            profile: profile.profile.clone(),
            source_id,
            url,
            target_path,
            started_at_ms,
            ended_at_ms,
            received_bytes: entry
                .get("currentBytes")
                .and_then(JsonValue::as_u64)
                .unwrap_or_default(),
            total_bytes: entry
                .get("totalBytes")
                .and_then(JsonValue::as_u64)
                .unwrap_or_default(),
            state: if succeeded {
                "complete"
            } else if canceled {
                "cancelled"
            } else if ended_at_ms.is_some() {
                "interrupted"
            } else {
                "inProgress"
            }
            .to_owned(),
        });
    }
    Ok(downloads)
}

fn discover_browser_profiles(config: &BrowserActivityConfig) -> Vec<BrowserProfile> {
    let mut profiles = Vec::new();
    if let Some(root) = &config.custom_profile_root {
        discover_chromium_root(root, "CI Chromium", &mut profiles);
        return profiles;
    }
    let Some(base_dirs) = BaseDirs::new() else {
        return profiles;
    };
    let home = base_dirs.home_dir();
    #[cfg(target_os = "macos")]
    {
        let application_support = home.join("Library/Application Support");
        for (browser, relative) in [
            ("Google Chrome", "Google/Chrome"),
            ("Chromium", "Chromium"),
            ("Brave", "BraveSoftware/Brave-Browser"),
            ("Microsoft Edge", "Microsoft Edge"),
            ("Arc", "Arc/User Data"),
        ] {
            discover_chromium_root(&application_support.join(relative), browser, &mut profiles);
        }
        discover_firefox_root(
            &application_support.join("Firefox/Profiles"),
            "Firefox",
            &mut profiles,
        );
        let safari = home.join("Library/Safari/History.db");
        if safari.is_file() {
            profiles.push(BrowserProfile {
                browser: "Safari".to_owned(),
                profile: "Default".to_owned(),
                kind: BrowserProfileKind::Safari,
                history_path: safari,
                firefox_downloads_path: None,
            });
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            for (browser, relative) in [
                ("Google Chrome", "Google/Chrome/User Data"),
                ("Chromium", "Chromium/User Data"),
                ("Brave", "BraveSoftware/Brave-Browser/User Data"),
                ("Microsoft Edge", "Microsoft/Edge/User Data"),
            ] {
                discover_chromium_root(&local.join(relative), browser, &mut profiles);
            }
        }
        if let Some(roaming) = env::var_os("APPDATA").map(PathBuf::from) {
            discover_firefox_root(
                &roaming.join("Mozilla/Firefox/Profiles"),
                "Firefox",
                &mut profiles,
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        let config_home = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        for (browser, relative) in [
            ("Google Chrome", "google-chrome"),
            ("Chromium", "chromium"),
            ("Brave", "BraveSoftware/Brave-Browser"),
            ("Microsoft Edge", "microsoft-edge"),
        ] {
            discover_chromium_root(&config_home.join(relative), browser, &mut profiles);
        }
        discover_firefox_root(&home.join(".mozilla/firefox"), "Firefox", &mut profiles);
    }
    let mut seen = HashSet::new();
    profiles.retain(|profile| seen.insert(profile.history_path.clone()));
    profiles
}

fn discover_chromium_root(root: &Path, browser: &str, output: &mut Vec<BrowserProfile>) {
    if root.join("History").is_file() {
        push_chromium_profile(root, browser, output);
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten().take(100) {
        let path = entry.path();
        if path.is_dir() && path.join("History").is_file() {
            push_chromium_profile(&path, browser, output);
        }
    }
}

fn push_chromium_profile(root: &Path, browser: &str, output: &mut Vec<BrowserProfile>) {
    output.push(BrowserProfile {
        browser: browser.to_owned(),
        profile: root
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(default_profile),
        kind: BrowserProfileKind::Chromium,
        history_path: root.join("History"),
        firefox_downloads_path: None,
    });
}

fn discover_firefox_root(root: &Path, browser: &str, output: &mut Vec<BrowserProfile>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten().take(100) {
        let path = entry.path();
        let history_path = path.join("places.sqlite");
        if path.is_dir() && history_path.is_file() {
            output.push(BrowserProfile {
                browser: browser.to_owned(),
                profile: path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_else(default_profile),
                kind: BrowserProfileKind::Firefox,
                history_path,
                firefox_downloads_path: Some(path.join("downloads.json")),
            });
        }
    }
}

struct DatabaseSnapshot {
    directory: PathBuf,
    database_path: PathBuf,
}

impl DatabaseSnapshot {
    fn copy(source: &Path, root: &Path) -> Result<Self, BrowserActivityError> {
        fs::create_dir_all(root)?;
        let sequence = SNAPSHOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = root.join(format!("{}-{sequence}", std::process::id()));
        fs::create_dir(&directory)?;
        let database_path = directory.join("source.sqlite");
        if let Err(error) = fs::copy(source, &database_path) {
            let _ = fs::remove_dir(&directory);
            return Err(error.into());
        }
        for suffix in ["-wal", "-shm"] {
            let source_companion = appended_path(source, suffix);
            if source_companion.is_file() {
                let destination = appended_path(&database_path, suffix);
                if let Err(error) = fs::copy(&source_companion, destination) {
                    let _ = fs::remove_file(&database_path);
                    let _ = fs::remove_dir(&directory);
                    return Err(error.into());
                }
            }
        }
        Ok(Self {
            directory,
            database_path,
        })
    }

    fn path(&self) -> &Path {
        &self.database_path
    }
}

impl Drop for DatabaseSnapshot {
    fn drop(&mut self) {
        if let Ok(entries) = fs::read_dir(&self.directory) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
        let _ = fs::remove_dir(&self.directory);
    }
}

fn appended_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, rusqlite::Error> {
    connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
         )",
        [table],
        |row| row.get(0),
    )
}

fn chromium_time_ms(value: i64) -> i64 {
    value
        .saturating_sub(CHROMIUM_TO_UNIX_EPOCH_MICROSECONDS)
        .div_euclid(1_000)
}

fn chromium_download_state(state: i64) -> &'static str {
    match state {
        0 => "inProgress",
        1 => "complete",
        2 => "cancelled",
        3 => "interrupted",
        _ => "unknown",
    }
}

fn domain_from_url(url: &str) -> String {
    let after_scheme = url
        .split_once("://")
        .map(|(_, remainder)| remainder)
        .unwrap_or(url);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let host = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    if let Some(bracketed) = host.strip_prefix('[') {
        return bracketed
            .split_once(']')
            .map(|(host, _)| host)
            .unwrap_or(bracketed)
            .to_ascii_lowercase();
    }
    host.split(':')
        .next()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn search_term_from_url(url: &str) -> Option<String> {
    let query = url.split_once('?')?.1.split('#').next().unwrap_or_default();
    const SEARCH_KEYS: [&str; 8] = [
        "q",
        "query",
        "p",
        "text",
        "wd",
        "search_query",
        "k",
        "keyword",
    ];
    for part in query.split('&') {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        let decoded_key = percent_decode(key);
        if SEARCH_KEYS
            .iter()
            .any(|candidate| decoded_key.eq_ignore_ascii_case(candidate))
        {
            let decoded = percent_decode(value).trim().to_owned();
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let high = hex_value(bytes[index + 1]);
                let low = hex_value(bytes[index + 2]);
                if let (Some(high), Some(low)) = (high, low) {
                    output.push((high << 4) | low);
                    index += 3;
                } else {
                    output.push(bytes[index]);
                    index += 1;
                }
            }
            value => {
                output.push(value);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn platform_current_tabs() -> Result<BrowserTabSnapshot, BrowserActivityError> {
    use std::process::Command;

    let front = Command::new("lsappinfo")
        .arg("front")
        .output()
        .map_err(|error| {
            BrowserActivityError::Collection(format!("lsappinfo front failed: {error}"))
        })?;
    if !front.status.success() {
        return Ok(unavailable_tabs(
            "unable to identify the frontmost macOS application",
        ));
    }
    let identifier = String::from_utf8_lossy(&front.stdout).trim().to_owned();
    let info = Command::new("lsappinfo")
        .args(["info", "-only", "name", &identifier])
        .output()
        .map_err(|error| {
            BrowserActivityError::Collection(format!("lsappinfo info failed: {error}"))
        })?;
    let name = String::from_utf8_lossy(&info.stdout);
    let browser = [
        "Google Chrome",
        "Chromium",
        "Brave Browser",
        "Microsoft Edge",
        "Safari",
    ]
    .into_iter()
    .find(|candidate| name.contains(candidate));
    let Some(browser) = browser else {
        return Ok(BrowserTabSnapshot {
            available: true,
            tabs: Vec::new(),
            warnings: Vec::new(),
        });
    };
    let script = if browser == "Safari" {
        "tell application \"Safari\"\n\
         if (count of windows) is 0 then return \"\"\n\
         set activeTab to current tab of front window\n\
         return (name of activeTab) & (ASCII character 30) & (URL of activeTab)\n\
         end tell"
            .to_owned()
    } else {
        format!(
            "tell application \"{browser}\"\n\
             if (count of windows) is 0 then return \"\"\n\
             set activeTab to active tab of front window\n\
             return (title of activeTab) & (ASCII character 30) & (URL of activeTab)\n\
             end tell"
        )
    };
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(|error| {
            BrowserActivityError::Collection(format!("browser AppleScript failed: {error}"))
        })?;
    if !output.status.success() {
        return Ok(unavailable_tabs(format!(
            "{browser} did not allow current-tab automation: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let value = String::from_utf8_lossy(&output.stdout);
    let Some((title, url)) = value.trim().split_once('\u{1e}') else {
        return Ok(BrowserTabSnapshot {
            available: true,
            tabs: Vec::new(),
            warnings: Vec::new(),
        });
    };
    Ok(BrowserTabSnapshot {
        available: true,
        tabs: vec![ObservedBrowserTab {
            browser: browser.to_owned(),
            profile: "Default".to_owned(),
            window_id: "front-window".to_owned(),
            tab_id: "active-tab".to_owned(),
            title: title.to_owned(),
            url: url.to_owned(),
            audible: None,
        }],
        warnings: vec!["audio playback state requires the browser current-tab bridge".to_owned()],
    })
}

#[cfg(not(target_os = "macos"))]
fn platform_current_tabs() -> Result<BrowserTabSnapshot, BrowserActivityError> {
    Ok(unavailable_tabs(
        "current tab title, URL, and audio state require browser-current-tabs.json on this platform",
    ))
}

fn unavailable_tabs(message: impl Into<String>) -> BrowserTabSnapshot {
    BrowserTabSnapshot {
        available: false,
        tabs: Vec::new(),
        warnings: vec![message.into()],
    }
}

fn duration_from_environment(
    name: &str,
    default_ms: u64,
    minimum_ms: u64,
    maximum_ms: u64,
) -> Result<Duration, BrowserActivityError> {
    let Some(value) = env::var_os(name) else {
        return Ok(Duration::from_millis(default_ms));
    };
    let value = value.to_string_lossy();
    let milliseconds = value.parse::<u64>().map_err(|_| {
        BrowserActivityError::Configuration(format!(
            "{name} must be an integer number of milliseconds, received {value:?}"
        ))
    })?;
    if !(minimum_ms..=maximum_ms).contains(&milliseconds) {
        return Err(BrowserActivityError::Configuration(format!(
            "{name} must be between {minimum_ms} and {maximum_ms} milliseconds"
        )));
    }
    Ok(Duration::from_millis(milliseconds))
}

fn default_query_limit() -> usize {
    100
}

fn default_true() -> bool {
    true
}

fn default_profile() -> String {
    "Default".to_owned()
}

fn non_empty_or(value: String, fallback: &str) -> String {
    if value.trim().is_empty() {
        fallback.to_owned()
    } else {
        value
    }
}

fn duration_ms_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn duration_ms_i64(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

fn now_ms() -> i64 {
    system_time_ms(SystemTime::now())
}

fn system_time_ms(value: SystemTime) -> i64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn format_timestamp(timestamp_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn config(directory: &TempDir) -> BrowserActivityConfig {
        BrowserActivityConfig {
            database_path: directory.path().join("browser.sqlite3"),
            bridge_path: directory.path().join("browser-current-tabs.json"),
            snapshot_directory: directory.path().join("snapshots"),
            custom_profile_root: None,
            tab_poll_interval: Duration::from_millis(50),
            history_refresh_interval: Duration::from_secs(1),
            bridge_max_age: Duration::from_secs(15),
        }
    }

    #[test]
    fn extracts_domains_and_search_terms_without_storing_input_contents() {
        assert_eq!(
            domain_from_url("https://user@example.com:8443/search?q=rust"),
            "example.com"
        );
        assert_eq!(
            domain_from_url("http://[2001:db8::1]:8080/index"),
            "2001:db8::1"
        );
        assert_eq!(
            search_term_from_url("https://www.google.com/search?q=rust%20sqlite%2Bwal"),
            Some("rust sqlite+wal".to_owned())
        );
        assert_eq!(
            search_term_from_url("https://example.com/page?not_search=value"),
            None
        );
    }

    #[test]
    fn records_tab_navigation_and_exact_session_boundaries() {
        let directory = tempfile::tempdir().expect("create browser test directory");
        let store =
            BrowserActivityStore::open(directory.path().join("browser.sqlite3")).expect("store");
        let first = ObservedBrowserTab {
            browser: "Test Browser".to_owned(),
            profile: "Default".to_owned(),
            window_id: "1".to_owned(),
            tab_id: "2".to_owned(),
            title: "First".to_owned(),
            url: "https://example.com/first".to_owned(),
            audible: Some(false),
        };
        store
            .record_tab_snapshot(std::slice::from_ref(&first), 1_000)
            .expect("record first tab");
        let mut audible = first.clone();
        audible.audible = Some(true);
        store
            .record_tab_snapshot(&[audible], 2_000)
            .expect("update audible state");
        let mut second = first;
        second.title = "Second".to_owned();
        second.url = "https://example.org/second".to_owned();
        store
            .record_tab_snapshot(&[second], 3_000)
            .expect("record navigation");
        store
            .record_tab_snapshot(&[], 4_000)
            .expect("close current tab");

        let sessions = store
            .query_tabs(&BrowserTabQuery {
                current_only: false,
                ..BrowserTabQuery::default()
            })
            .expect("query tab sessions");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].started_at_ms, 3_000);
        assert_eq!(sessions[0].ended_at_ms, Some(4_000));
        assert_eq!(sessions[1].started_at_ms, 1_000);
        assert_eq!(sessions[1].ended_at_ms, Some(3_000));
        assert_eq!(sessions[1].audible, Some(true));
    }

    #[test]
    fn imports_chromium_history_searches_and_downloads_from_a_snapshot() {
        let directory = tempfile::tempdir().expect("create browser test directory");
        let profile = directory.path().join("Default");
        fs::create_dir(&profile).expect("create profile");
        let history_path = profile.join("History");
        let connection = Connection::open(&history_path).expect("create Chromium history");
        connection
            .execute_batch(
                "CREATE TABLE urls (
                    id INTEGER PRIMARY KEY, url TEXT, title TEXT,
                    visit_count INTEGER, last_visit_time INTEGER
                 );
                 CREATE TABLE downloads (
                    id INTEGER PRIMARY KEY, tab_url TEXT, site_url TEXT,
                    target_path TEXT, start_time INTEGER, end_time INTEGER,
                    received_bytes INTEGER, total_bytes INTEGER, state INTEGER
                 );
                 CREATE TABLE downloads_url_chains (
                    id INTEGER, chain_index INTEGER, url TEXT
                 );",
            )
            .expect("create Chromium tables");
        let visit_time = CHROMIUM_TO_UNIX_EPOCH_MICROSECONDS + 1_700_000_000_000_000;
        connection
            .execute(
                "INSERT INTO urls VALUES (1, ?1, 'Rust Search', 3, ?2)",
                params!["https://search.example/?q=rust+sqlite", visit_time],
            )
            .expect("insert history");
        connection
            .execute(
                "INSERT INTO downloads VALUES (
                    7, '', '', '/tmp/report.pdf', ?1, ?2, 50, 100, 1
                 )",
                params![visit_time, visit_time + 1_000_000],
            )
            .expect("insert download");
        connection
            .execute(
                "INSERT INTO downloads_url_chains VALUES (
                    7, 0, 'https://downloads.example/report.pdf'
                 )",
                [],
            )
            .expect("insert download URL");
        drop(connection);

        let profile = BrowserProfile {
            browser: "Test Chromium".to_owned(),
            profile: "Default".to_owned(),
            kind: BrowserProfileKind::Chromium,
            history_path,
            firefox_downloads_path: None,
        };
        let records = collect_profile_records(&profile, &directory.path().join("snapshots"))
            .expect("collect Chromium records");
        assert!(records.history_supported);
        assert!(records.downloads_supported);
        assert_eq!(records.history.len(), 1);
        assert_eq!(records.history[0].visit_count, 3);
        assert_eq!(records.searches[0].search_term, "rust sqlite");
        assert_eq!(records.downloads.len(), 1);
        assert_eq!(records.downloads[0].state, "complete");
        assert_eq!(
            records.downloads[0].url,
            "https://downloads.example/report.pdf"
        );
    }

    #[test]
    fn persists_and_filters_all_browser_record_types() {
        let directory = tempfile::tempdir().expect("create browser test directory");
        let store =
            BrowserActivityStore::open(directory.path().join("browser.sqlite3")).expect("store");
        let snapshot = BrowserRecordsSnapshot {
            history: vec![ObservedBrowserHistory {
                browser: "Test".to_owned(),
                profile: "Default".to_owned(),
                url: "https://example.com/search?q=whale".to_owned(),
                title: "Whale".to_owned(),
                last_visited_at_ms: 10_000,
                visit_count: 2,
            }],
            searches: vec![ObservedBrowserSearch {
                browser: "Test".to_owned(),
                profile: "Default".to_owned(),
                search_term: "whale".to_owned(),
                url: "https://example.com/search?q=whale".to_owned(),
                title: "Whale".to_owned(),
                searched_at_ms: 10_000,
            }],
            downloads: vec![ObservedBrowserDownload {
                browser: "Test".to_owned(),
                profile: "Default".to_owned(),
                source_id: "download-1".to_owned(),
                url: "https://example.com/whale.zip".to_owned(),
                target_path: "/tmp/whale.zip".to_owned(),
                started_at_ms: 11_000,
                ended_at_ms: Some(12_000),
                received_bytes: 10,
                total_bytes: 10,
                state: "complete".to_owned(),
            }],
            ..BrowserRecordsSnapshot::default()
        };
        store.import_records(&snapshot, 20_000).expect("import");
        assert_eq!(
            store
                .query_history(&BrowserHistoryQuery {
                    domain_contains: Some("example".to_owned()),
                    ..BrowserHistoryQuery::default()
                })
                .expect("history")
                .len(),
            1
        );
        assert_eq!(
            store
                .query_searches(&BrowserSearchQuery {
                    term_contains: Some("hal".to_owned()),
                    ..BrowserSearchQuery::default()
                })
                .expect("searches")
                .len(),
            1
        );
        assert_eq!(
            store
                .query_downloads(&BrowserDownloadQuery {
                    state: Some("complete".to_owned()),
                    ..BrowserDownloadQuery::default()
                })
                .expect("downloads")
                .len(),
            1
        );
    }

    #[test]
    fn reads_fresh_bridge_and_rejects_stale_bridge() {
        let directory = tempfile::tempdir().expect("create browser test directory");
        let bridge = directory.path().join("browser-current-tabs.json");
        fs::write(
            &bridge,
            format!(
                r#"{{"observedAtMs":{},"tabs":[{{"browser":"Test","profile":"Default","windowId":"1","tabId":"2","title":"Active","url":"https://example.com","audible":true}}]}}"#,
                now_ms()
            ),
        )
        .expect("write bridge");
        let current =
            read_bridge_snapshot(&bridge, Duration::from_secs(10)).expect("read fresh bridge");
        assert!(current.available);
        assert_eq!(current.tabs[0].audible, Some(true));

        fs::write(&bridge, r#"{"observedAtMs":1,"tabs":[]}"#).expect("write stale bridge");
        let stale =
            read_bridge_snapshot(&bridge, Duration::from_secs(1)).expect("read stale bridge");
        assert!(!stale.available);
        assert!(!stale.warnings.is_empty());
    }

    #[test]
    fn test_config_has_isolated_paths() {
        let directory = tempfile::tempdir().expect("create browser test directory");
        let config = config(&directory);
        assert!(config.database_path.starts_with(directory.path()));
        assert!(config.bridge_path.starts_with(directory.path()));
    }
}
