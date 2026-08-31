use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::input_activity::InputActivityService;
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct InputActivityStatusTool {
    input_activity: InputActivityService,
}

impl InputActivityStatusTool {
    pub(crate) fn new(input_activity: InputActivityService) -> Self {
        Self { input_activity }
    }
}

#[async_trait]
impl LocalTool for InputActivityStatusTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "input.status".to_owned(),
            description:
                "Read authorization, OS permission, and five-second keyboard/pointer aggregate sensor state. No key values, text, clipboard data, or absolute coordinates are collected."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            risk: ToolRisk::Read,
            required_permissions: vec!["input.aggregate".to_owned()],
            supports_cancellation: false,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        if context.cancellation.is_cancelled() {
            return Err(ToolError::cancelled());
        }
        let Some(arguments) = arguments.as_object() else {
            return Err(ToolError::invalid_arguments(
                "input.status arguments must be an object.",
            ));
        };
        if !arguments.is_empty() {
            return Err(ToolError::invalid_arguments(
                "input.status does not accept arguments.",
            ));
        }
        serde_json::to_value(self.input_activity.status()).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize input activity status: {error}"),
            )
        })
    }
}
