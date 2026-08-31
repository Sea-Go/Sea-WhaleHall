use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::browser_activity::{BrowserActivityService, BrowserTabQuery};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct BrowserTabsTool {
    browser: BrowserActivityService,
}

impl BrowserTabsTool {
    pub(crate) fn new(browser: BrowserActivityService) -> Self {
        Self { browser }
    }
}

#[async_trait]
impl LocalTool for BrowserTabsTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "browser.tabs".to_owned(),
            description:
                "Query current or completed browser tab sessions with title, URL, domain, audio, and boundaries."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "currentOnly": { "type": "boolean", "default": true },
                    "browser": { "type": "string", "minLength": 1 },
                    "domainContains": { "type": "string", "minLength": 1 },
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
        let query: BrowserTabQuery = serde_json::from_value(arguments).map_err(|error| {
            ToolError::invalid_arguments(format!("browser.tabs arguments are invalid: {error}"))
        })?;
        query
            .validate()
            .map_err(|error| ToolError::invalid_arguments(error.to_string()))?;
        let tabs = self.browser.tabs(&query).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to query browser tabs: {error}"),
            )
        })?;
        Ok(json!({ "count": tabs.len(), "tabs": tabs }))
    }
}
