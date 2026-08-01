use serde::Deserialize;
use std::io::{self, Read, Write};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::{fs::OpenOptions, path::PathBuf};
use zeroize::Zeroizing;

pub const PROTOCOL_VERSION: u8 = 1;
pub const KEY_BYTES: usize = 32;
pub const MAX_REQUEST_HEADER_BYTES: usize = 4_096;
pub const MAX_SECRET_BYTES: usize = 2_048;
pub const SERVICE_NAMESPACE: &str = "com.seago.whalehall.auth";
pub const AUTH_REFRESH_TOKEN_NAME: &str = "auth.refresh-token.current";
const ALLOWED_SECRET_NAMES: &[&str] = &[AUTH_REFRESH_TOKEN_NAME];

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CredentialKind {
    AccountKey,
    NamedSecret,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CredentialOperation {
    Get,
    Create,
    Read,
    Write,
    Delete,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialRequest {
    pub version: u8,
    pub kind: CredentialKind,
    pub operation: CredentialOperation,
    pub installation_id: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub key_version: Option<u32>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub secret_bytes: Option<usize>,
}

#[derive(Debug)]
pub struct ParsedRequest {
    pub request: CredentialRequest,
    pub secret: Zeroizing<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CredentialTarget {
    AccountKey {
        installation_id: String,
        account_id: String,
        key_version: u32,
    },
    NamedSecret {
        installation_id: String,
        name: String,
    },
}

impl CredentialTarget {
    pub fn windows_target_name(&self) -> String {
        match self {
            Self::AccountKey {
                installation_id,
                account_id,
                key_version,
            } => format!("com.seago.whalehall/auth/{installation_id}/{account_id}/v{key_version}"),
            Self::NamedSecret {
                installation_id,
                name,
            } => format!("com.seago.whalehall/secret/{installation_id}/{name}"),
        }
    }

    pub fn macos_account_name(&self) -> String {
        match self {
            Self::AccountKey {
                installation_id,
                account_id,
                key_version,
            } => format!("key:{installation_id}:{account_id}:v{key_version}"),
            Self::NamedSecret {
                installation_id,
                name,
            } => format!("secret:{installation_id}:{name}"),
        }
    }

    fn user_label(&self) -> &str {
        match self {
            Self::AccountKey { account_id, .. } => account_id,
            Self::NamedSecret { name, .. } => name,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendError {
    NotFound,
    AlreadyExists,
    StoreUnavailable,
    StoreFailure,
    CorruptSecret,
    RandomFailure,
    UnsupportedPlatform,
}

impl BackendError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::AlreadyExists => "ALREADY_EXISTS",
            Self::StoreUnavailable => "STORE_UNAVAILABLE",
            Self::StoreFailure => "STORE_FAILURE",
            Self::CorruptSecret => "CORRUPT_SECRET",
            Self::RandomFailure => "RANDOM_FAILURE",
            Self::UnsupportedPlatform => "UNSUPPORTED_PLATFORM",
        }
    }
}

#[derive(Debug)]
pub enum HelperResponse {
    Key(Zeroizing<Vec<u8>>),
    Secret(Zeroizing<Vec<u8>>),
    Stored,
    Deleted(bool),
    Error(&'static str),
}

pub trait CredentialBackend {
    fn read(&self, target: &CredentialTarget) -> Result<Zeroizing<Vec<u8>>, BackendError>;
    fn write(&self, target: &CredentialTarget, secret: &[u8]) -> Result<(), BackendError>;
    fn delete(&self, target: &CredentialTarget) -> Result<bool, BackendError>;

    fn create_account_key(
        &self,
        target: &CredentialTarget,
    ) -> Result<Zeroizing<Vec<u8>>, BackendError>
    where
        Self: Sized,
    {
        load_or_create_account_key(self, target)
    }
}

pub struct PlatformCredentialBackend;

pub fn read_request(mut reader: impl Read) -> Result<ParsedRequest, &'static str> {
    let maximum = MAX_REQUEST_HEADER_BYTES + 1 + MAX_SECRET_BYTES;
    let mut bytes = Zeroizing::new(Vec::new());
    reader
        .by_ref()
        .take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "READ_FAILED")?;
    if bytes.len() > maximum {
        return Err("REQUEST_TOO_LARGE");
    }
    let Some(header_end) = bytes.iter().position(|byte| *byte == b'\n') else {
        return Err("INVALID_REQUEST");
    };
    if header_end == 0 || header_end > MAX_REQUEST_HEADER_BYTES {
        return Err("INVALID_REQUEST");
    }
    let request: CredentialRequest =
        serde_json::from_slice(&bytes[..header_end]).map_err(|_| "INVALID_REQUEST")?;
    let secret = Zeroizing::new(bytes[(header_end + 1)..].to_vec());
    let expected = request.secret_bytes.unwrap_or(0);
    if expected != secret.len() || expected > MAX_SECRET_BYTES {
        return Err("INVALID_REQUEST");
    }
    Ok(ParsedRequest { request, secret })
}

pub fn handle_request(backend: &impl CredentialBackend, parsed: ParsedRequest) -> HelperResponse {
    let target = match validate_request(&parsed) {
        Ok(target) => target,
        Err(code) => return HelperResponse::Error(code),
    };
    let result = match (parsed.request.kind, parsed.request.operation) {
        (CredentialKind::AccountKey, CredentialOperation::Get) => backend
            .read(&target)
            .and_then(validate_key)
            .map(HelperResponse::Key),
        (CredentialKind::AccountKey, CredentialOperation::Create) => backend
            .create_account_key(&target)
            .and_then(validate_key)
            .map(HelperResponse::Key),
        (CredentialKind::NamedSecret, CredentialOperation::Read) => backend
            .read(&target)
            .and_then(validate_named_secret)
            .map(HelperResponse::Secret),
        (CredentialKind::NamedSecret, CredentialOperation::Write) => backend
            .write(&target, &parsed.secret)
            .map(|()| HelperResponse::Stored),
        (_, CredentialOperation::Delete) => backend.delete(&target).map(HelperResponse::Deleted),
        _ => return HelperResponse::Error("INVALID_REQUEST"),
    };
    result.unwrap_or_else(|error| HelperResponse::Error(error.code()))
}

pub fn write_response(mut writer: impl Write, response: &HelperResponse) -> io::Result<()> {
    match response {
        HelperResponse::Key(key) => write_payload(&mut writer, "KEY", key)?,
        HelperResponse::Secret(secret) => write_payload(&mut writer, "SECRET", secret)?,
        HelperResponse::Stored => writer.write_all(b"OK STORED\n")?,
        HelperResponse::Deleted(deleted) => writer.write_all(if *deleted {
            b"OK DELETED 1\n"
        } else {
            b"OK DELETED 0\n"
        })?,
        HelperResponse::Error(code) => {
            writer.write_all(b"ERR ")?;
            writer.write_all(code.as_bytes())?;
            writer.write_all(b"\n")?;
        }
    }
    writer.flush()
}

fn write_payload(writer: &mut impl Write, kind: &str, payload: &[u8]) -> io::Result<()> {
    writer.write_all(format!("OK {kind} {}\n", payload.len()).as_bytes())?;
    writer.write_all(payload)
}

fn validate_request(parsed: &ParsedRequest) -> Result<CredentialTarget, &'static str> {
    let request = &parsed.request;
    if request.version != PROTOCOL_VERSION {
        return Err("UNSUPPORTED_VERSION");
    }
    if !valid_component(&request.installation_id) {
        return Err("INVALID_REQUEST");
    }
    match request.kind {
        CredentialKind::AccountKey => {
            if !matches!(
                request.operation,
                CredentialOperation::Get
                    | CredentialOperation::Create
                    | CredentialOperation::Delete
            ) || request.name.is_some()
                || request.secret_bytes.is_some()
                || !parsed.secret.is_empty()
            {
                return Err("INVALID_REQUEST");
            }
            let account_id = request.account_id.as_deref().ok_or("INVALID_REQUEST")?;
            let key_version = request.key_version.ok_or("INVALID_REQUEST")?;
            if !valid_component(account_id) || key_version == 0 || key_version > 1_000_000 {
                return Err("INVALID_REQUEST");
            }
            Ok(CredentialTarget::AccountKey {
                installation_id: request.installation_id.clone(),
                account_id: account_id.to_owned(),
                key_version,
            })
        }
        CredentialKind::NamedSecret => {
            if request.account_id.is_some() || request.key_version.is_some() {
                return Err("INVALID_REQUEST");
            }
            let name = request.name.as_deref().ok_or("INVALID_REQUEST")?;
            if !ALLOWED_SECRET_NAMES.contains(&name) {
                return Err("SECRET_NAME_NOT_ALLOWED");
            }
            match request.operation {
                CredentialOperation::Read | CredentialOperation::Delete
                    if request.secret_bytes.is_none() && parsed.secret.is_empty() => {}
                CredentialOperation::Write
                    if request.secret_bytes == Some(parsed.secret.len())
                        && !parsed.secret.is_empty()
                        && parsed.secret.len() <= MAX_SECRET_BYTES => {}
                _ => return Err("INVALID_REQUEST"),
            }
            Ok(CredentialTarget::NamedSecret {
                installation_id: request.installation_id.clone(),
                name: name.to_owned(),
            })
        }
    }
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn validate_key(secret: Zeroizing<Vec<u8>>) -> Result<Zeroizing<Vec<u8>>, BackendError> {
    if secret.len() == KEY_BYTES {
        Ok(secret)
    } else {
        Err(BackendError::CorruptSecret)
    }
}

fn validate_named_secret(secret: Zeroizing<Vec<u8>>) -> Result<Zeroizing<Vec<u8>>, BackendError> {
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
        Err(BackendError::CorruptSecret)
    } else {
        Ok(secret)
    }
}

fn load_or_create_account_key(
    backend: &impl CredentialBackend,
    target: &CredentialTarget,
) -> Result<Zeroizing<Vec<u8>>, BackendError> {
    match backend.read(target) {
        Ok(key) => validate_key(key),
        Err(BackendError::NotFound) => {
            let mut key = Zeroizing::new(vec![0_u8; KEY_BYTES]);
            getrandom::fill(&mut key).map_err(|_| BackendError::RandomFailure)?;
            backend.write(target, &key)?;
            Ok(key)
        }
        Err(error) => Err(error),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn acquire_account_key_creation_lock() -> Result<std::fs::File, BackendError> {
    let path = account_key_creation_lock_path();
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|_| BackendError::StoreUnavailable)?;
    file.lock().map_err(|_| BackendError::StoreUnavailable)?;
    Ok(file)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn account_key_creation_lock_path() -> PathBuf {
    std::env::temp_dir().join("com.seago.whalehall.account-key-create-v1.lock")
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn map_keyring_error(error: keyring_core::Error) -> BackendError {
    use keyring_core::Error;
    match error {
        Error::NoEntry => BackendError::NotFound,
        Error::NoStorageAccess(_) => BackendError::StoreUnavailable,
        Error::BadEncoding(_) | Error::BadDataFormat(_, _) | Error::BadStoreFormat(_) => {
            BackendError::CorruptSecret
        }
        Error::NotSupportedByStore(_) => BackendError::UnsupportedPlatform,
        Error::PlatformFailure(_)
        | Error::TooLong(_, _)
        | Error::Invalid(_, _)
        | Error::Ambiguous(_)
        | Error::NoDefaultStore => BackendError::StoreFailure,
        _ => BackendError::StoreFailure,
    }
}

#[cfg(target_os = "windows")]
fn platform_entry(target: &CredentialTarget) -> Result<keyring_core::Entry, BackendError> {
    use std::collections::HashMap;

    keyring_core::set_default_store(
        windows_native_keyring_store::Store::new().map_err(map_keyring_error)?,
    );
    let target_name = target.windows_target_name();
    let modifiers = HashMap::from([("target", target_name.as_str()), ("persistence", "Local")]);
    keyring_core::Entry::new_with_modifiers(SERVICE_NAMESPACE, target.user_label(), &modifiers)
        .map_err(map_keyring_error)
}

#[cfg(target_os = "macos")]
fn platform_entry(target: &CredentialTarget) -> Result<keyring_core::Entry, BackendError> {
    keyring_core::set_default_store(
        apple_native_keyring_store::keychain::Store::new().map_err(map_keyring_error)?,
    );
    keyring_core::Entry::new(SERVICE_NAMESPACE, &target.macos_account_name())
        .map_err(map_keyring_error)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl CredentialBackend for PlatformCredentialBackend {
    fn read(&self, target: &CredentialTarget) -> Result<Zeroizing<Vec<u8>>, BackendError> {
        platform_entry(target)?
            .get_secret()
            .map(Zeroizing::new)
            .map_err(map_keyring_error)
    }

    fn write(&self, target: &CredentialTarget, secret: &[u8]) -> Result<(), BackendError> {
        platform_entry(target)?
            .set_secret(secret)
            .map_err(map_keyring_error)
    }

    fn delete(&self, target: &CredentialTarget) -> Result<bool, BackendError> {
        match platform_entry(target)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring_core::Error::NoEntry) => Ok(false),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn create_account_key(
        &self,
        target: &CredentialTarget,
    ) -> Result<Zeroizing<Vec<u8>>, BackendError> {
        // The helper is one-shot, so an in-process mutex cannot close the
        // read-then-write race. Keep the lock file in the per-user OS temp
        // directory and never unlink it: replacing the inode would let two
        // processes believe they hold the same logical lock.
        let _creation_lock = acquire_account_key_creation_lock()?;
        load_or_create_account_key(self, target)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl CredentialBackend for PlatformCredentialBackend {
    fn read(&self, _target: &CredentialTarget) -> Result<Zeroizing<Vec<u8>>, BackendError> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn write(&self, _target: &CredentialTarget, _secret: &[u8]) -> Result<(), BackendError> {
        Err(BackendError::UnsupportedPlatform)
    }

    fn delete(&self, _target: &CredentialTarget) -> Result<bool, BackendError> {
        Err(BackendError::UnsupportedPlatform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryBackend {
        secrets: RefCell<HashMap<String, Vec<u8>>>,
    }

    impl CredentialBackend for MemoryBackend {
        fn read(&self, target: &CredentialTarget) -> Result<Zeroizing<Vec<u8>>, BackendError> {
            self.secrets
                .borrow()
                .get(&target.windows_target_name())
                .cloned()
                .map(Zeroizing::new)
                .ok_or(BackendError::NotFound)
        }

        fn write(&self, target: &CredentialTarget, secret: &[u8]) -> Result<(), BackendError> {
            self.secrets
                .borrow_mut()
                .insert(target.windows_target_name(), secret.to_vec());
            Ok(())
        }

        fn delete(&self, target: &CredentialTarget) -> Result<bool, BackendError> {
            Ok(self
                .secrets
                .borrow_mut()
                .remove(&target.windows_target_name())
                .is_some())
        }
    }

    fn key_request(operation: CredentialOperation) -> ParsedRequest {
        ParsedRequest {
            request: CredentialRequest {
                version: PROTOCOL_VERSION,
                kind: CredentialKind::AccountKey,
                operation,
                installation_id: "install-1".to_owned(),
                account_id: Some("account-1".to_owned()),
                key_version: Some(1),
                name: None,
                secret_bytes: None,
            },
            secret: Zeroizing::new(Vec::new()),
        }
    }

    fn named_request(operation: CredentialOperation, secret: &[u8]) -> ParsedRequest {
        ParsedRequest {
            request: CredentialRequest {
                version: PROTOCOL_VERSION,
                kind: CredentialKind::NamedSecret,
                operation,
                installation_id: "install-1".to_owned(),
                account_id: None,
                key_version: None,
                name: Some(AUTH_REFRESH_TOKEN_NAME.to_owned()),
                secret_bytes: (operation == CredentialOperation::Write).then_some(secret.len()),
            },
            secret: Zeroizing::new(secret.to_vec()),
        }
    }

    #[test]
    fn performs_account_key_lifecycle_without_overwriting() {
        let backend = MemoryBackend::default();
        let first = match handle_request(&backend, key_request(CredentialOperation::Create)) {
            HelperResponse::Key(key) => key,
            response => panic!("expected key, got {response:?}"),
        };
        let second = match handle_request(&backend, key_request(CredentialOperation::Create)) {
            HelperResponse::Key(key) => key,
            response => panic!("expected idempotent key, got {response:?}"),
        };
        assert_eq!(first.len(), KEY_BYTES);
        assert_eq!(first.as_slice(), second.as_slice());
        assert!(matches!(
            handle_request(&backend, key_request(CredentialOperation::Get)),
            HelperResponse::Key(key) if key.as_slice() == first.as_slice()
        ));
        assert!(matches!(
            handle_request(&backend, key_request(CredentialOperation::Delete)),
            HelperResponse::Deleted(true)
        ));
        assert!(matches!(
            handle_request(&backend, key_request(CredentialOperation::Delete)),
            HelperResponse::Deleted(false)
        ));
    }

    #[test]
    fn stores_only_allowlisted_named_secrets() {
        let backend = MemoryBackend::default();
        let token = b"refresh-token-secret";
        assert!(matches!(
            handle_request(&backend, named_request(CredentialOperation::Write, token)),
            HelperResponse::Stored
        ));
        assert!(matches!(
            handle_request(
                &backend,
                named_request(CredentialOperation::Read, &[])
            ),
            HelperResponse::Secret(secret) if secret.as_slice() == token
        ));

        let mut denied = named_request(CredentialOperation::Read, &[]);
        denied.request.name = Some("other.secret".to_owned());
        assert!(matches!(
            handle_request(&backend, denied),
            HelperResponse::Error("SECRET_NAME_NOT_ALLOWED")
        ));
    }

    #[test]
    fn parses_a_binary_secret_frame_and_rejects_size_mismatch() {
        let token = b"refresh-token-secret";
        let header = format!(
            "{{\"version\":1,\"kind\":\"named-secret\",\"operation\":\"write\",\"installationId\":\"install-1\",\"name\":\"{}\",\"secretBytes\":{}}}\n",
            AUTH_REFRESH_TOKEN_NAME,
            token.len()
        );
        let mut frame = header.into_bytes();
        frame.extend_from_slice(token);
        let parsed = read_request(frame.as_slice()).expect("parse request");
        assert_eq!(parsed.secret.as_slice(), token);

        frame.pop();
        assert!(matches!(
            read_request(frame.as_slice()),
            Err("INVALID_REQUEST")
        ));
    }

    #[test]
    fn rejects_oversized_unknown_and_unsafe_requests() {
        let oversized = vec![b'x'; MAX_REQUEST_HEADER_BYTES + MAX_SECRET_BYTES + 2];
        assert!(matches!(
            read_request(oversized.as_slice()),
            Err("REQUEST_TOO_LARGE")
        ));
        let unknown = b"{\"version\":1,\"kind\":\"account-key\",\"operation\":\"get\",\"installationId\":\"install-1\",\"accountId\":\"account-1\",\"keyVersion\":1,\"extra\":true}\n";
        assert!(matches!(
            read_request(unknown.as_slice()),
            Err("INVALID_REQUEST")
        ));

        let backend = MemoryBackend::default();
        let mut unsafe_request = key_request(CredentialOperation::Get);
        unsafe_request.request.account_id = Some("../account".to_owned());
        assert!(matches!(
            handle_request(&backend, unsafe_request),
            HelperResponse::Error("INVALID_REQUEST")
        ));
    }

    #[test]
    fn emits_fixed_headers_and_raw_payloads() {
        let response = HelperResponse::Secret(Zeroizing::new(b"secret".to_vec()));
        let mut output = Vec::new();
        write_response(&mut output, &response).expect("write response");
        assert_eq!(&output[..12], b"OK SECRET 6\n");
        assert_eq!(&output[12..], b"secret");
        assert!(!String::from_utf8_lossy(&output[..12]).contains(SERVICE_NAMESPACE));
    }

    #[test]
    fn builds_names_only_inside_the_whalehall_namespace() {
        let key = CredentialTarget::AccountKey {
            installation_id: "install-1".to_owned(),
            account_id: "account-1".to_owned(),
            key_version: 4,
        };
        assert_eq!(
            key.windows_target_name(),
            "com.seago.whalehall/auth/install-1/account-1/v4"
        );
        assert_eq!(key.macos_account_name(), "key:install-1:account-1:v4");

        let secret = CredentialTarget::NamedSecret {
            installation_id: "install-1".to_owned(),
            name: AUTH_REFRESH_TOKEN_NAME.to_owned(),
        };
        assert_eq!(
            secret.windows_target_name(),
            "com.seago.whalehall/secret/install-1/auth.refresh-token.current"
        );
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn linux_is_explicitly_unsupported() {
        assert_eq!(
            PlatformCredentialBackend.read(&CredentialTarget::NamedSecret {
                installation_id: "install-1".to_owned(),
                name: AUTH_REFRESH_TOKEN_NAME.to_owned(),
            }),
            Err(BackendError::UnsupportedPlatform)
        );
    }
}
