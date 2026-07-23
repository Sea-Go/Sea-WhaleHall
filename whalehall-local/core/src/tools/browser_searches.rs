use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::browser_activity::{BrowserActivityService, BrowserSearchQuery};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct BrowserSearchesTool {
    browser: BrowserActivityService,
}

impl BrowserSearchesTool {
    pub(crate) fn new(browser: BrowserActivityService) -> Self {
        Self { browser }
    }
}

#[async_trait]
impl LocalTool for BrowserSearchesTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "browser.searches".to_owned(),
            description:
                "Query search terms derived from supported browser history URLs with visit time."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "browser": { "type": "string", "minLength": 1 },
                    "termContains": { "type": "string", "minLength": 1 },
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
        let query: BrowserSearchQuery = serde_json::from_value(arguments).map_err(|error| {
            ToolError::invalid_arguments(format!("browser.searches arguments are invalid: {error}"))
        })?;
        query
            .validate()
            .map_err(|error| ToolError::invalid_arguments(error.to_string()))?;
        let searches = self.browser.searches(&query).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to query browser searches: {error}"),
            )
        })?;
        Ok(json!({ "count": searches.len(), "searches": searches }))
    }
}
