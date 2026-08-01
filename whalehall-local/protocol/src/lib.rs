use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;

pub mod error_codes {
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    pub const METHOD_NOT_FOUND: &str = "METHOD_NOT_FOUND";
    pub const TOOL_NOT_FOUND: &str = "TOOL_NOT_FOUND";
    pub const INVALID_ARGUMENTS: &str = "INVALID_ARGUMENTS";
    pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
    pub const CANCELLED: &str = "CANCELLED";
    pub const BUSY: &str = "BUSY";
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Request {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Response {
    Success {
        id: String,
        ok: bool,
        result: Value,
    },
    Failure {
        id: Option<String>,
        ok: bool,
        error: ErrorPayload,
    },
}

impl Response {
    pub fn success(id: String, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self::Success {
                id,
                ok: true,
                result,
            },
            Err(error) => Self::failure(
                Some(id),
                "INTERNAL_ERROR",
                format!("Failed serializing local result: {error}"),
            ),
        }
    }

    pub fn failure(
        id: Option<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::Failure {
            id,
            ok: false,
            error: ErrorPayload {
                code: code.into(),
                message: message.into(),
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolRisk {
    Read,
    Write,
    Control,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub risk: ToolRisk,
    pub required_permissions: Vec<String>,
    pub supports_cancellation: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub service: String,
    pub version: String,
    pub pid: u32,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolListResult {
    pub tools: Vec<ToolDescriptor>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallParams {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResult {
    pub call_id: String,
    pub output: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCancelParams {
    pub call_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCancelResult {
    pub call_id: String,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ToolEventKind {
    #[serde(rename = "tool.started")]
    Started,
    #[serde(rename = "tool.progress")]
    Progress,
    #[serde(rename = "tool.completed")]
    Completed,
    #[serde(rename = "tool.failed")]
    Failed,
    #[serde(rename = "tool.cancelled")]
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolEvent {
    pub event: ToolEventKind,
    pub call_id: String,
    pub data: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum OutboundMessage {
    Response(Response),
    Event(ToolEvent),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_lines(value: &str) -> Vec<OutboundMessage> {
        value
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).expect("fixture must match Rust protocol"))
            .collect()
    }

    #[test]
    fn shared_success_fixture_matches_protocol() {
        let messages = parse_lines(include_str!(
            "../../../tests/fixtures/local-protocol/success.jsonl"
        ));
        assert!(matches!(
            messages.as_slice(),
            [OutboundMessage::Response(Response::Success { .. })]
        ));
    }

    #[test]
    fn shared_failure_fixture_matches_protocol() {
        let messages = parse_lines(include_str!(
            "../../../tests/fixtures/local-protocol/failure.jsonl"
        ));
        assert!(matches!(
            messages.as_slice(),
            [OutboundMessage::Response(Response::Failure { .. })]
        ));
    }

    #[test]
    fn shared_event_fixture_matches_protocol() {
        let messages = parse_lines(include_str!(
            "../../../tests/fixtures/local-protocol/events.jsonl"
        ));
        assert_eq!(messages.len(), 5);
        assert!(
            messages
                .iter()
                .all(|message| matches!(message, OutboundMessage::Event(_)))
        );
    }
}
