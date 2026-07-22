use async_trait::async_trait;
use serde_json::{Value, json};
use whalehall_local_protocol::{ToolDescriptor, ToolRisk};

use crate::sensors::device_environment::DeviceEnvironmentSensor;
use crate::{LocalTool, ToolContext, ToolError};

pub(crate) struct DeviceEnvironmentTool {
    sensor: DeviceEnvironmentSensor,
}

impl DeviceEnvironmentTool {
    pub(crate) fn new(sensor: DeviceEnvironmentSensor) -> Self {
        Self { sensor }
    }
}

#[async_trait]
impl LocalTool for DeviceEnvironmentTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "device.environment".to_owned(),
            description: "Read local device identity, operating system, locale, displays, CPU, memory, batteries, and network interfaces."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            risk: ToolRisk::Read,
            required_permissions: vec!["device.environment.read".to_owned()],
            supports_cancellation: false,
        }
    }

    async fn call(&self, context: ToolContext, arguments: Value) -> Result<Value, ToolError> {
        if context.cancellation.is_cancelled() {
            return Err(ToolError::cancelled());
        }
        let Some(arguments) = arguments.as_object() else {
            return Err(ToolError::invalid_arguments(
                "device.environment arguments must be an object.",
            ));
        };
        if !arguments.is_empty() {
            return Err(ToolError::invalid_arguments(
                "device.environment does not accept arguments.",
            ));
        }
        serde_json::to_value(self.sensor.collect()).map_err(|error| {
            ToolError::new(
                "INTERNAL_ERROR",
                format!("Unable to serialize device environment information: {error}"),
            )
        })
    }
}
