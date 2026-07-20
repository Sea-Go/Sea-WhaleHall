use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::time::{Duration, Instant, sleep_until};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct DemoWaitTool;

#[async_trait]
impl LocalTool for DemoWaitTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "demo.wait".to_owned(),
            description: "Wait briefly while reporting progress; useful for testing cancellation."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "durationMs": {
                        "type": "integer",
                        "minimum": 100,
                        "maximum": 5000
                    }
                },
                "required": ["durationMs"],
                "additionalProperties": false,
            }),
            risk: ToolRisk::Read,
            required_permissions: Vec::new(),
            supports_cancellation: true,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        let duration_ms = arguments
            .as_object()
            .and_then(|object| {
                if object.len() == 1 {
                    object.get("durationMs")?.as_u64()
                } else {
                    None
                }
            })
            .filter(|duration| (100..=5000).contains(duration))
            .ok_or_else(|| {
                ToolError::invalid_arguments(
                    "demo.wait requires integer durationMs between 100 and 5000.",
                )
            })?;

        let started = Instant::now();
        for step in 1..=10_u64 {
            let deadline = started + Duration::from_millis(duration_ms * step / 10);
            tokio::select! {
                () = context.cancellation.cancelled() => return Err(ToolError::cancelled()),
                () = sleep_until(deadline) => {
                    context.emit_progress((step * 10) as u8, format!("Waiting… {}%", step * 10));
                }
            }
        }

        Ok(json!({ "waitedMs": duration_ms }))
    }
}
