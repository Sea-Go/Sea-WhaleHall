use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::application_inventory::ApplicationInventoryService;
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct ApplicationInventoryStatusTool {
    inventory: ApplicationInventoryService,
}

impl ApplicationInventoryStatusTool {
    pub(crate) fn new(inventory: ApplicationInventoryService) -> Self {
        Self { inventory }
    }
}

#[async_trait]
impl LocalTool for ApplicationInventoryStatusTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "applications.status".to_owned(),
            description:
                "Read the resident installed-application and process inventory sensor status."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            risk: ToolRisk::Read,
            required_permissions: vec!["applications.read".to_owned()],
            supports_cancellation: false,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        if context.cancellation.is_cancelled() {
            return Err(ToolError::cancelled());
        }
        let Some(arguments) = arguments.as_object() else {
            return Err(ToolError::invalid_arguments(
                "applications.status arguments must be an object.",
            ));
        };
        if !arguments.is_empty() {
            return Err(ToolError::invalid_arguments(
                "applications.status does not accept arguments.",
            ));
        }
        serde_json::to_value(self.inventory.status()).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize application inventory status: {error}"),
            )
        })
    }
}
