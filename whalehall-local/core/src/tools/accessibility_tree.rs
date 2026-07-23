use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::accessibility_tree::{AccessibilityService, AccessibilityTreeQuery};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct AccessibilityTreeTool {
    accessibility: AccessibilityService,
}

impl AccessibilityTreeTool {
    pub(crate) fn new(accessibility: AccessibilityService) -> Self {
        Self { accessibility }
    }
}

#[async_trait]
impl LocalTool for AccessibilityTreeTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "accessibility.tree".to_owned(),
            description: "Query a persisted foreground accessibility tree. Control values and partial document text require explicit include flags.".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "minimum": 1, "maximum": 1000},
                    "snapshotId": {"type": "integer", "minimum": 1},
                    "roles": {
                        "type": "array",
                        "maxItems": 64,
                        "items": {"type": "string", "minLength": 1}
                    },
                    "focusedOnly": {"type": "boolean"},
                    "selectedOnly": {"type": "boolean"},
                    "includeValues": {"type": "boolean"},
                    "includeDocumentText": {"type": "boolean"}
                },
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
        let query: AccessibilityTreeQuery = serde_json::from_value(arguments).map_err(|error| {
            ToolError::invalid_arguments(format!("Invalid accessibility.tree arguments: {error}"))
        })?;
        query
            .validate()
            .map_err(|error| ToolError::invalid_arguments(error.to_string()))?;
        let result = self
            .accessibility
            .tree(&query)
            .map_err(|error| ToolError::new("STORAGE_ERROR", error.to_string()))?;
        serde_json::to_value(result).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize accessibility tree: {error}"),
            )
        })
    }
}
