use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::browser_activity::{BrowserActivityService, BrowserDownloadQuery};
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct BrowserDownloadsTool {
    browser: BrowserActivityService,
}

impl BrowserDownloadsTool {
    pub(crate) fn new(browser: BrowserActivityService) -> Self {
        Self { browser }
    }
}

#[async_trait]
impl LocalTool for BrowserDownloadsTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "browser.downloads".to_owned(),
            description:
                "Query browser download source URL, local target path, times, bytes, and state."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 },
                    "browser": { "type": "string", "minLength": 1 },
                    "state": {
                        "type": "string",
                        "enum": ["inProgress", "complete", "cancelled", "interrupted", "unknown"]
                    },
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
        let query: BrowserDownloadQuery = serde_json::from_value(arguments).map_err(|error| {
            ToolError::invalid_arguments(format!(
                "browser.downloads arguments are invalid: {error}"
            ))
        })?;
        query
            .validate()
            .map_err(|error| ToolError::invalid_arguments(error.to_string()))?;
        let downloads = self.browser.downloads(&query).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to query browser downloads: {error}"),
            )
        })?;
        Ok(json!({ "count": downloads.len(), "downloads": downloads }))
    }
}
