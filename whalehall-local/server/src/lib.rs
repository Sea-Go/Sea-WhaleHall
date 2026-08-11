mod observer;

use std::io;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use whalehall_local_core::ToolHost;
use whalehall_local_core::events::{EventAppendResult, EventJournal, EventJournalError};
use whalehall_local_core::observations::{
    ObservationJournal, ObservationJournalError, ObservationKeyAvailability, ObservationKeyStatus,
    ObservationKeyStorageMode,
};
use whalehall_local_core::sensors::accessibility_tree::{
    AccessibilityConfig, AccessibilityService, SystemAccessibilityProvider,
};
use whalehall_local_core::sensors::activity::{
    ActivityConfig, ActivityService, SystemForegroundAppProvider,
};
use whalehall_local_core::sensors::application_inventory::{
    ApplicationInventoryConfig, ApplicationInventoryService, SystemApplicationInventoryProvider,
};
use whalehall_local_core::sensors::browser_activity::{
    BrowserActivityConfig, BrowserActivityService, SystemBrowserActivityProvider,
};
use whalehall_local_core::sensors::input_activity::{
    InputActivityConfig, InputActivityService, SystemInputActivityProvider,
};
use whalehall_local_core::sensors::presence::{
    PresenceConfig, PresenceService, SystemPresenceProvider,
};
use whalehall_local_core::sensors::vscode_edit_bridge::{
    VscodeEditBridgeConfig, VscodeEditBridgeService,
};
use whalehall_local_protocol::{
    AuditQueryFiveMinutesParams, AuditQueryFiveMinutesResult, DesktopEventFrame,
    DesktopEventFrameKind, EventCommitParams, EventGoalChangeParams, EventGoalChangeResult,
    EventQueryParams, MAX_JSONL_LINE_BYTES, MonitoringConfigureParams, OutboundMessage, Request,
    Response, RuntimeHealth, SemanticCommitParams, SemanticEventFrame, SemanticEventFrameKind,
    SemanticQueryParams, ToolCallParams, ToolCallResult, ToolCancelParams, ToolCancelResult,
    ToolListResult, VaultDeleteBatchParams, VaultKeyAvailability, VaultKeyStatusResult,
    VaultKeyStorageMode, VaultMigrateLegacyKeyParams, VaultMigrateLegacyKeyResult,
    VaultOpenBatchParams, VaultSealBatchParams, error_codes,
};

use observer::{ObserverSupervisor, ObserverSupervisorConfig};

const EVENT_RETENTION_CLEANUP_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const OBSERVATION_RETENTION_CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);
const STARTUP_GOAL_CHANGE_ENV: &str = "WHALEHALL_STARTUP_GOAL_CHANGE_JSON";

pub async fn serve<R, W>(reader: R, writer: W) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let config = ActivityConfig::from_environment().map_err(io::Error::other)?;
    let inventory_config =
        ApplicationInventoryConfig::from_environment().map_err(io::Error::other)?;
    let presence_config = PresenceConfig::from_environment().map_err(io::Error::other)?;
    let input_activity_config =
        InputActivityConfig::from_environment().map_err(io::Error::other)?;
    let browser_config = BrowserActivityConfig::from_environment().map_err(io::Error::other)?;
    let accessibility_config = AccessibilityConfig::from_environment().map_err(io::Error::other)?;
    let editor_config = VscodeEditBridgeConfig::from_environment().map_err(io::Error::other)?;
    let event_journal = EventJournal::open(config.database_path.with_file_name("events.sqlite3"))
        .map_err(io::Error::other)?;
    let observation_journal = ObservationJournal::open(
        config
            .database_path
            .with_file_name("observation-journal.sqlite3"),
    )
    .map_err(io::Error::other)?;
    append_startup_goal_change_to_journals_from_environment(&event_journal, &observation_journal)?;
    let activity = ActivityService::start_with_event_journal(
        config,
        Arc::new(SystemForegroundAppProvider),
        Some(event_journal.clone()),
    )
    .map_err(io::Error::other)?;
    let inventory = match ApplicationInventoryService::start_with_event_journal(
        inventory_config,
        Arc::new(SystemApplicationInventoryProvider::default()),
        Some(event_journal.clone()),
    ) {
        Ok(inventory) => inventory,
        Err(error) => {
            activity.shutdown().await;
            return Err(io::Error::other(error));
        }
    };
    let presence = match PresenceService::start_with_journals(
        presence_config,
        Arc::new(SystemPresenceProvider),
        Some(event_journal.clone()),
        Some(observation_journal.clone()),
    ) {
        Ok(presence) => presence,
        Err(error) => {
            inventory.shutdown().await;
            activity.shutdown().await;
            return Err(io::Error::other(error));
        }
    };
    let browser = match BrowserActivityService::start_with_event_journal(
        browser_config.clone(),
        Arc::new(SystemBrowserActivityProvider::new(browser_config)),
        Some(event_journal.clone()),
    ) {
        Ok(browser) => browser,
        Err(error) => {
            presence.shutdown().await;
            inventory.shutdown().await;
            activity.shutdown().await;
            return Err(io::Error::other(error));
        }
    };
    let accessibility = match AccessibilityService::start_with_event_journal(
        accessibility_config,
        Arc::new(SystemAccessibilityProvider),
        Some(event_journal.clone()),
    ) {
        Ok(accessibility) => accessibility,
        Err(error) => {
            browser.shutdown().await;
            presence.shutdown().await;
            inventory.shutdown().await;
            activity.shutdown().await;
            return Err(io::Error::other(error));
        }
    };
    let input_activity = match InputActivityService::start(
        input_activity_config.clone(),
        Arc::new(SystemInputActivityProvider::new(
            input_activity_config.enabled,
        )),
        event_journal.clone(),
    ) {
        Ok(input_activity) => input_activity,
        Err(error) => {
            accessibility.shutdown().await;
            browser.shutdown().await;
            presence.shutdown().await;
            inventory.shutdown().await;
            activity.shutdown().await;
            return Err(io::Error::other(error));
        }
    };
    let editor = match VscodeEditBridgeService::start(editor_config, event_journal.clone()) {
        Ok(editor) => editor,
        Err(error) => {
            input_activity.shutdown().await;
            accessibility.shutdown().await;
            browser.shutdown().await;
            presence.shutdown().await;
            inventory.shutdown().await;
            activity.shutdown().await;
            return Err(io::Error::other(error));
        }
    };
    eprintln!("activity database: {}", activity.database_path().display());
    eprintln!(
        "application inventory database: {}",
        inventory.database_path().display()
    );
    eprintln!("presence database: {}", presence.database_path().display());
    eprintln!("browser database: {}", browser.database_path().display());
    eprintln!(
        "accessibility database: {}",
        accessibility.database_path().display()
    );
    eprintln!(
        "desktop event database: {}",
        event_journal.database_path().display()
    );
    eprintln!(
        "observation journal database: {}",
        observation_journal.database_path().display()
    );
    eprintln!(
        "editor bridge database: {}",
        editor.database_path().display()
    );
    serve_with_all_services_and_events(
        reader,
        writer,
        AllServicesWithEvents {
            activity,
            inventory,
            presence,
            browser,
            accessibility,
            input_activity,
            editor,
            event_journal,
            observation_journal,
        },
    )
    .await
}

#[cfg(test)]
fn append_startup_goal_change_from_environment(
    event_journal: &EventJournal,
) -> io::Result<Option<EventAppendResult>> {
    let Some(serialized) = std::env::var_os(STARTUP_GOAL_CHANGE_ENV) else {
        return Ok(None);
    };
    // Startup is still single-threaded and no resident sensor has started.
    // Remove the one-shot payload before parsing so it cannot leak into tasks
    // or a child process, including on a fail-closed parse/append error.
    unsafe {
        std::env::remove_var(STARTUP_GOAL_CHANGE_ENV);
    }
    let serialized = serialized.into_string().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Startup goal change environment value is not valid UTF-8.",
        )
    })?;
    append_startup_goal_change_json(event_journal, &serialized)
}

fn append_startup_goal_change_to_journals_from_environment(
    event_journal: &EventJournal,
    observation_journal: &ObservationJournal,
) -> io::Result<Option<EventAppendResult>> {
    let Some(serialized) = std::env::var_os(STARTUP_GOAL_CHANGE_ENV) else {
        return Ok(None);
    };
    unsafe {
        std::env::remove_var(STARTUP_GOAL_CHANGE_ENV);
    }
    let serialized = serialized.into_string().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Startup goal change environment value is not valid UTF-8.",
        )
    })?;
    append_startup_goal_change_json_with_observations(
        event_journal,
        observation_journal,
        &serialized,
    )
}

#[cfg(test)]
fn append_startup_goal_change_json(
    event_journal: &EventJournal,
    serialized: &str,
) -> io::Result<Option<EventAppendResult>> {
    let params: EventGoalChangeParams = serde_json::from_str(serialized).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Invalid startup goal change parameters: {error}"),
        )
    })?;
    event_journal
        .reconcile_startup_goal_change(&params)
        .map_err(io::Error::other)
}

fn append_startup_goal_change_json_with_observations(
    event_journal: &EventJournal,
    observation_journal: &ObservationJournal,
    serialized: &str,
) -> io::Result<Option<EventAppendResult>> {
    let intent: EventGoalChangeParams = serde_json::from_str(serialized).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Invalid startup goal change parameters: {error}"),
        )
    })?;
    let result = event_journal
        .reconcile_startup_goal_change(&intent)
        .map_err(io::Error::other)?;
    if let Some(result) = result.as_ref() {
        let materialized = EventGoalChangeParams {
            previous: serde_json::from_value(result.event.payload["previous"].clone())
                .map_err(|_| io::Error::other("Invalid materialized startup goal boundary"))?,
            next: serde_json::from_value(result.event.payload["next"].clone())
                .map_err(|_| io::Error::other("Invalid materialized startup goal boundary"))?,
            occurred_at_ms: result.event.occurred_at_ms,
            deduplication_key: intent.deduplication_key,
        };
        observation_journal
            .append_goal_change(&materialized)
            .map_err(|_| {
                io::Error::other("Failed to synchronize startup goal with observation journal")
            })?;
    } else if intent.previous != intent.next {
        observation_journal
            .append_goal_change(&intent)
            .map_err(|_| {
                io::Error::other("Failed to synchronize startup goal with observation journal")
            })?;
    } else {
        observation_journal
            .reconcile_current_goal_version(intent.next.as_ref().map(|goal| goal.version))
            .map_err(|_| {
                io::Error::other("Failed to synchronize startup goal with observation journal")
            })?;
    }
    Ok(result)
}

pub async fn serve_with_activity<R, W>(
    reader: R,
    writer: W,
    activity: ActivityService,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let event_journal =
        EventJournal::open(activity.database_path().with_file_name("events.sqlite3"))
            .map_err(io::Error::other)?;
    serve_with_activity_and_events(reader, writer, activity, event_journal).await
}

pub async fn serve_with_activity_and_events<R, W>(
    reader: R,
    writer: W,
    activity: ActivityService,
    event_journal: EventJournal,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let observation_journal = ObservationJournal::open(
        activity
            .database_path()
            .with_file_name("observation-journal.sqlite3"),
    )
    .map_err(io::Error::other)?;
    let host = Arc::new(ToolHost::with_activity(activity.clone()));
    serve_session(
        reader,
        writer,
        host,
        ResidentServices::activity_only(activity),
        event_journal,
        observation_journal,
    )
    .await
}

pub async fn serve_with_services<R, W>(
    reader: R,
    writer: W,
    activity: ActivityService,
    inventory: ApplicationInventoryService,
    presence: PresenceService,
    browser: BrowserActivityService,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let event_journal =
        EventJournal::open(activity.database_path().with_file_name("events.sqlite3"))
            .map_err(io::Error::other)?;
    let observation_journal = ObservationJournal::open(
        activity
            .database_path()
            .with_file_name("observation-journal.sqlite3"),
    )
    .map_err(io::Error::other)?;
    let host = Arc::new(ToolHost::with_services(
        activity.clone(),
        inventory.clone(),
        presence.clone(),
        browser.clone(),
    ));
    serve_session(
        reader,
        writer,
        host,
        ResidentServices {
            activity,
            inventory: Some(inventory),
            presence: Some(presence),
            browser: Some(browser),
            accessibility: None,
            input_activity: None,
            editor: None,
        },
        event_journal,
        observation_journal,
    )
    .await
}

pub async fn serve_with_all_services<R, W>(
    reader: R,
    writer: W,
    activity: ActivityService,
    inventory: ApplicationInventoryService,
    presence: PresenceService,
    browser: BrowserActivityService,
    accessibility: AccessibilityService,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let event_journal =
        EventJournal::open(activity.database_path().with_file_name("events.sqlite3"))
            .map_err(io::Error::other)?;
    let observation_journal = ObservationJournal::open(
        activity
            .database_path()
            .with_file_name("observation-journal.sqlite3"),
    )
    .map_err(io::Error::other)?;
    let input_activity_config =
        InputActivityConfig::from_environment().map_err(io::Error::other)?;
    let input_activity = InputActivityService::start(
        input_activity_config.clone(),
        Arc::new(SystemInputActivityProvider::new(
            input_activity_config.enabled,
        )),
        event_journal.clone(),
    )
    .map_err(io::Error::other)?;
    let editor_config = VscodeEditBridgeConfig::from_environment().map_err(io::Error::other)?;
    let editor = match VscodeEditBridgeService::start(editor_config, event_journal.clone()) {
        Ok(editor) => editor,
        Err(error) => {
            input_activity.shutdown().await;
            accessibility.shutdown().await;
            browser.shutdown().await;
            presence.shutdown().await;
            inventory.shutdown().await;
            activity.shutdown().await;
            return Err(io::Error::other(error));
        }
    };
    serve_with_all_services_and_events(
        reader,
        writer,
        AllServicesWithEvents {
            activity,
            inventory,
            presence,
            browser,
            accessibility,
            input_activity,
            editor,
            event_journal,
            observation_journal,
        },
    )
    .await
}

async fn serve_with_all_services_and_events<R, W>(
    reader: R,
    writer: W,
    services: AllServicesWithEvents,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let AllServicesWithEvents {
        activity,
        inventory,
        presence,
        browser,
        accessibility,
        input_activity,
        editor,
        event_journal,
        observation_journal,
    } = services;
    let host = Arc::new(ToolHost::with_all_services(
        activity.clone(),
        inventory.clone(),
        presence.clone(),
        browser.clone(),
        accessibility.clone(),
        input_activity.clone(),
        editor.clone(),
    ));
    serve_session(
        reader,
        writer,
        host,
        ResidentServices {
            activity,
            inventory: Some(inventory),
            presence: Some(presence),
            browser: Some(browser),
            accessibility: Some(accessibility),
            input_activity: Some(input_activity),
            editor: Some(editor),
        },
        event_journal,
        observation_journal,
    )
    .await
}

struct AllServicesWithEvents {
    activity: ActivityService,
    inventory: ApplicationInventoryService,
    presence: PresenceService,
    browser: BrowserActivityService,
    accessibility: AccessibilityService,
    input_activity: InputActivityService,
    editor: VscodeEditBridgeService,
    event_journal: EventJournal,
    observation_journal: ObservationJournal,
}

struct ResidentServices {
    activity: ActivityService,
    inventory: Option<ApplicationInventoryService>,
    presence: Option<PresenceService>,
    browser: Option<BrowserActivityService>,
    accessibility: Option<AccessibilityService>,
    input_activity: Option<InputActivityService>,
    editor: Option<VscodeEditBridgeService>,
}

#[derive(Clone)]
struct ObservationServices {
    journal: ObservationJournal,
    observer: ObserverSupervisor,
}

impl ResidentServices {
    fn activity_only(activity: ActivityService) -> Self {
        Self {
            activity,
            inventory: None,
            presence: None,
            browser: None,
            accessibility: None,
            input_activity: None,
            editor: None,
        }
    }

    async fn shutdown(self) {
        if let Some(editor) = self.editor {
            editor.shutdown().await;
        }
        if let Some(input_activity) = self.input_activity {
            input_activity.shutdown().await;
        }
        if let Some(accessibility) = self.accessibility {
            accessibility.shutdown().await;
        }
        if let Some(browser) = self.browser {
            browser.shutdown().await;
        }
        if let Some(presence) = self.presence {
            presence.shutdown().await;
        }
        if let Some(inventory) = self.inventory {
            inventory.shutdown().await;
        }
        self.activity.shutdown().await;
    }
}

async fn serve_session<R, W>(
    reader: R,
    writer: W,
    host: Arc<ToolHost>,
    services: ResidentServices,
    event_journal: EventJournal,
    observation_journal: ObservationJournal,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let retention_task =
        EventRetentionTask::start(event_journal.clone(), EVENT_RETENTION_CLEANUP_INTERVAL);
    let observation_retention_task = ObservationRetentionTask::start(
        observation_journal.clone(),
        OBSERVATION_RETENTION_CLEANUP_INTERVAL,
    );
    let observer_config = ObserverSupervisorConfig::from_environment().map_err(io::Error::other)?;
    let observer = ObserverSupervisor::start(observer_config, observation_journal.clone());
    let observation_services = ObservationServices {
        journal: observation_journal.clone(),
        observer: observer.clone(),
    };
    let (output_tx, output_rx) = mpsc::unbounded_channel();
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let event_output = output_tx.clone();
    let event_forwarder = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            if event_output.send(OutboundMessage::Event(event)).is_err() {
                break;
            }
        }
    });
    let desktop_event_output = output_tx.clone();
    let mut desktop_event_rx = event_journal.subscribe();
    let desktop_event_forwarder = tokio::spawn(async move {
        loop {
            match desktop_event_rx.recv().await {
                Ok(event) => {
                    if desktop_event_output
                        .send(OutboundMessage::DesktopEvent(DesktopEventFrame {
                            event: DesktopEventFrameKind::DesktopEvent,
                            data: event,
                        }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // event.query is the durable recovery path for a lagged live subscriber.
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    let semantic_event_output = output_tx.clone();
    let mut semantic_event_rx = observation_journal.subscribe();
    let semantic_event_forwarder = tokio::spawn(async move {
        loop {
            match semantic_event_rx.recv().await {
                Ok(event) => {
                    if semantic_event_output
                        .send(OutboundMessage::SemanticEvent(SemanticEventFrame {
                            event: SemanticEventFrameKind::SemanticEvent,
                            data: event,
                        }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // semantic.query is the durable recovery path.
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    let writer_task = tokio::spawn(write_messages(writer, output_rx));
    let mut calls = JoinSet::new();
    let mut reader = reader;

    loop {
        let mut bytes = Vec::new();
        let read = reader.read_until(b'\n', &mut bytes).await?;
        if read == 0 {
            break;
        }
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
        }
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        if bytes.is_empty() {
            continue;
        }
        if bytes.len() > MAX_JSONL_LINE_BYTES {
            let _ = output_tx.send(OutboundMessage::Response(Response::failure(
                None,
                "INVALID_REQUEST",
                format!("JSONL line exceeds {MAX_JSONL_LINE_BYTES} bytes."),
            )));
            continue;
        }

        let line = match String::from_utf8(bytes) {
            Ok(line) => line,
            Err(error) => {
                let _ = output_tx.send(OutboundMessage::Response(Response::failure(
                    None,
                    "INVALID_REQUEST",
                    format!("Request is not valid UTF-8: {error}"),
                )));
                continue;
            }
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let _ = output_tx.send(OutboundMessage::Response(Response::failure(
                    None,
                    "INVALID_REQUEST",
                    format!("Invalid JSON: {error}"),
                )));
                continue;
            }
        };
        let possible_id = value
            .get("id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let request: Request = match serde_json::from_value(value) {
            Ok(request) => request,
            Err(error) => {
                let _ = output_tx.send(OutboundMessage::Response(Response::failure(
                    possible_id,
                    "INVALID_REQUEST",
                    format!("Invalid request: {error}"),
                )));
                continue;
            }
        };

        dispatch_request(
            request,
            host.clone(),
            event_tx.clone(),
            output_tx.clone(),
            event_journal.clone(),
            observation_services.clone(),
            &mut calls,
        );
    }

    while calls.join_next().await.is_some() {}
    observer.shutdown().await;
    observation_retention_task.shutdown().await;
    retention_task.shutdown().await;
    services.shutdown().await;
    drop(event_tx);
    let _ = event_forwarder.await;
    desktop_event_forwarder.abort();
    let _ = desktop_event_forwarder.await;
    semantic_event_forwarder.abort();
    let _ = semantic_event_forwarder.await;
    drop(output_tx);
    writer_task
        .await
        .map_err(|error| io::Error::other(format!("Local writer task failed: {error}")))??;
    Ok(())
}

struct EventRetentionTask {
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

struct ObservationRetentionTask {
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

type ObservationCleanup = dyn Fn(&ObservationJournal) + Send + Sync + 'static;

impl ObservationRetentionTask {
    fn start(observation_journal: ObservationJournal, cleanup_interval: Duration) -> Self {
        Self::start_with_cleanup(
            observation_journal,
            cleanup_interval,
            Arc::new(run_observation_retention_cleanup),
        )
    }

    fn start_with_cleanup(
        observation_journal: ObservationJournal,
        cleanup_interval: Duration,
        cleanup: Arc<ObservationCleanup>,
    ) -> Self {
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut ticker = interval_at(Instant::now() + cleanup_interval, cleanup_interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                let cleanup_journal = observation_journal.clone();
                let cleanup_operation = cleanup.clone();
                if tokio::task::spawn_blocking(move || cleanup_operation(&cleanup_journal))
                    .await
                    .is_err()
                {
                    // Deliberately omit panic payloads because cleanup may be
                    // operating on private observation records.
                    eprintln!("observation retention cleanup worker failed");
                }

                tokio::select! {
                    _ = &mut stopped => break,
                    _ = ticker.tick() => {}
                }
            }
        });
        Self {
            stop: Some(stop),
            task,
        }
    }

    async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = self.task.await;
    }
}

impl EventRetentionTask {
    fn start(event_journal: EventJournal, cleanup_interval: Duration) -> Self {
        run_event_retention_cleanup(&event_journal);
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut ticker = interval_at(Instant::now() + cleanup_interval, cleanup_interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = ticker.tick() => run_event_retention_cleanup(&event_journal),
                }
            }
        });
        Self {
            stop: Some(stop),
            task,
        }
    }

    async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let _ = self.task.await;
    }
}

fn run_event_retention_cleanup(event_journal: &EventJournal) {
    if let Err(error) = event_journal.cleanup(server_now_ms()) {
        eprintln!("desktop event retention cleanup warning: {error}");
    }
}

fn run_observation_retention_cleanup(observation_journal: &ObservationJournal) {
    if observation_journal.cleanup(server_now_ms()).is_err() {
        // Deliberately omit database payloads and detailed SQLite text.
        eprintln!("observation retention cleanup warning");
    }
}

fn server_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn dispatch_request(
    request: Request,
    host: Arc<ToolHost>,
    events: mpsc::UnboundedSender<whalehall_local_protocol::ToolEvent>,
    output: mpsc::UnboundedSender<OutboundMessage>,
    event_journal: EventJournal,
    observation_services: ObservationServices,
    calls: &mut JoinSet<()>,
) {
    let ObservationServices {
        journal: observation_journal,
        observer,
    } = observation_services;
    match request.method.as_str() {
        "runtime.health" => {
            let response = Response::success(
                request.id,
                RuntimeHealth {
                    service: "whalehall-local".to_owned(),
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                    pid: std::process::id(),
                    status: "ok".to_owned(),
                },
            );
            let _ = output.send(OutboundMessage::Response(response));
        }
        "tool.list" => {
            let response = Response::success(
                request.id,
                ToolListResult {
                    tools: host.descriptors(),
                },
            );
            let _ = output.send(OutboundMessage::Response(response));
        }
        "tool.call" => {
            let params: ToolCallParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        "INVALID_ARGUMENTS",
                        format!("Invalid tool.call parameters: {error}"),
                    )));
                    return;
                }
            };
            calls.spawn(async move {
                let call_id = request.id;
                let response = match host
                    .call(call_id.clone(), params.name, params.arguments, events)
                    .await
                {
                    Ok(result) => Response::success(
                        call_id.clone(),
                        ToolCallResult {
                            call_id,
                            output: result,
                        },
                    ),
                    Err(error) => Response::failure(Some(call_id), error.code, error.message),
                };
                let _ = output.send(OutboundMessage::Response(response));
            });
        }
        "tool.cancel" => {
            let params: ToolCancelParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        "INVALID_ARGUMENTS",
                        format!("Invalid tool.cancel parameters: {error}"),
                    )));
                    return;
                }
            };
            let result = ToolCancelResult {
                cancelled: host.cancel(&params.call_id),
                call_id: params.call_id,
            };
            let _ = output.send(OutboundMessage::Response(Response::success(
                request.id, result,
            )));
        }
        "monitoring.status" => {
            if !is_empty_object(&request.params) {
                let _ = output.send(OutboundMessage::Response(Response::failure(
                    Some(request.id),
                    error_codes::INVALID_ARGUMENTS,
                    "monitoring.status accepts an empty params object",
                )));
                return;
            }
            let _ = output.send(OutboundMessage::Response(Response::success(
                request.id,
                observer.status(),
            )));
        }
        "monitoring.configure" => {
            let params: MonitoringConfigureParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid monitoring.configure parameters: {error}"),
                    )));
                    return;
                }
            };
            calls.spawn(async move {
                let response = match observer.configure(params).await {
                    Ok(result) => Response::success(request.id, result),
                    Err(error) => {
                        Response::failure(Some(request.id), error_codes::INVALID_ARGUMENTS, error)
                    }
                };
                let _ = output.send(OutboundMessage::Response(response));
            });
        }
        "monitoring.pause" | "monitoring.resume" => {
            if !is_empty_object(&request.params) {
                let _ = output.send(OutboundMessage::Response(Response::failure(
                    Some(request.id),
                    error_codes::INVALID_ARGUMENTS,
                    "monitoring pause/resume accepts an empty params object",
                )));
                return;
            }
            let pause = request.method == "monitoring.pause";
            calls.spawn(async move {
                let result = if pause {
                    observer.pause().await
                } else {
                    observer.resume().await
                };
                let response = match result {
                    Ok(result) => Response::success(request.id, result),
                    Err(error) => {
                        Response::failure(Some(request.id), error_codes::INVALID_ARGUMENTS, error)
                    }
                };
                let _ = output.send(OutboundMessage::Response(response));
            });
        }
        "monitoring.refreshPermissions" => {
            if !is_empty_object(&request.params) {
                let _ = output.send(OutboundMessage::Response(Response::failure(
                    Some(request.id),
                    error_codes::INVALID_ARGUMENTS,
                    "monitoring.refreshPermissions accepts an empty params object",
                )));
                return;
            }
            calls.spawn(async move {
                let response = match observer.refresh_permissions().await {
                    Ok(result) => Response::success(request.id, result),
                    Err(error) => {
                        Response::failure(Some(request.id), error_codes::INVALID_ARGUMENTS, error)
                    }
                };
                let _ = output.send(OutboundMessage::Response(response));
            });
        }
        "monitoring.setupPermissions" => {
            if !is_empty_object(&request.params) {
                let _ = output.send(OutboundMessage::Response(Response::failure(
                    Some(request.id),
                    error_codes::INVALID_ARGUMENTS,
                    "monitoring.setupPermissions accepts an empty params object",
                )));
                return;
            }
            calls.spawn(async move {
                let response = match observer.setup_permissions().await {
                    Ok(result) => Response::success(request.id, result),
                    Err(error) => {
                        Response::failure(Some(request.id), error_codes::INVALID_ARGUMENTS, error)
                    }
                };
                let _ = output.send(OutboundMessage::Response(response));
            });
        }
        "semantic.query" => {
            let params: SemanticQueryParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid semantic.query parameters: {error}"),
                    )));
                    return;
                }
            };
            let response = match observation_journal.query_semantic(&params) {
                Ok(result) => Response::success(request.id, result),
                Err(error) => observation_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        "semantic.commit" => {
            let params: SemanticCommitParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid semantic.commit parameters: {error}"),
                    )));
                    return;
                }
            };
            let response = match observation_journal.commit_semantic(&params) {
                Ok(result) => Response::success(request.id, result),
                Err(error) => observation_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        "audit.queryFiveMinutes" => {
            let params: AuditQueryFiveMinutesParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid audit.queryFiveMinutes parameters: {error}"),
                    )));
                    return;
                }
            };
            let response = match observation_journal.query_five_minute_audit(&params) {
                Ok(result) => Response::success(
                    request.id,
                    AuditQueryFiveMinutesResult {
                        from_ms: result.from_ms,
                        to_ms: result.to_ms,
                        permissions: observer.status().permissions,
                        coverage: result.coverage,
                        raw_observations: result.raw_observations,
                        semantic_events: result.semantic_events,
                    },
                ),
                Err(error) => observation_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        "vault.status" => {
            if !is_empty_object(&request.params) {
                let _ = output.send(OutboundMessage::Response(Response::failure(
                    Some(request.id),
                    error_codes::INVALID_ARGUMENTS,
                    "vault.status accepts an empty params object",
                )));
                return;
            }
            let result = vault_key_status_result(observation_journal.key_status());
            let _ = output.send(OutboundMessage::Response(Response::success(
                request.id, result,
            )));
        }
        "vault.migrateLegacyKey" => {
            let params: VaultMigrateLegacyKeyParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid vault.migrateLegacyKey parameters: {error}"),
                    )));
                    return;
                }
            };
            if !params.confirm {
                let _ = output.send(OutboundMessage::Response(Response::failure(
                    Some(request.id),
                    error_codes::INVALID_ARGUMENTS,
                    "vault.migrateLegacyKey requires explicit confirmation",
                )));
                return;
            }
            calls.spawn(async move {
                let migration_journal = observation_journal.clone();
                let result = tokio::task::spawn_blocking(move || {
                    migration_journal.migrate_legacy_key_interactive()
                })
                .await;
                let response = match result {
                    Ok(Ok(migration)) => {
                        let status = vault_key_status_result(observation_journal.key_status());
                        Response::success(
                            request.id,
                            VaultMigrateLegacyKeyResult {
                                migrated: migration.migrated,
                                status,
                            },
                        )
                    }
                    Ok(Err(error)) => observation_error_response(request.id, error),
                    Err(_) => Response::failure(
                        Some(request.id),
                        error_codes::INTERNAL_ERROR,
                        "Vault migration worker failed",
                    ),
                };
                let _ = output.send(OutboundMessage::Response(response));
            });
        }
        "vault.sealBatch" => {
            let params: VaultSealBatchParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid vault.sealBatch parameters: {error}"),
                    )));
                    return;
                }
            };
            let response = match observation_journal.seal_vault_batch(&params) {
                Ok(result) => Response::success(request.id, result),
                Err(error) => observation_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        "vault.openBatch" => {
            let params: VaultOpenBatchParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid vault.openBatch parameters: {error}"),
                    )));
                    return;
                }
            };
            let response = match observation_journal.open_vault_batch(&params) {
                Ok(result) => Response::success(request.id, result),
                Err(error) => observation_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        "vault.deleteBatch" => {
            let params: VaultDeleteBatchParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid vault.deleteBatch parameters: {error}"),
                    )));
                    return;
                }
            };
            let response = match observation_journal.delete_vault_batch(&params) {
                Ok(result) => Response::success(request.id, result),
                Err(error) => observation_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        "event.query" => {
            let params: EventQueryParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid event.query parameters: {error}"),
                    )));
                    return;
                }
            };
            let response = match event_journal.query(&params) {
                Ok(result) => Response::success(request.id, result),
                Err(error) => event_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        "event.tailCursor" => {
            if !is_empty_object(&request.params) {
                let _ = output.send(OutboundMessage::Response(Response::failure(
                    Some(request.id),
                    error_codes::INVALID_ARGUMENTS,
                    "event.tailCursor accepts an empty params object",
                )));
                return;
            }
            let response = match event_journal.tail_cursor() {
                Ok(result) => Response::success(request.id, result),
                Err(error) => event_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        "event.commit" => {
            let params: EventCommitParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid event.commit parameters: {error}"),
                    )));
                    return;
                }
            };
            let response = match event_journal.commit(&params) {
                Ok(result) => Response::success(request.id, result),
                Err(error) => event_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        "event.goal.change" => {
            let params: EventGoalChangeParams = match serde_json::from_value(request.params) {
                Ok(params) => params,
                Err(error) => {
                    let _ = output.send(OutboundMessage::Response(Response::failure(
                        Some(request.id),
                        error_codes::INVALID_ARGUMENTS,
                        format!("Invalid event.goal.change parameters: {error}"),
                    )));
                    return;
                }
            };
            let response = match event_journal.append_goal_change(&params) {
                Ok(result) => match observation_journal.append_goal_change(&params) {
                    Ok(_) => Response::success(
                        request.id,
                        EventGoalChangeResult {
                            event: result.event,
                            inserted: result.inserted,
                        },
                    ),
                    // The legacy append happens first. Returning an error is
                    // intentional: a retry with the same deduplication key
                    // reuses the legacy row and completes the missing v2
                    // mirror without creating duplicate boundaries.
                    Err(error) => observation_error_response(request.id, error),
                },
                Err(error) => event_error_response(request.id, error),
            };
            let _ = output.send(OutboundMessage::Response(response));
        }
        _ => {
            let method = request.method;
            let _ = output.send(OutboundMessage::Response(Response::failure(
                Some(request.id),
                "METHOD_NOT_FOUND",
                format!("Unknown method: {method}"),
            )));
        }
    }
}

fn event_error_response(id: String, error: EventJournalError) -> Response {
    let code = match error {
        EventJournalError::InvalidCursor(_) => error_codes::INVALID_CURSOR,
        EventJournalError::CursorExpired(_) => error_codes::CURSOR_EXPIRED,
        EventJournalError::CursorRegression { .. } => error_codes::CURSOR_REGRESSION,
        EventJournalError::Configuration(_) | EventJournalError::IdempotencyConflict { .. } => {
            error_codes::INVALID_ARGUMENTS
        }
        EventJournalError::Io(_) | EventJournalError::Sqlite(_) | EventJournalError::Json(_) => {
            error_codes::INTERNAL_ERROR
        }
    };
    Response::failure(Some(id), code, error.to_string())
}

fn vault_key_status_result(status: ObservationKeyStatus) -> VaultKeyStatusResult {
    VaultKeyStatusResult {
        availability: match status.availability {
            ObservationKeyAvailability::Available => VaultKeyAvailability::Available,
            ObservationKeyAvailability::MigrationRequired => {
                VaultKeyAvailability::MigrationRequired
            }
            ObservationKeyAvailability::Unavailable => VaultKeyAvailability::Unavailable,
        },
        storage_mode: status.storage_mode.map(|mode| match mode {
            ObservationKeyStorageMode::DataProtectionKeychain => {
                VaultKeyStorageMode::DataProtectionKeychain
            }
            ObservationKeyStorageMode::LocalLoginKeychain => {
                VaultKeyStorageMode::LocalLoginKeychain
            }
            ObservationKeyStorageMode::LegacyDevelopmentKeychain => {
                VaultKeyStorageMode::LegacyDevelopmentKeychain
            }
            ObservationKeyStorageMode::Custom => VaultKeyStorageMode::Custom,
        }),
        key_version: status.key_version,
        interactive_migration_available: status.interactive_migration_available,
    }
}

fn observation_error_response(id: String, error: ObservationJournalError) -> Response {
    let code = match error {
        ObservationJournalError::InvalidCursor(_) => error_codes::INVALID_CURSOR,
        ObservationJournalError::CursorRegression { .. } => error_codes::CURSOR_REGRESSION,
        ObservationJournalError::Configuration(_)
        | ObservationJournalError::IdempotencyConflict
        | ObservationJournalError::VaultConflict => error_codes::INVALID_ARGUMENTS,
        ObservationJournalError::KeyUnavailable
        | ObservationJournalError::KeyMigration(_)
        | ObservationJournalError::VaultRecordUnavailable => error_codes::PERMISSION_DENIED,
        ObservationJournalError::Io(_)
        | ObservationJournalError::Sqlite(_)
        | ObservationJournalError::Json(_)
        | ObservationJournalError::Encryption
        | ObservationJournalError::Authentication => error_codes::INTERNAL_ERROR,
    };
    Response::failure(Some(id), code, error.to_string())
}

fn is_empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(Map::is_empty)
}

async fn write_messages<W>(
    mut writer: W,
    mut receiver: mpsc::UnboundedReceiver<OutboundMessage>,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    while let Some(message) = receiver.recv().await {
        let line = serde_json::to_vec(&message).map_err(io::Error::other)?;
        writer.write_all(&line).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tempfile::TempDir;
    use tokio::io::{AsyncWriteExt, BufReader, duplex};
    use whalehall_local_core::events::{DesktopEventDraft, EventJournal, EventJournalConfig};
    use whalehall_local_core::observations::{
        MemoryObservationKeyProvider, ObservationJournalConfig,
    };
    use whalehall_local_core::sensors::activity::{
        ActivityConfig, ActivityError, ActivityService, ForegroundApp, ForegroundAppProvider,
    };
    use whalehall_local_protocol::{
        EventCommitParams, EventQueryParams, SemanticQueryParams, desktop_event_kinds,
        semantic_event_kinds,
    };

    use super::*;

    static STARTUP_GOAL_ENV_LOCK: Mutex<()> = Mutex::new(());

    struct NoForegroundApp;

    impl ForegroundAppProvider for NoForegroundApp {
        fn foreground_app(&self) -> Result<Option<ForegroundApp>, ActivityError> {
            Ok(None)
        }
    }

    fn test_activity() -> (TempDir, ActivityService) {
        let directory = tempfile::tempdir().expect("create activity test directory");
        let activity = ActivityService::start(
            ActivityConfig {
                database_path: directory.path().join("usage.sqlite3"),
                poll_interval: Duration::from_millis(50),
                heartbeat_interval: Duration::from_millis(100),
            },
            Arc::new(NoForegroundApp),
        )
        .expect("start test activity service");
        (directory, activity)
    }

    fn startup_goal_change_json() -> String {
        serde_json::json!({
            "previous": {
                "goalId": "old-goal",
                "planId": null,
                "version": 1,
                "text": "Old goal",
                "activatedAtMs": 500
            },
            "next": null,
            "occurredAtMs": 2_000,
            "deduplicationKey": "startup-clear-old-goal-v1"
        })
        .to_string()
    }

    #[test]
    fn startup_goal_boundary_is_one_shot_idempotent_and_precedes_new_sensor_events() {
        let _environment_guard = STARTUP_GOAL_ENV_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().expect("create startup goal test directory");
        let journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open events");
        let mut old_event = DesktopEventDraft::metadata(
            desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED,
            "activity.sensor",
            1_000,
            serde_json::json!({ "appId": "code", "appName": "Code" }),
            "old-backlog",
        );
        old_event.goal_version = Some(1);
        journal.append(old_event).expect("append old backlog");
        let serialized = startup_goal_change_json();

        unsafe {
            std::env::set_var(STARTUP_GOAL_CHANGE_ENV, &serialized);
        }
        let first = append_startup_goal_change_from_environment(&journal)
            .expect("append startup goal")
            .expect("startup goal was present");
        assert!(first.inserted);
        assert!(std::env::var_os(STARTUP_GOAL_CHANGE_ENV).is_none());

        unsafe {
            std::env::set_var(STARTUP_GOAL_CHANGE_ENV, &serialized);
        }
        let replay =
            append_startup_goal_change_from_environment(&journal).expect("replay startup goal");
        assert!(
            replay.is_none(),
            "the durable journal already matches the startup target"
        );
        assert!(std::env::var_os(STARTUP_GOAL_CHANGE_ENV).is_none());

        journal
            .append(DesktopEventDraft::metadata(
                desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED,
                "activity.sensor",
                3_000,
                serde_json::json!({ "appId": "safari", "appName": "Safari" }),
                "new-sensor-event",
            ))
            .expect("append new sensor event");
        let events = journal
            .query(&EventQueryParams::default())
            .expect("query ordered events")
            .events;
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED,
                desktop_event_kinds::GOAL_CONTEXT_CHANGED,
                desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED,
            ]
        );
        assert_eq!(events[0].goal_version, Some(1));
        assert_eq!(events[1].payload["next"], Value::Null);
        assert_eq!(events[2].goal_version, None);
    }

    #[test]
    fn startup_goal_reconcile_is_idempotently_mirrored_to_v2_and_versions_following_events() {
        let directory = tempfile::tempdir().expect("create startup v2 goal test directory");
        let event_journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open events");
        let observation_journal =
            ObservationJournal::open_with_config(ObservationJournalConfig::new(
                directory.path().join("observations.sqlite3"),
                Arc::new(MemoryObservationKeyProvider::new([9; 32])),
            ))
            .expect("open observations");
        let serialized = serde_json::json!({
            "previous": null,
            "next": {
                "goalId": "goal-1",
                "planId": null,
                "version": 1,
                "text": "Ship v2",
                "activatedAtMs": 1_000
            },
            "occurredAtMs": 1_000,
            "deduplicationKey": "startup-goal-1"
        })
        .to_string();

        append_startup_goal_change_json_with_observations(
            &event_journal,
            &observation_journal,
            &serialized,
        )
        .expect("mirror startup goal");
        append_startup_goal_change_json_with_observations(
            &event_journal,
            &observation_journal,
            &serialized,
        )
        .expect("replay startup goal");
        observation_journal
            .append_presence_change("presence:screen_locked:2000", "locked", 2_000, 2_000, None)
            .expect("append following presence boundary");

        let semantic = observation_journal
            .query_semantic(&SemanticQueryParams {
                include_content: true,
                ..SemanticQueryParams::default()
            })
            .expect("query semantic events")
            .events;
        assert_eq!(semantic.len(), 2);
        assert_eq!(semantic[0].kind, semantic_event_kinds::GOAL_CHANGED);
        assert_eq!(semantic[1].goal_version, Some(1));
    }

    #[test]
    fn invalid_startup_goal_environment_is_removed_and_fails_closed() {
        let _environment_guard = STARTUP_GOAL_ENV_LOCK.lock().unwrap();
        let directory = tempfile::tempdir().expect("create invalid startup goal test directory");
        let journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open events");
        unsafe {
            std::env::set_var(
                STARTUP_GOAL_CHANGE_ENV,
                r#"{"previous":null,"next":null,"occurredAtMs":1,"deduplicationKey":"x","extra":true}"#,
            );
        }

        let error = append_startup_goal_change_from_environment(&journal)
            .expect_err("unknown fields must fail startup");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(std::env::var_os(STARTUP_GOAL_CHANGE_ENV).is_none());
        assert!(
            journal
                .query(&EventQueryParams::default())
                .expect("query empty journal")
                .events
                .is_empty()
        );
    }

    #[tokio::test]
    async fn handles_health_list_malformed_and_multiple_requests() {
        let (mut input, server_input) = duplex(16 * 1024);
        let (server_output, output) = duplex(16 * 1024);
        let (_directory, activity) = test_activity();
        let server = tokio::spawn(serve_with_activity(
            BufReader::new(server_input),
            server_output,
            activity,
        ));

        input
            .write_all(b"not-json\n")
            .await
            .expect("write malformed");
        input
            .write_all(b"{\"id\":\"health\",\"method\":\"runtime.health\",\"params\":{}}\n")
            .await
            .expect("write health");
        input
            .write_all(b"{\"id\":\"list\",\"method\":\"tool.list\",\"params\":{}}\n")
            .await
            .expect("write list");
        input
            .write_all(b"{\"id\":\"activity\",\"method\":\"tool.call\",\"params\":{\"name\":\"activity.status\",\"arguments\":{}}}\n")
            .await
            .expect("write activity status");
        input.shutdown().await.expect("close input");

        let mut output = BufReader::new(output);
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            if output.read_line(&mut line).await.expect("read output") == 0 {
                break;
            }
            lines.push(line);
        }
        server.await.expect("server join").expect("server result");
        assert_eq!(lines.len(), 6);
        assert!(lines[0].contains("INVALID_REQUEST"));
        assert!(lines[1].contains("whalehall-local"));
        assert!(lines[2].contains("system.info"));
        assert!(lines[2].contains("demo.wait"));
        assert!(lines[2].contains("activity.sessions"));
        assert!(lines[2].contains("activity.status"));
        assert!(lines[2].contains("device.environment"));
        assert!(lines.iter().any(|line| line.contains("usage.sqlite3")));
    }

    #[tokio::test]
    async fn exposes_monitoring_semantic_and_fixed_five_minute_audit_protocols() {
        let (mut input, server_input) = duplex(32 * 1024);
        let (server_output, output) = duplex(32 * 1024);
        let (_directory, activity) = test_activity();
        let server = tokio::spawn(serve_with_activity(
            BufReader::new(server_input),
            server_output,
            activity,
        ));
        input
            .write_all(b"{\"id\":\"monitor\",\"method\":\"monitoring.status\",\"params\":{}}\n")
            .await
            .expect("write monitoring request");
        input
            .write_all(
                b"{\"id\":\"semantic\",\"method\":\"semantic.query\",\"params\":{\"limit\":10}}\n",
            )
            .await
            .expect("write semantic query");
        input
            .write_all(
                b"{\"id\":\"audit\",\"method\":\"audit.queryFiveMinutes\",\"params\":{\"fromMs\":0,\"toMs\":300000}}\n",
            )
            .await
            .expect("write audit query");
        input
            .write_all(
                b"{\"id\":\"invalid-audit\",\"method\":\"audit.queryFiveMinutes\",\"params\":{\"fromMs\":0,\"toMs\":299999}}\n",
            )
            .await
            .expect("write invalid audit query");
        input
            .write_all(b"{\"id\":\"vault-status\",\"method\":\"vault.status\",\"params\":{}}\n")
            .await
            .expect("write vault status");
        input
            .write_all(
                b"{\"id\":\"invalid-migration\",\"method\":\"vault.migrateLegacyKey\",\"params\":{\"confirm\":false}}\n",
            )
            .await
            .expect("write invalid migration");
        input
            .write_all(
                b"{\"id\":\"forbidden-refresh-prompt\",\"method\":\"monitoring.refreshPermissions\",\"params\":{\"prompt\":true}}\n",
            )
            .await
            .expect("write forbidden refresh prompt");
        input
            .write_all(
                b"{\"id\":\"forbidden-setup-params\",\"method\":\"monitoring.setupPermissions\",\"params\":{\"prompt\":true}}\n",
            )
            .await
            .expect("write forbidden setup params");
        input.shutdown().await.expect("close input");

        let mut output = BufReader::new(output);
        let mut frames = Vec::new();
        loop {
            let mut line = String::new();
            if output.read_line(&mut line).await.expect("read response") == 0 {
                break;
            }
            frames.push(serde_json::from_str::<Value>(&line).expect("parse JSONL response"));
        }
        server.await.expect("join server").expect("server result");
        let by_id = |id: &str| {
            frames
                .iter()
                .find(|frame| frame["id"] == id)
                .unwrap_or_else(|| panic!("missing {id} response"))
        };
        assert_eq!(by_id("monitor")["ok"], true);
        assert!(by_id("monitor")["result"]["permissions"].is_object());
        assert!(by_id("monitor")["result"]["permissionSetupAvailable"].is_boolean());
        assert!(by_id("monitor")["result"]["permissionSetupAttempted"].is_boolean());
        assert_eq!(by_id("semantic")["result"]["events"], serde_json::json!([]));
        assert_eq!(by_id("audit")["result"]["fromMs"], 0);
        assert_eq!(by_id("audit")["result"]["toMs"], 300_000);
        assert_eq!(
            by_id("audit")["result"]["rawObservations"],
            serde_json::json!([])
        );
        assert_eq!(by_id("invalid-audit")["ok"], false);
        assert!(matches!(
            by_id("vault-status")["result"]["availability"].as_str(),
            Some("available" | "migration_required" | "unavailable")
        ));
        assert!(by_id("vault-status")["result"]["interactiveMigrationAvailable"].is_boolean());
        assert_eq!(by_id("invalid-migration")["ok"], false);
        assert_eq!(by_id("forbidden-refresh-prompt")["ok"], false);
        assert_eq!(by_id("forbidden-setup-params")["ok"], false);
    }

    #[tokio::test]
    async fn queries_commits_and_pushes_durable_desktop_events() {
        let (mut input, server_input) = duplex(32 * 1024);
        let (server_output, output) = duplex(32 * 1024);
        let (directory, activity) = test_activity();
        let event_journal =
            EventJournal::open(directory.path().join("events.sqlite3")).expect("open events");
        let server_events = event_journal.clone();
        let server = tokio::spawn(serve_with_activity_and_events(
            BufReader::new(server_input),
            server_output,
            activity,
            server_events,
        ));
        let mut output = BufReader::new(output);

        input
            .write_all(b"{\"id\":\"health\",\"method\":\"runtime.health\",\"params\":{}}\n")
            .await
            .expect("write health");
        let mut health_line = String::new();
        output
            .read_line(&mut health_line)
            .await
            .expect("read health");
        assert!(health_line.contains("\"id\":\"health\""));

        let appended = event_journal
            .append(DesktopEventDraft::metadata(
                desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED,
                "server.test",
                1_000,
                serde_json::json!({ "appId": "editor" }),
                "server-publisher-test",
            ))
            .expect("append desktop event")
            .event;
        input
            .write_all(
                b"{\"id\":\"events\",\"method\":\"event.query\",\"params\":{\"limit\":10}}\n",
            )
            .await
            .expect("write event query");
        input
            .write_all(b"{\"id\":\"tail\",\"method\":\"event.tailCursor\",\"params\":{}}\n")
            .await
            .expect("write event tail cursor");
        input
            .write_all(
                format!(
                    "{{\"id\":\"commit\",\"method\":\"event.commit\",\"params\":{{\"consumerId\":\"reflection-runtime\",\"cursor\":\"{}\"}}}}\n",
                    appended.cursor
                )
                .as_bytes(),
            )
            .await
            .expect("write event commit");
        input
            .write_all(
                b"{\"id\":\"resume\",\"method\":\"event.query\",\"params\":{\"consumerId\":\"reflection-runtime\",\"limit\":10}}\n",
            )
            .await
            .expect("write consumer event query");
        input
            .write_all(
                b"{\"id\":\"goal\",\"method\":\"event.goal.change\",\"params\":{\"previous\":null,\"next\":{\"goalId\":\"goal-1\",\"planId\":null,\"version\":1,\"text\":\"Ship reflection\",\"activatedAtMs\":2000},\"occurredAtMs\":2000,\"deduplicationKey\":\"goal-change:goal-1:1\"}}\n",
            )
            .await
            .expect("write goal change");
        input.shutdown().await.expect("close input");

        let mut lines = vec![health_line];
        loop {
            let mut line = String::new();
            if output.read_line(&mut line).await.expect("read output") == 0 {
                break;
            }
            lines.push(line);
        }
        server.await.expect("server join").expect("server result");

        let frames = lines
            .iter()
            .map(|line| serde_json::from_str::<Value>(line).expect("valid JSONL frame"))
            .collect::<Vec<_>>();
        assert!(frames.iter().any(|frame| {
            frame["event"] == "desktop.event" && frame["data"]["eventId"] == appended.event_id
        }));
        let query = frames
            .iter()
            .find(|frame| frame["id"] == "events")
            .expect("event.query response");
        assert_eq!(query["result"]["events"][0]["eventId"], appended.event_id);
        let tail = frames
            .iter()
            .find(|frame| frame["id"] == "tail")
            .expect("event.tailCursor response");
        assert_eq!(tail["result"]["cursor"], appended.cursor);
        let commit = frames
            .iter()
            .find(|frame| frame["id"] == "commit")
            .expect("event.commit response");
        assert_eq!(commit["result"]["consumerId"], "reflection-runtime");
        assert_eq!(commit["result"]["advanced"], true);
        let resume = frames
            .iter()
            .find(|frame| frame["id"] == "resume")
            .expect("consumer event.query response");
        assert_eq!(resume["result"]["events"], serde_json::json!([]));
        assert_eq!(resume["result"]["nextCursor"], appended.cursor);
        let goal = frames
            .iter()
            .find(|frame| frame["id"] == "goal")
            .expect("event.goal.change response");
        assert_eq!(
            goal["result"]["event"]["kind"],
            desktop_event_kinds::GOAL_CONTEXT_CHANGED
        );
        assert_eq!(
            goal["result"]["event"]["payload"]["next"]["goalId"],
            "goal-1"
        );
        assert_eq!(goal["result"]["inserted"], true);
    }

    #[tokio::test]
    async fn retention_task_runs_on_start_and_repeats_without_crossing_consumer_cursor() {
        let directory = tempfile::tempdir().expect("create retention scheduler directory");
        let journal = EventJournal::open_with_config(EventJournalConfig {
            database_path: directory.path().join("events.sqlite3"),
            retention: Duration::from_millis(1),
            broadcast_capacity: 8,
        })
        .expect("open retention journal");
        let first = journal
            .append(DesktopEventDraft::metadata(
                "test.first",
                "server.test",
                1,
                serde_json::json!({}),
                "retention-first",
            ))
            .unwrap()
            .event;
        let second = journal
            .append(DesktopEventDraft::metadata(
                "test.second",
                "server.test",
                2,
                serde_json::json!({}),
                "retention-second",
            ))
            .unwrap()
            .event;
        journal
            .commit(&EventCommitParams {
                consumer_id: "slow-consumer".to_owned(),
                cursor: first.cursor,
            })
            .unwrap();

        let task = EventRetentionTask::start(journal.clone(), Duration::from_millis(20));
        let remaining = journal.query(&EventQueryParams::default()).unwrap();
        assert_eq!(remaining.events, vec![second.clone()]);

        journal
            .commit(&EventCommitParams {
                consumer_id: "slow-consumer".to_owned(),
                cursor: second.cursor,
            })
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if journal
                    .query(&EventQueryParams::default())
                    .unwrap()
                    .events
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("scheduled cleanup should run");
        task.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn observation_retention_cleanup_does_not_block_startup_runtime() {
        let directory = tempfile::tempdir().expect("create observation retention directory");
        let journal = ObservationJournal::open_with_config(ObservationJournalConfig::new(
            directory.path().join("observation-journal.sqlite3"),
            Arc::new(MemoryObservationKeyProvider::new([7; 32])),
        ))
        .expect("open observation retention journal");
        let (entered_tx, entered_rx) = oneshot::channel();
        let entered_tx = Arc::new(std::sync::Mutex::new(Some(entered_tx)));
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Arc::new(std::sync::Mutex::new(release_rx));
        let cleanup = Arc::new(move |_: &ObservationJournal| {
            if let Some(entered_tx) = entered_tx.lock().expect("lock cleanup entry sender").take() {
                let _ = entered_tx.send(());
            }
            let _ = release_rx
                .lock()
                .expect("lock cleanup release receiver")
                .recv_timeout(Duration::from_secs(1));
        });

        let started_at = std::time::Instant::now();
        let task =
            ObservationRetentionTask::start_with_cleanup(journal, Duration::from_secs(60), cleanup);
        assert!(
            started_at.elapsed() < Duration::from_millis(500),
            "retention cleanup blocked the current-thread runtime during startup"
        );
        let runtime_resumed_at = std::time::Instant::now();
        tokio::task::yield_now().await;
        assert!(
            runtime_resumed_at.elapsed() < Duration::from_millis(500),
            "retention cleanup ran on the current-thread runtime"
        );
        tokio::time::timeout(Duration::from_secs(1), entered_rx)
            .await
            .expect("cleanup worker start timed out")
            .expect("cleanup worker did not report entry");
        let shutdown = tokio::spawn(task.shutdown());
        tokio::task::yield_now().await;
        assert!(
            !shutdown.is_finished(),
            "retention shutdown abandoned the in-flight cleanup worker"
        );
        release_tx.send(()).expect("release cleanup worker");
        tokio::time::timeout(Duration::from_secs(1), shutdown)
            .await
            .expect("retention shutdown timed out")
            .expect("retention shutdown task failed");
    }

    #[tokio::test]
    async fn rejects_lines_over_one_mebibyte() {
        let (mut input, server_input) = duplex(MAX_JSONL_LINE_BYTES + 1024);
        let (server_output, output) = duplex(4096);
        let (_directory, activity) = test_activity();
        let server = tokio::spawn(serve_with_activity(
            BufReader::new(server_input),
            server_output,
            activity,
        ));
        let mut oversized = vec![b'x'; MAX_JSONL_LINE_BYTES + 1];
        oversized.push(b'\n');
        input
            .write_all(&oversized)
            .await
            .expect("write oversized request");
        input.shutdown().await.expect("close input");

        let mut output = BufReader::new(output);
        let mut line = String::new();
        output.read_line(&mut line).await.expect("read rejection");
        server.await.expect("server join").expect("server result");
        assert!(line.contains("INVALID_REQUEST"));
        assert!(line.contains("1048576"));
    }
}
