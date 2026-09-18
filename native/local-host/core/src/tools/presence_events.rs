use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::presence::{PresenceEventQuery, PresenceService};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct PresenceEventsTool {
    presence: PresenceService,
}

impl PresenceEventsTool {
    pub(crate) fn new(presence: PresenceService) -> Self {
        Self { presence }
    }
}

#[async_trait]
impl LocalTool for PresenceEventsTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "presence.events".to_owned(),
            description: "Query AFK, screen lock/unlock, and sleep/wake events from local SQLite."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1000,
                        "default": 100
                    },
                    "eventTypes": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": [
                                "afkStarted",
                                "afkEnded",
                                "screenLocked",
                                "screenUnlocked",
                                "sleepStarted",
                                "wokeUp"
                            ]
                        },
                        "uniqueItems": true
                    },
                    "fromMs": { "type": "integer", "minimum": 0 },
                    "toMs": { "type": "integer", "minimum": 0 }
                },
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
        let query: PresenceEventQuery = serde_json::from_value(arguments).map_err(|error| {
            ToolError::invalid_arguments(format!("presence.events arguments are invalid: {error}"))
        })?;
        query
            .validate()
            .map_err(|error| ToolError::invalid_arguments(error.to_string()))?;
        let events = self.presence.events(&query).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to query presence events: {error}"),
            )
        })?;
        Ok(json!({
            "count": events.len(),
            "events": events,
        }))
    }
}
