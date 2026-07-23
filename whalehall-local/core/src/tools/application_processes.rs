use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::application_inventory::{ApplicationInventoryService, ProcessRunQuery};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct ApplicationProcessesTool {
    inventory: ApplicationInventoryService,
}

impl ApplicationProcessesTool {
    pub(crate) fn new(inventory: ApplicationInventoryService) -> Self {
        Self { inventory }
    }
}

#[async_trait]
impl LocalTool for ApplicationProcessesTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "applications.processes".to_owned(),
            description: "Query running and exited process records with CPU and memory usage from local SQLite."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "processId": { "type": "integer", "minimum": 0 },
                    "nameContains": { "type": "string", "minLength": 1 },
                    "fromMs": { "type": "integer", "minimum": 0 },
                    "toMs": { "type": "integer", "minimum": 0 },
                    "runningOnly": { "type": "boolean", "default": false }
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
        let query: ProcessRunQuery = serde_json::from_value(arguments).map_err(|error| {
            ToolError::invalid_arguments(format!(
                "applications.processes arguments are invalid: {error}"
            ))
        })?;
        query
            .validate()
            .map_err(|error| ToolError::invalid_arguments(error.to_string()))?;
        let processes = self.inventory.processes(&query).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to query application processes: {error}"),
            )
        })?;
        Ok(json!({
            "count": processes.len(),
            "processes": processes,
        }))
    }
}
