use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::accessibility_tree::AccessibilityService;
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct AccessibilityStatusTool {
    accessibility: AccessibilityService,
}

impl AccessibilityStatusTool {
    pub(crate) fn new(accessibility: AccessibilityService) -> Self {
        Self { accessibility }
    }
}

#[async_trait]
impl LocalTool for AccessibilityStatusTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "accessibility.status".to_owned(),
            description:
                "Read foreground accessibility-tree state, capabilities, and focused control."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            risk: ToolRisk::Read,
            required_permissions: vec!["accessibility.read".to_owned()],
            supports_cancellation: false,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        if context.cancellation.is_cancelled() {
            return Err(ToolError::cancelled());
        }
        let Some(arguments) = arguments.as_object() else {
            return Err(ToolError::invalid_arguments(
                "accessibility.status arguments must be an object.",
            ));
        };
        if !arguments.is_empty() {
            return Err(ToolError::invalid_arguments(
                "accessibility.status does not accept arguments.",
            ));
        }
        serde_json::to_value(self.accessibility.status()).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize accessibility status: {error}"),
            )
        })
    }
}
