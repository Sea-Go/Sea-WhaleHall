use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};
use whalehall_local_core::observations::{ObservationJournal, ObservationKeyStorageMode};
use whalehall_local_protocol::{
    CoverageLevelV2, MonitoringConfigureParams, MonitoringPermissionState, MonitoringPermissions,
    MonitoringRefreshPermissionsParams, MonitoringState, MonitoringStatusResult,
    RAW_OBSERVATION_SCHEMA_VERSION, RawObservationInputV2,
};

const HELPER_PATH_ENV: &str = "WHALEHALL_OBSERVER_HELPER_PATH";
const RUNTIME_CHANNEL_ENV: &str = "WHALEHALL_RUNTIME_CHANNEL";
const HELPER_ENABLED_ENV: &str = "WHALEHALL_OBSERVER_MONITORING_ENABLED";
const HELPER_CAPTURE_CONTENT_ENV: &str = "WHALEHALL_OBSERVER_CAPTURE_CONTENT";
const HELPER_EXCLUDED_APPS_ENV: &str = "WHALEHALL_OBSERVER_EXCLUDED_BUNDLE_IDS";
const OBSERVER_BUNDLE_NAME: &str = "WhaleHall Observer.app";
const OBSERVER_EXECUTABLE_NAME: &str = "whalehall-observer";
const OBSERVER_BUNDLE_ID: &str = "com.seago.whalehall.observer";
const DEV_LEGACY_KEYCHAIN_WARNING: &str = "dev_legacy_keychain_in_use";
const MAX_HELPER_FRAME_BYTES: usize = 512 * 1024;
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_TICK: Duration = Duration::from_secs(5);
const FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);
const FAILURE_LIMIT: usize = 5;
const RESTART_DELAYS: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(60),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeChannel {
    Dev,
    Canary,
    Stable,
}

impl RuntimeChannel {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "dev" => Ok(Self::Dev),
            "canary" => Ok(Self::Canary),
            "stable" => Ok(Self::Stable),
            _ => Err(format!(
                "{RUNTIME_CHANNEL_ENV} must be one of dev, canary, or stable"
            )),
        }
    }
}

#[derive(Clone)]
pub struct ObserverSupervisorConfig {
    pub enabled: bool,
    pub capture_content: bool,
    pub excluded_bundle_ids: Vec<String>,
    pub helper_path: Option<PathBuf>,
}

impl ObserverSupervisorConfig {
    pub fn from_environment() -> Result<Self, String> {
        let enabled = parse_bool(HELPER_ENABLED_ENV, false)?;
        let capture_content = parse_bool(HELPER_CAPTURE_CONTENT_ENV, true)?;
        let excluded_bundle_ids = std::env::var(HELPER_EXCLUDED_APPS_ENV)
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        validate_excluded_bundle_ids(&excluded_bundle_ids)?;
        let helper_path = resolve_helper_path()?;
        Ok(Self {
            enabled,
            capture_content,
            excluded_bundle_ids,
            helper_path,
        })
    }
}

#[derive(Clone)]
pub struct ObserverSupervisor {
    status: Arc<Mutex<MonitoringStatusResult>>,
    commands: mpsc::Sender<SupervisorCommand>,
}

impl ObserverSupervisor {
    pub fn start(config: ObserverSupervisorConfig, journal: ObservationJournal) -> Self {
        let initial_state = if config.enabled {
            MonitoringState::Starting
        } else {
            MonitoringState::Disabled
        };
        let key_warning = observation_key_warning(&journal).map(ToOwned::to_owned);
        let status = Arc::new(Mutex::new(MonitoringStatusResult {
            state: initial_state,
            enabled: config.enabled,
            capture_content: config.capture_content,
            excluded_bundle_ids: config.excluded_bundle_ids.clone(),
            helper_pid: None,
            helper_path_available: config.helper_path.is_some(),
            boot_id: None,
            last_sequence: None,
            last_acked_sequence: None,
            last_heartbeat_at_ms: None,
            permissions: MonitoringPermissions::default(),
            coverage: vec![CoverageLevelV2::Metadata],
            last_error: key_warning,
        }));
        let (commands, receiver) = mpsc::channel(32);
        tokio::spawn(run_supervisor(config, journal, status.clone(), receiver));
        Self { status, commands }
    }

    pub fn status(&self) -> MonitoringStatusResult {
        self.status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub async fn configure(
        &self,
        params: MonitoringConfigureParams,
    ) -> Result<MonitoringStatusResult, String> {
        validate_excluded_bundle_ids(&params.excluded_bundle_ids)?;
        self.request(|response| SupervisorCommand::Configure { params, response })
            .await
    }

    pub async fn pause(&self) -> Result<MonitoringStatusResult, String> {
        self.request(|response| SupervisorCommand::Pause { response })
            .await
    }

    pub async fn resume(&self) -> Result<MonitoringStatusResult, String> {
        self.request(|response| SupervisorCommand::Resume { response })
            .await
    }

    pub async fn refresh_permissions(
        &self,
        params: MonitoringRefreshPermissionsParams,
    ) -> Result<MonitoringStatusResult, String> {
        self.request(|response| SupervisorCommand::RefreshPermissions {
            prompt: params.prompt,
            response,
        })
        .await
    }

    pub async fn shutdown(&self) {
        let (response, completed) = oneshot::channel();
        if self
            .commands
            .send(SupervisorCommand::Shutdown { response })
            .await
            .is_ok()
        {
            let _ = completed.await;
        }
    }

    async fn request(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<MonitoringStatusResult, String>>) -> SupervisorCommand,
    ) -> Result<MonitoringStatusResult, String> {
        let (response, completed) = oneshot::channel();
        self.commands
            .send(build(response))
            .await
            .map_err(|_| "observer supervisor is stopped".to_owned())?;
        completed
            .await
            .map_err(|_| "observer supervisor stopped before replying".to_owned())?
    }
}

enum SupervisorCommand {
    Configure {
        params: MonitoringConfigureParams,
        response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
    },
    Pause {
        response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
    },
    Resume {
        response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
    },
    RefreshPermissions {
        prompt: bool,
        response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
    },
    Shutdown {
        response: oneshot::Sender<()>,
    },
}

struct RuntimeSettings {
    enabled: bool,
    paused: bool,
    capture_content: bool,
    excluded_bundle_ids: Vec<String>,
    helper_path: Option<PathBuf>,
}

enum SessionOutcome {
    Restart,
    Reconfigure,
    Disabled,
    Shutdown,
}

#[derive(Default)]
struct RestartFailures {
    failures: VecDeque<Instant>,
}

impl RestartFailures {
    fn record(&mut self, at: Instant) -> bool {
        self.failures.push_back(at);
        self.prune(at);
        self.failures.len() >= FAILURE_LIMIT
    }

    fn clear(&mut self) {
        self.failures.clear();
    }

    fn prune(&mut self, at: Instant) {
        while self
            .failures
            .front()
            .is_some_and(|failure| at.duration_since(*failure) > FAILURE_WINDOW)
        {
            self.failures.pop_front();
        }
    }
}

async fn run_supervisor(
    config: ObserverSupervisorConfig,
    journal: ObservationJournal,
    status: Arc<Mutex<MonitoringStatusResult>>,
    mut commands: mpsc::Receiver<SupervisorCommand>,
) {
    let mut settings = RuntimeSettings {
        enabled: config.enabled,
        paused: false,
        capture_content: config.capture_content,
        excluded_bundle_ids: config.excluded_bundle_ids,
        helper_path: config.helper_path,
    };
    let mut restart_attempt = 0_usize;
    let mut restart_failures = RestartFailures::default();
    let mut restart_latched = false;
    loop {
        update_configuration_status(&status, &settings);
        if restart_latched {
            set_state(
                &status,
                MonitoringState::Degraded,
                Some("observer_restart_limit_reached"),
            );
            let Some(command) = commands.recv().await else {
                break;
            };
            let manual_retry = command_requests_manual_retry(&command);
            if handle_idle_command(command, &mut settings, &status).await {
                break;
            }
            if manual_retry && settings.enabled && !settings.paused {
                settings.helper_path = resolve_helper_path().ok().flatten();
                restart_failures.clear();
                restart_attempt = 0;
                restart_latched = false;
            }
            continue;
        }
        if !settings.enabled || settings.paused {
            set_state(
                &status,
                if settings.enabled {
                    MonitoringState::Paused
                } else {
                    MonitoringState::Disabled
                },
                None,
            );
            let Some(command) = commands.recv().await else {
                break;
            };
            let manual_retry = command_requests_manual_retry(&command);
            if handle_idle_command(command, &mut settings, &status).await {
                break;
            }
            if manual_retry && settings.enabled && !settings.paused {
                settings.helper_path = resolve_helper_path().ok().flatten();
            }
            continue;
        }

        let Some(helper_path) = settings.helper_path.clone() else {
            set_state(
                &status,
                MonitoringState::Degraded,
                Some("observer_helper_unavailable"),
            );
            let Some(command) = commands.recv().await else {
                break;
            };
            let manual_retry = command_requests_manual_retry(&command);
            if handle_idle_command(command, &mut settings, &status).await {
                break;
            }
            if manual_retry && settings.enabled && !settings.paused {
                settings.helper_path = resolve_helper_path().ok().flatten();
            }
            continue;
        };

        set_state(&status, MonitoringState::Starting, None);
        let failed = match spawn_helper(&helper_path).await {
            Ok((child, stderr_task)) => {
                let session_started = Instant::now();
                match run_helper_session(
                    child,
                    stderr_task,
                    &journal,
                    &status,
                    &mut settings,
                    &mut commands,
                )
                .await
                {
                    SessionOutcome::Shutdown => break,
                    SessionOutcome::Disabled => continue,
                    SessionOutcome::Reconfigure => {
                        restart_attempt = 0;
                        continue;
                    }
                    SessionOutcome::Restart => {
                        if session_started.elapsed() >= FAILURE_WINDOW {
                            restart_attempt = 0;
                        }
                        true
                    }
                }
            }
            Err(_) => {
                set_state(
                    &status,
                    MonitoringState::Degraded,
                    Some("observer_helper_start_failed"),
                );
                true
            }
        };
        if failed && restart_failures.record(Instant::now()) {
            restart_latched = true;
            continue;
        }

        let delay = RESTART_DELAYS[restart_attempt.min(RESTART_DELAYS.len() - 1)];
        restart_attempt = restart_attempt.saturating_add(1);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            command = commands.recv() => {
                let Some(command) = command else { break; };
                if handle_idle_command(command, &mut settings, &status).await {
                    break;
                }
            }
        }
    }
    set_state(&status, MonitoringState::Stopped, None);
}

async fn run_helper_session(
    mut child: Child,
    stderr_task: JoinHandle<()>,
    journal: &ObservationJournal,
    status: &Arc<Mutex<MonitoringStatusResult>>,
    settings: &mut RuntimeSettings,
    commands: &mut mpsc::Receiver<SupervisorCommand>,
) -> SessionOutcome {
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        stderr_task.abort();
        return SessionOutcome::Restart;
    };
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        stderr_task.abort();
        return SessionOutcome::Restart;
    };
    {
        let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
        current.helper_pid = child.id();
        current.boot_id = None;
        current.last_sequence = None;
        current.last_acked_sequence = None;
        current.last_heartbeat_at_ms = None;
        current.last_error = observation_key_warning(journal).map(ToOwned::to_owned);
    }
    if send_command(&mut stdin, "start-1", "start", settings, false)
        .await
        .is_err()
    {
        let _ = child.kill().await;
        stderr_task.abort();
        return SessionOutcome::Restart;
    }

    let mut stdout = BufReader::new(stdout);
    let mut health = interval(HEALTH_TICK);
    health.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut frame_state = HelperFrameState {
        active_boot_id: None,
        last_sequence: 0,
        last_observation_at_ms: None,
        last_heartbeat: Instant::now(),
    };
    let mut line = Vec::new();

    let outcome = loop {
        line.clear();
        tokio::select! {
            read = stdout.read_until(b'\n', &mut line) => {
                match read {
                    Ok(0) | Err(_) => break SessionOutcome::Restart,
                    Ok(_) => {
                        trim_line_end(&mut line);
                        if line.len() > MAX_HELPER_FRAME_BYTES {
                            set_state(status, MonitoringState::Degraded, Some("observer_frame_too_large"));
                            break SessionOutcome::Restart;
                        }
                        match handle_helper_frame(
                            &line,
                            journal,
                            status,
                            &mut stdin,
                            &mut frame_state,
                        ).await {
                            Ok(()) => {}
                            Err(code) => {
                                set_state(status, MonitoringState::Degraded, Some(code));
                                break SessionOutcome::Restart;
                            }
                        }
                    }
                }
            }
            _ = health.tick() => {
                if frame_state.last_heartbeat.elapsed() > HEARTBEAT_TIMEOUT {
                    set_state(status, MonitoringState::Degraded, Some("observer_heartbeat_timeout"));
                    break SessionOutcome::Restart;
                }
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    break SessionOutcome::Shutdown;
                };
                match handle_running_command(
                    command,
                    settings,
                    status,
                    &mut stdin,
                ).await {
                    RunningCommandOutcome::Continue => {}
                    RunningCommandOutcome::Reconfigure => {
                        break SessionOutcome::Reconfigure;
                    }
                    RunningCommandOutcome::Disabled => break SessionOutcome::Disabled,
                    RunningCommandOutcome::Shutdown => break SessionOutcome::Shutdown,
                }
            }
        }
    };

    let _ = send_simple_command(&mut stdin, "shutdown-parent", "shutdown", false).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    if child.id().is_some() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    stderr_task.abort();
    let _ = stderr_task.await;
    {
        let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
        current.helper_pid = None;
        current.boot_id = None;
    }
    outcome
}

enum RunningCommandOutcome {
    Continue,
    Reconfigure,
    Disabled,
    Shutdown,
}

async fn handle_running_command(
    command: SupervisorCommand,
    settings: &mut RuntimeSettings,
    status: &Arc<Mutex<MonitoringStatusResult>>,
    stdin: &mut ChildStdin,
) -> RunningCommandOutcome {
    match command {
        SupervisorCommand::Configure { params, response } => {
            settings.enabled = params.enabled;
            settings.capture_content = params.capture_content;
            settings.excluded_bundle_ids = params.excluded_bundle_ids;
            update_configuration_status(status, settings);
            set_state(
                status,
                if settings.enabled {
                    MonitoringState::Starting
                } else {
                    MonitoringState::Disabled
                },
                None,
            );
            let _ = response.send(Ok(status_snapshot(status)));
            if settings.enabled {
                RunningCommandOutcome::Reconfigure
            } else {
                RunningCommandOutcome::Disabled
            }
        }
        SupervisorCommand::Pause { response } => {
            settings.paused = true;
            let result = send_simple_command(stdin, "pause-runtime", "pause", false)
                .await
                .map(|()| {
                    set_state(status, MonitoringState::Paused, None);
                    status_snapshot(status)
                })
                .map_err(|_| "observer_pause_failed".to_owned());
            let _ = response.send(result);
            RunningCommandOutcome::Disabled
        }
        SupervisorCommand::Resume { response } => {
            settings.paused = false;
            let result = send_simple_command(stdin, "resume-runtime", "resume", false)
                .await
                .map(|()| {
                    set_state(status, MonitoringState::Running, None);
                    status_snapshot(status)
                })
                .map_err(|_| "observer_resume_failed".to_owned());
            let _ = response.send(result);
            RunningCommandOutcome::Continue
        }
        SupervisorCommand::RefreshPermissions { prompt, response } => {
            let result =
                send_simple_command(stdin, "refresh-permissions", "refreshPermissions", prompt)
                    .await
                    .map(|()| status_snapshot(status))
                    .map_err(|_| "observer_permission_refresh_failed".to_owned());
            let _ = response.send(result);
            RunningCommandOutcome::Continue
        }
        SupervisorCommand::Shutdown { response } => {
            let _ = response.send(());
            RunningCommandOutcome::Shutdown
        }
    }
}

async fn handle_idle_command(
    command: SupervisorCommand,
    settings: &mut RuntimeSettings,
    status: &Arc<Mutex<MonitoringStatusResult>>,
) -> bool {
    match command {
        SupervisorCommand::Configure { params, response } => {
            settings.enabled = params.enabled;
            settings.capture_content = params.capture_content;
            settings.excluded_bundle_ids = params.excluded_bundle_ids;
            settings.paused = false;
            update_configuration_status(status, settings);
            set_state(
                status,
                if settings.enabled {
                    MonitoringState::Starting
                } else {
                    MonitoringState::Disabled
                },
                None,
            );
            let _ = response.send(Ok(status_snapshot(status)));
            false
        }
        SupervisorCommand::Pause { response } => {
            settings.paused = true;
            set_state(status, MonitoringState::Paused, None);
            let _ = response.send(Ok(status_snapshot(status)));
            false
        }
        SupervisorCommand::Resume { response } => {
            settings.paused = false;
            if !settings.enabled {
                let _ = response.send(Err("observer_monitoring_disabled".to_owned()));
            } else {
                set_state(status, MonitoringState::Starting, None);
                let _ = response.send(Ok(status_snapshot(status)));
            }
            false
        }
        SupervisorCommand::RefreshPermissions { response, .. } => {
            if settings.enabled && !settings.paused {
                set_state(status, MonitoringState::Starting, None);
                let _ = response.send(Ok(status_snapshot(status)));
            } else {
                let _ = response.send(Err("observer_helper_not_running".to_owned()));
            }
            false
        }
        SupervisorCommand::Shutdown { response } => {
            let _ = response.send(());
            true
        }
    }
}

fn command_requests_manual_retry(command: &SupervisorCommand) -> bool {
    matches!(
        command,
        SupervisorCommand::Configure { params, .. } if params.enabled
    ) || matches!(
        command,
        SupervisorCommand::Resume { .. } | SupervisorCommand::RefreshPermissions { .. }
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservationFrame {
    #[serde(rename = "type")]
    frame_type: String,
    schema_version: String,
    boot_id: String,
    sequence: u64,
    observed_at_ms: i64,
    observation: RawObservationInputV2,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GapFrame {
    #[serde(rename = "type")]
    frame_type: String,
    schema_version: String,
    boot_id: String,
    observed_at_ms: i64,
    reason: String,
    dropped_frames: u64,
    coverage: Vec<CoverageLevelV2>,
}

struct HelperFrameState {
    active_boot_id: Option<String>,
    last_sequence: u64,
    last_observation_at_ms: Option<i64>,
    last_heartbeat: Instant,
}

async fn handle_helper_frame(
    bytes: &[u8],
    journal: &ObservationJournal,
    status: &Arc<Mutex<MonitoringStatusResult>>,
    stdin: &mut ChildStdin,
    frame_state: &mut HelperFrameState,
) -> Result<(), &'static str> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "observer_invalid_json")?;
    let frame_type = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or("observer_missing_frame_type")?;
    match frame_type {
        "observation" => {
            let frame: ObservationFrame =
                serde_json::from_value(value).map_err(|_| "observer_invalid_observation_frame")?;
            if frame.frame_type != "observation"
                || frame.schema_version != "observer-frame.v1"
                || frame.observation.schema_version != RAW_OBSERVATION_SCHEMA_VERSION
                || frame.sequence == 0
                || frame.observed_at_ms < frame.observation.interval.ended_at_ms
            {
                return Err("observer_invalid_observation_frame");
            }
            if frame_state.active_boot_id.as_deref() != Some(&frame.boot_id) {
                validate_boot_id(&frame.boot_id).map_err(|_| "observer_invalid_boot_id")?;
                frame_state.active_boot_id = Some(frame.boot_id.clone());
                frame_state.last_sequence = 0;
                frame_state.last_observation_at_ms = None;
            }
            if frame.sequence > frame_state.last_sequence.saturating_add(1) {
                let missing_from = frame_state.last_sequence.saturating_add(1);
                let missing_through = frame.sequence.saturating_sub(1);
                let gap_started_at_ms = frame_state
                    .last_observation_at_ms
                    .unwrap_or(frame.observation.interval.started_at_ms)
                    .min(frame.observation.interval.started_at_ms);
                let gap_ended_at_ms = frame.observation.interval.started_at_ms;
                journal
                    .record_coverage_gap(
                        &format!(
                            "observer:{}:sequence-gap:{missing_from}:{missing_through}",
                            frame.boot_id
                        ),
                        gap_started_at_ms,
                        gap_ended_at_ms,
                        "observer_sequence_gap",
                    )
                    .map_err(|_| "observer_gap_persistence_failed")?;
                let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
                push_coverage(&mut current.coverage, CoverageLevelV2::Unavailable);
                current.last_error = Some("observer_sequence_gap".to_owned());
            }
            let deduplication_key = format!("observer:{}:{}", frame.boot_id, frame.sequence);
            journal
                .ingest(&deduplication_key, frame.observation)
                .map_err(|_| "observer_persistence_failed")?;
            send_ack(stdin, &frame.boot_id, frame.sequence)
                .await
                .map_err(|_| "observer_ack_failed")?;
            frame_state.last_sequence = frame_state.last_sequence.max(frame.sequence);
            frame_state.last_observation_at_ms = Some(
                frame_state
                    .last_observation_at_ms
                    .unwrap_or(frame.observed_at_ms)
                    .max(frame.observed_at_ms),
            );
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.boot_id = Some(frame.boot_id);
            current.last_sequence = Some(frame_state.last_sequence);
            current.last_acked_sequence = Some(frame_state.last_sequence);
        }
        "ready" | "heartbeat" | "permissionStatus" => {
            frame_state.last_heartbeat = Instant::now();
            update_permissions(status, &value);
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.state = MonitoringState::Running;
            current.last_heartbeat_at_ms = Some(now_ms());
            current.last_error = observation_key_warning(journal).map(ToOwned::to_owned);
        }
        "gap" => {
            let frame: GapFrame =
                serde_json::from_value(value).map_err(|_| "observer_invalid_gap_frame")?;
            if frame.frame_type != "gap"
                || frame.schema_version != "observer-frame.v1"
                || frame.observed_at_ms < 0
                || frame.dropped_frames == 0
                || frame.reason != "parent_backpressure"
                || frame.coverage != [CoverageLevelV2::Unavailable]
            {
                return Err("observer_invalid_gap_frame");
            }
            validate_boot_id(&frame.boot_id).map_err(|_| "observer_invalid_boot_id")?;
            journal
                .record_coverage_gap(
                    &format!(
                        "observer:{}:reported-gap:{}",
                        frame.boot_id, frame.observed_at_ms
                    ),
                    frame.observed_at_ms,
                    frame.observed_at_ms,
                    "observer_reported_gap",
                )
                .map_err(|_| "observer_gap_persistence_failed")?;
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            push_coverage(&mut current.coverage, CoverageLevelV2::Unavailable);
            current.last_error = Some("observer_reported_gap".to_owned());
        }
        "error" => {
            let recoverable = value
                .get("recoverable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.last_error = Some("observer_reported_error".to_owned());
            if !recoverable {
                return Err("observer_unrecoverable_error");
            }
        }
        "commandResult" => {}
        _ => return Err("observer_unknown_frame"),
    }
    Ok(())
}

async fn spawn_helper(helper_path: &Path) -> io::Result<(Child, JoinHandle<()>)> {
    validate_helper_before_spawn(helper_path)
        .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?;
    let mut child = Command::new(helper_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("observer helper stderr was unavailable"))?;
    // Helper diagnostics are intentionally drained and discarded. They must
    // never become an accidental content side channel in WhaleHall logs.
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });
    Ok((child, stderr_task))
}

async fn send_command(
    stdin: &mut ChildStdin,
    id: &str,
    command: &str,
    settings: &RuntimeSettings,
    prompt: bool,
) -> io::Result<()> {
    write_helper_message(
        stdin,
        &json!({
            "type": "command",
            "id": id,
            "command": command,
            "config": {
                "captureContent": settings.capture_content,
                "excludedBundleIds": settings.excluded_bundle_ids,
            },
            "prompt": prompt,
        }),
    )
    .await
}

async fn send_simple_command(
    stdin: &mut ChildStdin,
    id: &str,
    command: &str,
    prompt: bool,
) -> io::Result<()> {
    write_helper_message(
        stdin,
        &json!({
            "type": "command",
            "id": id,
            "command": command,
            "prompt": prompt,
        }),
    )
    .await
}

async fn send_ack(stdin: &mut ChildStdin, boot_id: &str, sequence: u64) -> io::Result<()> {
    write_helper_message(
        stdin,
        &json!({
            "type": "ack",
            "bootId": boot_id,
            "sequence": sequence,
        }),
    )
    .await
}

async fn write_helper_message(stdin: &mut ChildStdin, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.len() > MAX_HELPER_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "observer command exceeds protocol bound",
        ));
    }
    stdin.write_all(&bytes).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

fn update_permissions(status: &Arc<Mutex<MonitoringStatusResult>>, value: &Value) {
    let permissions = value
        .get("permissions")
        .and_then(Value::as_object)
        .or_else(|| {
            value
                .get("data")
                .and_then(Value::as_object)
                .and_then(|data| data.get("permissions"))
                .and_then(Value::as_object)
        });
    let Some(permissions) = permissions else {
        return;
    };
    let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
    current.permissions.accessibility = permission_state(permissions, "accessibility");
    current.permissions.screen_recording = permission_state(permissions, "screenRecording");
    current.permissions.input_monitoring = permission_state(permissions, "inputMonitoring");
    current.permissions.automation = permission_state(permissions, "automation");
    let preserve_gap = current.coverage.contains(&CoverageLevelV2::Unavailable);
    current.coverage = vec![CoverageLevelV2::Metadata];
    if current.capture_content
        && (current.permissions.accessibility == MonitoringPermissionState::Granted
            || current.permissions.screen_recording == MonitoringPermissionState::Granted)
    {
        push_coverage(&mut current.coverage, CoverageLevelV2::Content);
    }
    if [
        current.permissions.accessibility,
        current.permissions.screen_recording,
        current.permissions.input_monitoring,
        current.permissions.automation,
    ]
    .contains(&MonitoringPermissionState::Denied)
    {
        push_coverage(&mut current.coverage, CoverageLevelV2::Denied);
    }
    if preserve_gap {
        push_coverage(&mut current.coverage, CoverageLevelV2::Unavailable);
    }
}

fn permission_state(permissions: &Map<String, Value>, key: &str) -> MonitoringPermissionState {
    match permissions.get(key).and_then(Value::as_str) {
        Some("authorized" | "granted") => MonitoringPermissionState::Granted,
        Some("denied") => MonitoringPermissionState::Denied,
        Some("not_determined" | "notDetermined") => MonitoringPermissionState::NotDetermined,
        Some("unsupported") => MonitoringPermissionState::Unsupported,
        _ => MonitoringPermissionState::Unknown,
    }
}

fn update_configuration_status(
    status: &Arc<Mutex<MonitoringStatusResult>>,
    settings: &RuntimeSettings,
) {
    let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
    current.enabled = settings.enabled;
    current.capture_content = settings.capture_content;
    current.excluded_bundle_ids = settings.excluded_bundle_ids.clone();
    current.helper_path_available = settings.helper_path.is_some();
    if !settings.capture_content {
        current
            .coverage
            .retain(|coverage| *coverage != CoverageLevelV2::Content);
    }
}

fn set_state(
    status: &Arc<Mutex<MonitoringStatusResult>>,
    state: MonitoringState,
    error_code: Option<&str>,
) {
    let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
    current.state = state;
    let preserve_key_warning =
        error_code.is_none() && current.last_error.as_deref() == Some(DEV_LEGACY_KEYCHAIN_WARNING);
    if !preserve_key_warning {
        current.last_error = error_code.map(ToOwned::to_owned);
    }
}

fn status_snapshot(status: &Arc<Mutex<MonitoringStatusResult>>) -> MonitoringStatusResult {
    status
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

fn push_coverage(values: &mut Vec<CoverageLevelV2>, value: CoverageLevelV2) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn validate_boot_id(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(());
    }
    Ok(())
}

fn validate_excluded_bundle_ids(values: &[String]) -> Result<(), String> {
    if values.len() > 256 {
        return Err("excludedBundleIds exceeds 256 entries".to_owned());
    }
    let mut unique = std::collections::HashSet::new();
    for value in values {
        if value.is_empty()
            || value.len() > 256
            || value.chars().any(char::is_control)
            || !unique.insert(value)
        {
            return Err("excludedBundleIds must be unique, bounded non-control strings".to_owned());
        }
    }
    Ok(())
}

fn parse_bool(name: &str, default: bool) -> Result<bool, String> {
    match std::env::var(name) {
        Ok(value) if matches!(value.as_str(), "true" | "1" | "yes") => Ok(true),
        Ok(value) if matches!(value.as_str(), "false" | "0" | "no") => Ok(false),
        Ok(_) => Err(format!("{name} must be true/false, 1/0, or yes/no")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid UTF-8")),
    }
}

fn resolve_helper_path() -> Result<Option<PathBuf>, String> {
    let runtime_channel = runtime_channel_from_environment()?;
    #[cfg(not(debug_assertions))]
    if std::env::var_os(HELPER_PATH_ENV).is_some() {
        return Err(format!(
            "{HELPER_PATH_ENV} is disabled in release builds; the signed sibling helper is required"
        ));
    }
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os(HELPER_PATH_ENV) {
        if runtime_channel == RuntimeChannel::Stable {
            return Err(format!(
                "{HELPER_PATH_ENV} is disabled for the stable runtime channel"
            ));
        }
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!("{HELPER_PATH_ENV} must be an absolute path"));
        }
        return Ok(path.is_file().then_some(path));
    }
    let executable =
        std::env::current_exe().map_err(|_| "cannot resolve local host path".to_owned())?;
    let sibling = expected_helper_path(&executable)?;
    if !sibling.is_file() {
        return Ok(None);
    }
    validate_packaged_observer(&executable, &sibling, runtime_channel)?;
    Ok(Some(sibling))
}

fn expected_helper_path(executable: &Path) -> Result<PathBuf, String> {
    let parent = executable
        .parent()
        .ok_or_else(|| "cannot resolve local host directory".to_owned())?;
    Ok(parent
        .join(OBSERVER_BUNDLE_NAME)
        .join("Contents")
        .join("MacOS")
        .join(OBSERVER_EXECUTABLE_NAME))
}

fn runtime_channel_from_environment() -> Result<RuntimeChannel, String> {
    match std::env::var(RUNTIME_CHANNEL_ENV) {
        Ok(value) => RuntimeChannel::parse(&value),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(format!("{RUNTIME_CHANNEL_ENV} must be valid UTF-8"))
        }
        Err(std::env::VarError::NotPresent) => {
            #[cfg(debug_assertions)]
            {
                Ok(RuntimeChannel::Dev)
            }
            #[cfg(not(debug_assertions))]
            {
                Err(format!(
                    "{RUNTIME_CHANNEL_ENV} is required in release builds"
                ))
            }
        }
    }
}

fn validate_helper_before_spawn(helper_path: &Path) -> Result<(), String> {
    let runtime_channel = runtime_channel_from_environment()?;
    let executable =
        std::env::current_exe().map_err(|_| "cannot resolve local host path".to_owned())?;
    let expected = expected_helper_path(&executable)?;
    if helper_path == expected {
        return validate_packaged_observer(&executable, helper_path, runtime_channel);
    }
    #[cfg(debug_assertions)]
    {
        if runtime_channel != RuntimeChannel::Stable
            && std::env::var_os(HELPER_PATH_ENV)
                .is_some_and(|value| Path::new(&value) == helper_path)
        {
            return Ok(());
        }
    }
    Err("observer helper must be the fixed sibling bundle executable".to_owned())
}

fn validate_packaged_observer(
    local_executable: &Path,
    helper_path: &Path,
    runtime_channel: RuntimeChannel,
) -> Result<(), String> {
    let bundle_path = helper_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "observer helper bundle layout is invalid".to_owned())?;
    if bundle_path.file_name().and_then(|value| value.to_str()) != Some(OBSERVER_BUNDLE_NAME)
        || helper_path.file_name().and_then(|value| value.to_str())
            != Some(OBSERVER_EXECUTABLE_NAME)
    {
        return Err("observer helper bundle layout is invalid".to_owned());
    }
    let bundle_id = read_bundle_identifier(bundle_path)?;
    if bundle_id != OBSERVER_BUNDLE_ID {
        return Err("observer helper bundle identifier is invalid".to_owned());
    }
    verify_code_signature(bundle_path)?;
    if runtime_channel == RuntimeChannel::Stable {
        verify_code_signature(local_executable)?;
        let local_team = read_team_identifier(local_executable)?;
        let observer_team = read_team_identifier(bundle_path)?;
        validate_stable_team_identifiers(local_team.as_deref(), observer_team.as_deref())?;
    }
    Ok(())
}

fn read_bundle_identifier(bundle_path: &Path) -> Result<String, String> {
    let info_plist = bundle_path.join("Contents").join("Info.plist");
    let output = StdCommand::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(&info_plist)
        .output()
        .map_err(|_| "cannot inspect observer helper Info.plist".to_owned())?;
    if !output.status.success() {
        return Err("cannot inspect observer helper Info.plist".to_owned());
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| "observer helper bundle identifier is not UTF-8".to_owned())?;
    Ok(value.trim().to_owned())
}

fn verify_code_signature(path: &Path) -> Result<(), String> {
    let status = StdCommand::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(path)
        .status()
        .map_err(|_| "cannot verify observer code signature".to_owned())?;
    if status.success() {
        Ok(())
    } else {
        Err("observer code signature verification failed".to_owned())
    }
}

fn read_team_identifier(path: &Path) -> Result<Option<String>, String> {
    let output = StdCommand::new("/usr/bin/codesign")
        .args(["--display", "--verbose=4"])
        .arg(path)
        .output()
        .map_err(|_| "cannot inspect code signing team identifier".to_owned())?;
    if !output.status.success() {
        return Err("cannot inspect code signing team identifier".to_owned());
    }
    let details = String::from_utf8(output.stderr)
        .map_err(|_| "code signing details are not UTF-8".to_owned())?;
    parse_team_identifier(&details)
}

fn parse_team_identifier(details: &str) -> Result<Option<String>, String> {
    let mut values = details
        .lines()
        .filter_map(|line| line.strip_prefix("TeamIdentifier="));
    let Some(value) = values.next() else {
        return Err("code signing team identifier is missing".to_owned());
    };
    if values.next().is_some() {
        return Err("code signing team identifier is ambiguous".to_owned());
    }
    if value == "not set" {
        return Ok(None);
    }
    if value.len() != 10
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err("code signing team identifier is invalid".to_owned());
    }
    Ok(Some(value.to_owned()))
}

fn validate_stable_team_identifiers(
    local_team: Option<&str>,
    observer_team: Option<&str>,
) -> Result<(), String> {
    match (local_team, observer_team) {
        (Some(local), Some(observer)) if local == observer => Ok(()),
        (None, _) | (_, None) => Err(
            "stable observer and whalehall-local signatures require non-empty TeamIdentifier"
                .to_owned(),
        ),
        _ => {
            Err("stable observer and whalehall-local TeamIdentifier values do not match".to_owned())
        }
    }
}

fn observation_key_warning(journal: &ObservationJournal) -> Option<&'static str> {
    (journal.key_storage_mode() == Some(ObservationKeyStorageMode::LegacyDevelopmentKeychain))
        .then_some(DEV_LEGACY_KEYCHAIN_WARNING)
}

fn trim_line_end(bytes: &mut Vec<u8>) {
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_channel_parser_accepts_only_electrobun_channels() {
        assert_eq!(RuntimeChannel::parse("dev").unwrap(), RuntimeChannel::Dev);
        assert_eq!(
            RuntimeChannel::parse("canary").unwrap(),
            RuntimeChannel::Canary
        );
        assert_eq!(
            RuntimeChannel::parse("stable").unwrap(),
            RuntimeChannel::Stable
        );
        for invalid in ["", "production", "Stable", "nightly", "stable "] {
            assert!(RuntimeChannel::parse(invalid).is_err());
        }
    }

    #[test]
    fn team_identifier_parser_distinguishes_adhoc_and_developer_id_signatures() {
        assert_eq!(
            parse_team_identifier("Signature=adhoc\nTeamIdentifier=not set\n").unwrap(),
            None
        );
        assert_eq!(
            parse_team_identifier("Identifier=test\nTeamIdentifier=A1B2C3D4E5\n").unwrap(),
            Some("A1B2C3D4E5".to_owned())
        );
        assert!(parse_team_identifier("Identifier=test\n").is_err());
        assert!(parse_team_identifier("TeamIdentifier=lowercase1\n").is_err());
        assert!(
            parse_team_identifier("TeamIdentifier=A1B2C3D4E5\nTeamIdentifier=A1B2C3D4E5\n")
                .is_err()
        );
    }

    #[test]
    fn stable_team_policy_requires_equal_non_empty_identifiers() {
        assert!(validate_stable_team_identifiers(Some("A1B2C3D4E5"), Some("A1B2C3D4E5")).is_ok());
        assert!(validate_stable_team_identifiers(None, Some("A1B2C3D4E5")).is_err());
        assert!(validate_stable_team_identifiers(Some("A1B2C3D4E5"), None).is_err());
        assert!(validate_stable_team_identifiers(Some("A1B2C3D4E5"), Some("Z9Y8X7W6V5")).is_err());
    }

    #[test]
    fn restart_failures_latch_on_fifth_failure_inside_ten_minutes() {
        let base = Instant::now();
        let mut failures = RestartFailures::default();
        for offset in [0, 60, 120, 180] {
            assert!(!failures.record(base + Duration::from_secs(offset)));
        }
        assert!(failures.record(base + Duration::from_secs(240)));
    }

    #[test]
    fn restart_failures_outside_window_are_pruned_and_manual_clear_resets() {
        let base = Instant::now();
        let mut failures = RestartFailures::default();
        for offset in [0, 60, 120, 180] {
            assert!(!failures.record(base + Duration::from_secs(offset)));
        }
        assert!(!failures.record(base + FAILURE_WINDOW + Duration::from_secs(1)));
        failures.clear();
        assert!(!failures.record(base + FAILURE_WINDOW + Duration::from_secs(2)));
    }

    #[test]
    fn state_updates_preserve_dev_keychain_warning_until_a_real_error_occurs() {
        let status = Arc::new(Mutex::new(MonitoringStatusResult {
            state: MonitoringState::Starting,
            enabled: false,
            capture_content: false,
            excluded_bundle_ids: Vec::new(),
            helper_pid: None,
            helper_path_available: false,
            boot_id: None,
            last_sequence: None,
            last_acked_sequence: None,
            last_heartbeat_at_ms: None,
            permissions: MonitoringPermissions::default(),
            coverage: vec![CoverageLevelV2::Metadata],
            last_error: Some(DEV_LEGACY_KEYCHAIN_WARNING.to_owned()),
        }));
        set_state(&status, MonitoringState::Disabled, None);
        assert_eq!(
            status_snapshot(&status).last_error.as_deref(),
            Some(DEV_LEGACY_KEYCHAIN_WARNING)
        );
        set_state(
            &status,
            MonitoringState::Degraded,
            Some("observer_helper_start_failed"),
        );
        assert_eq!(
            status_snapshot(&status).last_error.as_deref(),
            Some("observer_helper_start_failed")
        );
    }
}
