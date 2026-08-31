use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct SystemInfoTool;

#[async_trait]
impl LocalTool for SystemInfoTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "system.info".to_owned(),
            description: "Return non-identifying information about the local runtime.".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
            risk: ToolRisk::Read,
            required_permissions: Vec::new(),
            supports_cancellation: false,
        }
    }

    async fn call(&self, _context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        let Some(arguments) = arguments.as_object() else {
            return Err(ToolError::invalid_arguments(
                "system.info arguments must be an object.",
            ));
        };
        if !arguments.is_empty() {
            return Err(ToolError::invalid_arguments(
                "system.info does not accept arguments.",
            ));
        }

        Ok(json!({
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "localVersion": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
        }))
    }
}
