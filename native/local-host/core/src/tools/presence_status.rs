use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::presence::PresenceService;
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct PresenceStatusTool {
    presence: PresenceService,
}

impl PresenceStatusTool {
    pub(crate) fn new(presence: PresenceService) -> Self {
        Self { presence }
    }
}

#[async_trait]
impl LocalTool for PresenceStatusTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "presence.status".to_owned(),
            description:
                "Read last-input, AFK, screen-lock, and sleep/wake sensor state from the local client."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            risk: ToolRisk::Read,
            required_permissions: vec!["presence.read".to_owned()],
            supports_cancellation: false,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        if context.cancellation.is_cancelled() {
            return Err(ToolError::cancelled());
        }
        let Some(arguments) = arguments.as_object() else {
            return Err(ToolError::invalid_arguments(
                "presence.status arguments must be an object.",
            ));
        };
        if !arguments.is_empty() {
            return Err(ToolError::invalid_arguments(
                "presence.status does not accept arguments.",
            ));
        }
        serde_json::to_value(self.presence.status()).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize presence status: {error}"),
            )
        })
    }
}
