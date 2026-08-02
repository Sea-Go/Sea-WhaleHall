use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use directories::ProjectDirs;
use zeroize::Zeroizing;

use crate::observations::{
    KEY_VERSION, LEGACY_DEV_KEY_VERSION, ObservationKey, ObservationKeyError,
    ObservationKeyProvider, ObservationKeyStorageMode,
};

const BROKER_BUNDLE_NAME: &str = "whalehall-vault-broker-v2";
const BROKER_INSTALL_NAME: &str = "whalehall-vault-broker-v2";
const BROKER_IDENTIFIER: &str = "com.seago.whalehall.vault-broker.v2";
const BROKER_VERSION_DIR: &str = "v2";
const BROKER_FD: i32 = 3;
const BROKER_TIMEOUT: Duration = Duration::from_secs(5);
const BROKER_IMPORT_TIMEOUT: Duration = Duration::from_secs(120);

const REQUEST_MAGIC: &[u8; 8] = b"WHVBREQ2";
const RESPONSE_MAGIC: &[u8; 8] = b"WHVBRSP2";
const PROTOCOL_VERSION: u8 = 2;
const OP_LOAD: u8 = 1;
const OP_IMPORT: u8 = 2;

const STATUS_AVAILABLE: u8 = 0;
const STATUS_MIGRATION_REQUIRED: u8 = 1;
const STATUS_UNAVAILABLE: u8 = 2;
const STATUS_CONFLICT: u8 = 3;
const STATUS_INVALID: u8 = 4;
const FLAG_MIGRATED: u8 = 1 << 0;
const KEY_VERSION_CURRENT: u8 = 1;
const KEY_VERSION_LEGACY: u8 = 2;

#[derive(Clone)]
pub(crate) struct VaultBrokerObservationKeyProvider {
    broker_path: PathBuf,
    expected_leaf: String,
}

impl VaultBrokerObservationKeyProvider {
    pub(crate) fn install_for_database(database_path: &Path) -> Result<Self, ObservationKeyError> {
        let data_dir = data_dir_for_database(database_path).ok_or_else(|| {
            report_initialization_failure(b"data_dir\0");
            ObservationKeyError::Storage
        })?;
        let executable = std::env::current_exe().map_err(|_| ObservationKeyError::Storage)?;
        let expected_leaf = current_executable_leaf(&executable).inspect_err(|_| {
            report_initialization_failure(b"core_identity\0");
        })?;
        let bundled = executable
            .parent()
            .ok_or(ObservationKeyError::Storage)?
            .join(BROKER_BUNDLE_NAME);
        verify_broker(&bundled, &expected_leaf).inspect_err(|_| {
            report_initialization_failure(b"bundled_broker\0");
        })?;

        let installed = broker_install_path(&data_dir);
        install_broker(&bundled, &installed, &expected_leaf).inspect_err(|_| {
            report_initialization_failure(b"installed_broker\0");
        })?;
        Ok(Self {
            broker_path: installed,
            expected_leaf,
        })
    }

    fn request(&self, operation: u8) -> Result<BrokerResponse, ObservationKeyError> {
        // Validate the immutable installed artifact immediately before execution.
        // A missing or modified broker fails closed and never falls back to direct
        // access to the login Keychain.
        verify_installed_broker(&self.broker_path, &self.expected_leaf)?;
        exchange_with_broker(&self.broker_path, operation)
    }
}

fn report_initialization_failure(code: &'static [u8]) {
    debug_assert_eq!(code.last(), Some(&0));
    // The app normally routes the native child's stderr into a background Bun
    // process whose stdio may be /dev/null. syslog keeps this content-free,
    // fixed diagnostic observable without persisting paths, URLs, titles, or
    // key material. `code` is always one of the NUL-terminated literals above.
    unsafe {
        libc::syslog(
            libc::LOG_ERR,
            c"WhaleHall Vault Broker initialization failed at %s".as_ptr(),
            code.as_ptr().cast::<libc::c_char>(),
        );
    }
}

impl ObservationKeyProvider for VaultBrokerObservationKeyProvider {
    fn load_or_create(&self) -> Result<ObservationKey, ObservationKeyError> {
        response_to_key(self.request(OP_LOAD)?, false).map(|(key, _)| key)
    }

    fn migrate_legacy_key_interactive(
        &self,
    ) -> Result<(ObservationKey, bool), ObservationKeyError> {
        response_to_key(self.request(OP_IMPORT)?, true)
    }
}

enum BrokerResponse {
    Available {
        key: Zeroizing<[u8; 32]>,
        version: &'static str,
        migrated: bool,
    },
    MigrationRequired,
    Unavailable,
    Conflict,
    Invalid,
}

fn response_to_key(
    response: BrokerResponse,
    import_operation: bool,
) -> Result<(ObservationKey, bool), ObservationKeyError> {
    match response {
        BrokerResponse::Available {
            key,
            version,
            migrated,
        } => Ok((
            ObservationKey::from_zeroizing_bytes(
                key,
                version,
                ObservationKeyStorageMode::LocalLoginKeychain,
            ),
            import_operation && migrated,
        )),
        BrokerResponse::MigrationRequired => Err(ObservationKeyError::MigrationRequired {
            interactive_available: true,
        }),
        BrokerResponse::Unavailable => Err(ObservationKeyError::Unavailable),
        BrokerResponse::Conflict => Err(ObservationKeyError::MigrationConflict),
        BrokerResponse::Invalid => Err(ObservationKeyError::Storage),
    }
}

fn exchange_with_broker(
    broker_path: &Path,
    operation: u8,
) -> Result<BrokerResponse, ObservationKeyError> {
    let response_timeout = if operation == OP_IMPORT {
        // IMPORT is reachable only through the explicit migration action and
        // may wait for one macOS SecurityAgent consent. It remains bounded,
        // while normal background LOAD stays fail-fast and never shows UI.
        BROKER_IMPORT_TIMEOUT
    } else {
        BROKER_TIMEOUT
    };
    let deadline = Instant::now() + response_timeout;
    let (mut parent_stream, child_stream) =
        std::os::unix::net::UnixStream::pair().map_err(|_| ObservationKeyError::Storage)?;
    parent_stream
        .set_read_timeout(Some(response_timeout))
        .map_err(|_| ObservationKeyError::Storage)?;
    parent_stream
        .set_write_timeout(Some(BROKER_TIMEOUT))
        .map_err(|_| ObservationKeyError::Storage)?;

    let child_fd = child_stream.as_raw_fd();
    let mut command = Command::new(broker_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: the closure only invokes async-signal-safe fd operations. `child_fd`
    // remains open until after spawn returns, and fd 3 is the protocol contract.
    unsafe {
        command.pre_exec(move || {
            if child_fd == BROKER_FD {
                let flags = libc::fcntl(BROKER_FD, libc::F_GETFD);
                if flags == -1
                    || libc::fcntl(BROKER_FD, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1
                {
                    return Err(io::Error::last_os_error());
                }
            } else if libc::dup2(child_fd, BROKER_FD) == -1 || libc::close(child_fd) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|_| ObservationKeyError::Storage)?;
    drop(child_stream);

    let result = (|| {
        let request = encode_request(operation)?;
        parent_stream
            .write_all(&request)
            .map_err(|_| ObservationKeyError::Storage)?;
        parent_stream
            .shutdown(std::net::Shutdown::Write)
            .map_err(|_| ObservationKeyError::Storage)?;
        read_response(&mut parent_stream, &request[16..32])
    })();
    drop(parent_stream);

    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() || wait_for_child(&mut child, remaining).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ObservationKeyError::Storage);
    }
    result
}

fn encode_request(operation: u8) -> Result<[u8; 32], ObservationKeyError> {
    if !matches!(operation, OP_LOAD | OP_IMPORT) {
        return Err(ObservationKeyError::Storage);
    }
    let mut request = [0_u8; 32];
    request[..8].copy_from_slice(REQUEST_MAGIC);
    request[8] = PROTOCOL_VERSION;
    request[9] = operation;
    // bytes 10..12 are reserved and remain zero. The payload length includes
    // the 16-byte nonce which immediately follows the fixed header.
    request[12..16].copy_from_slice(&16_u32.to_be_bytes());
    getrandom::fill(&mut request[16..32]).map_err(|_| ObservationKeyError::Storage)?;
    Ok(request)
}

fn read_response(
    stream: &mut std::os::unix::net::UnixStream,
    expected_nonce: &[u8],
) -> Result<BrokerResponse, ObservationKeyError> {
    let mut prefix = Zeroizing::new([0_u8; 32]);
    stream
        .read_exact(prefix.as_mut())
        .map_err(|_| ObservationKeyError::Storage)?;
    let payload_len = parse_response_header(prefix.as_ref(), expected_nonce)?;

    let mut key = Zeroizing::new([0_u8; 32]);
    if payload_len == 48 {
        stream
            .read_exact(key.as_mut())
            .map_err(|_| ObservationKeyError::Storage)?;
    }
    let mut extra = [0_u8; 1];
    match stream.read(&mut extra) {
        Ok(0) => {}
        Ok(_) | Err(_) => return Err(ObservationKeyError::Storage),
    }
    decode_response(prefix.as_ref(), payload_len, key)
}

fn parse_response_header(
    frame: &[u8],
    expected_nonce: &[u8],
) -> Result<usize, ObservationKeyError> {
    if frame.len() != 32
        || &frame[..8] != RESPONSE_MAGIC
        || frame[8] != PROTOCOL_VERSION
        || frame[9] > STATUS_INVALID
        || frame[10] & !FLAG_MIGRATED != 0
        || frame[16..32] != *expected_nonce
    {
        return Err(ObservationKeyError::Storage);
    }
    let payload_len = u32::from_be_bytes(
        frame[12..16]
            .try_into()
            .map_err(|_| ObservationKeyError::Storage)?,
    ) as usize;
    let available = frame[9] == STATUS_AVAILABLE;
    if available {
        if payload_len != 48 || !matches!(frame[11], KEY_VERSION_CURRENT | KEY_VERSION_LEGACY) {
            return Err(ObservationKeyError::Storage);
        }
    } else if payload_len != 16 || frame[11] != 0 || frame[10] != 0 {
        return Err(ObservationKeyError::Storage);
    }
    Ok(payload_len)
}

fn decode_response(
    prefix: &[u8],
    payload_len: usize,
    key: Zeroizing<[u8; 32]>,
) -> Result<BrokerResponse, ObservationKeyError> {
    Ok(match prefix[9] {
        STATUS_AVAILABLE if payload_len == 48 => BrokerResponse::Available {
            key,
            version: match prefix[11] {
                KEY_VERSION_CURRENT => KEY_VERSION,
                KEY_VERSION_LEGACY => LEGACY_DEV_KEY_VERSION,
                _ => return Err(ObservationKeyError::Storage),
            },
            migrated: prefix[10] & FLAG_MIGRATED != 0,
        },
        STATUS_MIGRATION_REQUIRED => BrokerResponse::MigrationRequired,
        STATUS_UNAVAILABLE => BrokerResponse::Unavailable,
        STATUS_CONFLICT => BrokerResponse::Conflict,
        STATUS_INVALID => BrokerResponse::Invalid,
        _ => return Err(ObservationKeyError::Storage),
    })
}

fn wait_for_child(child: &mut Child, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(io::Error::other("vault broker exited unsuccessfully"))
            };
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "vault broker did not exit",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn data_dir_for_database(database_path: &Path) -> Option<PathBuf> {
    // The Keychain service is shared by all local WhaleHall channels, so the
    // immutable broker that owns its ACL must be shared as well. A per-channel
    // install would let dev and canary create different v2 CDHashes for the
    // same service, after which one channel could no longer read the other's
    // item without another authorization. ProjectDirs resolves to the common
    // `com.seago.whalehall` application-support root on macOS.
    ProjectDirs::from("com", "seago", "whalehall")
        .map(|dirs| dirs.data_dir().to_owned())
        .or_else(|| {
            database_path
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .map(Path::to_path_buf)
        })
}

fn broker_install_path(data_dir: &Path) -> PathBuf {
    data_dir
        .join("monitoring")
        .join("vault-broker")
        .join(BROKER_VERSION_DIR)
        .join(BROKER_INSTALL_NAME)
}

fn install_broker(
    bundled: &Path,
    installed: &Path,
    expected_leaf: &str,
) -> Result<(), ObservationKeyError> {
    if installed.exists() {
        return verify_installed_broker(installed, expected_leaf);
    }
    let directory = installed.parent().ok_or(ObservationKeyError::Storage)?;
    let data_dir = directory
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or(ObservationKeyError::Storage)?;
    prepare_install_directory(data_dir, directory)?;

    let mut suffix = [0_u8; 8];
    getrandom::fill(&mut suffix).map_err(|_| ObservationKeyError::Storage)?;
    let temporary = directory.join(format!(
        ".whalehall-vault-broker.install.{}.{}",
        std::process::id(),
        hex_lower(&suffix)
    ));
    let result = (|| {
        let mut source = File::open(bundled).map_err(|_| ObservationKeyError::Storage)?;
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&temporary)
            .map_err(|_| ObservationKeyError::Storage)?;
        io::copy(&mut source, &mut target).map_err(|_| ObservationKeyError::Storage)?;
        target
            .sync_all()
            .map_err(|_| ObservationKeyError::Storage)?;
        // Drop all write bits before the immutable v2 artifact becomes visible.
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o500))
            .map_err(|_| ObservationKeyError::Storage)?;
        target
            .sync_all()
            .map_err(|_| ObservationKeyError::Storage)?;
        drop(target);
        verify_broker(&temporary, expected_leaf)?;
        atomic_rename_exclusive(&temporary, installed)?;
        sync_directory(directory)?;
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    if result.is_err() && installed.exists() {
        // Another process may have won the exclusive install race. Never
        // overwrite it; accept it only after the full signature check.
        return verify_installed_broker(installed, expected_leaf);
    }
    result?;
    verify_installed_broker(installed, expected_leaf)
}

fn prepare_install_directory(
    data_dir: &Path,
    version_dir: &Path,
) -> Result<(), ObservationKeyError> {
    ensure_directory_chain(data_dir)?;
    let monitoring_dir = data_dir.join("monitoring");
    let broker_dir = monitoring_dir.join("vault-broker");
    if version_dir != broker_dir.join(BROKER_VERSION_DIR) {
        return Err(ObservationKeyError::Storage);
    }
    for directory in [&monitoring_dir, &broker_dir, version_dir] {
        use std::os::unix::fs::MetadataExt;

        match fs::create_dir(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ObservationKeyError::Storage),
        }
        let metadata = fs::symlink_metadata(directory).map_err(|_| ObservationKeyError::Storage)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || !owner_is_trusted(metadata.uid())
            || metadata.mode() & 0o022 != 0
        {
            return Err(ObservationKeyError::Storage);
        }
        if metadata.mode() & 0o777 != 0o700 {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| ObservationKeyError::Storage)?;
        }
        let metadata = fs::symlink_metadata(directory).map_err(|_| ObservationKeyError::Storage)?;
        if !owner_is_trusted(metadata.uid()) || metadata.mode() & 0o777 != 0o700 {
            return Err(ObservationKeyError::Storage);
        }
    }
    Ok(())
}

fn ensure_directory_chain(path: &Path) -> Result<(), ObservationKeyError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink()
                    || !metadata.is_dir()
                    || !directory_metadata_is_trusted(&metadata)
                {
                    return Err(ObservationKeyError::Storage);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(ObservationKeyError::Storage),
                }
                let metadata =
                    fs::symlink_metadata(&current).map_err(|_| ObservationKeyError::Storage)?;
                if metadata.file_type().is_symlink()
                    || !metadata.is_dir()
                    || !directory_metadata_is_trusted(&metadata)
                {
                    return Err(ObservationKeyError::Storage);
                }
            }
            Err(_) => return Err(ObservationKeyError::Storage),
        }
    }
    Ok(())
}

fn directory_metadata_is_trusted(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    owner_is_trusted(metadata.uid()) && metadata.mode() & 0o022 == 0
}

fn owner_is_trusted(uid: u32) -> bool {
    uid == 0 || uid == unsafe { libc::geteuid() }
}

fn atomic_rename_exclusive(source: &Path, destination: &Path) -> Result<(), ObservationKeyError> {
    let source =
        CString::new(source.as_os_str().as_bytes()).map_err(|_| ObservationKeyError::Storage)?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| ObservationKeyError::Storage)?;
    // SAFETY: both C strings are NUL-terminated and valid for the duration of
    // the call. RENAME_EXCL guarantees an existing installed broker is never
    // replaced.
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(ObservationKeyError::Storage)
    }
}

fn sync_directory(directory: &Path) -> Result<(), ObservationKeyError> {
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| ObservationKeyError::Storage)
}

fn verify_broker(path: &Path, expected_leaf: &str) -> Result<(), ObservationKeyError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ObservationKeyError::Storage)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ObservationKeyError::Storage);
    }
    let verify = Command::new("/usr/bin/codesign")
        .arg("--verify")
        .arg("--strict")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| ObservationKeyError::Storage)?;
    if !verify.success() {
        return Err(ObservationKeyError::Storage);
    }
    let requirement =
        format!("identifier \"{BROKER_IDENTIFIER}\" and certificate leaf = H\"{expected_leaf}\"");
    if !code_satisfies_requirement(path, &requirement)? {
        return Err(ObservationKeyError::Storage);
    }
    Ok(())
}

fn verify_installed_broker(path: &Path, expected_leaf: &str) -> Result<(), ObservationKeyError> {
    validate_installed_file_metadata(path)?;
    verify_broker(path, expected_leaf)
}

fn validate_installed_file_metadata(path: &Path) -> Result<(), ObservationKeyError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::symlink_metadata(path).map_err(|_| ObservationKeyError::Storage)?;
    // The per-user executable is regular, owner-only, executable, immutable by
    // mode, and owned by the account running WhaleHall.
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o500
    {
        return Err(ObservationKeyError::Storage);
    }
    Ok(())
}

fn current_executable_leaf(executable: &Path) -> Result<String, ObservationKeyError> {
    let verify = Command::new("/usr/bin/codesign")
        .arg("--verify")
        .arg("--strict")
        .arg(executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| ObservationKeyError::Storage)?;
    if !verify.success() {
        report_initialization_failure(b"core_strict\0");
        return Err(ObservationKeyError::Storage);
    }
    let requirement = designated_requirement(executable).inspect_err(|_| {
        report_initialization_failure(b"core_designated_requirement\0");
    })?;
    let (_, leaf) = parse_designated_requirement(&requirement).inspect_err(|_| {
        report_initialization_failure(b"core_requirement_parse\0");
    })?;
    let leaf_requirement = format!("certificate leaf = H\"{leaf}\"");
    if !code_satisfies_requirement(executable, &leaf_requirement)? {
        report_initialization_failure(b"core_leaf_requirement\0");
        return Err(ObservationKeyError::Storage);
    }
    Ok(leaf)
}

fn code_satisfies_requirement(
    executable: &Path,
    requirement: &str,
) -> Result<bool, ObservationKeyError> {
    let status = Command::new("/usr/bin/codesign")
        .arg("--verify")
        .arg("--strict")
        .arg(format!("-R={requirement}"))
        .arg(executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| ObservationKeyError::Storage)?;
    Ok(status.success())
}

fn designated_requirement(path: &Path) -> Result<String, ObservationKeyError> {
    let output = Command::new("/usr/bin/codesign")
        .arg("-dr")
        .arg("-")
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .map_err(|_| ObservationKeyError::Storage)?;
    if !output.status.success() {
        return Err(ObservationKeyError::Storage);
    }
    decode_designated_requirement_output(&output.stdout, &output.stderr)
}

fn decode_designated_requirement_output(
    stdout: &[u8],
    stderr: &[u8],
) -> Result<String, ObservationKeyError> {
    // `codesign -dr -` has emitted the requirement on both stdout and stderr
    // across supported macOS/toolchain combinations. Decode both streams
    // strictly and let the requirement parser locate the authoritative line.
    let stdout = std::str::from_utf8(stdout).map_err(|_| ObservationKeyError::Storage)?;
    let stderr = std::str::from_utf8(stderr).map_err(|_| ObservationKeyError::Storage)?;
    Ok(format!("{stdout}\n{stderr}"))
}

fn parse_designated_requirement(details: &str) -> Result<(String, String), ObservationKeyError> {
    let requirement = details
        .lines()
        .find_map(|line| {
            line.split_once("designated =>")
                .map(|(_, value)| value.trim())
        })
        .ok_or(ObservationKeyError::Storage)?;
    let identifier_marker = "identifier \"";
    let leaf_marker = "certificate leaf = H\"";
    if requirement.matches(identifier_marker).count() != 1
        || requirement.matches(leaf_marker).count() != 1
    {
        return Err(ObservationKeyError::Storage);
    }
    let identifier = quoted_value_after(requirement, identifier_marker)?;
    let leaf = quoted_value_after(requirement, leaf_marker)?;
    if !leaf.bytes().all(|byte| byte.is_ascii_hexdigit()) || !matches!(leaf.len(), 40 | 64) {
        return Err(ObservationKeyError::Storage);
    }
    Ok((identifier.to_owned(), leaf.to_ascii_lowercase()))
}

fn quoted_value_after<'a>(text: &'a str, marker: &str) -> Result<&'a str, ObservationKeyError> {
    let value = text
        .split_once(marker)
        .map(|(_, value)| value)
        .ok_or(ObservationKeyError::Storage)?;
    let (value, _) = value.split_once('"').ok_or(ObservationKeyError::Storage)?;
    if value.is_empty() {
        return Err(ObservationKeyError::Storage);
    }
    Ok(value)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response_prefix(status: u8, flags: u8, version: u8, payload_len: u32) -> [u8; 32] {
        let mut response = [0_u8; 32];
        response[..8].copy_from_slice(RESPONSE_MAGIC);
        response[8] = PROTOCOL_VERSION;
        response[9] = status;
        response[10] = flags;
        response[11] = version;
        response[12..16].copy_from_slice(&payload_len.to_be_bytes());
        response[16..32].copy_from_slice(&[0x5a; 16]);
        response
    }

    #[test]
    fn protocol_header_accepts_only_exact_available_shape() {
        let valid = response_prefix(STATUS_AVAILABLE, 0, KEY_VERSION_CURRENT, 48);
        assert_eq!(parse_response_header(&valid, &[0x5a; 16]), Ok(48));

        let mut bad_nonce = valid;
        bad_nonce[31] ^= 1;
        assert_eq!(
            parse_response_header(&bad_nonce, &[0x5a; 16]),
            Err(ObservationKeyError::Storage)
        );
        assert_eq!(
            parse_response_header(&valid[..31], &[0x5a; 16]),
            Err(ObservationKeyError::Storage)
        );
        let mut bad_magic = valid;
        bad_magic[0] ^= 1;
        assert_eq!(
            parse_response_header(&bad_magic, &[0x5a; 16]),
            Err(ObservationKeyError::Storage)
        );
        let mut bad_version = valid;
        bad_version[8] = 1;
        assert_eq!(
            parse_response_header(&bad_version, &[0x5a; 16]),
            Err(ObservationKeyError::Storage)
        );
        for invalid in [
            response_prefix(STATUS_AVAILABLE, 2, KEY_VERSION_CURRENT, 48),
            response_prefix(STATUS_AVAILABLE, 0, 99, 48),
            response_prefix(STATUS_AVAILABLE, 0, KEY_VERSION_CURRENT, 47),
            response_prefix(STATUS_UNAVAILABLE, 0, 0, 48),
            response_prefix(STATUS_UNAVAILABLE, FLAG_MIGRATED, 0, 16),
            response_prefix(STATUS_UNAVAILABLE, 0, KEY_VERSION_CURRENT, 16),
        ] {
            assert_eq!(
                parse_response_header(&invalid, &[0x5a; 16]),
                Err(ObservationKeyError::Storage)
            );
        }
    }

    #[test]
    fn request_frame_is_exact_and_nonce_is_counted_as_payload() {
        let request = encode_request(OP_LOAD).expect("load request");
        assert_eq!(REQUEST_MAGIC, b"WHVBREQ2");
        assert_eq!(RESPONSE_MAGIC, b"WHVBRSP2");
        assert_eq!(PROTOCOL_VERSION, 2);
        assert_eq!(&request[..8], REQUEST_MAGIC);
        assert_eq!(request[8], PROTOCOL_VERSION);
        assert_eq!(request[9], OP_LOAD);
        assert_eq!(&request[10..12], &[0, 0]);
        assert_eq!(u32::from_be_bytes(request[12..16].try_into().unwrap()), 16);
        assert_eq!(encode_request(99), Err(ObservationKeyError::Storage));
    }

    #[test]
    fn response_status_mapping_is_fail_closed() {
        let key = Zeroizing::new([0x2a; 32]);
        let (available, migrated) = response_to_key(
            BrokerResponse::Available {
                key,
                version: LEGACY_DEV_KEY_VERSION,
                migrated: true,
            },
            true,
        )
        .expect("available response");
        assert_eq!(available.version(), LEGACY_DEV_KEY_VERSION);
        assert_eq!(
            available.storage_mode(),
            ObservationKeyStorageMode::LocalLoginKeychain
        );
        assert!(migrated);
        assert_eq!(
            response_to_key(BrokerResponse::MigrationRequired, false).err(),
            Some(ObservationKeyError::MigrationRequired {
                interactive_available: true
            })
        );
        assert_eq!(
            response_to_key(BrokerResponse::Unavailable, false).err(),
            Some(ObservationKeyError::Unavailable)
        );
        assert_eq!(
            response_to_key(BrokerResponse::Conflict, true).err(),
            Some(ObservationKeyError::MigrationConflict)
        );
        assert_eq!(
            response_to_key(BrokerResponse::Invalid, false).err(),
            Some(ObservationKeyError::Storage)
        );
    }

    #[test]
    fn install_path_is_versioned_under_supplied_data_dir() {
        assert_eq!(
            broker_install_path(Path::new("/tmp/whalehall-data")),
            Path::new("/tmp/whalehall-data/monitoring/vault-broker/v2/whalehall-vault-broker-v2")
        );
    }

    #[test]
    fn obsolete_v1_install_namespace_is_never_reused() {
        let data_dir = Path::new("/tmp/whalehall-data");
        let obsolete = data_dir.join("monitoring/vault-broker/v1/whalehall-vault-broker-v1");
        assert_ne!(broker_install_path(data_dir), obsolete);
        assert_eq!(
            prepare_install_directory(data_dir, &data_dir.join("monitoring/vault-broker/v1")),
            Err(ObservationKeyError::Storage)
        );
    }

    #[test]
    fn runtime_install_root_is_shared_across_channel_databases() {
        let expected = ProjectDirs::from("com", "seago", "whalehall")
            .expect("project directories")
            .data_dir()
            .to_owned();
        assert_eq!(
            data_dir_for_database(Path::new(
                "/tmp/com.seago.whalehall/canary/local/observation-journal.sqlite3"
            )),
            Some(expected.clone())
        );
        assert_eq!(
            data_dir_for_database(Path::new(
                "/tmp/com.seago.whalehall/dev/local/observation-journal.sqlite3"
            )),
            Some(expected)
        );
    }

    #[test]
    fn install_directory_rejects_symlinked_chain() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("tempdir");
        let data_dir = root.path().join("data");
        let elsewhere = root.path().join("elsewhere");
        fs::create_dir(&data_dir).expect("data dir");
        fs::create_dir(&elsewhere).expect("elsewhere");
        symlink(&elsewhere, data_dir.join("monitoring")).expect("monitoring symlink");
        assert_eq!(
            prepare_install_directory(&data_dir, &data_dir.join("monitoring/vault-broker/v2")),
            Err(ObservationKeyError::Storage)
        );
    }

    #[test]
    fn install_directory_rejects_group_or_world_writable_chain() {
        let root = tempfile::tempdir().expect("tempdir");
        let data_dir = root.path().join("data");
        fs::create_dir(&data_dir).expect("data dir");
        fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o777)).expect("unsafe mode");
        assert_eq!(
            prepare_install_directory(&data_dir, &data_dir.join("monitoring/vault-broker/v2")),
            Err(ObservationKeyError::Storage)
        );
    }

    #[test]
    fn installed_file_metadata_requires_owner_only_executable() {
        let root = tempfile::tempdir().expect("tempdir");
        let executable = root.path().join("broker");
        fs::write(&executable, b"not a real broker").expect("write test file");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o500)).expect("mode 500");
        assert_eq!(validate_installed_file_metadata(&executable), Ok(()));
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o520)).expect("mode 520");
        assert_eq!(
            validate_installed_file_metadata(&executable),
            Err(ObservationKeyError::Storage)
        );
    }

    #[test]
    fn requirement_parser_requires_identifier_and_leaf() {
        let details = "Executable=/tmp/core\ndesignated => identifier \"com.seago.whalehall.local\" and certificate leaf = H\"44B4ADA995AAD20E8D095D25887B079A0343FAF8\"\n";
        assert_eq!(
            parse_designated_requirement(details),
            Ok((
                "com.seago.whalehall.local".to_owned(),
                "44b4ada995aad20e8d095d25887b079a0343faf8".to_owned()
            ))
        );
        assert!(parse_designated_requirement("designated => identifier \"x\"").is_err());
    }

    #[test]
    fn designated_requirement_output_accepts_requirement_on_stdout() {
        let output = decode_designated_requirement_output(
            b"designated => identifier \"com.seago.whalehall.local\" and certificate leaf = H\"44B4ADA995AAD20E8D095D25887B079A0343FAF8\"\n",
            b"Executable=/tmp/core\n",
        )
        .expect("decode output");
        assert!(parse_designated_requirement(&output).is_ok());
    }

    #[test]
    fn designated_requirement_output_accepts_requirement_on_stderr() {
        let output = decode_designated_requirement_output(
            b"Executable=/tmp/core\n",
            b"designated => identifier \"com.seago.whalehall.local\" and certificate leaf = H\"44B4ADA995AAD20E8D095D25887B079A0343FAF8\"\n",
        )
        .expect("decode output");
        assert!(parse_designated_requirement(&output).is_ok());
    }

    #[test]
    fn designated_requirement_output_rejects_non_utf8() {
        assert_eq!(
            decode_designated_requirement_output(&[0xff], b""),
            Err(ObservationKeyError::Storage)
        );
        assert_eq!(
            decode_designated_requirement_output(b"", &[0xff]),
            Err(ObservationKeyError::Storage)
        );
    }
}
