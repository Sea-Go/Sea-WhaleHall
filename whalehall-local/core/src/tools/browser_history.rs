use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::browser_activity::{BrowserActivityService, BrowserHistoryQuery};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct BrowserHistoryTool {
    browser: BrowserActivityService,
}

impl BrowserHistoryTool {
    pub(crate) fn new(browser: BrowserActivityService) -> Self {
        Self { browser }
    }
}

#[async_trait]
impl LocalTool for BrowserHistoryTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "browser.history".to_owned(),
            description:
                "Query locally imported browser URLs, titles, visit times, and visit counts."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "browser": { "type": "string", "minLength": 1 },
                    "domainContains": { "type": "string", "minLength": 1 },
                    "urlContains": { "type": "string", "minLength": 1 },
                    "fromMs": { "type": "integer", "minimum": 0 },
                    "toMs": { "type": "integer", "minimum": 0 }
                },
                "additionalProperties": false
            }),
            risk: ToolRisk::Read,
            required_permissions: vec!["browser.read".to_owned()],
            supports_cancellation: false,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        if context.cancellation.is_cancelled() {
            return Err(ToolError::cancelled());
        }
        let query: BrowserHistoryQuery = serde_json::from_value(arguments).map_err(|error| {
            ToolError::invalid_arguments(format!("browser.history arguments are invalid: {error}"))
        })?;
        query
            .validate()
            .map_err(|error| ToolError::invalid_arguments(error.to_string()))?;
        let history = self.browser.history(&query).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to query browser history: {error}"),
            )
        })?;
        Ok(json!({ "count": history.len(), "history": history }))
    }
}
