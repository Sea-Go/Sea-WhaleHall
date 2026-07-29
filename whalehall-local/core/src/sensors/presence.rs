//! Resident idle, AFK, screen-lock, and sleep/wake sensor.
//!
//! Platform providers collect the current input-idle duration and lock state.
//! A deterministic state machine turns observations into lifecycle events and
//! persists both the latest state and the event history in SQLite.

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
use serde_json::json;
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;
use whalehall_local_protocol::{DesktopEventSensitivity, desktop_event_kinds};

use crate::events::{DesktopEventDraft, EventJournal, EventJournalError};

pub const DEFAULT_PRESENCE_POLL_INTERVAL_MS: u64 = 1_000;
pub const DEFAULT_AFK_THRESHOLD_MS: u64 = 5 * 60 * 1_000;
pub const DEFAULT_SUSPEND_GAP_THRESHOLD_MS: u64 = 15_000;
const PRESENCE_SCHEMA_VERSION: i64 = 2;
const MAX_QUERY_LIMIT: usize = 1_000;

#[derive(Debug, Error)]
pub enum PresenceError {
    #[error("presence sensor configuration error: {0}")]
    Configuration(String),
    #[error("presence sensor I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("presence sensor SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("presence sensor collection error: {0}")]
    Collection(String),
    #[error("presence event publication failed: {0}")]
    EventJournal(#[from] EventJournalError),
}

#[derive(Clone, Debug)]
pub struct PresenceConfig {
    pub database_path: PathBuf,
    pub poll_interval: Duration,
    pub afk_threshold: Duration,
    pub suspend_gap_threshold: Duration,
}

impl PresenceConfig {
    pub fn from_environment() -> Result<Self, PresenceError> {
        let data_dir = if let Some(path) = env::var_os("WHALEHALL_DATA_DIR") {
            PathBuf::from(path)
        } else {
            ProjectDirs::from("com", "seago", "whalehall")
                .ok_or_else(|| {
                    PresenceError::Configuration(
                        "unable to resolve the operating system application data directory"
                            .to_owned(),
                    )
                })?
                .data_dir()
                .to_path_buf()
        };
        Ok(Self {
            database_path: data_dir.join("presence.sqlite3"),
            poll_interval: duration_from_environment(
                "WHALEHALL_PRESENCE_POLL_MS",
                DEFAULT_PRESENCE_POLL_INTERVAL_MS,
                50,
                60_000,
            )?,
            afk_threshold: duration_from_environment(
                "WHALEHALL_AFK_THRESHOLD_MS",
                DEFAULT_AFK_THRESHOLD_MS,
                1_000,
                24 * 60 * 60 * 1_000,
            )?,
            suspend_gap_threshold: duration_from_environment(
                "WHALEHALL_SUSPEND_GAP_THRESHOLD_MS",
                DEFAULT_SUSPEND_GAP_THRESHOLD_MS,
                1_000,
                10 * 60 * 1_000,
            )?,
        })
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PresenceSensorState {
    Starting,
    Running,
    Degraded,
    Stopped,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceCapabilities {
    pub last_input: bool,
    pub lock_state: bool,
    pub sleep_wake: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceStatus {
    pub state: PresenceSensorState,
    pub database_path: String,
    pub poll_interval_ms: u64,
    pub afk_threshold_ms: u64,
    pub suspend_gap_threshold_ms: u64,
    pub observed_at_ms: Option<i64>,
    pub observed_at: Option<String>,
    pub last_input_at_ms: Option<i64>,
    pub last_input_at: Option<String>,
    pub idle_duration_ms: Option<u64>,
    pub is_afk: bool,
    pub afk_since_ms: Option<i64>,
    pub afk_since: Option<String>,
    pub is_locked: Option<bool>,
    pub last_sleep_at_ms: Option<i64>,
    pub last_sleep_at: Option<String>,
    pub last_wake_at_ms: Option<i64>,
    pub last_wake_at: Option<String>,
    pub capabilities: PresenceCapabilities,
    pub warnings: Vec<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PresenceEventKind {
    AfkStarted,
    AfkEnded,
    ScreenLocked,
    ScreenUnlocked,
    SleepStarted,
    WokeUp,
}

impl PresenceEventKind {
    fn as_database_value(self) -> &'static str {
        match self {
            Self::AfkStarted => "afk_started",
            Self::AfkEnded => "afk_ended",
            Self::ScreenLocked => "screen_locked",
            Self::ScreenUnlocked => "screen_unlocked",
            Self::SleepStarted => "sleep_started",
            Self::WokeUp => "woke_up",
        }
    }

    fn from_database_value(value: &str) -> Result<Self, rusqlite::Error> {
        match value {
            "afk_started" => Ok(Self::AfkStarted),
            "afk_ended" => Ok(Self::AfkEnded),
            "screen_locked" => Ok(Self::ScreenLocked),
            "screen_unlocked" => Ok(Self::ScreenUnlocked),
            "sleep_started" => Ok(Self::SleepStarted),
            "woke_up" => Ok(Self::WokeUp),
            _ => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown presence event type: {value}").into(),
            )),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceEventRecord {
    pub id: i64,
    pub event_type: PresenceEventKind,
    pub occurred_at_ms: i64,
    pub occurred_at: String,
    pub observed_at_ms: i64,
    pub observed_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresenceEventQuery {
    #[serde(default = "default_query_limit")]
    pub limit: usize,
    #[serde(default)]
    pub event_types: Vec<PresenceEventKind>,
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
}

impl Default for PresenceEventQuery {
    fn default() -> Self {
        Self {
            limit: default_query_limit(),
            event_types: Vec::new(),
            from_ms: None,
            to_ms: None,
        }
    }
}

impl PresenceEventQuery {
    pub fn validate(&self) -> Result<(), PresenceError> {
        if self.limit == 0 || self.limit > MAX_QUERY_LIMIT {
            return Err(PresenceError::Configuration(format!(
                "presence.events limit must be between 1 and {MAX_QUERY_LIMIT}"
            )));
        }
        if matches!((self.from_ms, self.to_ms), (Some(from), Some(to)) if from > to) {
            return Err(PresenceError::Configuration(
                "presence.events fromMs cannot be greater than toMs".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PresenceObservation {
    pub idle_duration: Option<Duration>,
    pub locked: Option<bool>,
    pub warnings: Vec<String>,
}

pub trait PresenceProvider: Send + Sync + 'static {
    fn observe(&self) -> Result<PresenceObservation, PresenceError>;
}

#[derive(Default)]
pub struct SystemPresenceProvider;

impl PresenceProvider for SystemPresenceProvider {
    fn observe(&self) -> Result<PresenceObservation, PresenceError> {
        platform::observe()
    }
}

#[derive(Clone)]
pub struct PresenceService {
    inner: Arc<PresenceInner>,
}

struct PresenceInner {
    config: PresenceConfig,
    store: PresenceStore,
    status: Mutex<PresenceStatus>,
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl PresenceService {
    pub fn start(
        config: PresenceConfig,
        provider: Arc<dyn PresenceProvider>,
    ) -> Result<Self, PresenceError> {
        Self::start_with_event_journal(config, provider, None)
    }

    pub fn start_with_event_journal(
        config: PresenceConfig,
        provider: Arc<dyn PresenceProvider>,
        event_journal: Option<EventJournal>,
    ) -> Result<Self, PresenceError> {
        let store = PresenceStore::open(&config.database_path)?;
        let persisted = store.load_state()?.unwrap_or_default();
        let status = PresenceStatus {
            state: PresenceSensorState::Starting,
            database_path: config.database_path.to_string_lossy().into_owned(),
            poll_interval_ms: duration_ms_u64(config.poll_interval),
            afk_threshold_ms: duration_ms_u64(config.afk_threshold),
            suspend_gap_threshold_ms: duration_ms_u64(config.suspend_gap_threshold),
            observed_at_ms: persisted.observed_at_ms,
            observed_at: persisted.observed_at_ms.map(format_timestamp),
            last_input_at_ms: persisted.last_input_at_ms,
            last_input_at: persisted.last_input_at_ms.map(format_timestamp),
            idle_duration_ms: persisted.idle_duration_ms,
            is_afk: persisted.is_afk,
            afk_since_ms: persisted.afk_since_ms,
            afk_since: persisted.afk_since_ms.map(format_timestamp),
            is_locked: persisted.is_locked,
            last_sleep_at_ms: persisted.last_sleep_at_ms,
            last_sleep_at: persisted.last_sleep_at_ms.map(format_timestamp),
            last_wake_at_ms: persisted.last_wake_at_ms,
            last_wake_at: persisted.last_wake_at_ms.map(format_timestamp),
            capabilities: PresenceCapabilities {
                sleep_wake: true,
                ..PresenceCapabilities::default()
            },
            warnings: Vec::new(),
            last_error: None,
        };
        let tracker = PresenceTracker {
            persisted,
            previous_runtime_sample_at_ms: None,
        };
        let inner = Arc::new(PresenceInner {
            config,
            store,
            status: Mutex::new(status),
            cancellation: CancellationToken::new(),
            task: Mutex::new(None),
        });
        let task = tokio::spawn(run_presence_monitor(
            inner.clone(),
            provider,
            tracker,
            event_journal,
        ));
        *inner.task.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
        Ok(Self { inner })
    }

    pub fn status(&self) -> PresenceStatus {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn events(
        &self,
        query: &PresenceEventQuery,
    ) -> Result<Vec<PresenceEventRecord>, PresenceError> {
        self.inner.store.query_events(query)
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

async fn run_presence_monitor(
    inner: Arc<PresenceInner>,
    provider: Arc<dyn PresenceProvider>,
    mut tracker: PresenceTracker,
    event_journal: Option<EventJournal>,
) {
    let mut ticker = interval(inner.config.poll_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            () = inner.cancellation.cancelled() => {
                inner.status
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .state = PresenceSensorState::Stopped;
                break;
            }
            _ = ticker.tick() => {
                let pending_publication_error = event_journal
                    .as_ref()
                    .and_then(|journal| flush_presence_event_outbox(&inner.store, journal).err());
                let observed_at_ms = now_ms();
                let observation = tokio::task::spawn_blocking({
                    let provider = provider.clone();
                    move || provider.observe()
                })
                .await
                .map_err(|error| PresenceError::Collection(
                    format!("presence observation task failed: {error}")
                ))
                .and_then(|result| result);

                match observation {
                    Ok(observation) => {
                        let mut candidate = tracker.clone();
                        let events = candidate.apply(
                            &inner.config,
                            &observation,
                            observed_at_ms,
                        );
                        if let Err(error) = inner.store.record_sample(
                            &candidate.persisted,
                            &events,
                            observed_at_ms,
                            event_journal.is_some(),
                        ) {
                            update_error_status(&inner, error.to_string());
                            continue;
                        }
                        tracker = candidate;
                        let publication_error = event_journal
                            .as_ref()
                            .and_then(|journal| flush_presence_event_outbox(&inner.store, journal).err());
                        update_observation_status(
                            &inner,
                            &tracker.persisted,
                            observation,
                        );
                        if let Some(error) = publication_error {
                            update_error_status(&inner, error.to_string());
                        }
                    }
                    Err(error) => {
                        let error = pending_publication_error
                            .map(|publication_error| {
                                format!("{error}; pending presence event retry failed: {publication_error}")
                            })
                            .unwrap_or_else(|| error.to_string());
                        update_error_status(&inner, error);
                    }
                }
            }
        }
    }
}

fn publish_presence_events(
    event_journal: &EventJournal,
    events: &[PendingPresenceEvent],
    observed_at_ms: i64,
) -> Result<(), PresenceError> {
    for event in events {
        event_journal.append(presence_event_draft(event, observed_at_ms))?;
    }
    Ok(())
}

fn presence_event_draft(event: &PendingPresenceEvent, observed_at_ms: i64) -> DesktopEventDraft {
    let kind = match event.event_type {
        PresenceEventKind::AfkStarted => desktop_event_kinds::PRESENCE_AFK_STARTED,
        PresenceEventKind::AfkEnded => desktop_event_kinds::PRESENCE_AFK_ENDED,
        PresenceEventKind::ScreenLocked => desktop_event_kinds::PRESENCE_LOCKED,
        PresenceEventKind::ScreenUnlocked => desktop_event_kinds::PRESENCE_UNLOCKED,
        PresenceEventKind::SleepStarted => desktop_event_kinds::PRESENCE_SLEEP,
        PresenceEventKind::WokeUp => desktop_event_kinds::PRESENCE_WAKE,
    };
    let payload = match event.event_type {
        PresenceEventKind::AfkStarted | PresenceEventKind::AfkEnded => {
            json!({ "idleForMs": event.idle_for_ms.unwrap_or_default() })
        }
        PresenceEventKind::ScreenLocked
        | PresenceEventKind::ScreenUnlocked
        | PresenceEventKind::SleepStarted
        | PresenceEventKind::WokeUp => json!({}),
    };
    DesktopEventDraft {
        kind: kind.to_owned(),
        source: "presence.sensor".to_owned(),
        occurred_at_ms: event.occurred_at_ms,
        observed_at_ms: observed_at_ms.max(event.occurred_at_ms),
        goal_version: None,
        sensitivity: DesktopEventSensitivity::Metadata,
        payload,
        deduplication_key: format!(
            "presence:{}:{}",
            event.event_type.as_database_value(),
            event.occurred_at_ms,
        ),
    }
}

fn flush_presence_event_outbox(
    store: &PresenceStore,
    event_journal: &EventJournal,
) -> Result<(), PresenceError> {
    for record in store.pending_desktop_events(100)? {
        event_journal.append(presence_event_draft(&record.event, record.observed_at_ms))?;
        store.delete_desktop_event(record.id)?;
    }
    Ok(())
}

fn update_observation_status(
    inner: &PresenceInner,
    persisted: &PersistedPresenceState,
    observation: PresenceObservation,
) {
    let capabilities = PresenceCapabilities {
        last_input: observation.idle_duration.is_some(),
        lock_state: observation.locked.is_some(),
        sleep_wake: true,
    };
    let fully_available = capabilities.last_input && capabilities.lock_state;
    let last_error = (!observation.warnings.is_empty()).then(|| observation.warnings.join("; "));
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    status.state = if fully_available {
        PresenceSensorState::Running
    } else {
        PresenceSensorState::Degraded
    };
    status.observed_at_ms = persisted.observed_at_ms;
    status.observed_at = persisted.observed_at_ms.map(format_timestamp);
    status.last_input_at_ms = persisted.last_input_at_ms;
    status.last_input_at = persisted.last_input_at_ms.map(format_timestamp);
    status.idle_duration_ms = persisted.idle_duration_ms;
    status.is_afk = persisted.is_afk;
    status.afk_since_ms = persisted.afk_since_ms;
    status.afk_since = persisted.afk_since_ms.map(format_timestamp);
    status.is_locked = persisted.is_locked;
    status.last_sleep_at_ms = persisted.last_sleep_at_ms;
    status.last_sleep_at = persisted.last_sleep_at_ms.map(format_timestamp);
    status.last_wake_at_ms = persisted.last_wake_at_ms;
    status.last_wake_at = persisted.last_wake_at_ms.map(format_timestamp);
    status.capabilities = capabilities;
    status.warnings = observation.warnings;
    status.last_error = last_error;
}

fn update_error_status(inner: &PresenceInner, error: String) {
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    status.state = PresenceSensorState::Degraded;
    status.warnings = vec![error.clone()];
    status.last_error = Some(error);
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct PersistedPresenceState {
    observed_at_ms: Option<i64>,
    last_input_at_ms: Option<i64>,
    idle_duration_ms: Option<u64>,
    is_afk: bool,
    afk_since_ms: Option<i64>,
    is_locked: Option<bool>,
    last_sleep_at_ms: Option<i64>,
    last_wake_at_ms: Option<i64>,
}

#[derive(Clone, Debug)]
struct PendingPresenceEvent {
    event_type: PresenceEventKind,
    occurred_at_ms: i64,
    idle_for_ms: Option<u64>,
}

#[derive(Clone, Debug)]
struct PresenceTracker {
    persisted: PersistedPresenceState,
    previous_runtime_sample_at_ms: Option<i64>,
}

impl PresenceTracker {
    fn apply(
        &mut self,
        config: &PresenceConfig,
        observation: &PresenceObservation,
        observed_at_ms: i64,
    ) -> Vec<PendingPresenceEvent> {
        let mut events = Vec::new();
        let poll_interval_ms = duration_ms_i64(config.poll_interval);
        let suspend_gap_ms = duration_ms_i64(config.suspend_gap_threshold);
        if let Some(previous_sample_at_ms) = self.previous_runtime_sample_at_ms {
            let elapsed_ms = observed_at_ms.saturating_sub(previous_sample_at_ms);
            if elapsed_ms > poll_interval_ms.saturating_add(suspend_gap_ms) {
                let sleep_at_ms = previous_sample_at_ms.saturating_add(poll_interval_ms);
                events.push(PendingPresenceEvent {
                    event_type: PresenceEventKind::SleepStarted,
                    occurred_at_ms: sleep_at_ms,
                    idle_for_ms: None,
                });
                events.push(PendingPresenceEvent {
                    event_type: PresenceEventKind::WokeUp,
                    occurred_at_ms: observed_at_ms,
                    idle_for_ms: None,
                });
                self.persisted.last_sleep_at_ms = Some(sleep_at_ms);
                self.persisted.last_wake_at_ms = Some(observed_at_ms);
            }
        }
        self.previous_runtime_sample_at_ms = Some(observed_at_ms);

        if let Some(idle_duration) = observation.idle_duration {
            let idle_duration_ms = duration_ms_u64(idle_duration);
            let idle_duration_ms_i64 = i64::try_from(idle_duration_ms).unwrap_or(i64::MAX);
            let last_input_at_ms = observed_at_ms.saturating_sub(idle_duration_ms_i64);
            let now_afk = idle_duration >= config.afk_threshold;
            if now_afk != self.persisted.is_afk {
                let (event_type, occurred_at_ms) = if now_afk {
                    (
                        PresenceEventKind::AfkStarted,
                        last_input_at_ms
                            .saturating_add(duration_ms_i64(config.afk_threshold))
                            .min(observed_at_ms),
                    )
                } else {
                    (PresenceEventKind::AfkEnded, last_input_at_ms)
                };
                events.push(PendingPresenceEvent {
                    event_type,
                    occurred_at_ms,
                    idle_for_ms: Some(if now_afk {
                        duration_ms_u64(config.afk_threshold)
                    } else {
                        self.persisted.idle_duration_ms.unwrap_or_default()
                    }),
                });
                self.persisted.is_afk = now_afk;
                self.persisted.afk_since_ms = now_afk.then_some(occurred_at_ms);
            }
            self.persisted.last_input_at_ms = Some(last_input_at_ms);
            self.persisted.idle_duration_ms = Some(idle_duration_ms);
        }

        if let Some(locked) = observation.locked {
            if let Some(previous_locked) = self.persisted.is_locked
                && previous_locked != locked
            {
                events.push(PendingPresenceEvent {
                    event_type: if locked {
                        PresenceEventKind::ScreenLocked
                    } else {
                        PresenceEventKind::ScreenUnlocked
                    },
                    occurred_at_ms: observed_at_ms,
                    idle_for_ms: None,
                });
            }
            self.persisted.is_locked = Some(locked);
        }
        self.persisted.observed_at_ms = Some(observed_at_ms);
        events.sort_by_key(|event| event.occurred_at_ms);
        events
    }
}

#[derive(Clone, Debug)]
struct PresenceStore {
    path: PathBuf,
}

#[derive(Clone, Debug)]
struct PresenceEventOutboxRecord {
    id: i64,
    event: PendingPresenceEvent,
    observed_at_ms: i64,
}

impl PresenceStore {
    fn open(path: impl Into<PathBuf>) -> Result<Self, PresenceError> {
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

    fn record_sample(
        &self,
        state: &PersistedPresenceState,
        events: &[PendingPresenceEvent],
        observed_at_ms: i64,
        enqueue_desktop_events: bool,
    ) -> Result<(), PresenceError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for event in events {
            transaction.execute(
                "INSERT INTO presence_events (event_type, occurred_at_ms, observed_at_ms)
                 VALUES (?1, ?2, ?3)",
                params![
                    event.event_type.as_database_value(),
                    event.occurred_at_ms,
                    observed_at_ms
                ],
            )?;
            if enqueue_desktop_events {
                transaction.execute(
                    "INSERT OR IGNORE INTO presence_event_outbox (
                        event_type, occurred_at_ms, observed_at_ms, idle_for_ms,
                        deduplication_key
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        event.event_type.as_database_value(),
                        event.occurred_at_ms,
                        observed_at_ms,
                        event
                            .idle_for_ms
                            .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
                        format!(
                            "presence:{}:{}",
                            event.event_type.as_database_value(),
                            event.occurred_at_ms,
                        ),
                    ],
                )?;
            }
        }
        transaction.execute(
            "INSERT INTO presence_state (
                singleton_id, observed_at_ms, last_input_at_ms, idle_duration_ms,
                is_afk, afk_since_ms, is_locked, last_sleep_at_ms, last_wake_at_ms
             ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(singleton_id) DO UPDATE SET
                observed_at_ms = excluded.observed_at_ms,
                last_input_at_ms = excluded.last_input_at_ms,
                idle_duration_ms = excluded.idle_duration_ms,
                is_afk = excluded.is_afk,
                afk_since_ms = excluded.afk_since_ms,
                is_locked = excluded.is_locked,
                last_sleep_at_ms = excluded.last_sleep_at_ms,
                last_wake_at_ms = excluded.last_wake_at_ms",
            params![
                state.observed_at_ms,
                state.last_input_at_ms,
                state
                    .idle_duration_ms
                    .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
                state.is_afk,
                state.afk_since_ms,
                state.is_locked,
                state.last_sleep_at_ms,
                state.last_wake_at_ms,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn pending_desktop_events(
        &self,
        limit: usize,
    ) -> Result<Vec<PresenceEventOutboxRecord>, PresenceError> {
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT id, event_type, occurred_at_ms, observed_at_ms, idle_for_ms
             FROM presence_event_outbox ORDER BY id LIMIT ?1",
        )?;
        let rows = statement.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
            Ok(PresenceEventOutboxRecord {
                id: row.get(0)?,
                event: PendingPresenceEvent {
                    event_type: PresenceEventKind::from_database_value(&row.get::<_, String>(1)?)?,
                    occurred_at_ms: row.get(2)?,
                    idle_for_ms: row
                        .get::<_, Option<i64>>(4)?
                        .map(|value| u64::try_from(value).unwrap_or_default()),
                },
                observed_at_ms: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn delete_desktop_event(&self, id: i64) -> Result<(), PresenceError> {
        let connection = self.connect()?;
        connection.execute("DELETE FROM presence_event_outbox WHERE id = ?1", [id])?;
        Ok(())
    }

    fn load_state(&self) -> Result<Option<PersistedPresenceState>, PresenceError> {
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT observed_at_ms, last_input_at_ms, idle_duration_ms,
                    is_afk, afk_since_ms, is_locked, last_sleep_at_ms, last_wake_at_ms
             FROM presence_state WHERE singleton_id = 1",
        )?;
        let mut rows = statement.query([])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let idle_duration_ms = row
            .get::<_, Option<i64>>(2)?
            .map(|value| u64::try_from(value).unwrap_or_default());
        Ok(Some(PersistedPresenceState {
            observed_at_ms: row.get(0)?,
            last_input_at_ms: row.get(1)?,
            idle_duration_ms,
            is_afk: row.get(3)?,
            afk_since_ms: row.get(4)?,
            is_locked: row.get(5)?,
            last_sleep_at_ms: row.get(6)?,
            last_wake_at_ms: row.get(7)?,
        }))
    }

    fn query_events(
        &self,
        query: &PresenceEventQuery,
    ) -> Result<Vec<PresenceEventRecord>, PresenceError> {
        query.validate()?;
        let connection = self.connect()?;
        let mut clauses = Vec::new();
        let mut values = Vec::<SqlValue>::new();
        if !query.event_types.is_empty() {
            let placeholders = vec!["?"; query.event_types.len()].join(", ");
            clauses.push(format!("event_type IN ({placeholders})"));
            values.extend(
                query
                    .event_types
                    .iter()
                    .map(|event| SqlValue::Text(event.as_database_value().to_owned())),
            );
        }
        if let Some(from_ms) = query.from_ms {
            clauses.push("occurred_at_ms >= ?".to_owned());
            values.push(SqlValue::Integer(from_ms));
        }
        if let Some(to_ms) = query.to_ms {
            clauses.push("occurred_at_ms <= ?".to_owned());
            values.push(SqlValue::Integer(to_ms));
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        values.push(SqlValue::Integer(query.limit as i64));
        let sql = format!(
            "SELECT id, event_type, occurred_at_ms, observed_at_ms
             FROM presence_events{where_clause}
             ORDER BY occurred_at_ms DESC, id DESC
             LIMIT ?"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| {
            let event_type = PresenceEventKind::from_database_value(&row.get::<_, String>(1)?)?;
            let occurred_at_ms = row.get::<_, i64>(2)?;
            let observed_at_ms = row.get::<_, i64>(3)?;
            Ok(PresenceEventRecord {
                id: row.get(0)?,
                event_type,
                occurred_at_ms,
                occurred_at: format_timestamp(occurred_at_ms),
                observed_at_ms,
                observed_at: format_timestamp(observed_at_ms),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn initialize(&self) -> Result<(), PresenceError> {
        let connection = self.connect()?;
        let current_version =
            connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
        if current_version > PRESENCE_SCHEMA_VERSION {
            return Err(PresenceError::Configuration(format!(
                "presence database schema version {current_version} is newer than supported version {PRESENCE_SCHEMA_VERSION}"
            )));
        }
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS presence_state (
                singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                observed_at_ms INTEGER,
                last_input_at_ms INTEGER,
                idle_duration_ms INTEGER,
                is_afk INTEGER NOT NULL,
                afk_since_ms INTEGER,
                is_locked INTEGER,
                last_sleep_at_ms INTEGER,
                last_wake_at_ms INTEGER
             );
             CREATE TABLE IF NOT EXISTS presence_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL CHECK (
                    event_type IN (
                        'afk_started', 'afk_ended', 'screen_locked',
                        'screen_unlocked', 'sleep_started', 'woke_up'
                    )
                ),
                occurred_at_ms INTEGER NOT NULL,
                observed_at_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_presence_events_occurred
                ON presence_events(occurred_at_ms DESC);
             CREATE INDEX IF NOT EXISTS idx_presence_events_type_occurred
                ON presence_events(event_type, occurred_at_ms DESC);
             CREATE TABLE IF NOT EXISTS presence_event_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL CHECK (
                    event_type IN (
                        'afk_started', 'afk_ended', 'screen_locked',
                        'screen_unlocked', 'sleep_started', 'woke_up'
                    )
                ),
                occurred_at_ms INTEGER NOT NULL,
                observed_at_ms INTEGER NOT NULL,
                idle_for_ms INTEGER,
                deduplication_key TEXT NOT NULL UNIQUE
             );
             CREATE INDEX IF NOT EXISTS presence_event_outbox_order
                ON presence_event_outbox(id);
             PRAGMA user_version = 2;",
        )?;
        Ok(())
    }

    fn connect(&self) -> Result<Connection, PresenceError> {
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

fn duration_from_environment(
    name: &str,
    default_ms: u64,
    minimum_ms: u64,
    maximum_ms: u64,
) -> Result<Duration, PresenceError> {
    let Some(value) = env::var_os(name) else {
        return Ok(Duration::from_millis(default_ms));
    };
    let value = value.to_string_lossy();
    let milliseconds = value.parse::<u64>().map_err(|_| {
        PresenceError::Configuration(format!(
            "{name} must be an integer number of milliseconds, received {value:?}"
        ))
    })?;
    if !(minimum_ms..=maximum_ms).contains(&milliseconds) {
        return Err(PresenceError::Configuration(format!(
            "{name} must be between {minimum_ms} and {maximum_ms} milliseconds"
        )));
    }
    Ok(Duration::from_millis(milliseconds))
}

fn default_query_limit() -> usize {
    100
}

fn duration_ms_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn duration_ms_i64(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn format_timestamp(timestamp_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::mem;
    use std::time::Duration;

    use super::{PresenceError, PresenceObservation};

    const DESKTOP_SWITCHDESKTOP: u32 = 0x0100;
    const ERROR_ACCESS_DENIED: u32 = 5;

    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }

    #[link(name = "User32")]
    unsafe extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
        fn OpenInputDesktop(flags: u32, inherit: i32, desired_access: u32) -> *mut c_void;
        fn SwitchDesktop(desktop: *mut c_void) -> i32;
        fn CloseDesktop(desktop: *mut c_void) -> i32;
    }

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn GetTickCount64() -> u64;
        fn GetLastError() -> u32;
    }

    pub(super) fn observe() -> Result<PresenceObservation, PresenceError> {
        let mut warnings = Vec::new();
        let idle_duration = match windows_idle_duration() {
            Ok(value) => Some(value),
            Err(error) => {
                warnings.push(error);
                None
            }
        };
        let locked = match windows_lock_state() {
            Ok(value) => Some(value),
            Err(error) => {
                warnings.push(error);
                None
            }
        };
        Ok(PresenceObservation {
            idle_duration,
            locked,
            warnings,
        })
    }

    fn windows_idle_duration() -> Result<Duration, String> {
        let mut info = LastInputInfo {
            cb_size: u32::try_from(mem::size_of::<LastInputInfo>()).unwrap_or(u32::MAX),
            dw_time: 0,
        };
        // SAFETY: `info` has the documented layout and remains valid for the call.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return Err("GetLastInputInfo failed".to_owned());
        }
        // SAFETY: GetTickCount64 has no preconditions.
        let current_tick = unsafe { GetTickCount64() } as u32;
        Ok(Duration::from_millis(u64::from(
            current_tick.wrapping_sub(info.dw_time),
        )))
    }

    fn windows_lock_state() -> Result<bool, String> {
        // SAFETY: Flags and access mask follow the OpenInputDesktop contract.
        let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP) };
        if desktop.is_null() {
            // SAFETY: GetLastError has no preconditions.
            return if unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
                Ok(true)
            } else {
                Err("OpenInputDesktop could not inspect the interactive desktop".to_owned())
            };
        }
        // SAFETY: `desktop` is a valid handle returned by OpenInputDesktop.
        let switchable = unsafe { SwitchDesktop(desktop) } != 0;
        // SAFETY: The handle is closed exactly once after use.
        let _ = unsafe { CloseDesktop(desktop) };
        Ok(!switchable)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::Command;
    use std::time::Duration;

    use super::{PresenceError, PresenceObservation};

    pub(super) fn observe() -> Result<PresenceObservation, PresenceError> {
        let mut warnings = Vec::new();
        let idle_duration =
            match command_text("/usr/sbin/ioreg", &["-c", "IOHIDSystem", "-r", "-d", "1"])
                .and_then(|text| parse_hid_idle_time(&text))
            {
                Ok(value) => Some(value),
                Err(error) => {
                    warnings.push(error);
                    None
                }
            };
        let locked = match command_text("/usr/sbin/ioreg", &["-n", "Root", "-d", "1"]).map(|text| {
            text.lines().any(|line| {
                line.contains("CGSSessionScreenIsLocked")
                    && (line.contains("Yes") || line.contains("true"))
            })
        }) {
            Ok(value) => Some(value),
            Err(error) => {
                warnings.push(error);
                None
            }
        };
        Ok(PresenceObservation {
            idle_duration,
            locked,
            warnings,
        })
    }

    fn command_text(program: &str, arguments: &[&str]) -> Result<String, String> {
        let output = Command::new(program)
            .args(arguments)
            .output()
            .map_err(|error| format!("{program} failed to start: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "{program} returned status {}",
                output.status.code().unwrap_or(-1)
            ));
        }
        String::from_utf8(output.stdout)
            .map_err(|error| format!("{program} returned invalid UTF-8: {error}"))
    }

    fn parse_hid_idle_time(output: &str) -> Result<Duration, String> {
        let value = output
            .lines()
            .find(|line| line.contains("HIDIdleTime"))
            .and_then(|line| line.rsplit_once('='))
            .map(|(_, value)| value.trim())
            .ok_or_else(|| "IOHIDSystem did not expose HIDIdleTime".to_owned())?;
        let nanoseconds = value
            .parse::<u64>()
            .map_err(|_| format!("invalid HIDIdleTime value: {value}"))?;
        Ok(Duration::from_nanos(nanoseconds))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::env;
    use std::fs;
    use std::process::Command;
    use std::time::Duration;

    use super::{PresenceError, PresenceObservation};

    pub(super) fn observe() -> Result<PresenceObservation, PresenceError> {
        let x11_idle = query_x11_idle();
        let login = query_logind();
        let idle_duration = x11_idle
            .as_ref()
            .ok()
            .copied()
            .or_else(|| login.as_ref().ok().and_then(|state| state.idle_duration));
        let locked = login.as_ref().ok().and_then(|state| state.locked);
        let mut warnings = Vec::new();
        if idle_duration.is_none() {
            warnings.push(format!(
                "last-input capability unavailable: {}; {}",
                error_text(&x11_idle),
                error_text(&login)
            ));
        }
        if locked.is_none() {
            warnings.push(format!(
                "lock-state capability unavailable: {}",
                error_text(&login)
            ));
        }
        Ok(PresenceObservation {
            idle_duration,
            locked,
            warnings,
        })
    }

    #[derive(Clone, Copy, Debug)]
    struct LogindState {
        idle_duration: Option<Duration>,
        locked: Option<bool>,
    }

    fn query_x11_idle() -> Result<Duration, String> {
        if env::var_os("DISPLAY").is_none() {
            return Err("DISPLAY is not set".to_owned());
        }
        let output = Command::new("xprintidle")
            .output()
            .map_err(|error| format!("xprintidle failed to start: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "xprintidle returned status {}",
                output.status.code().unwrap_or(-1)
            ));
        }
        let text = String::from_utf8(output.stdout)
            .map_err(|error| format!("xprintidle returned invalid UTF-8: {error}"))?;
        let milliseconds = text
            .trim()
            .parse::<u64>()
            .map_err(|_| format!("invalid xprintidle value: {}", text.trim()))?;
        Ok(Duration::from_millis(milliseconds))
    }

    fn query_logind() -> Result<LogindState, String> {
        let session = env::var("XDG_SESSION_ID").unwrap_or_else(|_| "self".to_owned());
        let output = Command::new("loginctl")
            .args([
                "show-session",
                &session,
                "--property=IdleHint",
                "--property=IdleSinceHintMonotonic",
                "--property=LockedHint",
            ])
            .output()
            .map_err(|error| format!("loginctl failed to start: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "loginctl could not inspect session {session}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let text = String::from_utf8(output.stdout)
            .map_err(|error| format!("loginctl returned invalid UTF-8: {error}"))?;
        let property = |name: &str| {
            text.lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
                .map(str::trim)
        };
        let idle_hint = property("IdleHint").and_then(parse_boolean);
        let idle_since_us = property("IdleSinceHintMonotonic")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0);
        let idle_duration = match idle_hint {
            Some(false) => Some(Duration::ZERO),
            Some(true) => idle_since_us.and_then(idle_duration_since_boot),
            None => None,
        };
        Ok(LogindState {
            idle_duration,
            locked: property("LockedHint").and_then(parse_boolean),
        })
    }

    fn idle_duration_since_boot(idle_since_us: u64) -> Option<Duration> {
        let uptime = fs::read_to_string("/proc/uptime").ok()?;
        let uptime_seconds = uptime.split_whitespace().next()?.parse::<f64>().ok()?;
        let uptime_us = (uptime_seconds * 1_000_000.0).max(0.0) as u64;
        Some(Duration::from_micros(
            uptime_us.saturating_sub(idle_since_us),
        ))
    }

    fn parse_boolean(value: &str) -> Option<bool> {
        match value {
            "yes" | "true" | "1" => Some(true),
            "no" | "false" | "0" => Some(false),
            _ => None,
        }
    }

    fn error_text<T>(result: &Result<T, String>) -> &str {
        match result {
            Ok(_) => "capability did not return a value",
            Err(error) => error,
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    use super::{PresenceError, PresenceObservation};

    pub(super) fn observe() -> Result<PresenceObservation, PresenceError> {
        Ok(PresenceObservation {
            idle_duration: None,
            locked: None,
            warnings: vec![format!(
                "presence collection is unsupported on {}",
                std::env::consts::OS
            )],
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use tempfile::TempDir;
    use whalehall_local_protocol::EventQueryParams;

    use super::*;

    fn config(directory: &TempDir) -> PresenceConfig {
        PresenceConfig {
            database_path: directory.path().join("presence.sqlite3"),
            poll_interval: Duration::from_secs(1),
            afk_threshold: Duration::from_secs(5),
            suspend_gap_threshold: Duration::from_secs(10),
        }
    }

    #[test]
    fn tracks_afk_lock_and_sleep_transitions() {
        let directory = tempfile::tempdir().expect("create presence test directory");
        let config = config(&directory);
        let store = PresenceStore::open(&config.database_path).expect("open presence store");
        let mut tracker = PresenceTracker {
            persisted: PersistedPresenceState::default(),
            previous_runtime_sample_at_ms: None,
        };

        let first = tracker.apply(
            &config,
            &PresenceObservation {
                idle_duration: Some(Duration::from_secs(1)),
                locked: Some(false),
                warnings: Vec::new(),
            },
            10_000,
        );
        assert!(first.is_empty());
        store
            .record_sample(&tracker.persisted, &first, 10_000, false)
            .expect("persist first observation");

        let afk = tracker.apply(
            &config,
            &PresenceObservation {
                idle_duration: Some(Duration::from_secs(6)),
                locked: Some(false),
                warnings: Vec::new(),
            },
            15_000,
        );
        assert_eq!(afk.len(), 1);
        assert_eq!(afk[0].event_type, PresenceEventKind::AfkStarted);
        assert_eq!(afk[0].occurred_at_ms, 14_000);
        assert_eq!(afk[0].idle_for_ms, Some(5_000));
        store
            .record_sample(&tracker.persisted, &afk, 15_000, false)
            .expect("persist AFK transition");

        let returned_and_locked = tracker.apply(
            &config,
            &PresenceObservation {
                idle_duration: Some(Duration::ZERO),
                locked: Some(true),
                warnings: Vec::new(),
            },
            16_000,
        );
        assert_eq!(
            returned_and_locked
                .iter()
                .map(|event| event.event_type)
                .collect::<Vec<_>>(),
            vec![PresenceEventKind::AfkEnded, PresenceEventKind::ScreenLocked]
        );
        assert_eq!(returned_and_locked[0].idle_for_ms, Some(6_000));
        assert_eq!(returned_and_locked[1].idle_for_ms, None);
        store
            .record_sample(&tracker.persisted, &returned_and_locked, 16_000, false)
            .expect("persist return and lock transitions");

        let woke_and_unlocked = tracker.apply(
            &config,
            &PresenceObservation {
                idle_duration: Some(Duration::from_secs(1)),
                locked: Some(false),
                warnings: Vec::new(),
            },
            50_000,
        );
        assert_eq!(
            woke_and_unlocked
                .iter()
                .map(|event| event.event_type)
                .collect::<Vec<_>>(),
            vec![
                PresenceEventKind::SleepStarted,
                PresenceEventKind::WokeUp,
                PresenceEventKind::ScreenUnlocked,
            ]
        );
        store
            .record_sample(&tracker.persisted, &woke_and_unlocked, 50_000, false)
            .expect("persist sleep and unlock transitions");

        let events = store
            .query_events(&PresenceEventQuery {
                limit: 20,
                ..PresenceEventQuery::default()
            })
            .expect("query events");
        assert_eq!(events.len(), 6);
        assert_eq!(events[0].event_type, PresenceEventKind::ScreenUnlocked);
        assert_eq!(events[1].event_type, PresenceEventKind::WokeUp);
        assert_eq!(tracker.persisted.last_input_at_ms, Some(49_000));
        assert!(!tracker.persisted.is_afk);
        assert_eq!(tracker.persisted.is_locked, Some(false));
        assert_eq!(tracker.persisted.last_sleep_at_ms, Some(17_000));
        assert_eq!(tracker.persisted.last_wake_at_ms, Some(50_000));
    }

    #[test]
    fn publishes_presence_boundaries_to_the_desktop_event_journal() {
        let directory = tempfile::tempdir().expect("create presence event directory");
        let journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open events");
        let pending = [
            PendingPresenceEvent {
                event_type: PresenceEventKind::AfkStarted,
                occurred_at_ms: 10_000,
                idle_for_ms: Some(300_000),
            },
            PendingPresenceEvent {
                event_type: PresenceEventKind::ScreenLocked,
                occurred_at_ms: 11_000,
                idle_for_ms: None,
            },
            PendingPresenceEvent {
                event_type: PresenceEventKind::WokeUp,
                occurred_at_ms: 12_000,
                idle_for_ms: None,
            },
        ];
        publish_presence_events(&journal, &pending, 12_500).unwrap();

        let events = journal.query(&EventQueryParams::default()).unwrap().events;
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, desktop_event_kinds::PRESENCE_AFK_STARTED);
        assert_eq!(events[0].payload, json!({ "idleForMs": 300_000 }));
        assert_eq!(events[1].kind, desktop_event_kinds::PRESENCE_LOCKED);
        assert_eq!(events[1].payload, json!({}));
        assert_eq!(events[2].kind, desktop_event_kinds::PRESENCE_WAKE);
        assert_eq!(events[2].payload, json!({}));
        assert!(
            events
                .iter()
                .all(|event| event.payload.get("eventType").is_none())
        );
        assert!(
            events
                .iter()
                .all(|event| !event.contributes_to_reflection_count())
        );
    }

    #[test]
    fn filters_events_and_rejects_invalid_ranges() {
        let directory = tempfile::tempdir().expect("create presence test directory");
        let store = PresenceStore::open(directory.path().join("presence.sqlite3"))
            .expect("open presence store");
        let state = PersistedPresenceState {
            observed_at_ms: Some(20),
            ..PersistedPresenceState::default()
        };
        store
            .record_sample(
                &state,
                &[
                    PendingPresenceEvent {
                        event_type: PresenceEventKind::ScreenLocked,
                        occurred_at_ms: 10,
                        idle_for_ms: None,
                    },
                    PendingPresenceEvent {
                        event_type: PresenceEventKind::ScreenUnlocked,
                        occurred_at_ms: 20,
                        idle_for_ms: None,
                    },
                ],
                20,
                false,
            )
            .expect("record events");
        let events = store
            .query_events(&PresenceEventQuery {
                event_types: vec![PresenceEventKind::ScreenLocked],
                from_ms: Some(5),
                to_ms: Some(15),
                ..PresenceEventQuery::default()
            })
            .expect("query filtered events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, PresenceEventKind::ScreenLocked);

        let error = PresenceEventQuery {
            from_ms: Some(20),
            to_ms: Some(10),
            ..PresenceEventQuery::default()
        }
        .validate()
        .expect_err("invalid range must fail");
        assert!(error.to_string().contains("fromMs"));
    }

    struct SequenceProvider {
        observations: Mutex<VecDeque<PresenceObservation>>,
    }

    impl PresenceProvider for SequenceProvider {
        fn observe(&self) -> Result<PresenceObservation, PresenceError> {
            Ok(self
                .observations
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .pop_front()
                .unwrap_or(PresenceObservation {
                    idle_duration: Some(Duration::ZERO),
                    locked: Some(false),
                    warnings: Vec::new(),
                }))
        }
    }

    #[tokio::test]
    async fn resident_service_persists_and_reports_capabilities() {
        let directory = tempfile::tempdir().expect("create presence test directory");
        let mut config = config(&directory);
        config.poll_interval = Duration::from_millis(50);
        let provider = Arc::new(SequenceProvider {
            observations: Mutex::new(VecDeque::from([PresenceObservation {
                idle_duration: Some(Duration::from_millis(25)),
                locked: Some(false),
                warnings: Vec::new(),
            }])),
        });
        let service = PresenceService::start(config, provider).expect("start presence service");
        tokio::time::sleep(Duration::from_millis(80)).await;
        let status = service.status();
        assert_eq!(status.state, PresenceSensorState::Running);
        assert!(status.capabilities.last_input);
        assert!(status.capabilities.lock_state);
        assert!(status.capabilities.sleep_wake);
        assert!(status.last_input_at_ms.is_some());
        assert!(service.database_path().exists());
        service.shutdown().await;
        assert_eq!(service.status().state, PresenceSensorState::Stopped);
    }

    #[test]
    fn system_provider_returns_an_explicit_capability_result() {
        let observation = SystemPresenceProvider
            .observe()
            .expect("system presence collection should not abort");
        if observation.idle_duration.is_none() || observation.locked.is_none() {
            assert!(!observation.warnings.is_empty());
        }
    }
}
