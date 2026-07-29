use std::env;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use directories::ProjectDirs;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;
use whalehall_local_protocol::desktop_event_kinds;

use super::model::format_timestamp;
use super::store::ActivityStore;
use super::{
    ActivityCacheScope, ActivityCleanupResult, ActivityCurrentSession, ActivityError,
    ActivityMonitorState, ActivityQuery, ActivityStatus, ForegroundApp, ForegroundAppProvider,
    UsageSession,
};
use crate::events::{DesktopEventDraft, EventJournal};

pub const DEFAULT_ACTIVITY_POLL_INTERVAL_MS: u64 = 100;
const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 5_000;

#[derive(Clone, Debug)]
pub struct ActivityConfig {
    pub database_path: PathBuf,
    pub poll_interval: Duration,
    pub heartbeat_interval: Duration,
}

impl ActivityConfig {
    pub fn from_environment() -> Result<Self, ActivityError> {
        let data_dir = if let Some(path) = env::var_os("WHALEHALL_DATA_DIR") {
            PathBuf::from(path)
        } else {
            ProjectDirs::from("com", "seago", "whalehall")
                .ok_or_else(|| {
                    ActivityError::Configuration(
                        "unable to resolve the operating system application data directory"
                            .to_owned(),
                    )
                })?
                .data_dir()
                .to_path_buf()
        };
        let poll_interval_ms = match env::var("WHALEHALL_ACTIVITY_POLL_MS") {
            Ok(value) => value.parse::<u64>().map_err(|error| {
                ActivityError::Configuration(format!(
                    "WHALEHALL_ACTIVITY_POLL_MS must be an integer: {error}"
                ))
            })?,
            Err(_) => DEFAULT_ACTIVITY_POLL_INTERVAL_MS,
        };
        if !(50..=5_000).contains(&poll_interval_ms) {
            return Err(ActivityError::Configuration(
                "WHALEHALL_ACTIVITY_POLL_MS must be between 50 and 5000.".to_owned(),
            ));
        }
        Ok(Self {
            database_path: data_dir.join("usage.sqlite3"),
            poll_interval: Duration::from_millis(poll_interval_ms),
            heartbeat_interval: Duration::from_millis(DEFAULT_HEARTBEAT_INTERVAL_MS),
        })
    }
}

#[derive(Clone)]
pub struct ActivityService {
    inner: Arc<ActivityInner>,
}

struct ActivityInner {
    config: ActivityConfig,
    store: ActivityStore,
    status: Mutex<ActivityStatus>,
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
    commands: mpsc::UnboundedSender<ActivityCommand>,
}

enum ActivityCommand {
    Cleanup {
        scope: ActivityCacheScope,
        response: oneshot::Sender<Result<ActivityCleanupResult, ActivityError>>,
    },
}

impl ActivityService {
    pub fn start(
        config: ActivityConfig,
        provider: Arc<dyn ForegroundAppProvider>,
    ) -> Result<Self, ActivityError> {
        Self::start_with_event_journal(config, provider, None)
    }

    pub fn start_with_event_journal(
        config: ActivityConfig,
        provider: Arc<dyn ForegroundAppProvider>,
        event_journal: Option<EventJournal>,
    ) -> Result<Self, ActivityError> {
        let store = ActivityStore::open(&config.database_path)?;
        store.recover_open_sessions()?;
        let (commands, command_receiver) = mpsc::unbounded_channel();
        let inner = Arc::new(ActivityInner {
            status: Mutex::new(ActivityStatus {
                state: ActivityMonitorState::Starting,
                database_path: config.database_path.to_string_lossy().into_owned(),
                poll_interval_ms: config.poll_interval.as_millis() as u64,
                current_session: None,
                last_observed_at_ms: None,
                last_error: None,
            }),
            config,
            store,
            cancellation: CancellationToken::new(),
            task: Mutex::new(None),
            commands,
        });
        let task = tokio::spawn(run_monitor(
            inner.clone(),
            provider,
            command_receiver,
            event_journal,
        ));
        *inner.task.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
        Ok(Self { inner })
    }

    pub fn status(&self) -> ActivityStatus {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn sessions(&self, query: &ActivityQuery) -> Result<Vec<UsageSession>, ActivityError> {
        self.inner.store.query(query)
    }

    pub fn database_path(&self) -> &std::path::Path {
        self.inner.store.path()
    }

    pub async fn cleanup(
        &self,
        scope: ActivityCacheScope,
    ) -> Result<ActivityCleanupResult, ActivityError> {
        let (response, receiver) = oneshot::channel();
        self.inner
            .commands
            .send(ActivityCommand::Cleanup { scope, response })
            .map_err(|_| {
                ActivityError::Configuration("activity monitor is not running".to_owned())
            })?;
        receiver.await.map_err(|_| {
            ActivityError::Configuration(
                "activity monitor stopped before cleanup completed".to_owned(),
            )
        })?
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

async fn run_monitor(
    inner: Arc<ActivityInner>,
    provider: Arc<dyn ForegroundAppProvider>,
    mut commands: mpsc::UnboundedReceiver<ActivityCommand>,
    event_journal: Option<EventJournal>,
) {
    let mut recorder = ActivityRecorder::new(
        inner.store.clone(),
        inner.config.heartbeat_interval.as_millis() as i64,
    )
    .with_event_journal(event_journal);
    update_status(&inner, ActivityMonitorState::Running, None, None, None);
    let mut ticker = interval(inner.config.poll_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let gap_threshold_ms = i64::try_from(inner.config.poll_interval.as_millis())
        .unwrap_or(i64::MAX)
        .saturating_mul(3)
        .max(2_000);
    let mut previous_tick_ms = None;

    loop {
        tokio::select! {
            () = inner.cancellation.cancelled() => {
                let observed_at_ms = now_ms();
                let error = recorder.stop(observed_at_ms, "shutdown").err().map(|error| error.to_string());
                update_status(&inner, ActivityMonitorState::Stopped, None, Some(observed_at_ms), error);
                break;
            }
            Some(command) = commands.recv() => {
                match command {
                    ActivityCommand::Cleanup { scope, response } => {
                        let result = inner.store.cleanup(scope, now_ms());
                        if result.is_ok() && scope == ActivityCacheScope::All {
                            recorder.reset_after_cleanup();
                            update_status(
                                &inner,
                                ActivityMonitorState::Running,
                                None,
                                None,
                                None,
                            );
                        }
                        let _ = response.send(result);
                    }
                }
            }
            _ = ticker.tick() => {
                let observed_at_ms = now_ms();
                if let Some(previous_tick_ms) = previous_tick_ms
                    && is_observation_gap(previous_tick_ms, observed_at_ms, gap_threshold_ms)
                    && let Err(error) = recorder.stop(previous_tick_ms, "observation_gap")
                {
                    update_status(
                        &inner,
                        ActivityMonitorState::Degraded,
                        recorder.current_status(),
                        Some(observed_at_ms),
                        Some(format!("failed closing activity after an observation gap: {error}")),
                    );
                    continue;
                }
                previous_tick_ms = Some(observed_at_ms);
                let observation = observe_foreground(provider.clone()).await;
                match observation {
                    Ok(app) => match recorder.observe(app, observed_at_ms) {
                        Ok(()) => update_status(
                            &inner,
                            ActivityMonitorState::Running,
                            recorder.current_status(),
                            Some(observed_at_ms),
                            None,
                        ),
                        Err(error) => update_status(
                            &inner,
                            ActivityMonitorState::Degraded,
                            recorder.current_status(),
                            Some(observed_at_ms),
                            Some(error.to_string()),
                        ),
                    },
                    Err(error) => {
                        let close_error = recorder.stop(observed_at_ms, "foreground_unavailable").err();
                        let message = close_error
                            .map(|close_error| format!("{error}; failed closing current session: {close_error}"))
                            .unwrap_or_else(|| error.to_string());
                        update_status(
                            &inner,
                            ActivityMonitorState::Degraded,
                            recorder.current_status(),
                            Some(observed_at_ms),
                            Some(message),
                        );
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
async fn observe_foreground(
    provider: Arc<dyn ForegroundAppProvider>,
) -> Result<Option<ForegroundApp>, ActivityError> {
    // NSWorkspace is main-thread-affine. The server binary uses a current-thread Tokio runtime,
    // keeping foreground reads on the process main thread so activation changes are visible.
    provider.foreground_app()
}

#[cfg(not(target_os = "macos"))]
async fn observe_foreground(
    provider: Arc<dyn ForegroundAppProvider>,
) -> Result<Option<ForegroundApp>, ActivityError> {
    tokio::task::spawn_blocking(move || provider.foreground_app())
        .await
        .map_err(|error| {
            ActivityError::Foreground(format!("foreground observation task failed: {error}"))
        })?
}

fn update_status(
    inner: &ActivityInner,
    state: ActivityMonitorState,
    current_session: Option<ActivityCurrentSession>,
    last_observed_at_ms: Option<i64>,
    last_error: Option<String>,
) {
    let mut status = inner
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    status.state = state;
    status.current_session = current_session;
    status.last_observed_at_ms = last_observed_at_ms.or(status.last_observed_at_ms);
    status.last_error = last_error;
}

struct OpenSession {
    id: i64,
    app: ForegroundApp,
    started_at_ms: i64,
}

struct ActivityRecorder {
    store: ActivityStore,
    current: Option<OpenSession>,
    heartbeat_interval_ms: i64,
    last_heartbeat_ms: i64,
    event_journal: Option<EventJournal>,
}

impl ActivityRecorder {
    fn new(store: ActivityStore, heartbeat_interval_ms: i64) -> Self {
        Self {
            store,
            current: None,
            heartbeat_interval_ms,
            last_heartbeat_ms: 0,
            event_journal: None,
        }
    }

    fn with_event_journal(mut self, event_journal: Option<EventJournal>) -> Self {
        self.event_journal = event_journal;
        self
    }

    fn observe(
        &mut self,
        next: Option<ForegroundApp>,
        observed_at_ms: i64,
    ) -> Result<(), ActivityError> {
        if let (Some(current), Some(next)) = (&self.current, &next)
            && current.app.same_usage_target(next)
        {
            if observed_at_ms.saturating_sub(self.last_heartbeat_ms) >= self.heartbeat_interval_ms {
                self.store.touch(current.id, observed_at_ms)?;
                self.last_heartbeat_ms = observed_at_ms;
            }
            return Ok(());
        }

        let current_id = self.current.as_ref().map(|session| session.id);
        let next_app = next.clone();
        let next_id =
            self.store
                .transition(current_id, next.as_ref(), observed_at_ms, "app_switch")?;
        self.current = next_id.zip(next).map(|(id, app)| OpenSession {
            id,
            app,
            started_at_ms: observed_at_ms,
        });
        self.last_heartbeat_ms = observed_at_ms;
        if let Some(next_app) = next_app.as_ref() {
            self.publish_foreground_change(next_app, next_id, observed_at_ms)?;
        }
        Ok(())
    }

    fn stop(&mut self, observed_at_ms: i64, reason: &str) -> Result<(), ActivityError> {
        let Some(current) = self.current.as_ref() else {
            return Ok(());
        };
        let current_id = current.id;
        self.store
            .transition(Some(current_id), None, observed_at_ms, reason)?;
        self.current = None;
        Ok(())
    }

    fn publish_foreground_change(
        &self,
        current: &ForegroundApp,
        current_session_id: Option<i64>,
        observed_at_ms: i64,
    ) -> Result<(), ActivityError> {
        let Some(event_journal) = &self.event_journal else {
            return Ok(());
        };
        event_journal.append(DesktopEventDraft::metadata(
            desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED,
            "activity.sensor",
            observed_at_ms,
            activity_event_payload(current),
            format!(
                "foreground:{observed_at_ms}:{}",
                current_session_id
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_owned()),
            ),
        ))?;
        Ok(())
    }

    fn current_status(&self) -> Option<ActivityCurrentSession> {
        self.current.as_ref().map(|session| ActivityCurrentSession {
            id: session.id,
            app_id: session.app.app_id.clone(),
            app_name: session.app.app_name.clone(),
            executable_path: session.app.executable_path.clone(),
            process_id: session.app.process_id,
            window_title: session.app.window_title.clone(),
            started_at_ms: session.started_at_ms,
            started_at: format_timestamp(session.started_at_ms),
        })
    }

    fn reset_after_cleanup(&mut self) {
        self.current = None;
        self.last_heartbeat_ms = 0;
    }
}

fn activity_event_payload(app: &ForegroundApp) -> Value {
    json!({
        "appId": app.app_id,
        "appName": app.app_name,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn is_observation_gap(previous_ms: i64, current_ms: i64, threshold_ms: i64) -> bool {
    current_ms.saturating_sub(previous_ms) > threshold_ms
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;
    use whalehall_local_protocol::EventQueryParams;

    use super::*;

    fn app(id: &str, process_id: u64) -> ForegroundApp {
        ForegroundApp {
            app_id: id.to_owned(),
            app_name: id.to_owned(),
            executable_path: format!("/apps/{id}"),
            process_id,
            window_title: format!("{id} window"),
        }
    }

    fn test_store() -> (TempDir, ActivityStore) {
        let directory = tempfile::tempdir().expect("create test directory");
        let store = ActivityStore::open(directory.path().join("usage.sqlite3"))
            .expect("open activity database");
        (directory, store)
    }

    #[test]
    fn records_every_observed_switch_with_exact_boundaries() {
        let (_directory, store) = test_store();
        let mut recorder = ActivityRecorder::new(store.clone(), 500);

        recorder.observe(Some(app("editor", 10)), 1_000).unwrap();
        recorder.observe(Some(app("editor", 10)), 1_600).unwrap();
        recorder.observe(Some(app("browser", 20)), 2_500).unwrap();
        recorder.observe(None, 3_100).unwrap();

        let sessions = store.query(&ActivityQuery::default()).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].app_id, "browser");
        assert_eq!(sessions[0].started_at_ms, 2_500);
        assert_eq!(sessions[0].ended_at_ms, Some(3_100));
        assert_eq!(sessions[0].duration_ms, Some(600));
        assert_eq!(sessions[1].app_id, "editor");
        assert_eq!(sessions[1].started_at_ms, 1_000);
        assert_eq!(sessions[1].last_seen_at_ms, 2_500);
        assert_eq!(sessions[1].ended_at_ms, Some(2_500));
        assert_eq!(sessions[1].duration_ms, Some(1_500));
    }

    #[test]
    fn publishes_each_real_foreground_transition_without_heartbeat_duplicates() {
        let (directory, store) = test_store();
        let event_journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open events");
        let mut recorder =
            ActivityRecorder::new(store, 500).with_event_journal(Some(event_journal.clone()));

        recorder.observe(Some(app("editor", 10)), 1_000).unwrap();
        recorder.observe(Some(app("editor", 10)), 1_600).unwrap();
        recorder.observe(Some(app("browser", 20)), 2_500).unwrap();
        recorder.stop(3_100, "shutdown").unwrap();

        let events = event_journal
            .query(&EventQueryParams::default())
            .unwrap()
            .events;
        assert_eq!(events.len(), 2);
        assert!(
            events
                .iter()
                .all(|event| event.kind == desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED)
        );
        assert_eq!(events[0].payload["appId"], "editor");
        assert_eq!(events[0].payload["appName"], "editor");
        assert!(events[0].payload.get("windowTitle").is_none());
        assert_eq!(events[1].payload["appId"], "browser");
        assert!(events[0].payload.get("previous").is_none());
        assert!(events[0].payload.get("processId").is_none());
        assert!(events[0].payload.get("executablePath").is_none());
    }

    #[test]
    fn keeps_current_session_open_and_closes_it_on_shutdown() {
        let (_directory, store) = test_store();
        let mut recorder = ActivityRecorder::new(store.clone(), 5_000);
        recorder.observe(Some(app("terminal", 30)), 4_000).unwrap();

        let open = store.query(&ActivityQuery::default()).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].ended_at_ms, None);
        assert_eq!(open[0].duration_ms, None);

        recorder.stop(5_250, "shutdown").unwrap();
        let closed = store.query(&ActivityQuery::default()).unwrap();
        assert_eq!(closed[0].ended_at_ms, Some(5_250));
        assert_eq!(closed[0].duration_ms, Some(1_250));
        assert_eq!(closed[0].end_reason.as_deref(), Some("shutdown"));
    }

    #[test]
    fn recovers_unclean_session_at_last_heartbeat_instead_of_restart_time() {
        let (_directory, store) = test_store();
        let mut recorder = ActivityRecorder::new(store.clone(), 500);
        recorder.observe(Some(app("editor", 40)), 10_000).unwrap();
        recorder.observe(Some(app("editor", 40)), 10_750).unwrap();
        drop(recorder);

        assert_eq!(store.recover_open_sessions().unwrap(), 1);
        let recovered = store.query(&ActivityQuery::default()).unwrap();
        assert_eq!(recovered[0].ended_at_ms, Some(10_750));
        assert_eq!(recovered[0].duration_ms, Some(750));
        assert_eq!(
            recovered[0].end_reason.as_deref(),
            Some("recovered_after_unclean_shutdown")
        );
    }

    #[test]
    fn preserves_zero_duration_switches_instead_of_aggregating_them_away() {
        let (_directory, store) = test_store();
        let mut recorder = ActivityRecorder::new(store.clone(), 5_000);
        recorder.observe(Some(app("first", 1)), 20_000).unwrap();
        recorder.observe(Some(app("second", 2)), 20_000).unwrap();
        recorder.observe(Some(app("third", 3)), 20_000).unwrap();
        recorder.stop(20_001, "shutdown").unwrap();

        let sessions = store.query(&ActivityQuery::default()).unwrap();
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[2].app_id, "first");
        assert_eq!(sessions[2].duration_ms, Some(0));
        assert_eq!(sessions[1].app_id, "second");
        assert_eq!(sessions[1].duration_ms, Some(0));
        assert_eq!(sessions[0].app_id, "third");
        assert_eq!(sessions[0].duration_ms, Some(1));
    }

    #[test]
    fn excludes_observation_gaps_from_usage_duration() {
        let (_directory, store) = test_store();
        let mut recorder = ActivityRecorder::new(store.clone(), 5_000);
        recorder.observe(Some(app("editor", 1)), 1_000).unwrap();

        assert!(!is_observation_gap(1_000, 3_000, 2_000));
        assert!(is_observation_gap(1_000, 3_001, 2_000));
        recorder.stop(1_100, "observation_gap").unwrap();
        recorder.observe(Some(app("editor", 1)), 10_000).unwrap();
        recorder.stop(10_200, "shutdown").unwrap();

        let sessions = store.query(&ActivityQuery::default()).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[1].duration_ms, Some(100));
        assert_eq!(sessions[1].end_reason.as_deref(), Some("observation_gap"));
        assert_eq!(sessions[0].started_at_ms, 10_000);
        assert_eq!(sessions[0].duration_ms, Some(200));
    }

    #[test]
    fn filters_sessions_and_validates_query_bounds() {
        let (_directory, store) = test_store();
        let mut recorder = ActivityRecorder::new(store.clone(), 5_000);
        recorder.observe(Some(app("editor", 1)), 1_000).unwrap();
        recorder.observe(Some(app("browser", 2)), 2_000).unwrap();
        recorder.stop(3_000, "shutdown").unwrap();

        let sessions = store
            .query(&ActivityQuery {
                limit: 10,
                from_ms: Some(1_500),
                to_ms: Some(2_500),
                app_id: Some("browser".to_owned()),
                include_open: false,
            })
            .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].app_id, "browser");
        assert!(
            store
                .query(&ActivityQuery {
                    limit: 0,
                    ..ActivityQuery::default()
                })
                .is_err()
        );
    }

    #[test]
    fn cleanup_applies_30_day_7_day_and_all_policies() {
        const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
        let (_directory, store) = test_store();
        let mut recorder = ActivityRecorder::new(store.clone(), 5_000);
        let now = 100 * DAY_MS;

        recorder
            .observe(Some(app("older-than-30-days", 1)), now - 40 * DAY_MS)
            .unwrap();
        recorder.stop(now - 39 * DAY_MS, "shutdown").unwrap();
        recorder
            .observe(Some(app("between-7-and-30-days", 2)), now - 20 * DAY_MS)
            .unwrap();
        recorder.stop(now - 19 * DAY_MS, "shutdown").unwrap();
        recorder
            .observe(Some(app("within-7-days", 3)), now - 2 * DAY_MS)
            .unwrap();
        recorder.stop(now - DAY_MS, "shutdown").unwrap();

        let long_term = store.cleanup(ActivityCacheScope::LongTerm, now).unwrap();
        assert_eq!(long_term.deleted_sessions, 1);
        assert_eq!(long_term.retention_days, Some(30));
        assert_eq!(store.query(&ActivityQuery::default()).unwrap().len(), 2);

        let short_term = store.cleanup(ActivityCacheScope::ShortTerm, now).unwrap();
        assert_eq!(short_term.deleted_sessions, 1);
        assert_eq!(short_term.retention_days, Some(7));
        assert_eq!(store.query(&ActivityQuery::default()).unwrap().len(), 1);

        let all = store.cleanup(ActivityCacheScope::All, now).unwrap();
        assert_eq!(all.deleted_sessions, 1);
        assert_eq!(all.retention_days, None);
        assert!(store.query(&ActivityQuery::default()).unwrap().is_empty());
    }

    #[test]
    fn retention_cleanup_never_deletes_the_open_session() {
        const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
        let (_directory, store) = test_store();
        let mut recorder = ActivityRecorder::new(store.clone(), 5_000);
        recorder
            .observe(Some(app("still-open", 1)), DAY_MS)
            .unwrap();

        let result = store
            .cleanup(ActivityCacheScope::ShortTerm, 100 * DAY_MS)
            .unwrap();
        assert_eq!(result.deleted_sessions, 0);
        let sessions = store.query(&ActivityQuery::default()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].ended_at_ms, None);
    }
}
