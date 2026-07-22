use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::activity::{ActivityQuery, ActivityService};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct ActivitySessionsTool {
    activity: ActivityService,
}

impl ActivitySessionsTool {
    pub(crate) fn new(activity: ActivityService) -> Self {
        Self { activity }
    }
}

#[async_trait]
impl LocalTool for ActivitySessionsTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "activity.sessions".to_owned(),
            description:
                "Read raw foreground-application usage sessions from the local SQLite database."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 },
                    "fromMs": { "type": "integer", "minimum": 0 },
                    "toMs": { "type": "integer", "minimum": 0 },
                    "appId": { "type": "string", "minLength": 1 },
                    "includeOpen": { "type": "boolean", "default": true }
                },
                "additionalProperties": false,
            }),
            risk: ToolRisk::Read,
            required_permissions: vec!["activity.read".to_owned()],
            supports_cancellation: false,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        if context.cancellation.is_cancelled() {
            return Err(ToolError::cancelled());
        }
        let query: ActivityQuery = serde_json::from_value(arguments).map_err(|error| {
            ToolError::invalid_arguments(format!(
                "activity.sessions arguments are invalid: {error}"
            ))
        })?;
        query
            .validate()
            .map_err(|error| ToolError::invalid_arguments(error.to_string()))?;
        let sessions = self.activity.sessions(&query).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to read activity sessions: {error}"),
            )
        })?;
        Ok(json!({
            "count": sessions.len(),
            "sessions": sessions,
        }))
    }
}
