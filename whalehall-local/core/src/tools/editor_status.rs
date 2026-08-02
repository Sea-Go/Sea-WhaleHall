use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::vscode_edit_bridge::VscodeEditBridgeService;
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct EditorStatusTool {
    editor: VscodeEditBridgeService,
}

impl EditorStatusTool {
    pub(crate) fn new(editor: VscodeEditBridgeService) -> Self {
        Self { editor }
    }
}

#[async_trait]
impl LocalTool for EditorStatusTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "editor.status".to_owned(),
            description:
                "Read the explicit-consent VS Code spool consumer state, durable edit-burst backlog, and privacy-safe health information."
                    .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            risk: ToolRisk::Read,
            required_permissions: vec!["editor.metadata".to_owned()],
            supports_cancellation: false,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        if context.cancellation.is_cancelled() {
            return Err(ToolError::cancelled());
        }
        let Some(arguments) = arguments.as_object() else {
            return Err(ToolError::invalid_arguments(
                "editor.status arguments must be an object.",
            ));
        };
        if !arguments.is_empty() {
            return Err(ToolError::invalid_arguments(
                "editor.status does not accept arguments.",
            ));
        }
        serde_json::to_value(self.editor.status()).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize editor bridge status: {error}"),
            )
        })
    }
}
