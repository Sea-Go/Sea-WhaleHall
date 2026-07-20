use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_ECHO_CHARACTERS: usize = 4096;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize, PartialEq)]
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

#[derive(Debug, Serialize, PartialEq)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

impl Response {
    fn success(id: String, result: Value) -> Self {
        Self::Success {
            id,
            ok: true,
            result,
        }
    }

    fn failure(id: Option<String>, code: &str, message: impl Into<String>) -> Self {
        Self::Failure {
            id,
            ok: false,
            error: ErrorPayload {
                code: code.to_owned(),
                message: message.into(),
            },
        }
    }
}

pub fn handle_line(line: &str) -> Response {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return Response::failure(None, "INVALID_JSON", format!("Invalid JSON: {error}"));
        }
    };

    let possible_id = value
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let request: Request = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(error) => {
            return Response::failure(
                possible_id,
                "INVALID_REQUEST",
                format!("Invalid request: {error}"),
            );
        }
    };

    handle_request(request)
}

pub fn handle_request(request: Request) -> Response {
    match request.method.as_str() {
        "health.check" => Response::success(
            request.id,
            json!({
                "service": "whalehall-core",
                "version": env!("CARGO_PKG_VERSION"),
                "pid": std::process::id(),
                "status": "ok"
            }),
        ),
        "echo" => handle_echo(request),
        method => Response::failure(
            Some(request.id),
            "METHOD_NOT_FOUND",
            format!("Unknown method: {method}"),
        ),
    }
}

fn handle_echo(request: Request) -> Response {
    let Some(message) = request.params.get("message").and_then(Value::as_str) else {
        return Response::failure(
            Some(request.id),
            "INVALID_PARAMS",
            "echo requires a string 'message' parameter",
        );
    };

    if message.chars().count() > MAX_ECHO_CHARACTERS {
        return Response::failure(
            Some(request.id),
            "INVALID_PARAMS",
            format!("echo message must not exceed {MAX_ECHO_CHARACTERS} characters"),
        );
    }

    Response::success(
        request.id,
        json!({
            "message": message,
            "handledBy": "whalehall-core",
            "pid": std::process::id()
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(response: Response) -> Value {
        match response {
            Response::Success { result, .. } => result,
            Response::Failure { error, .. } => panic!("unexpected failure: {error:?}"),
        }
    }

    #[test]
    fn handles_health_check() {
        let response = handle_line(r#"{"id":"health-1","method":"health.check","params":{}}"#);
        let result = result(response);
        assert_eq!(result["service"], "whalehall-core");
        assert_eq!(result["status"], "ok");
        assert!(result["pid"].as_u64().is_some());
    }

    #[test]
    fn echoes_messages() {
        let response =
            handle_line(r#"{"id":"echo-1","method":"echo","params":{"message":"hello whale"}}"#);
        let result = result(response);
        assert_eq!(result["message"], "hello whale");
        assert_eq!(result["handledBy"], "whalehall-core");
    }

    #[test]
    fn rejects_unknown_methods() {
        let response = handle_line(r#"{"id":"bad-1","method":"missing","params":{}}"#);
        match response {
            Response::Failure { id, error, .. } => {
                assert_eq!(id.as_deref(), Some("bad-1"));
                assert_eq!(error.code, "METHOD_NOT_FOUND");
            }
            Response::Success { .. } => panic!("expected failure"),
        }
    }

    #[test]
    fn reports_malformed_json_without_writing_non_json_output() {
        let response = handle_line("not-json");
        match response {
            Response::Failure { id, error, .. } => {
                assert_eq!(id, None);
                assert_eq!(error.code, "INVALID_JSON");
            }
            Response::Success { .. } => panic!("expected failure"),
        }
    }

    #[test]
    fn handles_multiple_requests_independently() {
        let lines = [
            r#"{"id":"1","method":"echo","params":{"message":"first"}}"#,
            r#"{"id":"2","method":"echo","params":{"message":"second"}}"#,
        ];
        let messages: Vec<Value> = lines.into_iter().map(handle_line).map(result).collect();
        assert_eq!(messages[0]["message"], "first");
        assert_eq!(messages[1]["message"], "second");
    }
}
