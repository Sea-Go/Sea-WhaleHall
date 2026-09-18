use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::application_inventory::{
    ApplicationInventoryService, InstalledApplicationQuery,
};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct InstalledApplicationsTool {
    inventory: ApplicationInventoryService,
}

impl InstalledApplicationsTool {
    pub(crate) fn new(inventory: ApplicationInventoryService) -> Self {
        Self { inventory }
    }
}

#[async_trait]
impl LocalTool for InstalledApplicationsTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "applications.installed".to_owned(),
            description: "Query installed applications persisted in the local SQLite inventory."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "nameContains": { "type": "string", "minLength": 1 }
                },
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
        let query: InstalledApplicationQuery =
            serde_json::from_value(arguments).map_err(|error| {
                ToolError::invalid_arguments(format!(
                    "applications.installed arguments are invalid: {error}"
                ))
            })?;
        query
            .validate()
            .map_err(|error| ToolError::invalid_arguments(error.to_string()))?;
        let applications = self
            .inventory
            .installed_applications(&query)
            .map_err(|error| {
                ToolError::new(
                    "INTERNAL_ERROR",
                    format!("Unable to query installed applications: {error}"),
                )
            })?;
        Ok(json!({
            "count": applications.len(),
            "applications": applications,
        }))
    }
}
