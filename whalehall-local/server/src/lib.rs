use std::io;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use whalehall_local_core::ToolHost;
use whalehall_local_core::events::{EventJournal, EventJournalError};
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
    DesktopEventFrame, DesktopEventFrameKind, EventCommitParams, EventQueryParams,
    MAX_JSONL_LINE_BYTES, OutboundMessage, Request, Response, RuntimeHealth, ToolCallParams,
    ToolCallResult, ToolCancelParams, ToolCancelResult, ToolListResult, error_codes,
};

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
    let presence = match PresenceService::start_with_event_journal(
        presence_config,
        Arc::new(SystemPresenceProvider),
        Some(event_journal.clone()),
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
    let accessibility = match AccessibilityService::start(
        accessibility_config,
        Arc::new(SystemAccessibilityProvider),
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
        },
    )
    .await
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
    let host = Arc::new(ToolHost::with_activity(activity.clone()));
    serve_session(
        reader,
        writer,
        host,
        ResidentServices::activity_only(activity),
        event_journal,
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
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
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
            &mut calls,
        );
    }

    while calls.join_next().await.is_some() {}
    services.shutdown().await;
    drop(event_tx);
    let _ = event_forwarder.await;
    desktop_event_forwarder.abort();
    let _ = desktop_event_forwarder.await;
    drop(output_tx);
    writer_task
        .await
        .map_err(|error| io::Error::other(format!("Local writer task failed: {error}")))??;
    Ok(())
}

fn dispatch_request(
    request: Request,
    host: Arc<ToolHost>,
    events: mpsc::UnboundedSender<whalehall_local_protocol::ToolEvent>,
    output: mpsc::UnboundedSender<OutboundMessage>,
    event_journal: EventJournal,
    calls: &mut JoinSet<()>,
) {
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
    use std::sync::Arc;
    use std::time::Duration;

    use tempfile::TempDir;
    use tokio::io::{AsyncWriteExt, BufReader, duplex};
    use whalehall_local_core::events::{DesktopEventDraft, EventJournal};
    use whalehall_local_core::sensors::activity::{
        ActivityConfig, ActivityError, ActivityService, ForegroundApp, ForegroundAppProvider,
    };
    use whalehall_local_protocol::desktop_event_kinds;

    use super::*;

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
