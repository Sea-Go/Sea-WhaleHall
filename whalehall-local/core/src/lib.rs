mod activity;
pub mod sensors;
mod tools;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;
use whalehall_local_protocol::{ToolDescriptor, ToolEvent, ToolEventKind};

use sensors::activity::ActivityService;
use sensors::device_environment::DeviceEnvironmentSensor;
use tools::{
    ActivityCleanupTool, ActivitySessionsTool, ActivityStatusTool, DemoWaitTool,
    DeviceEnvironmentTool, SystemInfoTool,
};

pub const MAX_CONCURRENT_TOOLS: usize = 4;

pub type EventSender = mpsc::UnboundedSender<ToolEvent>;

#[derive(Clone)]
pub struct ToolContext {
    pub call_id: String,
    pub cancellation: CancellationToken,
    events: EventSender,
}

impl ToolContext {
    pub fn emit_progress(&self, progress: u8, message: impl Into<String>) {
        let _ = self.events.send(ToolEvent {
            event: ToolEventKind::Progress,
            call_id: self.call_id.clone(),
            data: json!({
                "progress": progress,
                "message": message.into(),
            }),
        });
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_arguments(message: impl Into<String>) -> Self {
        Self::new("INVALID_ARGUMENTS", message)
    }

    pub fn cancelled() -> Self {
        Self::new("CANCELLED", "Local tool call was cancelled.")
    }
}

#[async_trait]
pub trait LocalTool: Send + Sync {
    fn descriptor(&self) -> ToolDescriptor;

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError>;
}

pub struct ToolHost {
    tools: HashMap<String, Arc<dyn LocalTool>>,
    active: Mutex<HashMap<String, CancellationToken>>,
    concurrency: Arc<Semaphore>,
}

impl Default for ToolHost {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolHost {
    pub fn new() -> Self {
        let tools: Vec<Arc<dyn LocalTool>> = vec![
            Arc::new(SystemInfoTool),
            Arc::new(DemoWaitTool),
            Arc::new(DeviceEnvironmentTool::new(DeviceEnvironmentSensor)),
        ];
        Self::with_tools(tools)
    }

    pub fn with_activity(activity: ActivityService) -> Self {
        let tools: Vec<Arc<dyn LocalTool>> = vec![
            Arc::new(SystemInfoTool),
            Arc::new(DemoWaitTool),
            Arc::new(DeviceEnvironmentTool::new(DeviceEnvironmentSensor)),
            Arc::new(ActivityCleanupTool::new(activity.clone())),
            Arc::new(ActivityStatusTool::new(activity.clone())),
            Arc::new(ActivitySessionsTool::new(activity)),
        ];
        Self::with_tools(tools)
    }

    pub fn with_tools(tools: Vec<Arc<dyn LocalTool>>) -> Self {
        let tools = tools
            .into_iter()
            .map(|tool| (tool.descriptor().name.clone(), tool))
            .collect();
        Self {
            tools,
            active: Mutex::new(HashMap::new()),
            concurrency: Arc::new(Semaphore::new(MAX_CONCURRENT_TOOLS)),
        }
    }

    pub fn descriptors(&self) -> Vec<ToolDescriptor> {
        let mut descriptors: Vec<_> = self.tools.values().map(|tool| tool.descriptor()).collect();
        descriptors.sort_by(|left, right| left.name.cmp(&right.name));
        descriptors
    }

    pub async fn call(
        &self,
        call_id: String,
        name: String,
        arguments: Value,
        events: EventSender,
    ) -> Result<Value, ToolError> {
        let Some(tool) = self.tools.get(&name).cloned() else {
            return Err(ToolError::new(
                "TOOL_NOT_FOUND",
                format!("Unknown local tool: {name}"),
            ));
        };

        let permit = self
            .concurrency
            .clone()
            .try_acquire_owned()
            .map_err(|_| ToolError::new("BUSY", "Local tool concurrency limit reached."))?;
        let cancellation = CancellationToken::new();
        {
            let mut active = self
                .active
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if active.contains_key(&call_id) {
                return Err(ToolError::new(
                    "INVALID_REQUEST",
                    format!("Duplicate local tool call id: {call_id}"),
                ));
            }
            active.insert(call_id.clone(), cancellation.clone());
        }

        let _ = events.send(ToolEvent {
            event: ToolEventKind::Started,
            call_id: call_id.clone(),
            data: json!({ "name": name }),
        });

        let context = ToolContext {
            call_id: call_id.clone(),
            cancellation,
            events: events.clone(),
        };
        let result = tool.call(context, arguments).await;
        self.active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&call_id);
        drop(permit);

        match &result {
            Ok(_) => {
                let _ = events.send(ToolEvent {
                    event: ToolEventKind::Completed,
                    call_id,
                    data: json!({ "name": name }),
                });
            }
            Err(error) if error.code == "CANCELLED" => {
                let _ = events.send(ToolEvent {
                    event: ToolEventKind::Cancelled,
                    call_id,
                    data: json!({
                        "name": name,
                        "message": error.message,
                    }),
                });
            }
            Err(error) => {
                let _ = events.send(ToolEvent {
                    event: ToolEventKind::Failed,
                    call_id,
                    data: json!({
                        "name": name,
                        "code": error.code,
                        "message": error.message,
                    }),
                });
            }
        }

        result
    }

    pub fn cancel(&self, call_id: &str) -> bool {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(cancellation) = active.get(call_id) else {
            return false;
        };
        cancellation.cancel();
        true
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use tokio::sync::mpsc;
    use whalehall_local_protocol::ToolEventKind;

    use super::*;

    #[test]
    fn lists_registered_tools_in_stable_order() {
        let host = ToolHost::new();
        let descriptors = host.descriptors();
        assert_eq!(
            descriptors
                .iter()
                .map(|descriptor| descriptor.name.as_str())
                .collect::<Vec<_>>(),
            vec!["demo.wait", "device.environment", "system.info"]
        );
        assert!(descriptors[0].supports_cancellation);
        assert!(descriptors[0].required_permissions.is_empty());
        assert_eq!(
            descriptors[1].required_permissions,
            vec!["device.environment.read"]
        );
    }

    #[tokio::test]
    async fn returns_safe_system_information() {
        let host = ToolHost::new();
        let (events, mut receiver) = mpsc::unbounded_channel();
        let result = host
            .call(
                "system-1".to_owned(),
                "system.info".to_owned(),
                json!({}),
                events,
            )
            .await
            .expect("system.info should succeed");
        assert_eq!(result["os"], std::env::consts::OS);
        assert_eq!(result["arch"], std::env::consts::ARCH);
        assert!(result.get("hostname").is_none());
        assert!(matches!(
            receiver.recv().await,
            Some(ToolEvent {
                event: ToolEventKind::Started,
                ..
            })
        ));
        assert!(matches!(
            receiver.recv().await,
            Some(ToolEvent {
                event: ToolEventKind::Completed,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn returns_device_environment_information() {
        let host = ToolHost::new();
        let (events, _) = mpsc::unbounded_channel();
        let result = host
            .call(
                "device-1".to_owned(),
                "device.environment".to_owned(),
                json!({}),
                events,
            )
            .await
            .expect("device.environment should succeed");

        assert!(result["operatingSystem"]["name"].is_string());
        assert!(result["operatingSystem"]["architecture"].is_string());
        assert!(result["timezone"]["utcOffsetMinutes"].is_number());
        assert!(result["screenCount"].is_number());
        assert!(result["screens"].is_array());
        assert!(result["cpu"]["logicalCores"].is_number());
        assert!(result["memory"]["totalBytes"].as_u64().unwrap_or_default() > 0);
        assert!(result["batteries"].is_array());
        assert!(result["networkInterfaces"].is_array());
    }

    #[tokio::test]
    async fn rejects_unknown_tools_and_invalid_arguments() {
        let host = ToolHost::new();
        let (events, _) = mpsc::unbounded_channel();
        let missing = host
            .call(
                "missing-1".to_owned(),
                "missing".to_owned(),
                json!({}),
                events.clone(),
            )
            .await
            .expect_err("unknown tool should fail");
        assert_eq!(missing.code, "TOOL_NOT_FOUND");

        let invalid = host
            .call(
                "wait-invalid".to_owned(),
                "demo.wait".to_owned(),
                json!({ "durationMs": 10 }),
                events,
            )
            .await
            .expect_err("out of range duration should fail");
        assert_eq!(invalid.code, "INVALID_ARGUMENTS");

        let invalid_device = host
            .call(
                "device-invalid".to_owned(),
                "device.environment".to_owned(),
                json!({ "unexpected": true }),
                mpsc::unbounded_channel().0,
            )
            .await
            .expect_err("device.environment must reject unknown arguments");
        assert_eq!(invalid_device.code, "INVALID_ARGUMENTS");
    }

    #[tokio::test]
    async fn emits_progress_and_cancels_active_work() {
        let host = Arc::new(ToolHost::new());
        let (events, mut receiver) = mpsc::unbounded_channel();
        let running_host = host.clone();
        let call = tokio::spawn(async move {
            running_host
                .call(
                    "wait-1".to_owned(),
                    "demo.wait".to_owned(),
                    json!({ "durationMs": 2000 }),
                    events,
                )
                .await
        });

        assert!(matches!(
            receiver.recv().await,
            Some(ToolEvent {
                event: ToolEventKind::Started,
                ..
            })
        ));
        assert!(matches!(
            receiver.recv().await,
            Some(ToolEvent {
                event: ToolEventKind::Progress,
                ..
            })
        ));
        assert!(host.cancel("wait-1"));

        let error = call
            .await
            .expect("tool task should join")
            .expect_err("cancelled tool should fail");
        assert_eq!(error.code, "CANCELLED");
        while let Some(event) = receiver.recv().await {
            if event.event == ToolEventKind::Cancelled {
                return;
            }
        }
        panic!("expected tool.cancelled event");
    }

    #[tokio::test]
    async fn tracks_multiple_concurrent_calls() {
        let host = Arc::new(ToolHost::new());
        let (events, mut receiver) = mpsc::unbounded_channel();
        let first_host = host.clone();
        let first_events = events.clone();
        let first = tokio::spawn(async move {
            first_host
                .call(
                    "concurrent-1".to_owned(),
                    "demo.wait".to_owned(),
                    json!({ "durationMs": 200 }),
                    first_events,
                )
                .await
        });
        let second_host = host.clone();
        let second = tokio::spawn(async move {
            second_host
                .call(
                    "concurrent-2".to_owned(),
                    "demo.wait".to_owned(),
                    json!({ "durationMs": 200 }),
                    events,
                )
                .await
        });

        let mut started = 0;
        while started < 2 {
            if matches!(
                receiver.recv().await,
                Some(ToolEvent {
                    event: ToolEventKind::Started,
                    ..
                })
            ) {
                started += 1;
            }
        }
        assert_eq!(
            host.active
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            2
        );
        assert!(first.await.expect("first task joins").is_ok());
        assert!(second.await.expect("second task joins").is_ok());
    }
}
