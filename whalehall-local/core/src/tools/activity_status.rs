use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::activity::ActivityService;
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct ActivityStatusTool {
    activity: ActivityService,
}

impl ActivityStatusTool {
    pub(crate) fn new(activity: ActivityService) -> Self {
        Self { activity }
    }
}

#[async_trait]
impl LocalTool for ActivityStatusTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "activity.status".to_owned(),
            description: "Return activity monitoring state and the current foreground session."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
            risk: ToolRisk::Read,
            required_permissions: Vec::new(),
            supports_cancellation: false,
        }
    }

    async fn call(&self, _context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        let Some(arguments) = arguments.as_object() else {
            return Err(ToolError::invalid_arguments(
                "activity.status arguments must be an object.",
            ));
        };
        if !arguments.is_empty() {
            return Err(ToolError::invalid_arguments(
                "activity.status does not accept arguments.",
            ));
        }
        serde_json::to_value(self.activity.status()).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize activity status: {error}"),
            )
        })
    }
}
