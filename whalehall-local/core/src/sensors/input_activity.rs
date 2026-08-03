//! Privacy-preserving global keyboard and pointer activity aggregation.
//!
//! The platform callback only increments counters and reads relative pointer
//! deltas. It never reads key codes, text, clipboard data, or absolute pointer
//! coordinates. Completed non-empty buckets are persisted as DesktopEvents.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::json;
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use tokio_util::sync::CancellationToken;
use whalehall_local_protocol::desktop_event_kinds;

use crate::events::{DesktopEventDraft, EventJournal, EventJournalError};

pub const DEFAULT_INPUT_ACTIVITY_BUCKET_MS: u64 = 5_000;
const ENABLED_ENVIRONMENT_VARIABLE: &str = "WHALEHALL_INPUT_MONITORING_ENABLED";

#[derive(Clone, Debug)]
pub struct InputActivityConfig {
    pub bucket_duration: Duration,
    /// Explicit product opt-in, independent from operating-system permission.
    pub enabled: bool,
}

impl InputActivityConfig {
    pub fn from_environment() -> Result<Self, InputActivityError> {
        let enabled = match env::var(ENABLED_ENVIRONMENT_VARIABLE) {
            Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" => true,
                "0" | "false" | "no" | "" => false,
                _ => {
                    return Err(InputActivityError::Configuration(format!(
                        "{ENABLED_ENVIRONMENT_VARIABLE} must be true/false or 1/0"
                    )));
                }
            },
            Err(env::VarError::NotPresent) => false,
            Err(error) => {
                return Err(InputActivityError::Configuration(format!(
                    "unable to read {ENABLED_ENVIRONMENT_VARIABLE}: {error}"
                )));
            }
        };
        Ok(Self {
            bucket_duration: Duration::from_millis(DEFAULT_INPUT_ACTIVITY_BUCKET_MS),
            enabled,
        })
    }

    fn validate(&self) -> Result<(), InputActivityError> {
        let bucket_ms = duration_ms_i64(self.bucket_duration)?;
        if bucket_ms <= 0 {
            return Err(InputActivityError::Configuration(
                "input activity bucket duration must be greater than zero".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum InputActivityError {
    #[error("input activity sensor configuration error: {0}")]
    Configuration(String),
    #[error("input activity sensor I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("input activity sensor SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("input activity event publication failed: {0}")]
    EventJournal(#[from] EventJournalError),
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InputActivitySensorState {
    Starting,
    Disabled,
    Running,
    Degraded,
    Stopped,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputActivityAggregate {
    pub key_count: u64,
    pub click_count: u64,
    pub scroll_delta: i64,
    pub mouse_distance: f64,
    pub bucket_started_at_ms: i64,
    pub bucket_ended_at_ms: i64,
}

impl InputActivityAggregate {
    pub fn is_empty(&self) -> bool {
        self.key_count == 0
            && self.click_count == 0
            && self.scroll_delta == 0
            && self.mouse_distance == 0.0
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InputActivityDelta {
    pub key_count: u64,
    pub click_count: u64,
    pub scroll_delta: i64,
    pub mouse_distance: f64,
}

impl InputActivityDelta {
    fn merge(&mut self, next: Self) {
        self.key_count = self.key_count.saturating_add(next.key_count);
        self.click_count = self.click_count.saturating_add(next.click_count);
        self.scroll_delta = self.scroll_delta.saturating_add(next.scroll_delta);
        self.mouse_distance = finite_distance(self.mouse_distance + next.mouse_distance);
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputActivityStatus {
    pub state: InputActivitySensorState,
    pub enabled: bool,
    pub authorized: bool,
    pub supported: bool,
    pub permission_granted: bool,
    pub capture_available: bool,
    pub bucket_duration_ms: u64,
    pub last_bucket_ended_at_ms: Option<i64>,
    pub last_published_at_ms: Option<i64>,
    pub published_buckets: u64,
    pub last_aggregate: Option<InputActivityAggregate>,
    pub warnings: Vec<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputActivityProviderStatus {
    pub supported: bool,
    pub permission_granted: bool,
    pub available: bool,
    pub warnings: Vec<String>,
}

pub trait InputActivityProvider: Send + Sync + 'static {
    fn status(&self) -> InputActivityProviderStatus;
    fn drain(&self) -> InputActivityDelta;
    fn shutdown(&self);
}

pub struct SystemInputActivityProvider {
    capture: platform::SystemCapture,
}

impl SystemInputActivityProvider {
    pub fn new(enabled: bool) -> Self {
        Self {
            capture: platform::SystemCapture::new(enabled),
        }
    }
}

impl InputActivityProvider for SystemInputActivityProvider {
    fn status(&self) -> InputActivityProviderStatus {
        self.capture.status()
    }

    fn drain(&self) -> InputActivityDelta {
        self.capture.drain()
    }

    fn shutdown(&self) {
        self.capture.shutdown();
    }
}

#[derive(Clone)]
pub struct InputActivityService {
    inner: Arc<InputActivityInner>,
}

struct InputActivityInner {
    config: InputActivityConfig,
    provider: Arc<dyn InputActivityProvider>,
    event_journal: EventJournal,
    store: InputActivityStore,
    initial_revocation_pending: bool,
    status: Mutex<InputActivityStatus>,
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl InputActivityService {
    pub fn start(
        config: InputActivityConfig,
        provider: Arc<dyn InputActivityProvider>,
        event_journal: EventJournal,
    ) -> Result<Self, InputActivityError> {
        config.validate()?;
        let store = InputActivityStore::open(
            event_journal
                .database_path()
                .with_file_name("input-activity.sqlite3"),
        )?;
        let provider_status = provider.status();
        let durable_authorization = event_journal.latest_authorization_state("input.monitoring")?;
        let mut initial_revocation_pending =
            config.enabled && matches!(durable_authorization, Some(false));
        if config.enabled
            && !provider_status.permission_granted
            && durable_authorization != Some(false)
        {
            let observed_at_ms = now_ms();
            append_authorization_boundary(
                &event_journal,
                desktop_event_kinds::AUTHORIZATION_REVOKED,
                "revoked",
                observed_at_ms,
            )?;
            initial_revocation_pending = true;
        }
        let status = status_from_provider(&config, provider_status);
        let inner = Arc::new(InputActivityInner {
            config,
            provider,
            event_journal,
            store,
            initial_revocation_pending,
            status: Mutex::new(status),
            cancellation: CancellationToken::new(),
            task: Mutex::new(None),
        });
        let task = tokio::spawn(run_input_activity(inner.clone()));
        *inner.task.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
        Ok(Self { inner })
    }

    pub fn status(&self) -> InputActivityStatus {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
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
        if let Err(error) = flush_input_event_outbox(&self.inner) {
            set_service_error(&self.inner, error.to_string());
        }
        self.inner.provider.shutdown();
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .state = InputActivitySensorState::Stopped;
    }
}

async fn run_input_activity(inner: Arc<InputActivityInner>) {
    let bucket_duration_ms = match duration_ms_i64(inner.config.bucket_duration) {
        Ok(value) => value,
        Err(error) => {
            set_service_error(&inner, error.to_string());
            return;
        }
    };
    let current_time_ms = now_ms();
    let (bucket_started_at_ms, _, wait_until_bucket_end_ms) =
        epoch_bucket_schedule(current_time_ms, bucket_duration_ms);
    let mut accumulator = InputBucketAccumulator::new(bucket_started_at_ms, bucket_duration_ms);
    let start_at = Instant::now() + Duration::from_millis(wait_until_bucket_end_ms);
    let mut ticker = interval_at(start_at, inner.config.bucket_duration);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut permission_was_granted = inner.provider.status().permission_granted;
    let mut revocation_was_published = inner.initial_revocation_pending;
    if let Err(error) = flush_input_event_outbox(&inner) {
        set_service_error(&inner, error.to_string());
    }

    loop {
        tokio::select! {
            () = inner.cancellation.cancelled() => break,
            _ = ticker.tick() => {
                if let Err(error) = flush_input_event_outbox(&inner) {
                    set_service_error(&inner, error.to_string());
                }
                let tick_at_ms = now_ms();
                accumulator.align_to_latest_completed_bucket(tick_at_ms);
                let provider_status = inner.provider.status();
                let capture_allowed = inner.config.enabled
                    && provider_status.permission_granted
                    && provider_status.available;
                // Enforce the privacy gate in the service as well as the
                // system provider. A custom or faulty provider cannot bypass
                // explicit enablement or an unavailable capture state.
                if capture_allowed {
                    accumulator.record(inner.provider.drain());
                } else {
                    let _ = inner.provider.drain();
                }
                let aggregate = accumulator.seal();
                update_provider_status(&inner, &provider_status, aggregate.bucket_ended_at_ms);
                let mut authorization_boundary_ready = true;
                if inner.config.enabled
                    && permission_was_granted
                    && !provider_status.permission_granted
                {
                    match publish_authorization_boundary(
                        &inner,
                        desktop_event_kinds::AUTHORIZATION_REVOKED,
                        "revoked",
                        aggregate.bucket_ended_at_ms,
                    ) {
                        Ok(()) => {
                            revocation_was_published = true;
                        }
                        Err(error) => {
                            set_service_error(&inner, error.to_string());
                            authorization_boundary_ready = false;
                        }
                    }
                } else if inner.config.enabled
                    && provider_status.permission_granted
                    && revocation_was_published
                {
                    match publish_authorization_boundary(
                        &inner,
                        desktop_event_kinds::AUTHORIZATION_GRANTED,
                        "granted",
                        aggregate.bucket_ended_at_ms,
                    ) {
                        Ok(()) => {
                            revocation_was_published = false;
                        }
                        Err(error) => {
                            set_service_error(&inner, error.to_string());
                            authorization_boundary_ready = false;
                        }
                    }
                }
                if authorization_boundary_ready {
                    permission_was_granted = provider_status.permission_granted;
                }
                if capture_allowed
                    && authorization_boundary_ready
                    && !aggregate.is_empty()
                {
                    match inner.store.enqueue_aggregate(&aggregate) {
                        Ok(()) => {
                            if let Err(error) = flush_input_event_outbox(&inner) {
                                set_service_error(&inner, error.to_string());
                            }
                        }
                        Err(error) => {
                            accumulator.restore(aggregate);
                            set_service_error(&inner, error.to_string());
                        }
                    }
                }
            }
        }
    }
}

fn publish_authorization_boundary(
    inner: &InputActivityInner,
    kind: &'static str,
    transition: &'static str,
    observed_at_ms: i64,
) -> Result<(), InputActivityError> {
    append_authorization_boundary(&inner.event_journal, kind, transition, observed_at_ms)
}

fn append_authorization_boundary(
    event_journal: &EventJournal,
    kind: &'static str,
    transition: &'static str,
    observed_at_ms: i64,
) -> Result<(), InputActivityError> {
    event_journal.append(DesktopEventDraft::metadata(
        kind,
        "input.activity.sensor",
        observed_at_ms,
        json!({ "permissions": ["input.monitoring"] }),
        format!("input-authorization-{transition}:{observed_at_ms}"),
    ))?;
    Ok(())
}

fn input_aggregate_draft(aggregate: &InputActivityAggregate) -> DesktopEventDraft {
    DesktopEventDraft {
        kind: desktop_event_kinds::INPUT_ACTIVITY_AGGREGATED.to_owned(),
        source: "input.activity.sensor".to_owned(),
        occurred_at_ms: aggregate.bucket_ended_at_ms,
        observed_at_ms: now_ms().max(aggregate.bucket_ended_at_ms),
        goal_version: None,
        sensitivity: whalehall_local_protocol::DesktopEventSensitivity::Metadata,
        payload: json!({
            "keyCount": aggregate.key_count,
            "clickCount": aggregate.click_count,
            "scrollDelta": aggregate.scroll_delta,
            "mouseDistance": aggregate.mouse_distance,
            "bucketStartedAtMs": aggregate.bucket_started_at_ms,
            "bucketEndedAtMs": aggregate.bucket_ended_at_ms,
        }),
        deduplication_key: format!(
            "input-bucket:{}:{}",
            aggregate.bucket_started_at_ms, aggregate.bucket_ended_at_ms
        ),
    }
}

fn flush_input_event_outbox(inner: &InputActivityInner) -> Result<(), InputActivityError> {
    for record in inner.store.pending_aggregates(100)? {
        inner
            .event_journal
            .append(input_aggregate_draft(&record.aggregate))?;
        inner.store.delete_aggregate(record.id)?;
        let mut status = inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        status.last_published_at_ms = Some(record.aggregate.bucket_ended_at_ms);
        status.published_buckets = status.published_buckets.saturating_add(1);
        status.last_aggregate = Some(record.aggregate);
        if status.warnings.is_empty() {
            status.last_error = None;
        }
    }
    Ok(())
}

fn status_from_provider(
    config: &InputActivityConfig,
    provider: InputActivityProviderStatus,
) -> InputActivityStatus {
    let capture_available = config.enabled && provider.permission_granted && provider.available;
    let state = if !config.enabled {
        InputActivitySensorState::Disabled
    } else if capture_available {
        InputActivitySensorState::Running
    } else {
        InputActivitySensorState::Degraded
    };
    InputActivityStatus {
        state,
        enabled: config.enabled,
        authorized: provider.permission_granted,
        supported: provider.supported,
        permission_granted: provider.permission_granted,
        capture_available,
        bucket_duration_ms: duration_ms_u64(config.bucket_duration),
        last_bucket_ended_at_ms: None,
        last_published_at_ms: None,
        published_buckets: 0,
        last_aggregate: None,
        last_error: (!provider.warnings.is_empty()).then(|| provider.warnings.join("; ")),
        warnings: provider.warnings,
    }
}

fn update_provider_status(
    inner: &InputActivityInner,
    provider: &InputActivityProviderStatus,
    bucket_ended_at_ms: i64,
) {
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let capture_available =
        inner.config.enabled && provider.permission_granted && provider.available;
    status.state = if !inner.config.enabled {
        InputActivitySensorState::Disabled
    } else if capture_available {
        InputActivitySensorState::Running
    } else {
        InputActivitySensorState::Degraded
    };
    status.supported = provider.supported;
    status.authorized = provider.permission_granted;
    status.permission_granted = provider.permission_granted;
    status.capture_available = capture_available;
    status.last_bucket_ended_at_ms = Some(bucket_ended_at_ms);
    status.warnings = provider.warnings.clone();
    status.last_error = (!provider.warnings.is_empty()).then(|| provider.warnings.join("; "));
}

fn set_service_error(inner: &InputActivityInner, error: String) {
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    status.state = InputActivitySensorState::Degraded;
    status.warnings = vec![error.clone()];
    status.last_error = Some(error);
}

#[derive(Clone, Debug)]
struct InputActivityStore {
    path: PathBuf,
}

#[derive(Clone, Debug)]
struct InputAggregateOutboxRecord {
    id: i64,
    aggregate: InputActivityAggregate,
}

impl InputActivityStore {
    fn open(path: impl Into<PathBuf>) -> Result<Self, InputActivityError> {
        let path = path.into();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let store = Self { path };
        let connection = store.connect()?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS input_aggregate_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key_count INTEGER NOT NULL,
                click_count INTEGER NOT NULL,
                scroll_delta INTEGER NOT NULL,
                mouse_distance REAL NOT NULL,
                bucket_started_at_ms INTEGER NOT NULL,
                bucket_ended_at_ms INTEGER NOT NULL,
                UNIQUE(bucket_started_at_ms, bucket_ended_at_ms)
             );
             CREATE INDEX IF NOT EXISTS input_aggregate_outbox_order
                ON input_aggregate_outbox(id);",
        )?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, InputActivityError> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )?;
        Ok(connection)
    }

    fn enqueue_aggregate(
        &self,
        aggregate: &InputActivityAggregate,
    ) -> Result<(), InputActivityError> {
        let connection = self.connect()?;
        connection.execute(
            "INSERT OR IGNORE INTO input_aggregate_outbox (
                key_count, click_count, scroll_delta, mouse_distance,
                bucket_started_at_ms, bucket_ended_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                i64::try_from(aggregate.key_count).unwrap_or(i64::MAX),
                i64::try_from(aggregate.click_count).unwrap_or(i64::MAX),
                aggregate.scroll_delta,
                aggregate.mouse_distance,
                aggregate.bucket_started_at_ms,
                aggregate.bucket_ended_at_ms,
            ],
        )?;
        Ok(())
    }

    fn pending_aggregates(
        &self,
        limit: usize,
    ) -> Result<Vec<InputAggregateOutboxRecord>, InputActivityError> {
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT id, key_count, click_count, scroll_delta, mouse_distance,
                    bucket_started_at_ms, bucket_ended_at_ms
             FROM input_aggregate_outbox ORDER BY id LIMIT ?1",
        )?;
        let rows = statement.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
            Ok(InputAggregateOutboxRecord {
                id: row.get(0)?,
                aggregate: InputActivityAggregate {
                    key_count: u64::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                    click_count: u64::try_from(row.get::<_, i64>(2)?).unwrap_or_default(),
                    scroll_delta: row.get(3)?,
                    mouse_distance: row.get(4)?,
                    bucket_started_at_ms: row.get(5)?,
                    bucket_ended_at_ms: row.get(6)?,
                },
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn delete_aggregate(&self, id: i64) -> Result<(), InputActivityError> {
        let connection = self.connect()?;
        connection.execute("DELETE FROM input_aggregate_outbox WHERE id = ?1", [id])?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct InputBucketAccumulator {
    bucket_duration_ms: i64,
    bucket_started_at_ms: i64,
    delta: InputActivityDelta,
}

impl InputBucketAccumulator {
    fn new(bucket_started_at_ms: i64, bucket_duration_ms: i64) -> Self {
        Self {
            bucket_duration_ms,
            bucket_started_at_ms,
            delta: InputActivityDelta::default(),
        }
    }

    fn record(&mut self, delta: InputActivityDelta) {
        self.delta.merge(delta);
    }

    fn align_to_latest_completed_bucket(&mut self, timestamp_ms: i64) {
        let latest_completed_end_ms = timestamp_ms
            .div_euclid(self.bucket_duration_ms)
            .saturating_mul(self.bucket_duration_ms);
        let expected_end_ms = self
            .bucket_started_at_ms
            .saturating_add(self.bucket_duration_ms);
        if latest_completed_end_ms > expected_end_ms {
            self.bucket_started_at_ms =
                latest_completed_end_ms.saturating_sub(self.bucket_duration_ms);
        }
    }

    fn seal(&mut self) -> InputActivityAggregate {
        let bucket_ended_at_ms = self
            .bucket_started_at_ms
            .saturating_add(self.bucket_duration_ms);
        let delta = std::mem::take(&mut self.delta);
        let aggregate = InputActivityAggregate {
            key_count: delta.key_count,
            click_count: delta.click_count,
            scroll_delta: delta.scroll_delta,
            mouse_distance: round_distance(delta.mouse_distance),
            bucket_started_at_ms: self.bucket_started_at_ms,
            bucket_ended_at_ms,
        };
        self.bucket_started_at_ms = bucket_ended_at_ms;
        aggregate
    }

    fn restore(&mut self, aggregate: InputActivityAggregate) {
        self.bucket_started_at_ms = aggregate.bucket_started_at_ms;
        self.delta.merge(InputActivityDelta {
            key_count: aggregate.key_count,
            click_count: aggregate.click_count,
            scroll_delta: aggregate.scroll_delta,
            mouse_distance: aggregate.mouse_distance,
        });
    }
}

fn duration_ms_i64(duration: Duration) -> Result<i64, InputActivityError> {
    i64::try_from(duration.as_millis()).map_err(|_| {
        InputActivityError::Configuration("input activity duration is too large".to_owned())
    })
}

fn epoch_bucket_schedule(timestamp_ms: i64, bucket_duration_ms: i64) -> (i64, i64, u64) {
    debug_assert!(bucket_duration_ms > 0);
    let bucket_started_at_ms = timestamp_ms
        .div_euclid(bucket_duration_ms)
        .saturating_mul(bucket_duration_ms);
    let bucket_ended_at_ms = bucket_started_at_ms.saturating_add(bucket_duration_ms);
    let wait_until_end_ms =
        u64::try_from(bucket_ended_at_ms.saturating_sub(timestamp_ms)).unwrap_or_default();
    (bucket_started_at_ms, bucket_ended_at_ms, wait_until_end_ms)
}

fn duration_ms_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn finite_distance(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        0.0
    }
}

fn round_distance(value: f64) -> f64 {
    (finite_distance(value) * 1_000.0).round() / 1_000.0
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use objc2_core_foundation::{CFMachPort, CFRunLoop, kCFRunLoopCommonModes};
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventTapProxy, CGEventType, CGPreflightListenEventAccess,
    };

    use super::{InputActivityDelta, InputActivityProviderStatus};

    pub(super) struct SystemCapture {
        enabled: bool,
        counters: Arc<CaptureCounters>,
        status: Arc<Mutex<InputActivityProviderStatus>>,
        stop: Arc<AtomicBool>,
        thread: Mutex<Option<JoinHandle<()>>>,
    }

    impl SystemCapture {
        pub(super) fn new(enabled: bool) -> Self {
            let counters = Arc::new(CaptureCounters::default());
            // Preflight is read-only and never shows the macOS permission
            // prompt. It is evaluated even while the product switch is off so
            // `authorized` reports the actual operating-system state.
            let permission_granted = CGPreflightListenEventAccess();
            let status = Arc::new(Mutex::new(InputActivityProviderStatus {
                supported: true,
                permission_granted,
                available: false,
                warnings: Vec::new(),
            }));
            let stop = Arc::new(AtomicBool::new(false));
            let capture = Self {
                enabled,
                counters,
                status,
                stop,
                thread: Mutex::new(None),
            };
            if !enabled {
                set_status(
                    &capture.status,
                    permission_granted,
                    false,
                    "global input aggregation is disabled by the explicit product switch",
                );
                return capture;
            }
            if !permission_granted {
                set_status(
                    &capture.status,
                    false,
                    false,
                    "macOS Input Monitoring permission is not granted",
                );
                return capture;
            }
            capture.ensure_capture_thread();
            capture
        }

        pub(super) fn status(&self) -> InputActivityProviderStatus {
            self.ensure_capture_thread();
            self.status
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        }

        pub(super) fn drain(&self) -> InputActivityDelta {
            self.counters.drain()
        }

        pub(super) fn shutdown(&self) {
            self.stop.store(true, Ordering::Release);
            let thread = self
                .thread
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let Some(thread) = thread {
                let _ = thread.join();
            }
        }

        fn ensure_capture_thread(&self) {
            if !self.enabled || self.stop.load(Ordering::Acquire) {
                return;
            }
            if !CGPreflightListenEventAccess() {
                set_status(
                    &self.status,
                    false,
                    false,
                    "macOS Input Monitoring permission is not granted",
                );
                return;
            }
            let mut thread = self
                .thread
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if thread.as_ref().is_some_and(|thread| !thread.is_finished()) {
                return;
            }
            if let Some(finished) = thread.take() {
                let _ = finished.join();
            }
            *thread = spawn_capture_thread(
                self.counters.clone(),
                self.status.clone(),
                self.stop.clone(),
            );
        }
    }

    fn spawn_capture_thread(
        counters: Arc<CaptureCounters>,
        status: Arc<Mutex<InputActivityProviderStatus>>,
        stop: Arc<AtomicBool>,
    ) -> Option<JoinHandle<()>> {
        let thread_status = status.clone();
        let (startup_tx, startup_rx) = mpsc::sync_channel(1);
        let capture_thread = thread::Builder::new()
            .name("whalehall-input-activity".to_owned())
            .spawn(move || {
                run_event_tap(counters, thread_status, stop, startup_tx);
            });
        match capture_thread {
            Ok(thread) => {
                match startup_rx.recv_timeout(Duration::from_secs(2)) {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        set_status(&status, true, false, &error);
                    }
                    Err(error) => set_status(
                        &status,
                        true,
                        false,
                        &format!("macOS input event tap startup timed out: {error}"),
                    ),
                }
                Some(thread)
            }
            Err(error) => {
                set_status(
                    &status,
                    true,
                    false,
                    &format!("unable to start macOS input event tap thread: {error}"),
                );
                None
            }
        }
    }

    #[derive(Default)]
    struct CaptureCounters {
        key_count: AtomicU64,
        click_count: AtomicU64,
        scroll_delta: AtomicI64,
        mouse_distance_millipoints: AtomicU64,
    }

    impl CaptureCounters {
        fn drain(&self) -> InputActivityDelta {
            InputActivityDelta {
                key_count: self.key_count.swap(0, Ordering::AcqRel),
                click_count: self.click_count.swap(0, Ordering::AcqRel),
                scroll_delta: self.scroll_delta.swap(0, Ordering::AcqRel),
                mouse_distance: self.mouse_distance_millipoints.swap(0, Ordering::AcqRel) as f64
                    / 1_000.0,
            }
        }
    }

    fn run_event_tap(
        counters: Arc<CaptureCounters>,
        status: Arc<Mutex<InputActivityProviderStatus>>,
        stop: Arc<AtomicBool>,
        startup: mpsc::SyncSender<Result<(), String>>,
    ) {
        let mask = event_mask(&[
            CGEventType::KeyDown,
            CGEventType::LeftMouseDown,
            CGEventType::RightMouseDown,
            CGEventType::OtherMouseDown,
            CGEventType::MouseMoved,
            CGEventType::LeftMouseDragged,
            CGEventType::RightMouseDragged,
            CGEventType::OtherMouseDragged,
            CGEventType::ScrollWheel,
        ]);
        // SAFETY: the callback returns the original event unchanged, and the Arc
        // backing user_info remains alive until after the run loop and tap stop.
        let tap = unsafe {
            CGEvent::tap_create(
                CGEventTapLocation::SessionEventTap,
                CGEventTapPlacement::TailAppendEventTap,
                CGEventTapOptions::ListenOnly,
                mask,
                Some(event_tap_callback),
                Arc::as_ptr(&counters).cast_mut().cast::<c_void>(),
            )
        };
        let Some(tap) = tap else {
            let error = "macOS could not create a listen-only input event tap".to_owned();
            set_status(&status, true, false, &error);
            let _ = startup.send(Err(error));
            return;
        };
        let Some(source) = CFMachPort::new_run_loop_source(None, Some(&tap), 0) else {
            let error = "macOS could not create an input event run-loop source".to_owned();
            set_status(&status, true, false, &error);
            let _ = startup.send(Err(error));
            return;
        };
        let Some(run_loop) = CFRunLoop::current() else {
            let error = "macOS did not provide a run loop for the input event tap".to_owned();
            set_status(&status, true, false, &error);
            let _ = startup.send(Err(error));
            return;
        };
        // SAFETY: CoreFoundation exports this immutable process-lifetime mode.
        let common_modes = unsafe { kCFRunLoopCommonModes };
        let Some(common_modes) = common_modes else {
            let error = "macOS did not provide the common run-loop mode".to_owned();
            set_status(&status, true, false, &error);
            let _ = startup.send(Err(error));
            return;
        };
        run_loop.add_source(Some(&source), Some(common_modes));
        CGEvent::tap_enable(&tap, true);
        if !CGEvent::tap_is_enabled(&tap) {
            let error = "macOS input event tap was created but could not be enabled".to_owned();
            set_status(&status, true, false, &error);
            let _ = startup.send(Err(error));
            return;
        }
        set_status(&status, true, true, "");
        let _ = startup.send(Ok(()));

        while !stop.load(Ordering::Acquire) {
            CFRunLoop::run_in_mode(Some(common_modes), 0.25, false);
            if !CGEvent::tap_is_enabled(&tap) {
                if !CGPreflightListenEventAccess() {
                    set_status(
                        &status,
                        false,
                        false,
                        "macOS Input Monitoring permission was revoked",
                    );
                    break;
                }
                CGEvent::tap_enable(&tap, true);
                if !CGEvent::tap_is_enabled(&tap) {
                    set_status(&status, true, false, "macOS input event tap is disabled");
                    break;
                }
                set_status(&status, true, true, "");
            }
        }
        run_loop.remove_source(Some(&source), Some(common_modes));
        tap.invalidate();
    }

    unsafe extern "C-unwind" fn event_tap_callback(
        _proxy: CGEventTapProxy,
        event_type: CGEventType,
        event: NonNull<CGEvent>,
        user_info: *mut c_void,
    ) -> *mut CGEvent {
        if user_info.is_null() {
            return event.as_ptr();
        }
        // SAFETY: user_info points to the CaptureCounters Arc held by the tap thread.
        let counters = unsafe { &*user_info.cast::<CaptureCounters>() };
        // SAFETY: CoreGraphics guarantees a valid event for the callback duration.
        let event_ref = unsafe { event.as_ref() };
        match event_type {
            CGEventType::KeyDown => {
                counters.key_count.fetch_add(1, Ordering::Relaxed);
            }
            CGEventType::LeftMouseDown
            | CGEventType::RightMouseDown
            | CGEventType::OtherMouseDown => {
                counters.click_count.fetch_add(1, Ordering::Relaxed);
            }
            CGEventType::MouseMoved
            | CGEventType::LeftMouseDragged
            | CGEventType::RightMouseDragged
            | CGEventType::OtherMouseDragged => {
                let delta_x =
                    CGEvent::integer_value_field(Some(event_ref), CGEventField::MouseEventDeltaX);
                let delta_y =
                    CGEvent::integer_value_field(Some(event_ref), CGEventField::MouseEventDeltaY);
                let distance = (delta_x as f64).hypot(delta_y as f64);
                let millipoints = (distance * 1_000.0).round().max(0.0) as u64;
                counters
                    .mouse_distance_millipoints
                    .fetch_add(millipoints, Ordering::Relaxed);
            }
            CGEventType::ScrollWheel => {
                let vertical = CGEvent::integer_value_field(
                    Some(event_ref),
                    CGEventField::ScrollWheelEventDeltaAxis1,
                );
                let horizontal = CGEvent::integer_value_field(
                    Some(event_ref),
                    CGEventField::ScrollWheelEventDeltaAxis2,
                );
                counters
                    .scroll_delta
                    .fetch_add(vertical.saturating_add(horizontal), Ordering::Relaxed);
            }
            _ => {}
        }
        event.as_ptr()
    }

    fn event_mask(event_types: &[CGEventType]) -> u64 {
        event_types
            .iter()
            .filter(|event_type| event_type.0 < u64::BITS)
            .fold(0, |mask, event_type| mask | (1_u64 << event_type.0))
    }

    fn set_status(
        status: &Mutex<InputActivityProviderStatus>,
        permission_granted: bool,
        available: bool,
        warning: &str,
    ) {
        let mut status = status.lock().unwrap_or_else(|error| error.into_inner());
        status.supported = true;
        status.permission_granted = permission_granted;
        status.available = available;
        status.warnings = if warning.is_empty() {
            Vec::new()
        } else {
            vec![warning.to_owned()]
        };
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::sync::Mutex;

    use super::{InputActivityDelta, InputActivityProviderStatus};

    pub(super) struct SystemCapture {
        status: Mutex<InputActivityProviderStatus>,
    }

    impl SystemCapture {
        pub(super) fn new(enabled: bool) -> Self {
            let product_switch = if enabled {
                "the product switch is enabled"
            } else {
                "the product switch is disabled"
            };
            Self {
                status: Mutex::new(InputActivityProviderStatus {
                    supported: false,
                    permission_granted: false,
                    available: false,
                    warnings: vec![format!(
                        "global input aggregation is unsupported on {} ({product_switch})",
                        std::env::consts::OS
                    )],
                }),
            }
        }

        pub(super) fn status(&self) -> InputActivityProviderStatus {
            self.status
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        }

        pub(super) fn drain(&self) -> InputActivityDelta {
            InputActivityDelta::default()
        }

        pub(super) fn shutdown(&self) {}
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use whalehall_local_protocol::EventQueryParams;

    use super::*;

    #[test]
    fn state_machine_emits_one_fixed_bucket_for_many_raw_actions() {
        let mut accumulator = InputBucketAccumulator::new(10_000, 5_000);
        accumulator.record(InputActivityDelta {
            key_count: 1_000,
            click_count: 25,
            scroll_delta: -18,
            mouse_distance: 123.4567,
        });

        let aggregate = accumulator.seal();
        assert_eq!(aggregate.key_count, 1_000);
        assert_eq!(aggregate.click_count, 25);
        assert_eq!(aggregate.scroll_delta, -18);
        assert_eq!(aggregate.mouse_distance, 123.457);
        assert_eq!(aggregate.bucket_started_at_ms, 10_000);
        assert_eq!(aggregate.bucket_ended_at_ms, 15_000);
        assert!(!aggregate.is_empty());

        let empty = accumulator.seal();
        assert_eq!(empty.bucket_started_at_ms, 15_000);
        assert_eq!(empty.bucket_ended_at_ms, 20_000);
        assert!(empty.is_empty());
    }

    #[test]
    fn bucket_schedule_is_epoch_aligned_and_waits_for_the_current_bucket_end() {
        assert_eq!(
            epoch_bucket_schedule(12_345, 5_000),
            (10_000, 15_000, 2_655)
        );
        assert_eq!(
            epoch_bucket_schedule(15_000, 5_000),
            (15_000, 20_000, 5_000)
        );
        assert_eq!(epoch_bucket_schedule(4_999, 5_000), (0, 5_000, 1));
    }

    #[test]
    fn long_pause_realigns_to_one_current_epoch_bucket_without_empty_catchup() {
        let mut accumulator = InputBucketAccumulator::new(10_000, 5_000);
        accumulator.align_to_latest_completed_bucket(3_612_345);
        accumulator.record(InputActivityDelta {
            key_count: 2,
            ..InputActivityDelta::default()
        });

        let aggregate = accumulator.seal();
        assert_eq!(aggregate.bucket_started_at_ms, 3_605_000);
        assert_eq!(aggregate.bucket_ended_at_ms, 3_610_000);
        assert_eq!(aggregate.key_count, 2);

        let next = accumulator.seal();
        assert_eq!(next.bucket_started_at_ms, 3_610_000);
        assert_eq!(next.bucket_ended_at_ms, 3_615_000);
        assert!(next.is_empty());
    }

    #[test]
    fn serialized_aggregate_has_no_raw_input_or_coordinate_fields() {
        let aggregate = InputActivityAggregate {
            key_count: 3,
            click_count: 2,
            scroll_delta: 4,
            mouse_distance: 10.5,
            bucket_started_at_ms: 1_000,
            bucket_ended_at_ms: 6_000,
        };
        let value = serde_json::to_value(aggregate).unwrap();
        let mut field_names = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        field_names.sort_unstable();
        assert_eq!(
            field_names,
            vec![
                "bucketEndedAtMs",
                "bucketStartedAtMs",
                "clickCount",
                "keyCount",
                "mouseDistance",
                "scrollDelta",
            ]
        );
        let encoded = serde_json::to_string(&value).unwrap();
        for forbidden in [
            "keyCode",
            "keyValue",
            "text",
            "clipboard",
            "coordinate",
            "mouseX",
            "mouseY",
        ] {
            assert!(!encoded.contains(forbidden));
        }
    }

    struct SequenceProvider {
        status: InputActivityProviderStatus,
        deltas: Mutex<VecDeque<InputActivityDelta>>,
    }

    impl InputActivityProvider for SequenceProvider {
        fn status(&self) -> InputActivityProviderStatus {
            self.status.clone()
        }

        fn drain(&self) -> InputActivityDelta {
            self.deltas
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .pop_front()
                .unwrap_or_default()
        }

        fn shutdown(&self) {}
    }

    struct RevokedProvider {
        status_calls: AtomicUsize,
    }

    impl InputActivityProvider for RevokedProvider {
        fn status(&self) -> InputActivityProviderStatus {
            let granted = self.status_calls.fetch_add(1, Ordering::SeqCst) < 2;
            InputActivityProviderStatus {
                supported: true,
                permission_granted: granted,
                available: granted,
                warnings: if granted {
                    Vec::new()
                } else {
                    vec!["permission revoked".to_owned()]
                },
            }
        }

        fn drain(&self) -> InputActivityDelta {
            InputActivityDelta::default()
        }

        fn shutdown(&self) {}
    }

    struct RevokedThenGrantedProvider {
        status_calls: AtomicUsize,
    }

    impl InputActivityProvider for RevokedThenGrantedProvider {
        fn status(&self) -> InputActivityProviderStatus {
            let call = self.status_calls.fetch_add(1, Ordering::SeqCst);
            let granted = !(2..4).contains(&call);
            InputActivityProviderStatus {
                supported: true,
                permission_granted: granted,
                available: granted,
                warnings: if granted {
                    Vec::new()
                } else {
                    vec!["permission revoked".to_owned()]
                },
            }
        }

        fn drain(&self) -> InputActivityDelta {
            InputActivityDelta::default()
        }

        fn shutdown(&self) {}
    }

    async fn wait_for_events(
        journal: &EventJournal,
        minimum_count: usize,
    ) -> Vec<whalehall_local_protocol::DesktopEvent> {
        for _ in 0..100 {
            let events = journal.query(&EventQueryParams::default()).unwrap().events;
            if events.len() >= minimum_count {
                return events;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        journal.query(&EventQueryParams::default()).unwrap().events
    }

    #[tokio::test]
    async fn resident_service_publishes_only_non_empty_aggregate_events() {
        let directory = tempfile::tempdir().expect("create input activity test directory");
        let journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open events");
        let provider = Arc::new(SequenceProvider {
            status: InputActivityProviderStatus {
                supported: true,
                permission_granted: true,
                available: true,
                warnings: Vec::new(),
            },
            deltas: Mutex::new(VecDeque::from([
                InputActivityDelta {
                    key_count: 4,
                    click_count: 1,
                    scroll_delta: 2,
                    mouse_distance: 9.25,
                },
                InputActivityDelta::default(),
            ])),
        });
        let service = InputActivityService::start(
            InputActivityConfig {
                bucket_duration: Duration::from_millis(30),
                enabled: true,
            },
            provider,
            journal.clone(),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(75)).await;
        let events = journal.query(&EventQueryParams::default()).unwrap().events;
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            desktop_event_kinds::INPUT_ACTIVITY_AGGREGATED
        );
        assert_eq!(events[0].payload["keyCount"], 4);
        assert_eq!(events[0].payload["clickCount"], 1);
        assert_eq!(events[0].payload["scrollDelta"], 2);
        assert_eq!(events[0].payload["mouseDistance"], 9.25);
        assert!(events[0].payload.get("keyCode").is_none());
        assert!(events[0].payload.get("mouseX").is_none());
        assert_eq!(service.status().published_buckets, 1);
        service.shutdown().await;
        assert_eq!(service.status().state, InputActivitySensorState::Stopped);
    }

    #[tokio::test]
    async fn aggregate_outbox_retries_one_failed_append_exactly_once() {
        let directory = tempfile::tempdir().expect("create input retry directory");
        let journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open events");
        journal.fail_next_appends_for_test(1);
        let provider = Arc::new(SequenceProvider {
            status: InputActivityProviderStatus {
                supported: true,
                permission_granted: true,
                available: true,
                warnings: Vec::new(),
            },
            deltas: Mutex::new(VecDeque::from([InputActivityDelta {
                key_count: 7,
                click_count: 2,
                ..InputActivityDelta::default()
            }])),
        });
        let service = InputActivityService::start(
            InputActivityConfig {
                bucket_duration: Duration::from_millis(30),
                enabled: true,
            },
            provider,
            journal.clone(),
        )
        .unwrap();

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if service.status().published_buckets == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("pending aggregate should retry");
        tokio::time::sleep(Duration::from_millis(70)).await;

        let events = journal.query(&EventQueryParams::default()).unwrap().events;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["keyCount"], 7);
        assert_eq!(service.status().published_buckets, 1);
        service.shutdown().await;
    }

    #[tokio::test]
    async fn disabled_or_unsupported_provider_does_not_fail_startup() {
        let directory = tempfile::tempdir().unwrap();
        let journal = EventJournal::open(directory.path().join("events.sqlite3")).unwrap();
        let provider = Arc::new(SequenceProvider {
            status: InputActivityProviderStatus {
                supported: false,
                permission_granted: false,
                // Even an inconsistent provider must not bypass the explicit
                // product switch.
                available: true,
                warnings: vec!["not available".to_owned()],
            },
            deltas: Mutex::new(VecDeque::from([InputActivityDelta {
                key_count: 99,
                ..InputActivityDelta::default()
            }])),
        });
        let service = InputActivityService::start(
            InputActivityConfig {
                bucket_duration: Duration::from_millis(20),
                enabled: false,
            },
            provider,
            journal.clone(),
        )
        .expect("permission absence must not fail startup");
        tokio::time::sleep(Duration::from_millis(30)).await;
        let status = service.status();
        assert_eq!(status.state, InputActivitySensorState::Disabled);
        assert!(!status.enabled);
        assert!(!status.authorized);
        assert!(!status.supported);
        assert!(!status.capture_available);
        assert!(
            journal
                .query(&EventQueryParams::default())
                .unwrap()
                .events
                .is_empty()
        );
        service.shutdown().await;
    }

    #[tokio::test]
    async fn permission_revocation_emits_one_non_counting_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let journal = EventJournal::open(directory.path().join("events.sqlite3")).unwrap();
        let service = InputActivityService::start(
            InputActivityConfig {
                bucket_duration: Duration::from_millis(50),
                enabled: true,
            },
            Arc::new(RevokedProvider {
                status_calls: AtomicUsize::new(0),
            }),
            journal.clone(),
        )
        .unwrap();
        let events = wait_for_events(&journal, 1).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, desktop_event_kinds::AUTHORIZATION_REVOKED);
        assert_eq!(
            events[0].payload,
            json!({ "permissions": ["input.monitoring"] })
        );
        assert!(!events[0].contributes_to_reflection_count());
        service.shutdown().await;
    }

    #[tokio::test]
    async fn permission_recovery_closes_only_a_previously_published_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let journal = EventJournal::open(directory.path().join("events.sqlite3")).unwrap();
        let service = InputActivityService::start(
            InputActivityConfig {
                bucket_duration: Duration::from_millis(35),
                enabled: true,
            },
            Arc::new(RevokedThenGrantedProvider {
                status_calls: AtomicUsize::new(0),
            }),
            journal.clone(),
        )
        .unwrap();
        let events = wait_for_events(&journal, 2).await;
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                desktop_event_kinds::AUTHORIZATION_REVOKED,
                desktop_event_kinds::AUTHORIZATION_GRANTED,
            ]
        );
        for event in events {
            assert_eq!(
                event.payload,
                json!({ "permissions": ["input.monitoring"] })
            );
            assert!(!event.contributes_to_reflection_count());
        }
        service.shutdown().await;
    }

    #[tokio::test]
    async fn permission_recovery_after_restart_uses_durable_authorization_state() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("events.sqlite3");
        {
            let first_process = EventJournal::open(&database_path).unwrap();
            first_process
                .append(DesktopEventDraft::metadata(
                    desktop_event_kinds::AUTHORIZATION_REVOKED,
                    "input.activity.sensor",
                    1_000,
                    json!({ "permissions": ["input.monitoring"] }),
                    "input-revoked-before-restart",
                ))
                .unwrap();
        }
        let restarted_journal = EventJournal::open(&database_path).unwrap();
        let service = InputActivityService::start(
            InputActivityConfig {
                bucket_duration: Duration::from_millis(20),
                enabled: true,
            },
            Arc::new(SequenceProvider {
                status: InputActivityProviderStatus {
                    supported: true,
                    permission_granted: true,
                    available: true,
                    warnings: Vec::new(),
                },
                deltas: Mutex::new(VecDeque::new()),
            }),
            restarted_journal.clone(),
        )
        .unwrap();
        let events = wait_for_events(&restarted_journal, 2).await;
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                desktop_event_kinds::AUTHORIZATION_REVOKED,
                desktop_event_kinds::AUTHORIZATION_GRANTED,
            ]
        );
        assert_eq!(
            restarted_journal
                .latest_authorization_state("input.monitoring")
                .unwrap(),
            Some(true)
        );
        service.shutdown().await;
    }

    #[tokio::test]
    async fn restart_with_permission_already_denied_publishes_one_durable_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("events.sqlite3");
        {
            let previous_process = EventJournal::open(&database_path).unwrap();
            previous_process
                .append(DesktopEventDraft::metadata(
                    desktop_event_kinds::AUTHORIZATION_GRANTED,
                    "input.activity.sensor",
                    1_000,
                    json!({ "permissions": ["input.monitoring"] }),
                    "input-granted-before-offline-revoke",
                ))
                .unwrap();
        }
        let restarted_journal = EventJournal::open(&database_path).unwrap();
        let service = InputActivityService::start(
            InputActivityConfig {
                bucket_duration: Duration::from_millis(20),
                enabled: true,
            },
            Arc::new(SequenceProvider {
                status: InputActivityProviderStatus {
                    supported: true,
                    permission_granted: false,
                    available: false,
                    warnings: vec!["permission revoked while WhaleHall was stopped".to_owned()],
                },
                deltas: Mutex::new(VecDeque::new()),
            }),
            restarted_journal.clone(),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let events = restarted_journal
            .query(&EventQueryParams::default())
            .unwrap()
            .events;
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                desktop_event_kinds::AUTHORIZATION_GRANTED,
                desktop_event_kinds::AUTHORIZATION_REVOKED,
            ]
        );
        assert_eq!(
            restarted_journal
                .latest_authorization_state("input.monitoring")
                .unwrap(),
            Some(false)
        );
        assert!(!events[1].contributes_to_reflection_count());
        service.shutdown().await;
    }

    #[test]
    fn product_switch_and_operating_system_authorization_are_independent() {
        let disabled_but_authorized = status_from_provider(
            &InputActivityConfig {
                bucket_duration: Duration::from_secs(5),
                enabled: false,
            },
            InputActivityProviderStatus {
                supported: true,
                permission_granted: true,
                available: false,
                warnings: vec!["disabled".to_owned()],
            },
        );
        assert_eq!(
            disabled_but_authorized.state,
            InputActivitySensorState::Disabled
        );
        assert!(!disabled_but_authorized.enabled);
        assert!(disabled_but_authorized.authorized);

        let enabled_but_unauthorized = status_from_provider(
            &InputActivityConfig {
                bucket_duration: Duration::from_secs(5),
                enabled: true,
            },
            InputActivityProviderStatus {
                supported: true,
                permission_granted: false,
                available: false,
                warnings: vec!["permission missing".to_owned()],
            },
        );
        assert_eq!(
            enabled_but_unauthorized.state,
            InputActivitySensorState::Degraded
        );
        assert!(enabled_but_unauthorized.enabled);
        assert!(!enabled_but_unauthorized.authorized);
        assert!(!enabled_but_unauthorized.capture_available);
    }
}
