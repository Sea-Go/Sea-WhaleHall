use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::browser_activity::BrowserActivityService;
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct BrowserStatusTool {
    browser: BrowserActivityService,
}

impl BrowserStatusTool {
    pub(crate) fn new(browser: BrowserActivityService) -> Self {
        Self { browser }
    }
}

#[async_trait]
impl LocalTool for BrowserStatusTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "browser.status".to_owned(),
            description:
                "Read browser sensor state, capabilities, counts, and current tab observations."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
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
        let Some(arguments) = arguments.as_object() else {
            return Err(ToolError::invalid_arguments(
                "browser.status arguments must be an object.",
            ));
        };
        if !arguments.is_empty() {
            return Err(ToolError::invalid_arguments(
                "browser.status does not accept arguments.",
            ));
        }
        serde_json::to_value(self.browser.status()).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize browser status: {error}"),
            )
        })
    }
}
