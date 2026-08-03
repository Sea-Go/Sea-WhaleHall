#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::io;
use whalehall_credential_helper::{
    HelperResponse, PlatformCredentialBackend, handle_request, read_request, write_response,
};

fn main() {
    let response = match read_request(io::stdin().lock()) {
        Ok(request) => handle_request(&PlatformCredentialBackend, request),
        Err(code) => HelperResponse::Error(code),
    };
    let failed = matches!(response, HelperResponse::Error(_));
    if write_response(io::stdout().lock(), &response).is_err() || failed {
        std::process::exit(1);
    }
}
