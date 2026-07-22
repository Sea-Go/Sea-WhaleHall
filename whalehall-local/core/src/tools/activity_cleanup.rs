use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::activity::{ActivityCacheScope, ActivityService};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct ActivityCleanupTool {
    activity: ActivityService,
}

impl ActivityCleanupTool {
    pub(crate) fn new(activity: ActivityService) -> Self {
        Self { activity }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupArguments {
    scope: ActivityCacheScope,
}

#[async_trait]
impl LocalTool for ActivityCleanupTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "activity.cleanup".to_owned(),
            description:
                "Delete local activity history using a 30-day, 7-day, or complete cleanup policy."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["longTerm", "shortTerm", "all"],
                        "description": "longTerm keeps 30 days, shortTerm keeps 7 days, all deletes every session."
                    }
                },
                "required": ["scope"],
                "additionalProperties": false
            }),
            risk: ToolRisk::Write,
            required_permissions: vec!["activity.delete".to_owned()],
            supports_cancellation: false,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        if context.cancellation.is_cancelled() {
            return Err(ToolError::cancelled());
        }
        let arguments: CleanupArguments = serde_json::from_value(arguments).map_err(|error| {
            ToolError::invalid_arguments(format!("activity.cleanup arguments are invalid: {error}"))
        })?;
        let result = self
            .activity
            .cleanup(arguments.scope)
            .await
            .map_err(|error| {
                ToolError::new(
                    "INTERNAL_ERROR",
                    format!("Unable to clean activity history: {error}"),
                )
            })?;
        serde_json::to_value(result).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize activity cleanup result: {error}"),
            )
        })
    }
}
