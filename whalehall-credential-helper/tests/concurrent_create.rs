#![cfg(any(target_os = "windows", target_os = "macos"))]

use serde_json::json;
use std::io::Write;
use std::process::{Child, Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use whalehall_credential_helper::KEY_BYTES;

const CONCURRENCY: usize = 24;
const HELPER_BINARY: &str = env!("CARGO_BIN_EXE_whalehall-credential-helper");

#[test]
fn concurrent_helper_processes_return_one_stable_account_key() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time after epoch")
        .as_nanos();
    let installation_id = format!("race-{}-{nonce}", std::process::id());
    let account_id = format!("account-{}-{nonce}", std::process::id());
    let create = request_frame("create", &installation_id, &account_id);

    // Start every process before closing any stdin. read_request waits for
    // EOF, which gives the helpers a real cross-process race at the same key.
    let mut children = (0..CONCURRENCY).map(|_| spawn_helper()).collect::<Vec<_>>();
    for child in &mut children {
        let mut stdin = child.stdin.take().expect("helper stdin");
        stdin.write_all(&create).expect("write helper request");
    }
    let outputs = children
        .into_iter()
        .map(|child| child.wait_with_output().expect("wait for helper"))
        .collect::<Vec<_>>();

    // Always remove the test credential before asserting on child output.
    let delete = run_request(&request_frame("delete", &installation_id, &account_id));
    assert!(
        delete.status.success(),
        "credential cleanup failed: {}",
        String::from_utf8_lossy(&delete.stderr)
    );

    let keys = outputs.iter().map(parse_key_response).collect::<Vec<_>>();
    let first = keys.first().expect("at least one key");
    assert_eq!(first.len(), KEY_BYTES);
    assert!(keys.iter().all(|key| key == first));
}

fn spawn_helper() -> Child {
    Command::new(HELPER_BINARY)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn credential helper")
}

fn run_request(frame: &[u8]) -> Output {
    let mut child = spawn_helper();
    child
        .stdin
        .take()
        .expect("helper stdin")
        .write_all(frame)
        .expect("write helper request");
    child.wait_with_output().expect("wait for helper")
}

fn request_frame(operation: &str, installation_id: &str, account_id: &str) -> Vec<u8> {
    let mut frame = serde_json::to_vec(&json!({
        "version": 1,
        "kind": "account-key",
        "operation": operation,
        "installationId": installation_id,
        "accountId": account_id,
        "keyVersion": 1,
    }))
    .expect("serialize request");
    frame.push(b'\n');
    frame
}

fn parse_key_response(output: &Output) -> Vec<u8> {
    assert!(
        output.status.success(),
        "helper exited with {:?}; stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty(), "helper wrote to stderr");
    let newline = output
        .stdout
        .iter()
        .position(|byte| *byte == b'\n')
        .expect("response header newline");
    assert_eq!(
        &output.stdout[..=newline],
        format!("OK KEY {KEY_BYTES}\n").as_bytes()
    );
    output.stdout[(newline + 1)..].to_vec()
}
