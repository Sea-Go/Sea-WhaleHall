use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};
use whalehall_local_core::observations::{ObservationJournal, ObservationKeyStorageMode};
use whalehall_local_protocol::{
    CoverageLevelV2, MonitoringConfigureParams, MonitoringPermissionCheckState,
    MonitoringPermissionState, MonitoringPermissions, MonitoringState, MonitoringStatusResult,
    RAW_OBSERVATION_SCHEMA_VERSION, RawObservationInputV2,
};

const HELPER_PATH_ENV: &str = "WHALEHALL_OBSERVER_HELPER_PATH";
const RUNTIME_CHANNEL_ENV: &str = "WHALEHALL_RUNTIME_CHANNEL";
const HELPER_ENABLED_ENV: &str = "WHALEHALL_OBSERVER_MONITORING_ENABLED";
const HELPER_CAPTURE_CONTENT_ENV: &str = "WHALEHALL_OBSERVER_CAPTURE_CONTENT";
const HELPER_EXCLUDED_APPS_ENV: &str = "WHALEHALL_OBSERVER_EXCLUDED_BUNDLE_IDS";
const MONITORING_SETTINGS_DIRECTORY: &str = "monitoring";
const MONITORING_SETTINGS_FILE: &str = "settings.v1.json";
const MONITORING_SETTINGS_SCHEMA_VERSION: &str = "monitoring-settings.v1";
const MONITORING_PERMISSIONS_FILE: &str = "permissions.v2.json";
const MONITORING_PERMISSIONS_SCHEMA_VERSION: &str = "monitoring-permissions.v2";
const MAX_MONITORING_SETTINGS_BYTES: u64 = 128 * 1024;
const MONITORING_SETTINGS_LOAD_WARNING: &str = "observer_settings_load_failed";
const MONITORING_SETTINGS_PERSISTENCE_WARNING: &str = "observer_settings_persistence_failed";
const MONITORING_PERMISSIONS_LOAD_WARNING: &str = "observer_permissions_cache_load_failed";
const MONITORING_PERMISSIONS_PERSISTENCE_WARNING: &str =
    "observer_permissions_cache_persistence_failed";
const OBSERVER_BUNDLE_NAME: &str = "WhaleHall Observer.app";
const OBSERVER_EXECUTABLE_NAME: &str = "whalehall-observer";
const OBSERVER_BUNDLE_ID: &str = "com.seago.whalehall.observer";
const WHALEHALL_LOCAL_EXECUTABLE_NAME: &str = "whalehall-local";
const WHALEHALL_APP_BUNDLE_ID: &str = "com.seago.whalehall";
const DEV_LEGACY_KEYCHAIN_WARNING: &str = "dev_legacy_keychain_in_use";
const MAX_HELPER_FRAME_BYTES: usize = 512 * 1024;
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_TICK: Duration = Duration::from_secs(5);
const PERMISSION_REFRESH_TIMEOUT: Duration = Duration::from_secs(30);
const PERMISSION_REFRESH_COMMAND_ID: &str = "refresh-permissions";
const PERMISSION_SETUP_COMMAND_ID: &str = "setup-permissions";
const FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);
const FAILURE_LIMIT: usize = 5;
const RESTART_DELAYS: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(60),
];
static MONITORING_SETTINGS_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeChannel {
    Dev,
    Canary,
    Stable,
}

impl RuntimeChannel {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "dev" => Ok(Self::Dev),
            "canary" => Ok(Self::Canary),
            "stable" => Ok(Self::Stable),
            _ => Err(format!(
                "{RUNTIME_CHANNEL_ENV} must be one of dev, canary, or stable"
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedMonitoringSettings {
    schema_version: String,
    enabled: bool,
    capture_content: bool,
    paused: bool,
    excluded_bundle_ids: Vec<String>,
}

#[derive(Clone, Debug)]
struct MonitoringSettingsStore {
    directory_path: PathBuf,
    settings_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedMonitoringPermissions {
    schema_version: String,
    identity_fingerprint: String,
    setup_attempted: bool,
    permissions: MonitoringPermissions,
    checked_at_ms: Option<i64>,
}

#[derive(Clone, Debug)]
struct MonitoringPermissionsStore {
    directory_path: PathBuf,
    permissions_path: PathBuf,
    identity_fingerprint: Option<String>,
}

fn observer_permission_identity_fingerprint(helper_path: &Path) -> Result<String, String> {
    validate_helper_before_spawn(helper_path)?;
    let observer_bundle_path = helper_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "observer_permission_setup_identity_unavailable".to_owned())?;
    let local_executable = std::env::current_exe()
        .map_err(|_| "observer_permission_setup_identity_unavailable".to_owned())?;
    let app_bundle_path = containing_whalehall_app_bundle(&local_executable)?;

    verify_code_signature(&app_bundle_path)
        .map_err(|_| "observer_permission_setup_identity_unavailable".to_owned())?;
    verify_code_signature(observer_bundle_path)
        .map_err(|_| "observer_permission_setup_identity_unavailable".to_owned())?;

    let app_details = read_permission_identity_details(&app_bundle_path)?;
    let observer_details = read_permission_identity_details(observer_bundle_path)?;
    let app_bundle_identifier = read_bundle_identifier(&app_bundle_path)
        .map_err(|_| "observer_permission_setup_identity_unavailable".to_owned())?;
    let observer_bundle_identifier = read_bundle_identifier(observer_bundle_path)
        .map_err(|_| "observer_permission_setup_identity_unavailable".to_owned())?;
    let material = permission_identity_material(
        &app_bundle_identifier,
        &app_details,
        &observer_bundle_identifier,
        &observer_details,
    )?;
    Ok(format!("sha256:{:x}", Sha256::digest(material.as_bytes())))
}

fn read_permission_identity_details(path: &Path) -> Result<String, String> {
    let output = StdCommand::new("/usr/bin/codesign")
        .args(["--display", "--requirements", "-", "--verbose=4"])
        .arg(path)
        .output()
        .map_err(|_| "observer_permission_setup_identity_unavailable".to_owned())?;
    if !output.status.success() {
        return Err("observer_permission_setup_identity_unavailable".to_owned());
    }
    decode_codesign_identity_output(&output.stdout, &output.stderr)
}

fn containing_whalehall_app_bundle(executable: &Path) -> Result<PathBuf, String> {
    let unavailable = || "observer_permission_setup_identity_unavailable".to_owned();
    if !executable.is_absolute()
        || executable.file_name().and_then(|value| value.to_str())
            != Some(WHALEHALL_LOCAL_EXECUTABLE_NAME)
    {
        return Err(unavailable());
    }
    let metadata = fs::symlink_metadata(executable).map_err(|_| unavailable())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(unavailable());
    }
    let canonical_executable = fs::canonicalize(executable).map_err(|_| unavailable())?;
    if canonical_executable != executable {
        return Err(unavailable());
    }
    let app_bundles = canonical_executable
        .ancestors()
        .filter(|ancestor| {
            ancestor
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.ends_with(".app"))
        })
        .collect::<Vec<_>>();
    if app_bundles.len() != 1 {
        return Err(unavailable());
    }
    let app_bundle = app_bundles[0];
    let relative_executable = canonical_executable
        .strip_prefix(app_bundle)
        .map_err(|_| unavailable())?;
    if !relative_executable.starts_with("Contents") {
        return Err(unavailable());
    }
    let info_plist = app_bundle.join("Contents").join("Info.plist");
    let info_metadata = fs::symlink_metadata(info_plist).map_err(|_| unavailable())?;
    if !info_metadata.is_file() || info_metadata.file_type().is_symlink() {
        return Err(unavailable());
    }
    Ok(app_bundle.to_path_buf())
}

fn permission_identity_material(
    app_bundle_identifier: &str,
    app_details: &str,
    observer_bundle_identifier: &str,
    observer_details: &str,
) -> Result<String, String> {
    if app_bundle_identifier != WHALEHALL_APP_BUNDLE_ID
        || observer_bundle_identifier != OBSERVER_BUNDLE_ID
    {
        return Err("observer_permission_setup_identity_unavailable".to_owned());
    }
    let (app_identity_marker, app_designated_requirement) =
        parse_exact_permission_identity_details(app_details, WHALEHALL_APP_BUNDLE_ID)?;
    let (observer_identity_marker, observer_designated_requirement) =
        parse_exact_permission_identity_details(observer_details, OBSERVER_BUNDLE_ID)?;
    if app_identity_marker != observer_identity_marker {
        return Err("observer_permission_setup_identity_unavailable".to_owned());
    }
    Ok(format!(
        "whalehall-permission-identity.v2\0{app_bundle_identifier}\0{app_designated_requirement}\0{observer_bundle_identifier}\0{observer_designated_requirement}\0{app_identity_marker}"
    ))
}

fn parse_exact_permission_identity_details(
    details: &str,
    expected_bundle_identifier: &str,
) -> Result<(String, String), String> {
    let (identity_marker, designated_requirement) = parse_permission_identity_details(details)?;
    let identifiers = details
        .lines()
        .filter_map(|line| line.strip_prefix("Identifier="))
        .collect::<Vec<_>>();
    if identifiers != [expected_bundle_identifier]
        || designated_requirement_identifier(&designated_requirement)
            != Some(expected_bundle_identifier)
    {
        return Err("observer_permission_setup_identity_unavailable".to_owned());
    }
    Ok((identity_marker, designated_requirement))
}

fn designated_requirement_identifier(requirement: &str) -> Option<&str> {
    let tail = requirement.strip_prefix("identifier \"")?;
    let end = tail.find('"')?;
    let identifier = &tail[..end];
    let suffix = &tail[end + 1..];
    if identifier.is_empty() || (!suffix.is_empty() && !suffix.starts_with(" and ")) {
        return None;
    }
    Some(identifier)
}

fn decode_codesign_identity_output(stdout: &[u8], stderr: &[u8]) -> Result<String, String> {
    let stdout = std::str::from_utf8(stdout)
        .map_err(|_| "observer_permission_setup_identity_unavailable".to_owned())?;
    let stderr = std::str::from_utf8(stderr)
        .map_err(|_| "observer_permission_setup_identity_unavailable".to_owned())?;
    Ok(format!("{stdout}\n{stderr}"))
}

fn parse_permission_identity_details(details: &str) -> Result<(String, String), String> {
    let requirements = details.lines().filter_map(|line| {
        line.trim()
            .strip_prefix("# designated => ")
            .or_else(|| line.trim().strip_prefix("designated => "))
    });
    let requirements = requirements.collect::<Vec<_>>();
    if requirements.len() != 1 || requirements[0].is_empty() || requirements[0].len() > 8_192 {
        return Err("observer_permission_setup_identity_unavailable".to_owned());
    }
    let designated_requirement = requirements[0];
    if designated_requirement
        .to_ascii_lowercase()
        .contains("cdhash")
    {
        return Err("observer_permission_setup_identity_unavailable".to_owned());
    }

    let teams = details
        .lines()
        .filter_map(|line| line.strip_prefix("TeamIdentifier="))
        .collect::<Vec<_>>();
    if teams.len() != 1 {
        return Err("observer_permission_setup_identity_unavailable".to_owned());
    }
    let identity_marker = if teams[0] == "not set" {
        let authorities = details
            .lines()
            .filter_map(|line| line.strip_prefix("Authority="))
            .collect::<Vec<_>>();
        if authorities != ["WhaleHall Local Development"] {
            return Err("observer_permission_setup_identity_unavailable".to_owned());
        }
        let leaf_hash = local_certificate_leaf_hash(designated_requirement)
            .ok_or_else(|| "observer_permission_setup_identity_unavailable".to_owned())?;
        format!("local-certificate:whalehall-local-development:{leaf_hash}")
    } else if teams[0].len() == 10
        && teams[0]
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        format!("developer-team:{}", teams[0])
    } else {
        return Err("observer_permission_setup_identity_unavailable".to_owned());
    };
    Ok((identity_marker, designated_requirement.to_owned()))
}

fn local_certificate_leaf_hash(requirement: &str) -> Option<String> {
    let marker = "certificate leaf = H\"";
    let start = requirement.find(marker)? + marker.len();
    let tail = &requirement[start..];
    let end = tail.find('"')?;
    let value = &tail[..end];
    if requirement[start + end + 1..].contains(marker)
        || value.len() != 40
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

fn valid_identity_fingerprint(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

impl MonitoringPermissionsStore {
    fn for_observation_journal(
        journal: &ObservationJournal,
        identity_fingerprint: Option<String>,
    ) -> Self {
        let data_directory = journal
            .database_path()
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        Self::new(data_directory, identity_fingerprint)
    }

    fn new(data_directory: &Path, identity_fingerprint: Option<String>) -> Self {
        let directory_path = data_directory.join(MONITORING_SETTINGS_DIRECTORY);
        let permissions_path = directory_path.join(MONITORING_PERMISSIONS_FILE);
        Self {
            directory_path,
            permissions_path,
            identity_fingerprint,
        }
    }

    fn setup_available(&self) -> bool {
        self.identity_fingerprint.is_some()
    }

    fn load(&self) -> Result<Option<PersistedMonitoringPermissions>, String> {
        let Some(identity_fingerprint) = self.identity_fingerprint.as_deref() else {
            return Ok(None);
        };
        prepare_monitoring_directory(&self.directory_path, MONITORING_PERMISSIONS_LOAD_WARNING)?;
        let metadata = match fs::symlink_metadata(&self.permissions_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(MONITORING_PERMISSIONS_LOAD_WARNING.to_owned()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(MONITORING_PERMISSIONS_LOAD_WARNING.to_owned());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&self.permissions_path)
            .map_err(|_| MONITORING_PERMISSIONS_LOAD_WARNING.to_owned())?;
        let metadata = file
            .metadata()
            .map_err(|_| MONITORING_PERMISSIONS_LOAD_WARNING.to_owned())?;
        if !metadata.is_file() || metadata.len() > MAX_MONITORING_SETTINGS_BYTES {
            return Err(MONITORING_PERMISSIONS_LOAD_WARNING.to_owned());
        }
        harden_monitoring_settings_file(&file)
            .map_err(|_| MONITORING_PERMISSIONS_LOAD_WARNING.to_owned())?;
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
        (&mut file)
            .take(MAX_MONITORING_SETTINGS_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| MONITORING_PERMISSIONS_LOAD_WARNING.to_owned())?;
        if bytes.len() as u64 > MAX_MONITORING_SETTINGS_BYTES {
            return Err(MONITORING_PERMISSIONS_LOAD_WARNING.to_owned());
        }
        let permissions: PersistedMonitoringPermissions = serde_json::from_slice(&bytes)
            .map_err(|_| MONITORING_PERMISSIONS_LOAD_WARNING.to_owned())?;
        if permissions.schema_version != MONITORING_PERMISSIONS_SCHEMA_VERSION
            || !valid_identity_fingerprint(&permissions.identity_fingerprint)
            || permissions.checked_at_ms.is_some_and(|value| value < 0)
        {
            return Err(MONITORING_PERMISSIONS_LOAD_WARNING.to_owned());
        }
        if permissions.identity_fingerprint != identity_fingerprint {
            return Ok(None);
        }
        Ok(Some(permissions))
    }

    fn save(
        &self,
        permissions: &MonitoringPermissions,
        checked_at_ms: Option<i64>,
        setup_attempted: bool,
    ) -> Result<(), String> {
        let Some(identity_fingerprint) = self.identity_fingerprint.as_deref() else {
            return Err("observer_permission_setup_identity_unavailable".to_owned());
        };
        if checked_at_ms.is_some_and(|value| value < 0) {
            return Err(MONITORING_PERMISSIONS_PERSISTENCE_WARNING.to_owned());
        }
        prepare_monitoring_directory(
            &self.directory_path,
            MONITORING_PERMISSIONS_PERSISTENCE_WARNING,
        )?;
        let persisted = PersistedMonitoringPermissions {
            schema_version: MONITORING_PERMISSIONS_SCHEMA_VERSION.to_owned(),
            identity_fingerprint: identity_fingerprint.to_owned(),
            setup_attempted,
            permissions: permissions.clone(),
            checked_at_ms,
        };
        let mut bytes = serde_json::to_vec(&persisted)
            .map_err(|_| MONITORING_PERMISSIONS_PERSISTENCE_WARNING.to_owned())?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_MONITORING_SETTINGS_BYTES {
            return Err(MONITORING_PERMISSIONS_PERSISTENCE_WARNING.to_owned());
        }

        let sequence = MONITORING_SETTINGS_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary_path = self.directory_path.join(format!(
            ".{MONITORING_PERMISSIONS_FILE}.tmp-{}-{sequence}",
            std::process::id()
        ));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;

                options
                    .mode(0o600)
                    .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
            }
            let mut file = options.open(&temporary_path)?;
            harden_monitoring_settings_file(&file)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary_path, &self.permissions_path)?;
            sync_monitoring_settings_directory(&self.directory_path)?;
            Ok::<(), io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result.map_err(|_| MONITORING_PERMISSIONS_PERSISTENCE_WARNING.to_owned())
    }
}

impl MonitoringSettingsStore {
    fn for_observation_journal(journal: &ObservationJournal) -> Self {
        let data_directory = journal
            .database_path()
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        Self::new(data_directory)
    }

    fn new(data_directory: &Path) -> Self {
        let directory_path = data_directory.join(MONITORING_SETTINGS_DIRECTORY);
        let settings_path = directory_path.join(MONITORING_SETTINGS_FILE);
        Self {
            directory_path,
            settings_path,
        }
    }

    fn load(&self) -> Result<Option<PersistedMonitoringSettings>, String> {
        self.prepare_directory()?;
        let metadata = match fs::symlink_metadata(&self.settings_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(MONITORING_SETTINGS_LOAD_WARNING.to_owned()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(MONITORING_SETTINGS_LOAD_WARNING.to_owned());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&self.settings_path)
            .map_err(|_| MONITORING_SETTINGS_LOAD_WARNING.to_owned())?;
        let metadata = file
            .metadata()
            .map_err(|_| MONITORING_SETTINGS_LOAD_WARNING.to_owned())?;
        if !metadata.is_file() || metadata.len() > MAX_MONITORING_SETTINGS_BYTES {
            return Err(MONITORING_SETTINGS_LOAD_WARNING.to_owned());
        }
        harden_monitoring_settings_file(&file)
            .map_err(|_| MONITORING_SETTINGS_LOAD_WARNING.to_owned())?;
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
        (&mut file)
            .take(MAX_MONITORING_SETTINGS_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| MONITORING_SETTINGS_LOAD_WARNING.to_owned())?;
        if bytes.len() as u64 > MAX_MONITORING_SETTINGS_BYTES {
            return Err(MONITORING_SETTINGS_LOAD_WARNING.to_owned());
        }
        let settings: PersistedMonitoringSettings = serde_json::from_slice(&bytes)
            .map_err(|_| MONITORING_SETTINGS_LOAD_WARNING.to_owned())?;
        if settings.schema_version != MONITORING_SETTINGS_SCHEMA_VERSION {
            return Err(MONITORING_SETTINGS_LOAD_WARNING.to_owned());
        }
        validate_excluded_bundle_ids(&settings.excluded_bundle_ids)
            .map_err(|_| MONITORING_SETTINGS_LOAD_WARNING.to_owned())?;
        Ok(Some(settings))
    }

    fn save(&self, settings: &RuntimeSettings) -> Result<(), String> {
        self.prepare_directory()
            .map_err(|_| MONITORING_SETTINGS_PERSISTENCE_WARNING.to_owned())?;
        validate_excluded_bundle_ids(&settings.excluded_bundle_ids)
            .map_err(|_| MONITORING_SETTINGS_PERSISTENCE_WARNING.to_owned())?;
        let persisted = PersistedMonitoringSettings {
            schema_version: MONITORING_SETTINGS_SCHEMA_VERSION.to_owned(),
            enabled: settings.enabled,
            capture_content: settings.capture_content,
            paused: settings.paused,
            excluded_bundle_ids: settings.excluded_bundle_ids.clone(),
        };
        let mut bytes = serde_json::to_vec(&persisted)
            .map_err(|_| MONITORING_SETTINGS_PERSISTENCE_WARNING.to_owned())?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_MONITORING_SETTINGS_BYTES {
            return Err(MONITORING_SETTINGS_PERSISTENCE_WARNING.to_owned());
        }

        let sequence = MONITORING_SETTINGS_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary_path = self.directory_path.join(format!(
            ".{MONITORING_SETTINGS_FILE}.tmp-{}-{sequence}",
            std::process::id()
        ));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;

                options
                    .mode(0o600)
                    .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
            }
            let mut file = options.open(&temporary_path)?;
            harden_monitoring_settings_file(&file)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary_path, &self.settings_path)?;
            sync_monitoring_settings_directory(&self.directory_path)?;
            Ok::<(), io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result.map_err(|_| MONITORING_SETTINGS_PERSISTENCE_WARNING.to_owned())
    }

    fn prepare_directory(&self) -> Result<(), String> {
        match fs::symlink_metadata(&self.directory_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(MONITORING_SETTINGS_LOAD_WARNING.to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(&self.directory_path)
                    .map_err(|_| MONITORING_SETTINGS_LOAD_WARNING.to_owned())?;
            }
            Err(_) => return Err(MONITORING_SETTINGS_LOAD_WARNING.to_owned()),
        }
        harden_monitoring_settings_directory(&self.directory_path)
            .map_err(|_| MONITORING_SETTINGS_LOAD_WARNING.to_owned())
    }
}

#[derive(Clone)]
pub struct ObserverSupervisorConfig {
    pub enabled: bool,
    pub capture_content: bool,
    pub excluded_bundle_ids: Vec<String>,
    pub helper_path: Option<PathBuf>,
}

impl ObserverSupervisorConfig {
    pub fn from_environment() -> Result<Self, String> {
        let enabled = parse_bool(HELPER_ENABLED_ENV, false)?;
        let capture_content = parse_bool(HELPER_CAPTURE_CONTENT_ENV, true)?;
        let excluded_bundle_ids = std::env::var(HELPER_EXCLUDED_APPS_ENV)
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        validate_excluded_bundle_ids(&excluded_bundle_ids)?;
        let helper_path = resolve_helper_path()?;
        Ok(Self {
            enabled,
            capture_content,
            excluded_bundle_ids,
            helper_path,
        })
    }
}

#[derive(Clone)]
pub struct ObserverSupervisor {
    status: Arc<Mutex<MonitoringStatusResult>>,
    commands: mpsc::Sender<SupervisorCommand>,
}

impl ObserverSupervisor {
    pub fn start(config: ObserverSupervisorConfig, journal: ObservationJournal) -> Self {
        let settings_store = MonitoringSettingsStore::for_observation_journal(&journal);
        let (settings, settings_warning) = load_runtime_settings(config, &settings_store);
        let identity_fingerprint = settings
            .helper_path
            .as_deref()
            .and_then(|path| observer_permission_identity_fingerprint(path).ok());
        let permissions_store =
            MonitoringPermissionsStore::for_observation_journal(&journal, identity_fingerprint);
        let (cached_permissions, permissions_warning) = match permissions_store.load() {
            Ok(permissions) => (permissions, None),
            Err(error) => (None, Some(error)),
        };
        let initial_state = if !settings.enabled {
            MonitoringState::Disabled
        } else if settings.paused {
            MonitoringState::Paused
        } else {
            MonitoringState::Starting
        };
        let key_warning = observation_key_warning(&journal).map(ToOwned::to_owned);
        let status = Arc::new(Mutex::new(MonitoringStatusResult {
            state: initial_state,
            enabled: settings.enabled,
            capture_content: settings.capture_content,
            excluded_bundle_ids: settings.excluded_bundle_ids.clone(),
            helper_pid: None,
            helper_path_available: settings.helper_path.is_some(),
            boot_id: None,
            last_sequence: None,
            last_acked_sequence: None,
            last_heartbeat_at_ms: None,
            tap_ready: false,
            last_callback_at_ms: None,
            last_bucket_at_ms: None,
            permissions: cached_permissions
                .as_ref()
                .map(|cached| cached.permissions.clone())
                .unwrap_or_default(),
            permission_check_state: if cached_permissions
                .as_ref()
                .and_then(|cached| cached.checked_at_ms)
                .is_some()
            {
                MonitoringPermissionCheckState::Current
            } else {
                MonitoringPermissionCheckState::Unchecked
            },
            permissions_checked_at_ms: cached_permissions
                .as_ref()
                .and_then(|cached| cached.checked_at_ms),
            permission_setup_available: permissions_store.setup_available(),
            permission_setup_attempted: cached_permissions
                .as_ref()
                .is_some_and(|cached| cached.setup_attempted),
            coverage: vec![CoverageLevelV2::Metadata],
            last_error: settings_warning.or(permissions_warning).or(key_warning),
        }));
        let (commands, receiver) = mpsc::channel(32);
        tokio::spawn(run_supervisor(
            settings,
            settings_store,
            permissions_store,
            journal,
            status.clone(),
            receiver,
        ));
        Self { status, commands }
    }

    pub fn status(&self) -> MonitoringStatusResult {
        self.status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub async fn configure(
        &self,
        params: MonitoringConfigureParams,
    ) -> Result<MonitoringStatusResult, String> {
        validate_excluded_bundle_ids(&params.excluded_bundle_ids)?;
        self.request(|response| SupervisorCommand::Configure { params, response })
            .await
    }

    pub async fn pause(&self) -> Result<MonitoringStatusResult, String> {
        self.request(|response| SupervisorCommand::Pause { response })
            .await
    }

    pub async fn resume(&self) -> Result<MonitoringStatusResult, String> {
        self.request(|response| SupervisorCommand::Resume { response })
            .await
    }

    pub async fn refresh_permissions(&self) -> Result<MonitoringStatusResult, String> {
        self.request(|response| SupervisorCommand::RefreshPermissions { response })
            .await
    }

    pub async fn setup_permissions(&self) -> Result<MonitoringStatusResult, String> {
        self.request(|response| SupervisorCommand::SetupPermissions { response })
            .await
    }

    pub async fn shutdown(&self) {
        let (response, completed) = oneshot::channel();
        if self
            .commands
            .send(SupervisorCommand::Shutdown { response })
            .await
            .is_ok()
        {
            let _ = completed.await;
        }
    }

    async fn request(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<MonitoringStatusResult, String>>) -> SupervisorCommand,
    ) -> Result<MonitoringStatusResult, String> {
        let (response, completed) = oneshot::channel();
        self.commands
            .send(build(response))
            .await
            .map_err(|_| "observer supervisor is stopped".to_owned())?;
        completed
            .await
            .map_err(|_| "observer supervisor stopped before replying".to_owned())?
    }
}

enum SupervisorCommand {
    Configure {
        params: MonitoringConfigureParams,
        response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
    },
    Pause {
        response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
    },
    Resume {
        response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
    },
    RefreshPermissions {
        response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
    },
    SetupPermissions {
        response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
    },
    Shutdown {
        response: oneshot::Sender<()>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RuntimeSettings {
    enabled: bool,
    paused: bool,
    capture_content: bool,
    excluded_bundle_ids: Vec<String>,
    helper_path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionOutcome {
    Restart,
    Reconfigure,
    Disabled,
    Shutdown,
}

struct PendingPermissionRefresh {
    command_id: &'static str,
    completes_permission_setup: bool,
    permission_status_received: bool,
    command_result_received: bool,
    deadline: Instant,
    response: oneshot::Sender<Result<MonitoringStatusResult, String>>,
}

struct HelperSessionContext<'a> {
    journal: &'a ObservationJournal,
    status: &'a Arc<Mutex<MonitoringStatusResult>>,
    settings_store: &'a MonitoringSettingsStore,
    permissions_store: &'a MonitoringPermissionsStore,
    permission_check_before_start: MonitoringPermissionCheckState,
}

enum HelperFrameEvent {
    Other,
    PermissionStatus,
    CommandResult { id: String, ok: bool },
}

#[derive(Default)]
struct RestartFailures {
    failures: VecDeque<Instant>,
}

impl RestartFailures {
    fn record(&mut self, at: Instant) -> bool {
        self.failures.push_back(at);
        self.prune(at);
        self.failures.len() >= FAILURE_LIMIT
    }

    fn clear(&mut self) {
        self.failures.clear();
    }

    fn prune(&mut self, at: Instant) {
        while self
            .failures
            .front()
            .is_some_and(|failure| at.duration_since(*failure) > FAILURE_WINDOW)
        {
            self.failures.pop_front();
        }
    }
}

fn load_runtime_settings(
    config: ObserverSupervisorConfig,
    settings_store: &MonitoringSettingsStore,
) -> (RuntimeSettings, Option<String>) {
    let helper_path = config.helper_path;
    match settings_store.load() {
        Ok(Some(persisted)) => (
            RuntimeSettings {
                enabled: persisted.enabled,
                paused: persisted.paused,
                capture_content: persisted.capture_content,
                excluded_bundle_ids: persisted.excluded_bundle_ids,
                helper_path,
            },
            None,
        ),
        Ok(None) => (
            RuntimeSettings {
                enabled: config.enabled,
                paused: false,
                capture_content: config.capture_content,
                excluded_bundle_ids: config.excluded_bundle_ids,
                helper_path,
            },
            None,
        ),
        Err(_) => (
            RuntimeSettings {
                enabled: false,
                paused: false,
                capture_content: false,
                excluded_bundle_ids: Vec::new(),
                helper_path,
            },
            Some(MONITORING_SETTINGS_LOAD_WARNING.to_owned()),
        ),
    }
}

fn persist_runtime_settings(
    settings_store: &MonitoringSettingsStore,
    settings: &RuntimeSettings,
    status: &Arc<Mutex<MonitoringStatusResult>>,
) -> Result<(), String> {
    match settings_store.save(settings) {
        Ok(()) => {
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            if matches!(
                current.last_error.as_deref(),
                Some(MONITORING_SETTINGS_LOAD_WARNING | MONITORING_SETTINGS_PERSISTENCE_WARNING)
            ) {
                current.last_error = None;
            }
            Ok(())
        }
        Err(_) => {
            status
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .last_error = Some(MONITORING_SETTINGS_PERSISTENCE_WARNING.to_owned());
            Err(MONITORING_SETTINGS_PERSISTENCE_WARNING.to_owned())
        }
    }
}

async fn run_supervisor(
    mut settings: RuntimeSettings,
    settings_store: MonitoringSettingsStore,
    permissions_store: MonitoringPermissionsStore,
    journal: ObservationJournal,
    status: Arc<Mutex<MonitoringStatusResult>>,
    mut commands: mpsc::Receiver<SupervisorCommand>,
) {
    let mut restart_attempt = 0_usize;
    let mut restart_failures = RestartFailures::default();
    let mut restart_latched = false;
    loop {
        update_configuration_status(&status, &settings);
        if restart_latched {
            set_state(
                &status,
                MonitoringState::Degraded,
                Some("observer_restart_limit_reached"),
            );
            let Some(command) = commands.recv().await else {
                break;
            };
            let manual_retry = command_requests_manual_retry(&command);
            if handle_idle_command(
                command,
                &mut settings,
                &status,
                &settings_store,
                &permissions_store,
                &journal,
            )
            .await
            {
                break;
            }
            if manual_retry && settings.enabled && !settings.paused {
                settings.helper_path = resolve_helper_path().ok().flatten();
                restart_failures.clear();
                restart_attempt = 0;
                restart_latched = false;
            }
            continue;
        }
        if !settings.enabled || settings.paused {
            set_state(
                &status,
                if settings.enabled {
                    MonitoringState::Paused
                } else {
                    MonitoringState::Disabled
                },
                None,
            );
            let Some(command) = commands.recv().await else {
                break;
            };
            let manual_retry = command_requests_manual_retry(&command);
            if handle_idle_command(
                command,
                &mut settings,
                &status,
                &settings_store,
                &permissions_store,
                &journal,
            )
            .await
            {
                break;
            }
            if manual_retry && settings.enabled && !settings.paused {
                settings.helper_path = resolve_helper_path().ok().flatten();
            }
            continue;
        }

        let Some(helper_path) = settings.helper_path.clone() else {
            set_state(
                &status,
                MonitoringState::Degraded,
                Some("observer_helper_unavailable"),
            );
            let Some(command) = commands.recv().await else {
                break;
            };
            let manual_retry = command_requests_manual_retry(&command);
            if handle_idle_command(
                command,
                &mut settings,
                &status,
                &settings_store,
                &permissions_store,
                &journal,
            )
            .await
            {
                break;
            }
            if manual_retry && settings.enabled && !settings.paused {
                settings.helper_path = resolve_helper_path().ok().flatten();
            }
            continue;
        };

        set_state(&status, MonitoringState::Starting, None);
        let permission_check_before_start = status_snapshot(&status).permission_check_state;
        set_permission_check_state(&status, MonitoringPermissionCheckState::Checking);
        let failed = match spawn_helper(&helper_path).await {
            Ok((child, stderr_task)) => {
                let session_started = Instant::now();
                match run_helper_session(
                    child,
                    stderr_task,
                    HelperSessionContext {
                        journal: &journal,
                        status: &status,
                        settings_store: &settings_store,
                        permissions_store: &permissions_store,
                        permission_check_before_start,
                    },
                    &mut settings,
                    &mut commands,
                )
                .await
                {
                    SessionOutcome::Shutdown => break,
                    SessionOutcome::Disabled => continue,
                    SessionOutcome::Reconfigure => {
                        restart_attempt = 0;
                        continue;
                    }
                    SessionOutcome::Restart => {
                        if session_started.elapsed() >= FAILURE_WINDOW {
                            restart_attempt = 0;
                        }
                        true
                    }
                }
            }
            Err(_) => {
                set_permission_check_state(&status, MonitoringPermissionCheckState::Failed);
                set_state(
                    &status,
                    MonitoringState::Degraded,
                    Some("observer_helper_start_failed"),
                );
                true
            }
        };
        if failed && restart_failures.record(Instant::now()) {
            restart_latched = true;
            continue;
        }

        let delay = RESTART_DELAYS[restart_attempt.min(RESTART_DELAYS.len() - 1)];
        restart_attempt = restart_attempt.saturating_add(1);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            command = commands.recv() => {
                let Some(command) = command else { break; };
                if handle_idle_command(
                    command,
                    &mut settings,
                    &status,
                    &settings_store,
                    &permissions_store,
                    &journal,
                )
                .await
                {
                    break;
                }
            }
        }
    }
    set_state(&status, MonitoringState::Stopped, None);
}

async fn run_helper_session(
    mut child: Child,
    stderr_task: JoinHandle<()>,
    context: HelperSessionContext<'_>,
    settings: &mut RuntimeSettings,
    commands: &mut mpsc::Receiver<SupervisorCommand>,
) -> SessionOutcome {
    let HelperSessionContext {
        journal,
        status,
        settings_store,
        permissions_store,
        permission_check_before_start,
    } = context;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        stderr_task.abort();
        set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
        return SessionOutcome::Restart;
    };
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        stderr_task.abort();
        set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
        return SessionOutcome::Restart;
    };
    {
        let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
        current.helper_pid = child.id();
        current.boot_id = None;
        current.last_sequence = None;
        current.last_acked_sequence = None;
        current.last_heartbeat_at_ms = None;
        current.tap_ready = false;
        current.last_callback_at_ms = None;
        current.last_bucket_at_ms = None;
        current.last_error = observation_key_warning(journal).map(ToOwned::to_owned);
    }
    if send_start_command(&mut stdin, "start-1", settings)
        .await
        .is_err()
    {
        let _ = child.kill().await;
        stderr_task.abort();
        {
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            clear_helper_connection(&mut current);
            current.permission_check_state = MonitoringPermissionCheckState::Failed;
        }
        return SessionOutcome::Restart;
    }

    let mut stdout = BufReader::new(stdout);
    let mut health = interval(HEALTH_TICK);
    health.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut frame_state = HelperFrameState {
        active_boot_id: None,
        last_sequence: 0,
        last_observation_at_ms: None,
        last_heartbeat: Instant::now(),
        permission_frame_received: false,
    };
    let mut pending_permission_refresh: Option<PendingPermissionRefresh> = None;
    let mut line = Vec::new();

    let outcome = loop {
        line.clear();
        let permission_refresh_deadline = pending_permission_refresh
            .as_ref()
            .map(|pending| pending.deadline);
        tokio::select! {
            biased;
            _ = wait_for_permission_refresh_deadline(permission_refresh_deadline) => {
                fail_pending_permission_refresh(
                    status,
                    &mut pending_permission_refresh,
                    "observer_permission_refresh_timeout",
                );
            }
            read = stdout.read_until(b'\n', &mut line) => {
                match read {
                    Ok(0) | Err(_) => break SessionOutcome::Restart,
                    Ok(_) => {
                        trim_line_end(&mut line);
                        if line.len() > MAX_HELPER_FRAME_BYTES {
                            set_state(status, MonitoringState::Degraded, Some("observer_frame_too_large"));
                            break SessionOutcome::Restart;
                        }
                        match handle_helper_frame(
                            &line,
                            journal,
                            status,
                            permissions_store,
                            &mut stdin,
                            &mut frame_state,
                        ).await {
                            Ok(event) => {
                                handle_permission_refresh_event(
                                    event,
                                    status,
                                    permissions_store,
                                    &mut pending_permission_refresh,
                                );
                            }
                            Err(code) => {
                                set_state(status, MonitoringState::Degraded, Some(code));
                                break SessionOutcome::Restart;
                            }
                        }
                    }
                }
            }
            _ = health.tick() => {
                if frame_state.last_heartbeat.elapsed() > HEARTBEAT_TIMEOUT {
                    set_state(status, MonitoringState::Degraded, Some("observer_heartbeat_timeout"));
                    break SessionOutcome::Restart;
                }
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    break SessionOutcome::Shutdown;
                };
                match handle_running_command(
                    command,
                    settings,
                    status,
                    settings_store,
                    permissions_store,
                    &mut stdin,
                    &mut pending_permission_refresh,
                ).await {
                    RunningCommandOutcome::Continue => {}
                    RunningCommandOutcome::Reconfigure => {
                        break SessionOutcome::Reconfigure;
                    }
                    RunningCommandOutcome::Disabled => break SessionOutcome::Disabled,
                    RunningCommandOutcome::Shutdown => break SessionOutcome::Shutdown,
                }
            }
        }
    };

    settle_permission_check_after_session(
        status,
        outcome,
        frame_state.permission_frame_received,
        permission_check_before_start,
    );
    fail_pending_permission_refresh(
        status,
        &mut pending_permission_refresh,
        "observer_permission_refresh_interrupted",
    );
    let _ = send_simple_command(&mut stdin, "shutdown-parent", "shutdown").await;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    if child.id().is_some() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    stderr_task.abort();
    let _ = stderr_task.await;
    {
        let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
        clear_helper_connection(&mut current);
    }
    outcome
}

enum RunningCommandOutcome {
    Continue,
    Reconfigure,
    Disabled,
    Shutdown,
}

async fn handle_running_command(
    command: SupervisorCommand,
    settings: &mut RuntimeSettings,
    status: &Arc<Mutex<MonitoringStatusResult>>,
    settings_store: &MonitoringSettingsStore,
    permissions_store: &MonitoringPermissionsStore,
    stdin: &mut ChildStdin,
    pending_permission_refresh: &mut Option<PendingPermissionRefresh>,
) -> RunningCommandOutcome {
    match command {
        SupervisorCommand::Configure { params, response } => {
            let mut proposed = settings.clone();
            proposed.enabled = params.enabled;
            proposed.capture_content = params.capture_content;
            proposed.excluded_bundle_ids = params.excluded_bundle_ids;
            if let Err(error) = persist_runtime_settings(settings_store, &proposed, status) {
                let _ = response.send(Err(error));
                return RunningCommandOutcome::Continue;
            }
            *settings = proposed;
            update_configuration_status(status, settings);
            set_state(
                status,
                if settings.enabled {
                    MonitoringState::Starting
                } else {
                    MonitoringState::Disabled
                },
                None,
            );
            let _ = response.send(Ok(status_snapshot(status)));
            if settings.enabled {
                RunningCommandOutcome::Reconfigure
            } else {
                RunningCommandOutcome::Disabled
            }
        }
        SupervisorCommand::Pause { response } => {
            let mut proposed = settings.clone();
            proposed.paused = true;
            if let Err(error) = persist_runtime_settings(settings_store, &proposed, status) {
                let _ = response.send(Err(error));
                return RunningCommandOutcome::Continue;
            }
            *settings = proposed;
            let result = send_simple_command(stdin, "pause-runtime", "pause")
                .await
                .map(|()| {
                    set_state(status, MonitoringState::Paused, None);
                    status_snapshot(status)
                })
                .map_err(|_| "observer_pause_failed".to_owned());
            let _ = response.send(result);
            RunningCommandOutcome::Disabled
        }
        SupervisorCommand::Resume { response } => {
            let mut proposed = settings.clone();
            proposed.paused = false;
            if let Err(error) = persist_runtime_settings(settings_store, &proposed, status) {
                let _ = response.send(Err(error));
                return RunningCommandOutcome::Continue;
            }
            *settings = proposed;
            let result = send_simple_command(stdin, "resume-runtime", "resume")
                .await
                .map(|()| {
                    set_state(status, MonitoringState::Running, None);
                    status_snapshot(status)
                })
                .map_err(|_| "observer_resume_failed".to_owned());
            let _ = response.send(result);
            RunningCommandOutcome::Continue
        }
        SupervisorCommand::RefreshPermissions { response } => {
            if pending_permission_refresh.is_some() {
                let _ = response.send(Err(
                    "observer_permission_refresh_already_in_progress".to_owned()
                ));
                return RunningCommandOutcome::Continue;
            }
            set_permission_check_state(status, MonitoringPermissionCheckState::Checking);
            if send_permission_refresh_command(stdin, PERMISSION_REFRESH_COMMAND_ID)
                .await
                .is_err()
            {
                set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
                let _ = response.send(Err("observer_permission_refresh_failed".to_owned()));
                return RunningCommandOutcome::Continue;
            }
            *pending_permission_refresh = Some(PendingPermissionRefresh {
                command_id: PERMISSION_REFRESH_COMMAND_ID,
                completes_permission_setup: false,
                permission_status_received: false,
                command_result_received: false,
                deadline: Instant::now() + PERMISSION_REFRESH_TIMEOUT,
                response,
            });
            RunningCommandOutcome::Continue
        }
        SupervisorCommand::SetupPermissions { response } => {
            if pending_permission_refresh.is_some() {
                let _ = response.send(Err(
                    "observer_permission_refresh_already_in_progress".to_owned()
                ));
                return RunningCommandOutcome::Continue;
            }
            let request_allowed = match prepare_permission_setup(permissions_store, status) {
                Ok(request_allowed) => request_allowed,
                Err(error) => {
                    let _ = response.send(Err(error));
                    return RunningCommandOutcome::Continue;
                }
            };
            set_permission_check_state(status, MonitoringPermissionCheckState::Checking);
            let (command_id, result) = if request_allowed {
                (
                    PERMISSION_SETUP_COMMAND_ID,
                    send_permission_setup_command(stdin, PERMISSION_SETUP_COMMAND_ID).await,
                )
            } else {
                (
                    PERMISSION_REFRESH_COMMAND_ID,
                    send_permission_refresh_command(stdin, PERMISSION_REFRESH_COMMAND_ID).await,
                )
            };
            if result.is_err() {
                set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
                let _ = response.send(Err("observer_permission_refresh_failed".to_owned()));
                return RunningCommandOutcome::Continue;
            }
            *pending_permission_refresh = Some(PendingPermissionRefresh {
                command_id,
                completes_permission_setup: request_allowed,
                permission_status_received: false,
                command_result_received: false,
                deadline: Instant::now() + PERMISSION_REFRESH_TIMEOUT,
                response,
            });
            RunningCommandOutcome::Continue
        }
        SupervisorCommand::Shutdown { response } => {
            let _ = response.send(());
            RunningCommandOutcome::Shutdown
        }
    }
}

fn handle_permission_refresh_event(
    event: HelperFrameEvent,
    status: &Arc<Mutex<MonitoringStatusResult>>,
    permissions_store: &MonitoringPermissionsStore,
    pending: &mut Option<PendingPermissionRefresh>,
) {
    let Some(refresh) = pending.as_mut() else {
        return;
    };
    match event {
        HelperFrameEvent::PermissionStatus => {
            refresh.permission_status_received = true;
        }
        HelperFrameEvent::CommandResult { id, ok } if id == refresh.command_id => {
            if !ok {
                fail_pending_permission_refresh(
                    status,
                    pending,
                    "observer_permission_refresh_rejected",
                );
                return;
            }
            refresh.command_result_received = true;
        }
        HelperFrameEvent::Other | HelperFrameEvent::CommandResult { .. } => {}
    }
    if refresh.permission_status_received && refresh.command_result_received {
        let Some(refresh) = pending.take() else {
            return;
        };
        if refresh.completes_permission_setup
            && let Err(error) = complete_permission_setup(permissions_store, status)
        {
            let _ = refresh.response.send(Err(error));
            return;
        }
        let _ = refresh.response.send(Ok(status_snapshot(status)));
    }
}

fn fail_pending_permission_refresh(
    status: &Arc<Mutex<MonitoringStatusResult>>,
    pending: &mut Option<PendingPermissionRefresh>,
    code: &'static str,
) {
    let Some(refresh) = pending.take() else {
        return;
    };
    set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
    let _ = refresh.response.send(Err(code.to_owned()));
}

async fn wait_for_permission_refresh_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => {
            tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
        }
        None => std::future::pending::<()>().await,
    }
}

fn settle_permission_check_after_session(
    status: &Arc<Mutex<MonitoringStatusResult>>,
    outcome: SessionOutcome,
    permission_frame_received: bool,
    permission_check_before_start: MonitoringPermissionCheckState,
) {
    if permission_frame_received {
        return;
    }
    let next = match outcome {
        SessionOutcome::Restart => MonitoringPermissionCheckState::Failed,
        SessionOutcome::Reconfigure | SessionOutcome::Disabled | SessionOutcome::Shutdown => {
            if permission_check_before_start == MonitoringPermissionCheckState::Current {
                MonitoringPermissionCheckState::Current
            } else {
                MonitoringPermissionCheckState::Unchecked
            }
        }
    };
    let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
    current.permission_check_state = next;
    if next == MonitoringPermissionCheckState::Unchecked {
        current.permissions_checked_at_ms = None;
    }
}

async fn handle_idle_command(
    command: SupervisorCommand,
    settings: &mut RuntimeSettings,
    status: &Arc<Mutex<MonitoringStatusResult>>,
    settings_store: &MonitoringSettingsStore,
    permissions_store: &MonitoringPermissionsStore,
    journal: &ObservationJournal,
) -> bool {
    match command {
        SupervisorCommand::Configure { params, response } => {
            let mut proposed = settings.clone();
            proposed.enabled = params.enabled;
            proposed.capture_content = params.capture_content;
            proposed.excluded_bundle_ids = params.excluded_bundle_ids;
            proposed.paused = false;
            if let Err(error) = persist_runtime_settings(settings_store, &proposed, status) {
                let _ = response.send(Err(error));
                return false;
            }
            *settings = proposed;
            update_configuration_status(status, settings);
            set_state(
                status,
                if settings.enabled {
                    MonitoringState::Starting
                } else {
                    MonitoringState::Disabled
                },
                None,
            );
            let _ = response.send(Ok(status_snapshot(status)));
            false
        }
        SupervisorCommand::Pause { response } => {
            let mut proposed = settings.clone();
            proposed.paused = true;
            if let Err(error) = persist_runtime_settings(settings_store, &proposed, status) {
                let _ = response.send(Err(error));
                return false;
            }
            *settings = proposed;
            set_state(status, MonitoringState::Paused, None);
            let _ = response.send(Ok(status_snapshot(status)));
            false
        }
        SupervisorCommand::Resume { response } => {
            let mut proposed = settings.clone();
            proposed.paused = false;
            if let Err(error) = persist_runtime_settings(settings_store, &proposed, status) {
                let _ = response.send(Err(error));
                return false;
            }
            *settings = proposed;
            if !settings.enabled {
                let _ = response.send(Err("observer_monitoring_disabled".to_owned()));
            } else {
                set_state(status, MonitoringState::Starting, None);
                let _ = response.send(Ok(status_snapshot(status)));
            }
            false
        }
        SupervisorCommand::RefreshPermissions { response } => {
            let resting_state = status_snapshot(status).state;
            if settings.helper_path.is_none() {
                settings.helper_path = resolve_helper_path().ok().flatten();
                update_configuration_status(status, settings);
            }
            let result = match settings.helper_path.as_deref() {
                Some(helper_path) => {
                    run_permission_probe(
                        helper_path,
                        status,
                        permissions_store,
                        journal,
                        resting_state,
                        PermissionProbeMode::Refresh,
                    )
                    .await
                }
                None => {
                    set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
                    Err("observer_helper_unavailable".to_owned())
                }
            };
            let _ = response.send(result);
            false
        }
        SupervisorCommand::SetupPermissions { response } => {
            let resting_state = status_snapshot(status).state;
            if settings.helper_path.is_none() {
                settings.helper_path = resolve_helper_path().ok().flatten();
                update_configuration_status(status, settings);
            }
            let result = match settings.helper_path.as_deref() {
                Some(helper_path) => {
                    let mode = match prepare_permission_setup(permissions_store, status) {
                        Ok(true) => PermissionProbeMode::Setup,
                        Ok(false) => PermissionProbeMode::Refresh,
                        Err(error) => {
                            let _ = response.send(Err(error));
                            return false;
                        }
                    };
                    run_permission_probe(
                        helper_path,
                        status,
                        permissions_store,
                        journal,
                        resting_state,
                        mode,
                    )
                    .await
                }
                None => {
                    set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
                    Err("observer_helper_unavailable".to_owned())
                }
            };
            let _ = response.send(result);
            false
        }
        SupervisorCommand::Shutdown { response } => {
            let _ = response.send(());
            true
        }
    }
}

fn command_requests_manual_retry(command: &SupervisorCommand) -> bool {
    matches!(
        command,
        SupervisorCommand::Configure { params, .. } if params.enabled
    ) || matches!(
        command,
        SupervisorCommand::Resume { .. }
            | SupervisorCommand::RefreshPermissions { .. }
            | SupervisorCommand::SetupPermissions { .. }
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PermissionProbeMode {
    Refresh,
    Setup,
}

async fn run_permission_probe(
    helper_path: &Path,
    status: &Arc<Mutex<MonitoringStatusResult>>,
    permissions_store: &MonitoringPermissionsStore,
    journal: &ObservationJournal,
    resting_state: MonitoringState,
    mode: PermissionProbeMode,
) -> Result<MonitoringStatusResult, String> {
    let previous_error = status_snapshot(status).last_error;
    set_permission_check_state(status, MonitoringPermissionCheckState::Checking);
    let (mut child, stderr_task) = match spawn_helper(helper_path).await {
        Ok(session) => session,
        Err(_) => {
            set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
            return Err("observer_helper_start_failed".to_owned());
        }
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        stderr_task.abort();
        set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
        return Err("observer_probe_stdout_unavailable".to_owned());
    };
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        stderr_task.abort();
        set_permission_check_state(status, MonitoringPermissionCheckState::Failed);
        return Err("observer_probe_stdin_unavailable".to_owned());
    };
    {
        let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
        current.helper_pid = child.id();
        current.boot_id = None;
        current.tap_ready = false;
    }

    let probe = async {
        let command_id = match mode {
            PermissionProbeMode::Refresh => {
                send_permission_refresh_command(&mut stdin, PERMISSION_REFRESH_COMMAND_ID)
                    .await
                    .map_err(|_| "observer_permission_refresh_failed")?;
                PERMISSION_REFRESH_COMMAND_ID
            }
            PermissionProbeMode::Setup => {
                send_permission_setup_command(&mut stdin, PERMISSION_SETUP_COMMAND_ID)
                    .await
                    .map_err(|_| "observer_permission_refresh_failed")?;
                PERMISSION_SETUP_COMMAND_ID
            }
        };
        let mut stdout = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut permission_status_received = false;
        let mut command_result_received = false;
        loop {
            line.clear();
            match stdout.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => return Err("observer_probe_ended_early"),
                Ok(_) => {}
            }
            trim_line_end(&mut line);
            if line.len() > MAX_HELPER_FRAME_BYTES {
                return Err("observer_frame_too_large");
            }
            match handle_permission_probe_frame(&line, status, permissions_store, journal)? {
                HelperFrameEvent::PermissionStatus => {
                    permission_status_received = true;
                }
                HelperFrameEvent::CommandResult { id, ok } if id == command_id => {
                    if !ok {
                        return Err("observer_permission_refresh_rejected");
                    }
                    command_result_received = true;
                }
                HelperFrameEvent::Other | HelperFrameEvent::CommandResult { .. } => {}
            }
            if permission_status_received && command_result_received {
                return Ok(());
            }
        }
    };

    let result = match tokio::time::timeout(PERMISSION_REFRESH_TIMEOUT, probe).await {
        Ok(result) => result.map_err(ToOwned::to_owned),
        Err(_) => Err("observer_permission_refresh_timeout".to_owned()),
    };
    let _ = send_simple_command(&mut stdin, "shutdown-probe", "shutdown").await;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    if child.id().is_some() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    stderr_task.abort();
    let _ = stderr_task.await;

    {
        let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
        clear_helper_connection(&mut current);
        current.state = resting_state;
        match &result {
            Ok(()) => {
                current.permission_check_state = MonitoringPermissionCheckState::Current;
                if current.last_error.as_deref() != Some(MONITORING_PERMISSIONS_PERSISTENCE_WARNING)
                {
                    current.last_error = previous_error.filter(|warning| {
                        !matches!(
                            warning.as_str(),
                            MONITORING_PERMISSIONS_LOAD_WARNING
                                | MONITORING_PERMISSIONS_PERSISTENCE_WARNING
                        )
                    });
                }
            }
            Err(code) => {
                current.permission_check_state = MonitoringPermissionCheckState::Failed;
                current.last_error = Some(code.clone());
            }
        }
    }
    if result.is_ok() && mode == PermissionProbeMode::Setup {
        complete_permission_setup(permissions_store, status)?;
    }
    result.map(|()| status_snapshot(status))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservationFrame {
    #[serde(rename = "type")]
    frame_type: String,
    schema_version: String,
    boot_id: String,
    sequence: u64,
    observed_at_ms: i64,
    observation: RawObservationInputV2,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GapFrame {
    #[serde(rename = "type")]
    frame_type: String,
    schema_version: String,
    boot_id: String,
    observed_at_ms: i64,
    reason: String,
    dropped_frames: u64,
    coverage: Vec<CoverageLevelV2>,
}

struct HelperFrameState {
    active_boot_id: Option<String>,
    last_sequence: u64,
    last_observation_at_ms: Option<i64>,
    last_heartbeat: Instant,
    permission_frame_received: bool,
}

struct AuthorizationFrame {
    boot_id: String,
    observed_at_ms: i64,
    permissions: MonitoringPermissions,
    reason: String,
    input_activity_health: Option<InputActivityHealthFrame>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct InputActivityHealthFrame {
    tap_ready: bool,
    last_callback_at_ms: Option<i64>,
    last_bucket_at_ms: Option<i64>,
}

async fn handle_helper_frame(
    bytes: &[u8],
    journal: &ObservationJournal,
    status: &Arc<Mutex<MonitoringStatusResult>>,
    permissions_store: &MonitoringPermissionsStore,
    stdin: &mut ChildStdin,
    frame_state: &mut HelperFrameState,
) -> Result<HelperFrameEvent, &'static str> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "observer_invalid_json")?;
    let frame_type = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or("observer_missing_frame_type")?;
    match frame_type {
        "observation" => {
            let frame: ObservationFrame =
                serde_json::from_value(value).map_err(|_| "observer_invalid_observation_frame")?;
            if frame.frame_type != "observation"
                || frame.schema_version != "observer-frame.v1"
                || frame.observation.schema_version != RAW_OBSERVATION_SCHEMA_VERSION
                || frame.sequence == 0
                || frame.observed_at_ms < frame.observation.interval.ended_at_ms
            {
                return Err("observer_invalid_observation_frame");
            }
            if frame_state.active_boot_id.as_deref() != Some(&frame.boot_id) {
                validate_boot_id(&frame.boot_id).map_err(|_| "observer_invalid_boot_id")?;
                frame_state.active_boot_id = Some(frame.boot_id.clone());
                frame_state.last_sequence = 0;
                frame_state.last_observation_at_ms = None;
            }
            if frame.sequence > frame_state.last_sequence.saturating_add(1) {
                let missing_from = frame_state.last_sequence.saturating_add(1);
                let missing_through = frame.sequence.saturating_sub(1);
                let gap_started_at_ms = frame_state
                    .last_observation_at_ms
                    .unwrap_or(frame.observation.interval.started_at_ms)
                    .min(frame.observation.interval.started_at_ms);
                let gap_ended_at_ms = frame.observation.interval.started_at_ms;
                journal
                    .record_coverage_gap(
                        &format!(
                            "observer:{}:sequence-gap:{missing_from}:{missing_through}",
                            frame.boot_id
                        ),
                        gap_started_at_ms,
                        gap_ended_at_ms,
                        "observer_sequence_gap",
                    )
                    .map_err(|_| "observer_gap_persistence_failed")?;
                let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
                push_coverage(&mut current.coverage, CoverageLevelV2::Unavailable);
                current.last_error = Some("observer_sequence_gap".to_owned());
            }
            let deduplication_key = format!("observer:{}:{}", frame.boot_id, frame.sequence);
            journal
                .ingest(&deduplication_key, frame.observation)
                .map_err(|_| "observer_persistence_failed")?;
            send_ack(stdin, &frame.boot_id, frame.sequence)
                .await
                .map_err(|_| "observer_ack_failed")?;
            frame_state.last_sequence = frame_state.last_sequence.max(frame.sequence);
            frame_state.last_observation_at_ms = Some(
                frame_state
                    .last_observation_at_ms
                    .unwrap_or(frame.observed_at_ms)
                    .max(frame.observed_at_ms),
            );
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.boot_id = Some(frame.boot_id);
            current.last_sequence = Some(frame_state.last_sequence);
            current.last_acked_sequence = Some(frame_state.last_sequence);
            Ok(HelperFrameEvent::Other)
        }
        "ready" | "heartbeat" | "permissionStatus" => {
            let event = if frame_type == "permissionStatus" {
                HelperFrameEvent::PermissionStatus
            } else {
                HelperFrameEvent::Other
            };
            frame_state.last_heartbeat = Instant::now();
            let authorization = parse_authorization_frame(&value)?;
            let permissions_cache_error =
                persist_permission_frame(permissions_store, status, &authorization).err();
            journal
                .append_authorization_change(
                    &authorization.boot_id,
                    authorization.observed_at_ms,
                    &authorization.permissions,
                    &authorization.reason,
                )
                .map_err(|_| "observer_permission_persistence_failed")?;
            apply_permission_frame(status, &authorization);
            frame_state.permission_frame_received = true;
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.state = MonitoringState::Running;
            current.last_error = permissions_cache_error
                .or_else(|| observation_key_warning(journal).map(ToOwned::to_owned));
            Ok(event)
        }
        "gap" => {
            let frame: GapFrame =
                serde_json::from_value(value).map_err(|_| "observer_invalid_gap_frame")?;
            if frame.frame_type != "gap"
                || frame.schema_version != "observer-frame.v1"
                || frame.observed_at_ms < 0
                || frame.dropped_frames == 0
                || frame.reason != "parent_backpressure"
                || frame.coverage != [CoverageLevelV2::Unavailable]
            {
                return Err("observer_invalid_gap_frame");
            }
            validate_boot_id(&frame.boot_id).map_err(|_| "observer_invalid_boot_id")?;
            journal
                .record_coverage_gap(
                    &format!(
                        "observer:{}:reported-gap:{}",
                        frame.boot_id, frame.observed_at_ms
                    ),
                    frame.observed_at_ms,
                    frame.observed_at_ms,
                    "observer_reported_gap",
                )
                .map_err(|_| "observer_gap_persistence_failed")?;
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            push_coverage(&mut current.coverage, CoverageLevelV2::Unavailable);
            current.last_error = Some("observer_reported_gap".to_owned());
            Ok(HelperFrameEvent::Other)
        }
        "error" => {
            let recoverable = value
                .get("recoverable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.last_error = Some("observer_reported_error".to_owned());
            if !recoverable {
                return Err("observer_unrecoverable_error");
            }
            Ok(HelperFrameEvent::Other)
        }
        "commandResult" => {
            let (id, ok) = parse_command_result_frame(&value)?;
            Ok(HelperFrameEvent::CommandResult { id, ok })
        }
        _ => Err("observer_unknown_frame"),
    }
}

fn handle_permission_probe_frame(
    bytes: &[u8],
    status: &Arc<Mutex<MonitoringStatusResult>>,
    permissions_store: &MonitoringPermissionsStore,
    journal: &ObservationJournal,
) -> Result<HelperFrameEvent, &'static str> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "observer_invalid_json")?;
    let frame_type = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or("observer_missing_frame_type")?;
    match frame_type {
        "ready" | "heartbeat" | "permissionStatus" => {
            let authorization = parse_authorization_frame(&value)?;
            let permissions_cache_error =
                persist_permission_frame(permissions_store, status, &authorization).err();
            journal
                .append_authorization_change(
                    &authorization.boot_id,
                    authorization.observed_at_ms,
                    &authorization.permissions,
                    &authorization.reason,
                )
                .map_err(|_| "observer_permission_persistence_failed")?;
            apply_permission_frame(status, &authorization);
            status
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .last_error = permissions_cache_error;
            Ok(if frame_type == "permissionStatus" {
                HelperFrameEvent::PermissionStatus
            } else {
                HelperFrameEvent::Other
            })
        }
        "commandResult" => {
            let (id, ok) = parse_command_result_frame(&value)?;
            Ok(HelperFrameEvent::CommandResult { id, ok })
        }
        "error" => Err("observer_probe_reported_error"),
        "observation" | "gap" => Err("observer_probe_started_sensors"),
        _ => Err("observer_unknown_frame"),
    }
}

async fn spawn_helper(helper_path: &Path) -> io::Result<(Child, JoinHandle<()>)> {
    validate_helper_before_spawn(helper_path)
        .map_err(|error| io::Error::new(io::ErrorKind::PermissionDenied, error))?;
    let mut child = Command::new(helper_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("observer helper stderr was unavailable"))?;
    // Helper diagnostics are intentionally drained and discarded. They must
    // never become an accidental content side channel in WhaleHall logs.
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });
    Ok((child, stderr_task))
}

fn start_command_value(id: &str, settings: &RuntimeSettings) -> Value {
    json!({
        "type": "command",
        "id": id,
        "command": "start",
        "config": {
            "captureContent": settings.capture_content,
            "excludedBundleIds": settings.excluded_bundle_ids,
        },
    })
}

fn simple_command_value(id: &str, command: &str) -> Value {
    json!({
        "type": "command",
        "id": id,
        "command": command,
    })
}

fn permission_refresh_command_value(id: &str) -> Value {
    json!({
        "type": "command",
        "id": id,
        "command": "refreshPermissions",
    })
}

fn permission_setup_command_value(id: &str) -> Value {
    json!({
        "type": "command",
        "id": id,
        "command": "setupPermissions",
    })
}

async fn send_start_command(
    stdin: &mut ChildStdin,
    id: &str,
    settings: &RuntimeSettings,
) -> io::Result<()> {
    write_helper_message(stdin, &start_command_value(id, settings)).await
}

async fn send_simple_command(stdin: &mut ChildStdin, id: &str, command: &str) -> io::Result<()> {
    write_helper_message(stdin, &simple_command_value(id, command)).await
}

async fn send_permission_refresh_command(stdin: &mut ChildStdin, id: &str) -> io::Result<()> {
    write_helper_message(stdin, &permission_refresh_command_value(id)).await
}

async fn send_permission_setup_command(stdin: &mut ChildStdin, id: &str) -> io::Result<()> {
    write_helper_message(stdin, &permission_setup_command_value(id)).await
}

async fn send_ack(stdin: &mut ChildStdin, boot_id: &str, sequence: u64) -> io::Result<()> {
    write_helper_message(
        stdin,
        &json!({
            "type": "ack",
            "bootId": boot_id,
            "sequence": sequence,
        }),
    )
    .await
}

async fn write_helper_message(stdin: &mut ChildStdin, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.len() > MAX_HELPER_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "observer command exceeds protocol bound",
        ));
    }
    stdin.write_all(&bytes).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

fn parse_authorization_frame(value: &Value) -> Result<AuthorizationFrame, &'static str> {
    if value.get("schemaVersion").and_then(Value::as_str) != Some("observer-frame.v1") {
        return Err("observer_invalid_permission_frame");
    }
    let frame_type = value
        .get("type")
        .and_then(Value::as_str)
        .filter(|frame_type| matches!(*frame_type, "ready" | "heartbeat" | "permissionStatus"))
        .ok_or("observer_invalid_permission_frame")?;
    let boot_id = value
        .get("bootId")
        .and_then(Value::as_str)
        .ok_or("observer_invalid_permission_frame")?;
    validate_boot_id(boot_id).map_err(|_| "observer_invalid_boot_id")?;
    let observed_at_ms = value
        .get("observedAtMs")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .ok_or("observer_invalid_permission_frame")?;
    let reason = match value.get("authorizationReason") {
        Some(Value::String(reason))
            if matches!(
                reason.as_str(),
                "startup_snapshot"
                    | "runtime_change"
                    | "manual_refresh"
                    | "status_request"
                    | "heartbeat_check"
            ) =>
        {
            reason.as_str()
        }
        None => match frame_type {
            "ready" => "startup_snapshot",
            "heartbeat" => "heartbeat_check",
            "permissionStatus" => "legacy_status",
            _ => unreachable!("permission frame type was validated"),
        },
        Some(_) => return Err("observer_invalid_permission_frame"),
    };
    let permissions = value
        .get("permissions")
        .and_then(Value::as_object)
        .or_else(|| {
            value
                .get("data")
                .and_then(Value::as_object)
                .and_then(|data| data.get("permissions"))
                .and_then(Value::as_object)
        })
        .ok_or("observer_invalid_permission_frame")?;
    let input_activity_health = parse_input_activity_health(value, observed_at_ms)?;
    Ok(AuthorizationFrame {
        boot_id: boot_id.to_owned(),
        observed_at_ms,
        permissions: MonitoringPermissions {
            accessibility: permission_state(permissions, "accessibility")
                .ok_or("observer_invalid_permission_frame")?,
            screen_recording: permission_state(permissions, "screenRecording")
                .ok_or("observer_invalid_permission_frame")?,
            input_monitoring: permission_state(permissions, "inputMonitoring")
                .ok_or("observer_invalid_permission_frame")?,
            automation: permission_state(permissions, "automation")
                .ok_or("observer_invalid_permission_frame")?,
        },
        reason: reason.to_owned(),
        input_activity_health,
    })
}

fn parse_input_activity_health(
    value: &Value,
    observed_at_ms: i64,
) -> Result<Option<InputActivityHealthFrame>, &'static str> {
    let tap_ready = value.get("tapReady");
    let last_callback_at_ms = value.get("lastCallbackAtMs");
    let last_bucket_at_ms = value.get("lastBucketAtMs");
    if tap_ready.is_none() && last_callback_at_ms.is_none() && last_bucket_at_ms.is_none() {
        return Ok(None);
    }
    let tap_ready = tap_ready
        .and_then(Value::as_bool)
        .ok_or("observer_invalid_input_activity_health")?;
    let last_callback_at_ms = parse_health_timestamp(last_callback_at_ms, observed_at_ms)?;
    let last_bucket_at_ms = parse_health_timestamp(last_bucket_at_ms, observed_at_ms)?;
    Ok(Some(InputActivityHealthFrame {
        tap_ready,
        last_callback_at_ms,
        last_bucket_at_ms,
    }))
}

fn parse_health_timestamp(
    value: Option<&Value>,
    observed_at_ms: i64,
) -> Result<Option<i64>, &'static str> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .filter(|timestamp| *timestamp >= 0 && *timestamp <= observed_at_ms)
            .map(Some)
            .ok_or("observer_invalid_input_activity_health"),
        None => Err("observer_invalid_input_activity_health"),
    }
}

fn apply_permission_frame(status: &Arc<Mutex<MonitoringStatusResult>>, frame: &AuthorizationFrame) {
    let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
    current.permissions = frame.permissions.clone();
    current.permission_check_state = MonitoringPermissionCheckState::Current;
    current.permissions_checked_at_ms = Some(frame.observed_at_ms);
    current.boot_id = Some(frame.boot_id.clone());
    current.last_heartbeat_at_ms = Some(frame.observed_at_ms);
    if let Some(health) = frame.input_activity_health {
        current.tap_ready = health.tap_ready;
        current.last_callback_at_ms = health.last_callback_at_ms;
        current.last_bucket_at_ms = health.last_bucket_at_ms;
    }
    let preserve_gap = current.coverage.contains(&CoverageLevelV2::Unavailable);
    current.coverage = vec![CoverageLevelV2::Metadata];
    if current.capture_content
        && (current.permissions.accessibility == MonitoringPermissionState::Granted
            || current.permissions.screen_recording == MonitoringPermissionState::Granted)
    {
        push_coverage(&mut current.coverage, CoverageLevelV2::Content);
    }
    if [
        current.permissions.accessibility,
        current.permissions.screen_recording,
        current.permissions.input_monitoring,
        current.permissions.automation,
    ]
    .contains(&MonitoringPermissionState::Denied)
    {
        push_coverage(&mut current.coverage, CoverageLevelV2::Denied);
    }
    if preserve_gap {
        push_coverage(&mut current.coverage, CoverageLevelV2::Unavailable);
    }
}

fn persist_permission_frame(
    store: &MonitoringPermissionsStore,
    status: &Arc<Mutex<MonitoringStatusResult>>,
    frame: &AuthorizationFrame,
) -> Result<(), String> {
    if !store.setup_available() {
        return Ok(());
    }
    let current = status_snapshot(status);
    let must_refresh_cache = current.permissions != frame.permissions
        || current.permissions_checked_at_ms.is_none()
        || matches!(frame.reason.as_str(), "startup_snapshot" | "manual_refresh");
    if !must_refresh_cache {
        return Ok(());
    }
    store.save(
        &frame.permissions,
        Some(frame.observed_at_ms),
        current.permission_setup_attempted,
    )
}

fn prepare_permission_setup(
    store: &MonitoringPermissionsStore,
    status: &Arc<Mutex<MonitoringStatusResult>>,
) -> Result<bool, String> {
    if !store.setup_available() {
        return Err("observer_permission_setup_identity_unavailable".to_owned());
    }
    let current = status_snapshot(status);
    if current.permission_setup_attempted {
        return Ok(false);
    }
    // Prove the identity-scoped cache is writable before invoking any request
    // API, but do not hide the setup entry yet. A helper launch/write failure,
    // crash, or timeout must remain recoverable by the same explicit user
    // action. TCC request APIs are never reached by a background path.
    store.save(
        &current.permissions,
        current.permissions_checked_at_ms,
        false,
    )?;
    Ok(true)
}

fn complete_permission_setup(
    store: &MonitoringPermissionsStore,
    status: &Arc<Mutex<MonitoringStatusResult>>,
) -> Result<(), String> {
    let current = status_snapshot(status);
    store.save(
        &current.permissions,
        current.permissions_checked_at_ms,
        true,
    )?;
    status
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .permission_setup_attempted = true;
    Ok(())
}

fn permission_state(
    permissions: &Map<String, Value>,
    key: &str,
) -> Option<MonitoringPermissionState> {
    match permissions.get(key).and_then(Value::as_str) {
        Some("unknown") => Some(MonitoringPermissionState::Unknown),
        Some("authorized" | "granted") => Some(MonitoringPermissionState::Granted),
        Some("denied") => Some(MonitoringPermissionState::Denied),
        Some("not_determined" | "notDetermined") => Some(MonitoringPermissionState::NotDetermined),
        Some("unsupported" | "unavailable") => Some(MonitoringPermissionState::Unsupported),
        _ => None,
    }
}

fn parse_command_result_frame(value: &Value) -> Result<(String, bool), &'static str> {
    if value.get("schemaVersion").and_then(Value::as_str) != Some("observer-frame.v1")
        || value
            .get("observedAtMs")
            .and_then(Value::as_i64)
            .is_none_or(|value| value < 0)
    {
        return Err("observer_invalid_command_result");
    }
    let boot_id = value
        .get("bootId")
        .and_then(Value::as_str)
        .ok_or("observer_invalid_command_result")?;
    validate_boot_id(boot_id).map_err(|_| "observer_invalid_boot_id")?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or("observer_invalid_command_result")?;
    let ok = value
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or("observer_invalid_command_result")?;
    Ok((id.to_owned(), ok))
}

fn update_configuration_status(
    status: &Arc<Mutex<MonitoringStatusResult>>,
    settings: &RuntimeSettings,
) {
    let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
    current.enabled = settings.enabled;
    current.capture_content = settings.capture_content;
    current.excluded_bundle_ids = settings.excluded_bundle_ids.clone();
    current.helper_path_available = settings.helper_path.is_some();
    if !settings.capture_content {
        current
            .coverage
            .retain(|coverage| *coverage != CoverageLevelV2::Content);
    }
}

fn set_state(
    status: &Arc<Mutex<MonitoringStatusResult>>,
    state: MonitoringState,
    error_code: Option<&str>,
) {
    let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
    current.state = state;
    if state != MonitoringState::Running {
        current.tap_ready = false;
    }
    let preserve_warning = error_code.is_none()
        && matches!(
            current.last_error.as_deref(),
            Some(
                DEV_LEGACY_KEYCHAIN_WARNING
                    | MONITORING_SETTINGS_LOAD_WARNING
                    | MONITORING_SETTINGS_PERSISTENCE_WARNING
                    | MONITORING_PERMISSIONS_LOAD_WARNING
                    | MONITORING_PERMISSIONS_PERSISTENCE_WARNING
            )
        );
    if !preserve_warning {
        current.last_error = error_code.map(ToOwned::to_owned);
    }
}

fn set_permission_check_state(
    status: &Arc<Mutex<MonitoringStatusResult>>,
    state: MonitoringPermissionCheckState,
) {
    let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
    current.permission_check_state = state;
}

fn status_snapshot(status: &Arc<Mutex<MonitoringStatusResult>>) -> MonitoringStatusResult {
    status
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

fn clear_helper_connection(status: &mut MonitoringStatusResult) {
    status.helper_pid = None;
    status.boot_id = None;
    status.tap_ready = false;
}

fn push_coverage(values: &mut Vec<CoverageLevelV2>, value: CoverageLevelV2) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn prepare_monitoring_directory(path: &Path, error_code: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(error_code.to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| error_code.to_owned())?;
        }
        Err(_) => return Err(error_code.to_owned()),
    }
    harden_monitoring_settings_directory(path).map_err(|_| error_code.to_owned())
}

#[cfg(unix)]
fn harden_monitoring_settings_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn harden_monitoring_settings_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn harden_monitoring_settings_file(file: &File) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn harden_monitoring_settings_file(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_monitoring_settings_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_monitoring_settings_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn validate_boot_id(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(());
    }
    Ok(())
}

fn validate_excluded_bundle_ids(values: &[String]) -> Result<(), String> {
    if values.len() > 256 {
        return Err("excludedBundleIds exceeds 256 entries".to_owned());
    }
    let mut unique = std::collections::HashSet::new();
    for value in values {
        if value.is_empty()
            || value.len() > 256
            || !value
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
            || !unique.insert(value)
        {
            return Err(
                "excludedBundleIds must be unique, bounded macOS bundle identifiers".to_owned(),
            );
        }
    }
    Ok(())
}

fn parse_bool(name: &str, default: bool) -> Result<bool, String> {
    match std::env::var(name) {
        Ok(value) if matches!(value.as_str(), "true" | "1" | "yes") => Ok(true),
        Ok(value) if matches!(value.as_str(), "false" | "0" | "no") => Ok(false),
        Ok(_) => Err(format!("{name} must be true/false, 1/0, or yes/no")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid UTF-8")),
    }
}

fn resolve_helper_path() -> Result<Option<PathBuf>, String> {
    let runtime_channel = runtime_channel_from_environment()?;
    #[cfg(not(debug_assertions))]
    if std::env::var_os(HELPER_PATH_ENV).is_some() {
        return Err(format!(
            "{HELPER_PATH_ENV} is disabled in release builds; the signed sibling helper is required"
        ));
    }
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os(HELPER_PATH_ENV) {
        if runtime_channel == RuntimeChannel::Stable {
            return Err(format!(
                "{HELPER_PATH_ENV} is disabled for the stable runtime channel"
            ));
        }
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!("{HELPER_PATH_ENV} must be an absolute path"));
        }
        return Ok(path.is_file().then_some(path));
    }
    let executable =
        std::env::current_exe().map_err(|_| "cannot resolve local host path".to_owned())?;
    let sibling = expected_helper_path(&executable)?;
    if !sibling.is_file() {
        return Ok(None);
    }
    validate_packaged_observer(&executable, &sibling, runtime_channel)?;
    Ok(Some(sibling))
}

fn expected_helper_path(executable: &Path) -> Result<PathBuf, String> {
    let parent = executable
        .parent()
        .ok_or_else(|| "cannot resolve local host directory".to_owned())?;
    Ok(parent
        .join(OBSERVER_BUNDLE_NAME)
        .join("Contents")
        .join("MacOS")
        .join(OBSERVER_EXECUTABLE_NAME))
}

fn runtime_channel_from_environment() -> Result<RuntimeChannel, String> {
    match std::env::var(RUNTIME_CHANNEL_ENV) {
        Ok(value) => RuntimeChannel::parse(&value),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(format!("{RUNTIME_CHANNEL_ENV} must be valid UTF-8"))
        }
        Err(std::env::VarError::NotPresent) => {
            #[cfg(debug_assertions)]
            {
                Ok(RuntimeChannel::Dev)
            }
            #[cfg(not(debug_assertions))]
            {
                Err(format!(
                    "{RUNTIME_CHANNEL_ENV} is required in release builds"
                ))
            }
        }
    }
}

fn validate_helper_before_spawn(helper_path: &Path) -> Result<(), String> {
    let runtime_channel = runtime_channel_from_environment()?;
    let executable =
        std::env::current_exe().map_err(|_| "cannot resolve local host path".to_owned())?;
    let expected = expected_helper_path(&executable)?;
    if helper_path == expected {
        return validate_packaged_observer(&executable, helper_path, runtime_channel);
    }
    #[cfg(debug_assertions)]
    {
        if runtime_channel != RuntimeChannel::Stable
            && std::env::var_os(HELPER_PATH_ENV)
                .is_some_and(|value| Path::new(&value) == helper_path)
        {
            return Ok(());
        }
    }
    Err("observer helper must be the fixed sibling bundle executable".to_owned())
}

fn validate_packaged_observer(
    local_executable: &Path,
    helper_path: &Path,
    runtime_channel: RuntimeChannel,
) -> Result<(), String> {
    let bundle_path = helper_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "observer helper bundle layout is invalid".to_owned())?;
    if bundle_path.file_name().and_then(|value| value.to_str()) != Some(OBSERVER_BUNDLE_NAME)
        || helper_path.file_name().and_then(|value| value.to_str())
            != Some(OBSERVER_EXECUTABLE_NAME)
    {
        return Err("observer helper bundle layout is invalid".to_owned());
    }
    let bundle_id = read_bundle_identifier(bundle_path)?;
    if bundle_id != OBSERVER_BUNDLE_ID {
        return Err("observer helper bundle identifier is invalid".to_owned());
    }
    verify_code_signature(bundle_path)?;
    if runtime_channel == RuntimeChannel::Stable {
        verify_code_signature(local_executable)?;
        let local_team = read_team_identifier(local_executable)?;
        let observer_team = read_team_identifier(bundle_path)?;
        validate_stable_team_identifiers(local_team.as_deref(), observer_team.as_deref())?;
    }
    Ok(())
}

fn read_bundle_identifier(bundle_path: &Path) -> Result<String, String> {
    let info_plist = bundle_path.join("Contents").join("Info.plist");
    let output = StdCommand::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(&info_plist)
        .output()
        .map_err(|_| "cannot inspect observer helper Info.plist".to_owned())?;
    if !output.status.success() {
        return Err("cannot inspect observer helper Info.plist".to_owned());
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| "observer helper bundle identifier is not UTF-8".to_owned())?;
    Ok(value.trim().to_owned())
}

fn verify_code_signature(path: &Path) -> Result<(), String> {
    let status = StdCommand::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(path)
        .status()
        .map_err(|_| "cannot verify observer code signature".to_owned())?;
    if status.success() {
        Ok(())
    } else {
        Err("observer code signature verification failed".to_owned())
    }
}

fn read_team_identifier(path: &Path) -> Result<Option<String>, String> {
    let output = StdCommand::new("/usr/bin/codesign")
        .args(["--display", "--verbose=4"])
        .arg(path)
        .output()
        .map_err(|_| "cannot inspect code signing team identifier".to_owned())?;
    if !output.status.success() {
        return Err("cannot inspect code signing team identifier".to_owned());
    }
    let details = String::from_utf8(output.stderr)
        .map_err(|_| "code signing details are not UTF-8".to_owned())?;
    parse_team_identifier(&details)
}

fn parse_team_identifier(details: &str) -> Result<Option<String>, String> {
    let mut values = details
        .lines()
        .filter_map(|line| line.strip_prefix("TeamIdentifier="));
    let Some(value) = values.next() else {
        return Err("code signing team identifier is missing".to_owned());
    };
    if values.next().is_some() {
        return Err("code signing team identifier is ambiguous".to_owned());
    }
    if value == "not set" {
        return Ok(None);
    }
    if value.len() != 10
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err("code signing team identifier is invalid".to_owned());
    }
    Ok(Some(value.to_owned()))
}

fn validate_stable_team_identifiers(
    local_team: Option<&str>,
    observer_team: Option<&str>,
) -> Result<(), String> {
    match (local_team, observer_team) {
        (Some(local), Some(observer)) if local == observer => Ok(()),
        (None, _) | (_, None) => Err(
            "stable observer and whalehall-local signatures require non-empty TeamIdentifier"
                .to_owned(),
        ),
        _ => {
            Err("stable observer and whalehall-local TeamIdentifier values do not match".to_owned())
        }
    }
}

fn observation_key_warning(journal: &ObservationJournal) -> Option<&'static str> {
    (journal.key_storage_mode() == Some(ObservationKeyStorageMode::LegacyDevelopmentKeychain))
        .then_some(DEV_LEGACY_KEYCHAIN_WARNING)
}

fn trim_line_end(bytes: &mut Vec<u8>) {
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use whalehall_local_core::observations::{
        ObservationJournalConfig, UnavailableObservationKeyProvider,
    };

    fn test_journal(directory: &Path) -> ObservationJournal {
        let mut config = ObservationJournalConfig::new(
            directory.join("observation-journal.sqlite3"),
            Arc::new(UnavailableObservationKeyProvider),
        );
        config.device_id = Some("observer-test-device".to_owned());
        config.session_id = Some("observer-test-session".to_owned());
        ObservationJournal::open_with_config(config).expect("open test observation journal")
    }

    fn test_runtime_settings() -> RuntimeSettings {
        RuntimeSettings {
            enabled: false,
            paused: false,
            capture_content: true,
            excluded_bundle_ids: Vec::new(),
            helper_path: None,
        }
    }

    fn test_identity_fingerprint() -> String {
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned()
    }

    fn test_permissions_store(directory: &Path) -> MonitoringPermissionsStore {
        MonitoringPermissionsStore::new(directory, Some(test_identity_fingerprint()))
    }

    fn test_status() -> Arc<Mutex<MonitoringStatusResult>> {
        Arc::new(Mutex::new(MonitoringStatusResult {
            state: MonitoringState::Starting,
            enabled: false,
            capture_content: false,
            excluded_bundle_ids: Vec::new(),
            helper_pid: None,
            helper_path_available: false,
            boot_id: None,
            last_sequence: None,
            last_acked_sequence: None,
            last_heartbeat_at_ms: None,
            tap_ready: false,
            last_callback_at_ms: None,
            last_bucket_at_ms: None,
            permissions: MonitoringPermissions::default(),
            permission_check_state: MonitoringPermissionCheckState::Unchecked,
            permissions_checked_at_ms: None,
            permission_setup_available: true,
            permission_setup_attempted: false,
            coverage: vec![CoverageLevelV2::Metadata],
            last_error: None,
        }))
    }

    #[test]
    fn monitoring_settings_are_private_atomic_and_allowlisted() {
        let directory = tempfile::tempdir().expect("create monitoring settings directory");
        let store = MonitoringSettingsStore::new(directory.path());
        let settings = RuntimeSettings {
            enabled: true,
            paused: true,
            capture_content: false,
            excluded_bundle_ids: vec!["com.example.private".to_owned()],
            helper_path: Some(PathBuf::from(
                "/tmp/https://private.example/observed-window-title.txt",
            )),
        };

        store.save(&settings).expect("persist monitoring settings");
        let loaded = store
            .load()
            .expect("load monitoring settings")
            .expect("settings exist");
        assert!(loaded.enabled);
        assert!(loaded.paused);
        assert!(!loaded.capture_content);
        assert_eq!(
            loaded.excluded_bundle_ids,
            vec!["com.example.private".to_owned()]
        );

        let bytes = fs::read(&store.settings_path).expect("read settings file");
        let value: Value = serde_json::from_slice(&bytes).expect("parse settings JSON");
        let keys = value
            .as_object()
            .expect("settings object")
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            keys,
            std::collections::BTreeSet::from([
                "captureContent",
                "enabled",
                "excludedBundleIds",
                "paused",
                "schemaVersion",
            ])
        );
        let serialized = String::from_utf8(bytes).expect("settings JSON is UTF-8");
        assert!(!serialized.contains("helperPath"));
        assert!(!serialized.contains("https://private.example"));
        assert!(!serialized.contains("observed-window-title"));
        assert!(
            fs::read_dir(&store.directory_path)
                .expect("list monitoring settings directory")
                .all(|entry| {
                    entry
                        .expect("read monitoring settings entry")
                        .path()
                        .file_name()
                        .is_some_and(|name| name == MONITORING_SETTINGS_FILE)
                })
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let directory_mode = fs::metadata(&store.directory_path)
                .expect("monitoring settings directory metadata")
                .permissions()
                .mode()
                & 0o777;
            let file_mode = fs::metadata(&store.settings_path)
                .expect("monitoring settings file metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(directory_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }
    }

    #[test]
    fn monitoring_permissions_cache_is_private_atomic_and_allowlisted() {
        let directory = tempfile::tempdir().expect("create monitoring permissions directory");
        let store = test_permissions_store(directory.path());
        let permissions = MonitoringPermissions {
            accessibility: MonitoringPermissionState::Granted,
            screen_recording: MonitoringPermissionState::Denied,
            input_monitoring: MonitoringPermissionState::Granted,
            automation: MonitoringPermissionState::Unsupported,
        };

        store
            .save(&permissions, Some(1_800_000_000_000), false)
            .expect("persist monitoring permissions");
        let loaded = store
            .load()
            .expect("load monitoring permissions")
            .expect("permissions exist");
        assert_eq!(loaded.permissions, permissions);
        assert_eq!(loaded.checked_at_ms, Some(1_800_000_000_000));
        assert!(!loaded.setup_attempted);
        assert_eq!(loaded.identity_fingerprint, test_identity_fingerprint());

        let bytes = fs::read(&store.permissions_path).expect("read permissions cache");
        let value: Value = serde_json::from_slice(&bytes).expect("parse permissions cache");
        let keys = value
            .as_object()
            .expect("permissions object")
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            keys,
            std::collections::BTreeSet::from([
                "checkedAtMs",
                "identityFingerprint",
                "permissions",
                "schemaVersion",
                "setupAttempted",
            ])
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                fs::metadata(&store.directory_path)
                    .expect("permissions directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&store.permissions_path)
                    .expect("permissions file metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn corrupt_monitoring_permissions_cache_is_rejected_without_guessing() {
        let directory = tempfile::tempdir().expect("create monitoring permissions directory");
        let store = test_permissions_store(directory.path());
        prepare_monitoring_directory(&store.directory_path, MONITORING_PERMISSIONS_LOAD_WARNING)
            .expect("prepare permissions directory");
        fs::write(
            &store.permissions_path,
            br#"{
                "schemaVersion":"monitoring-permissions.v2",
                "identityFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "setupAttempted":false,
                "checkedAtMs":1800000000000,
                "permissions":{
                    "accessibility":"granted",
                    "screenRecording":"denied",
                    "inputMonitoring":"granted",
                    "automation":"unsupported"
                },
                "unexpected":"must fail closed"
            }"#,
        )
        .expect("write corrupt permissions cache");

        assert_eq!(
            store.load().unwrap_err(),
            MONITORING_PERMISSIONS_LOAD_WARNING
        );
    }

    #[test]
    fn permission_identity_accepts_developer_id_and_fixed_local_certificate() {
        let developer = r#"
# designated => identifier "com.seago.whalehall.observer" and anchor apple generic
Identifier=com.seago.whalehall.observer
TeamIdentifier=A1B2C3D4E5
"#;
        assert_eq!(
            parse_permission_identity_details(developer).unwrap(),
            (
                "developer-team:A1B2C3D4E5".to_owned(),
                "identifier \"com.seago.whalehall.observer\" and anchor apple generic".to_owned(),
            )
        );

        let local = r#"
# designated => identifier "com.seago.whalehall.observer" and certificate leaf = H"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
Identifier=com.seago.whalehall.observer
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#;
        assert_eq!(
            parse_permission_identity_details(local).unwrap(),
            (
                "local-certificate:whalehall-local-development:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                "identifier \"com.seago.whalehall.observer\" and certificate leaf = H\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"".to_owned(),
            )
        );
    }

    #[test]
    fn permission_identity_combines_codesign_stdout_and_stderr() {
        let details = decode_codesign_identity_output(
            br#"designated => identifier "com.seago.whalehall.observer" and certificate leaf = H"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
"#,
            br#"Executable=/Applications/WhaleHall Observer.app/Contents/MacOS/whalehall-observer
Identifier=com.seago.whalehall.observer
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#,
        )
        .expect("decode split codesign output");
        assert_eq!(
            parse_permission_identity_details(&details).unwrap(),
            (
                "local-certificate:whalehall-local-development:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                "identifier \"com.seago.whalehall.observer\" and certificate leaf = H\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"".to_owned(),
            )
        );
        assert!(decode_codesign_identity_output(&[0xff], b"valid").is_err());
        assert!(decode_codesign_identity_output(b"valid", &[0xff]).is_err());
    }

    #[test]
    fn permission_identity_binds_app_and_observer_to_the_same_certificate() {
        let app = r#"
designated => identifier "com.seago.whalehall" and certificate leaf = H"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
Identifier=com.seago.whalehall
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#;
        let observer = r#"
designated => identifier "com.seago.whalehall.observer" and certificate leaf = H"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
Identifier=com.seago.whalehall.observer
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#;

        let material = permission_identity_material(
            WHALEHALL_APP_BUNDLE_ID,
            app,
            OBSERVER_BUNDLE_ID,
            observer,
        )
        .expect("bind matching app and observer identities");
        assert!(material.starts_with("whalehall-permission-identity.v2\0"));
        assert!(material.contains("\0com.seago.whalehall\0"));
        assert!(material.contains("\0com.seago.whalehall.observer\0"));
        assert!(material.ends_with(
            "\0local-certificate:whalehall-local-development:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ));
    }

    #[test]
    fn permission_identity_rejects_mismatched_app_and_observer_identities() {
        let app = r#"
designated => identifier "com.seago.whalehall" and certificate leaf = H"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
Identifier=com.seago.whalehall
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#;
        let observer = r#"
designated => identifier "com.seago.whalehall.observer" and certificate leaf = H"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
Identifier=com.seago.whalehall.observer
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#;

        assert_eq!(
            permission_identity_material(
                WHALEHALL_APP_BUNDLE_ID,
                app,
                OBSERVER_BUNDLE_ID,
                observer,
            )
            .unwrap_err(),
            "observer_permission_setup_identity_unavailable"
        );
    }

    #[test]
    fn permission_identity_rejects_bundle_or_requirement_identifier_mismatches() {
        let app = r#"
designated => identifier "com.seago.whalehall" and certificate leaf = H"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
Identifier=com.seago.whalehall
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#;
        let wrong_observer_requirement = r#"
designated => identifier "com.seago.whalehall.observer.preview" and certificate leaf = H"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
Identifier=com.seago.whalehall.observer
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#;
        let observer = r#"
designated => identifier "com.seago.whalehall.observer" and certificate leaf = H"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
Identifier=com.seago.whalehall.observer
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#;

        for result in [
            permission_identity_material(
                WHALEHALL_APP_BUNDLE_ID,
                app,
                OBSERVER_BUNDLE_ID,
                wrong_observer_requirement,
            ),
            permission_identity_material(
                "com.seago.whalehall.preview",
                app,
                OBSERVER_BUNDLE_ID,
                observer,
            ),
        ] {
            assert_eq!(
                result.unwrap_err(),
                "observer_permission_setup_identity_unavailable"
            );
        }
    }

    #[test]
    fn permission_identity_rejects_adhoc_and_ambiguous_local_signatures() {
        for details in [
            r#"
# designated => cdhash H"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
Signature=adhoc
TeamIdentifier=not set
"#,
            r#"
# designated => identifier "com.seago.whalehall.observer"
Authority=WhaleHall Local Development
TeamIdentifier=not set
"#,
            r#"
# designated => identifier "com.seago.whalehall.observer" and certificate leaf = H"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
Authority=Unexpected Local Authority
TeamIdentifier=not set
"#,
        ] {
            assert_eq!(
                parse_permission_identity_details(details).unwrap_err(),
                "observer_permission_setup_identity_unavailable"
            );
        }
    }

    #[test]
    fn setup_send_failure_or_crash_does_not_commit_the_identity_marker() {
        let directory = tempfile::tempdir().expect("create monitoring permissions directory");
        let store = test_permissions_store(directory.path());
        let status = test_status();

        assert!(prepare_permission_setup(&store, &status).expect("prepare first setup"));
        assert!(!status_snapshot(&status).permission_setup_attempted);
        let persisted = store
            .load()
            .expect("load setup preparation")
            .expect("setup preparation exists");
        assert!(!persisted.setup_attempted);
        assert_eq!(persisted.checked_at_ms, None);

        // A new process after a launch/write failure or helper crash restores
        // an actionable setup entry instead of permanently hiding it.
        assert!(
            prepare_permission_setup(&store, &test_status())
                .expect("retry setup after interrupted attempt")
        );

        complete_permission_setup(&store, &status).expect("complete confirmed setup");
        assert!(status_snapshot(&status).permission_setup_attempted);
        assert!(
            store
                .load()
                .expect("load completed marker")
                .expect("completed marker exists")
                .setup_attempted
        );
        assert!(!prepare_permission_setup(&store, &status).expect("repeat setup is passive"));

        let other_identity = MonitoringPermissionsStore::new(
            directory.path(),
            Some(
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .to_owned(),
            ),
        );
        assert!(
            other_identity
                .load()
                .expect("identity mismatch is not corruption")
                .is_none()
        );

        let unavailable = MonitoringPermissionsStore::new(directory.path(), None);
        assert_eq!(
            prepare_permission_setup(&unavailable, &test_status()).unwrap_err(),
            "observer_permission_setup_identity_unavailable"
        );
    }

    #[test]
    fn permission_commands_never_serialize_a_prompt_field() {
        let settings = test_runtime_settings();
        for command in [
            start_command_value("start", &settings),
            simple_command_value("pause", "pause"),
            simple_command_value("resume", "resume"),
            simple_command_value("shutdown", "shutdown"),
        ] {
            assert!(command.get("prompt").is_none());
        }

        let passive_refresh = permission_refresh_command_value("refresh");
        assert_eq!(
            passive_refresh.get("command").and_then(Value::as_str),
            Some("refreshPermissions")
        );
        assert!(passive_refresh.get("prompt").is_none());
        let explicit_setup = permission_setup_command_value("setup");
        assert_eq!(
            explicit_setup.get("command").and_then(Value::as_str),
            Some("setupPermissions")
        );
        assert!(explicit_setup.get("prompt").is_none());
    }

    #[test]
    fn unchanged_heartbeat_does_not_rewrite_permission_cache() {
        let directory = tempfile::tempdir().expect("create monitoring permissions directory");
        let store = test_permissions_store(directory.path());
        let status = test_status();
        let permissions = MonitoringPermissions {
            accessibility: MonitoringPermissionState::Granted,
            screen_recording: MonitoringPermissionState::Granted,
            input_monitoring: MonitoringPermissionState::Granted,
            automation: MonitoringPermissionState::Unsupported,
        };
        {
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.permissions = permissions.clone();
            current.permissions_checked_at_ms = Some(100);
        }
        store
            .save(&permissions, Some(100), false)
            .expect("seed permissions cache");
        let frame = AuthorizationFrame {
            boot_id: "boot-heartbeat".to_owned(),
            observed_at_ms: 200,
            permissions,
            reason: "heartbeat_check".to_owned(),
            input_activity_health: None,
        };

        persist_permission_frame(&store, &status, &frame).expect("unchanged heartbeat is accepted");
        assert_eq!(
            store
                .load()
                .expect("load cache")
                .expect("cache exists")
                .checked_at_ms,
            Some(100)
        );
    }

    #[tokio::test]
    async fn idle_changes_persist_before_response_and_restore_after_restart() {
        let directory = tempfile::tempdir().expect("create monitoring settings directory");
        let store = MonitoringSettingsStore::new(directory.path());
        let permissions_store = test_permissions_store(directory.path());
        let journal = test_journal(directory.path());
        let status = test_status();
        let mut settings = test_runtime_settings();
        let (configure_response, configured) = oneshot::channel();

        assert!(
            !handle_idle_command(
                SupervisorCommand::Configure {
                    params: MonitoringConfigureParams {
                        enabled: true,
                        capture_content: false,
                        excluded_bundle_ids: vec!["com.example.excluded".to_owned()],
                    },
                    response: configure_response,
                },
                &mut settings,
                &status,
                &store,
                &permissions_store,
                &journal,
            )
            .await
        );
        configured
            .await
            .expect("configure response")
            .expect("configure succeeds");
        let persisted_after_configure = store
            .load()
            .expect("load configured settings")
            .expect("configured settings exist");
        assert!(persisted_after_configure.enabled);
        assert!(!persisted_after_configure.capture_content);
        assert!(!persisted_after_configure.paused);

        let (pause_response, paused) = oneshot::channel();
        assert!(
            !handle_idle_command(
                SupervisorCommand::Pause {
                    response: pause_response,
                },
                &mut settings,
                &status,
                &store,
                &permissions_store,
                &journal,
            )
            .await
        );
        paused
            .await
            .expect("pause response")
            .expect("pause succeeds");

        let (restored, warning) = load_runtime_settings(
            ObserverSupervisorConfig {
                enabled: false,
                capture_content: true,
                excluded_bundle_ids: Vec::new(),
                helper_path: Some(PathBuf::from("/tmp/helper")),
            },
            &store,
        );
        assert_eq!(warning, None);
        assert!(restored.enabled);
        assert!(restored.paused);
        assert!(!restored.capture_content);
        assert_eq!(
            restored.excluded_bundle_ids,
            vec!["com.example.excluded".to_owned()]
        );
        assert_eq!(restored.helper_path, Some(PathBuf::from("/tmp/helper")));
    }

    #[test]
    fn corrupt_monitoring_settings_fail_closed() {
        let directory = tempfile::tempdir().expect("create monitoring settings directory");
        let store = MonitoringSettingsStore::new(directory.path());
        store
            .prepare_directory()
            .expect("prepare monitoring settings directory");
        fs::write(
            &store.settings_path,
            br#"{
                "schemaVersion":"monitoring-settings.v1",
                "enabled":true,
                "captureContent":true,
                "paused":false,
                "excludedBundleIds":[],
                "url":"https://private.example/secret"
            }"#,
        )
        .expect("write corrupt settings");

        let (restored, warning) = load_runtime_settings(
            ObserverSupervisorConfig {
                enabled: true,
                capture_content: true,
                excluded_bundle_ids: vec!["com.example.environment".to_owned()],
                helper_path: None,
            },
            &store,
        );
        assert_eq!(warning.as_deref(), Some(MONITORING_SETTINGS_LOAD_WARNING));
        assert!(!restored.enabled);
        assert!(!restored.paused);
        assert!(!restored.capture_content);
        assert!(restored.excluded_bundle_ids.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn monitoring_settings_loader_rejects_symlinks_without_touching_the_target() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let directory = tempfile::tempdir().expect("create monitoring settings directory");
        let store = MonitoringSettingsStore::new(directory.path());
        store
            .prepare_directory()
            .expect("prepare monitoring settings directory");
        let target = directory.path().join("outside-settings.json");
        fs::write(
            &target,
            br#"{
                "schemaVersion":"monitoring-settings.v1",
                "enabled":true,
                "captureContent":true,
                "paused":false,
                "excludedBundleIds":[]
            }"#,
        )
        .expect("write symlink target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644))
            .expect("set target permissions");
        symlink(&target, &store.settings_path).expect("create settings symlink");

        assert_eq!(store.load().unwrap_err(), MONITORING_SETTINGS_LOAD_WARNING);
        let target_mode = fs::metadata(&target)
            .expect("target metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(target_mode, 0o644);
    }

    #[tokio::test]
    async fn persistence_failure_rejects_change_without_mutating_runtime_settings() {
        let directory = tempfile::tempdir().expect("create monitoring settings directory");
        fs::write(
            directory.path().join(MONITORING_SETTINGS_DIRECTORY),
            b"not a directory",
        )
        .expect("block monitoring settings directory");
        let store = MonitoringSettingsStore::new(directory.path());
        let permissions_store = test_permissions_store(directory.path());
        let journal = test_journal(directory.path());
        let status = test_status();
        let mut settings = test_runtime_settings();
        let original = settings.clone();
        let (response, completed) = oneshot::channel();

        assert!(
            !handle_idle_command(
                SupervisorCommand::Configure {
                    params: MonitoringConfigureParams {
                        enabled: true,
                        capture_content: false,
                        excluded_bundle_ids: vec!["com.example.excluded".to_owned()],
                    },
                    response,
                },
                &mut settings,
                &status,
                &store,
                &permissions_store,
                &journal,
            )
            .await
        );
        assert_eq!(
            completed.await.expect("configure response").unwrap_err(),
            MONITORING_SETTINGS_PERSISTENCE_WARNING
        );
        assert_eq!(settings, original);
        assert_eq!(
            status_snapshot(&status).last_error.as_deref(),
            Some(MONITORING_SETTINGS_PERSISTENCE_WARNING)
        );
    }

    #[test]
    fn monitoring_exclusions_accept_only_bundle_identifiers() {
        assert!(
            validate_excluded_bundle_ids(&[
                "com.apple.Passwords".to_owned(),
                "com.example.private-app".to_owned(),
            ])
            .is_ok()
        );
        for value in [
            "https://private.example/window-title",
            "敏感窗口标题",
            "com.example/private",
            ".com.example",
        ] {
            assert!(
                validate_excluded_bundle_ids(&[value.to_owned()]).is_err(),
                "{value} must not be persisted as a bundle identifier"
            );
        }
    }

    #[test]
    fn runtime_channel_parser_accepts_only_electrobun_channels() {
        assert_eq!(RuntimeChannel::parse("dev").unwrap(), RuntimeChannel::Dev);
        assert_eq!(
            RuntimeChannel::parse("canary").unwrap(),
            RuntimeChannel::Canary
        );
        assert_eq!(
            RuntimeChannel::parse("stable").unwrap(),
            RuntimeChannel::Stable
        );
        for invalid in ["", "production", "Stable", "nightly", "stable "] {
            assert!(RuntimeChannel::parse(invalid).is_err());
        }
    }

    #[test]
    fn team_identifier_parser_distinguishes_adhoc_and_developer_id_signatures() {
        assert_eq!(
            parse_team_identifier("Signature=adhoc\nTeamIdentifier=not set\n").unwrap(),
            None
        );
        assert_eq!(
            parse_team_identifier("Identifier=test\nTeamIdentifier=A1B2C3D4E5\n").unwrap(),
            Some("A1B2C3D4E5".to_owned())
        );
        assert!(parse_team_identifier("Identifier=test\n").is_err());
        assert!(parse_team_identifier("TeamIdentifier=lowercase1\n").is_err());
        assert!(
            parse_team_identifier("TeamIdentifier=A1B2C3D4E5\nTeamIdentifier=A1B2C3D4E5\n")
                .is_err()
        );
    }

    #[test]
    fn stable_team_policy_requires_equal_non_empty_identifiers() {
        assert!(validate_stable_team_identifiers(Some("A1B2C3D4E5"), Some("A1B2C3D4E5")).is_ok());
        assert!(validate_stable_team_identifiers(None, Some("A1B2C3D4E5")).is_err());
        assert!(validate_stable_team_identifiers(Some("A1B2C3D4E5"), None).is_err());
        assert!(validate_stable_team_identifiers(Some("A1B2C3D4E5"), Some("Z9Y8X7W6V5")).is_err());
    }

    #[test]
    fn restart_failures_latch_on_fifth_failure_inside_ten_minutes() {
        let base = Instant::now();
        let mut failures = RestartFailures::default();
        for offset in [0, 60, 120, 180] {
            assert!(!failures.record(base + Duration::from_secs(offset)));
        }
        assert!(failures.record(base + Duration::from_secs(240)));
    }

    #[test]
    fn restart_failures_outside_window_are_pruned_and_manual_clear_resets() {
        let base = Instant::now();
        let mut failures = RestartFailures::default();
        for offset in [0, 60, 120, 180] {
            assert!(!failures.record(base + Duration::from_secs(offset)));
        }
        assert!(!failures.record(base + FAILURE_WINDOW + Duration::from_secs(1)));
        failures.clear();
        assert!(!failures.record(base + FAILURE_WINDOW + Duration::from_secs(2)));
    }

    #[test]
    fn state_updates_preserve_dev_keychain_warning_until_a_real_error_occurs() {
        let status = test_status();
        status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .last_error = Some(DEV_LEGACY_KEYCHAIN_WARNING.to_owned());
        set_state(&status, MonitoringState::Disabled, None);
        assert_eq!(
            status_snapshot(&status).last_error.as_deref(),
            Some(DEV_LEGACY_KEYCHAIN_WARNING)
        );
        set_state(
            &status,
            MonitoringState::Degraded,
            Some("observer_helper_start_failed"),
        );
        assert_eq!(
            status_snapshot(&status).last_error.as_deref(),
            Some("observer_helper_start_failed")
        );
    }

    #[tokio::test]
    async fn permission_refresh_waits_for_matching_status_and_command_result() {
        let directory = tempfile::tempdir().expect("create monitoring permissions directory");
        let permissions_store = test_permissions_store(directory.path());
        let status = test_status();
        {
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.permission_check_state = MonitoringPermissionCheckState::Current;
            current.permissions_checked_at_ms = Some(1_800_000_000_000);
        }
        let (response, completed) = oneshot::channel();
        let mut pending = Some(PendingPermissionRefresh {
            command_id: PERMISSION_REFRESH_COMMAND_ID,
            completes_permission_setup: false,
            permission_status_received: false,
            command_result_received: false,
            deadline: Instant::now() + PERMISSION_REFRESH_TIMEOUT,
            response,
        });

        handle_permission_refresh_event(
            HelperFrameEvent::CommandResult {
                id: "unrelated-command".to_owned(),
                ok: true,
            },
            &status,
            &permissions_store,
            &mut pending,
        );
        handle_permission_refresh_event(
            HelperFrameEvent::PermissionStatus,
            &status,
            &permissions_store,
            &mut pending,
        );
        assert!(pending.is_some());

        handle_permission_refresh_event(
            HelperFrameEvent::CommandResult {
                id: PERMISSION_REFRESH_COMMAND_ID.to_owned(),
                ok: true,
            },
            &status,
            &permissions_store,
            &mut pending,
        );
        assert!(pending.is_none());
        let result = completed.await.expect("refresh response").expect("success");
        assert_eq!(
            result.permission_check_state,
            MonitoringPermissionCheckState::Current
        );
    }

    #[tokio::test]
    async fn setup_timeout_keeps_the_explicit_entry_retryable() {
        let directory = tempfile::tempdir().expect("create monitoring permissions directory");
        let permissions_store = test_permissions_store(directory.path());
        let status = test_status();
        assert!(
            prepare_permission_setup(&permissions_store, &status).expect("prepare explicit setup")
        );
        let (response, completed) = oneshot::channel();
        let mut pending = Some(PendingPermissionRefresh {
            command_id: PERMISSION_SETUP_COMMAND_ID,
            completes_permission_setup: true,
            permission_status_received: true,
            command_result_received: false,
            deadline: Instant::now(),
            response,
        });

        fail_pending_permission_refresh(
            &status,
            &mut pending,
            "observer_permission_refresh_timeout",
        );
        assert!(pending.is_none());
        assert_eq!(
            completed.await.expect("timeout response").unwrap_err(),
            "observer_permission_refresh_timeout"
        );
        assert!(!status_snapshot(&status).permission_setup_attempted);
        assert!(
            prepare_permission_setup(&permissions_store, &status).expect("retry after timeout")
        );
    }

    #[tokio::test]
    async fn confirmed_setup_handshake_commits_once_per_identity() {
        let directory = tempfile::tempdir().expect("create monitoring permissions directory");
        let permissions_store = test_permissions_store(directory.path());
        let status = test_status();
        assert!(
            prepare_permission_setup(&permissions_store, &status).expect("prepare explicit setup")
        );
        let (response, completed) = oneshot::channel();
        let mut pending = Some(PendingPermissionRefresh {
            command_id: PERMISSION_SETUP_COMMAND_ID,
            completes_permission_setup: true,
            permission_status_received: false,
            command_result_received: false,
            deadline: Instant::now() + PERMISSION_REFRESH_TIMEOUT,
            response,
        });

        handle_permission_refresh_event(
            HelperFrameEvent::PermissionStatus,
            &status,
            &permissions_store,
            &mut pending,
        );
        handle_permission_refresh_event(
            HelperFrameEvent::CommandResult {
                id: PERMISSION_SETUP_COMMAND_ID.to_owned(),
                ok: true,
            },
            &status,
            &permissions_store,
            &mut pending,
        );
        assert!(pending.is_none());
        assert!(
            completed
                .await
                .expect("setup response")
                .expect("confirmed setup")
                .permission_setup_attempted
        );
        assert!(
            permissions_store
                .load()
                .expect("load completed setup")
                .expect("completed setup exists")
                .setup_attempted
        );
        assert!(
            !prepare_permission_setup(&permissions_store, &status)
                .expect("subsequent explicit action is passive")
        );
    }

    #[test]
    fn permission_check_converges_when_session_exits_before_its_first_permission_frame() {
        let status = test_status();
        set_permission_check_state(&status, MonitoringPermissionCheckState::Checking);
        settle_permission_check_after_session(
            &status,
            SessionOutcome::Restart,
            false,
            MonitoringPermissionCheckState::Unchecked,
        );
        assert_eq!(
            status_snapshot(&status).permission_check_state,
            MonitoringPermissionCheckState::Failed
        );

        for outcome in [
            SessionOutcome::Reconfigure,
            SessionOutcome::Disabled,
            SessionOutcome::Shutdown,
        ] {
            set_permission_check_state(&status, MonitoringPermissionCheckState::Checking);
            settle_permission_check_after_session(
                &status,
                outcome,
                false,
                MonitoringPermissionCheckState::Unchecked,
            );
            let snapshot = status_snapshot(&status);
            assert_eq!(
                snapshot.permission_check_state,
                MonitoringPermissionCheckState::Unchecked
            );
            assert_eq!(snapshot.permissions_checked_at_ms, None);
        }

        {
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.permission_check_state = MonitoringPermissionCheckState::Checking;
            current.permissions_checked_at_ms = Some(1_800_000_000_000);
        }
        settle_permission_check_after_session(
            &status,
            SessionOutcome::Disabled,
            false,
            MonitoringPermissionCheckState::Current,
        );
        let snapshot = status_snapshot(&status);
        assert_eq!(
            snapshot.permission_check_state,
            MonitoringPermissionCheckState::Current
        );
        assert_eq!(snapshot.permissions_checked_at_ms, Some(1_800_000_000_000));
    }

    #[test]
    fn helper_disconnect_clears_tap_readiness_before_restart_backoff() {
        let status = test_status();
        {
            let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
            current.state = MonitoringState::Running;
            current.helper_pid = Some(42);
            current.boot_id = Some("boot-disconnected".to_owned());
            current.tap_ready = true;
            current.last_callback_at_ms = Some(1_800_000_000_000);
            current.last_bucket_at_ms = Some(1_799_999_995_000);
            clear_helper_connection(&mut current);
        }

        let snapshot = status_snapshot(&status);
        assert_eq!(snapshot.helper_pid, None);
        assert_eq!(snapshot.boot_id, None);
        assert!(!snapshot.tap_ready);
        // Last-seen timestamps remain useful diagnostics while the helper is
        // backing off; only live readiness must be cleared immediately.
        assert_eq!(snapshot.last_callback_at_ms, Some(1_800_000_000_000));
        assert_eq!(snapshot.last_bucket_at_ms, Some(1_799_999_995_000));
    }

    #[tokio::test]
    async fn permission_refresh_deadline_does_not_wait_for_the_health_tick() {
        let deadline = Instant::now();
        assert!(
            tokio::time::timeout(
                Duration::from_secs(1),
                wait_for_permission_refresh_deadline(Some(deadline)),
            )
            .await
            .is_ok()
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(10),
                wait_for_permission_refresh_deadline(None),
            )
            .await
            .is_err()
        );
    }

    #[test]
    fn permission_frames_expose_check_timestamp_and_probe_rejects_observations() {
        let directory = tempfile::tempdir().expect("create authorization journal directory");
        let journal = test_journal(directory.path());
        let permissions_store = test_permissions_store(directory.path());
        let status = test_status();
        let permission_frame = br#"{
            "type":"permissionStatus",
            "schemaVersion":"observer-frame.v1",
            "bootId":"boot-1",
            "observedAtMs":1800000000000,
            "authorizationReason":"manual_refresh",
            "permissions":{
                "accessibility":"authorized",
                "screenRecording":"denied",
                "inputMonitoring":"not_determined",
                "automation":"unsupported"
            },
            "tapReady":true,
            "lastCallbackAtMs":1799999999998,
            "lastBucketAtMs":1799999995000
        }"#;
        assert!(matches!(
            handle_permission_probe_frame(permission_frame, &status, &permissions_store, &journal,),
            Ok(HelperFrameEvent::PermissionStatus)
        ));
        let snapshot = status_snapshot(&status);
        assert_eq!(
            snapshot.permission_check_state,
            MonitoringPermissionCheckState::Current
        );
        assert_eq!(snapshot.permissions_checked_at_ms, Some(1_800_000_000_000));
        assert_eq!(
            snapshot.permissions.accessibility,
            MonitoringPermissionState::Granted
        );
        assert!(snapshot.tap_ready);
        assert_eq!(snapshot.last_callback_at_ms, Some(1_799_999_999_998));
        assert_eq!(snapshot.last_bucket_at_ms, Some(1_799_999_995_000));
        let legacy_frame = br#"{
            "type":"permissionStatus",
            "schemaVersion":"observer-frame.v1",
            "bootId":"boot-legacy",
            "observedAtMs":1800000000001,
            "permissions":{
                "accessibility":"denied",
                "screenRecording":"denied",
                "inputMonitoring":"not_determined",
                "automation":"unsupported"
            }
        }"#;
        assert!(matches!(
            handle_permission_probe_frame(legacy_frame, &status, &permissions_store, &journal,),
            Ok(HelperFrameEvent::PermissionStatus)
        ));
        // Additive health fields remain backward-compatible with an older
        // helper, and an old frame cannot erase the latest known health.
        let snapshot = status_snapshot(&status);
        assert!(snapshot.tap_ready);
        assert_eq!(snapshot.last_callback_at_ms, Some(1_799_999_999_998));
        assert_eq!(snapshot.last_bucket_at_ms, Some(1_799_999_995_000));
        let authorization_events = journal
            .query_semantic(&whalehall_local_protocol::SemanticQueryParams {
                after_cursor: None,
                consumer_id: None,
                limit: 100,
                include_content: true,
            })
            .expect("query persisted authorization frames")
            .events;
        assert_eq!(
            authorization_events
                .last()
                .expect("legacy frame must be persisted")
                .payload["reason"],
            "legacy_status"
        );
        assert_eq!(
            handle_permission_probe_frame(
                br#"{"type":"observation"}"#,
                &status,
                &permissions_store,
                &journal,
            )
            .err(),
            Some("observer_probe_started_sensors")
        );

        for invalid_health in [
            br#"{
                "type":"permissionStatus",
                "schemaVersion":"observer-frame.v1",
                "bootId":"boot-invalid-partial",
                "observedAtMs":1800000000000,
                "authorizationReason":"manual_refresh",
                "permissions":{
                    "accessibility":"authorized",
                    "screenRecording":"authorized",
                    "inputMonitoring":"authorized",
                    "automation":"unsupported"
                },
                "tapReady":true
            }"#
            .as_slice(),
            br#"{
                "type":"heartbeat",
                "schemaVersion":"observer-frame.v1",
                "bootId":"boot-invalid-future",
                "observedAtMs":1800000000000,
                "authorizationReason":"heartbeat_check",
                "permissions":{
                    "accessibility":"authorized",
                    "screenRecording":"authorized",
                    "inputMonitoring":"authorized",
                    "automation":"unsupported"
                },
                "tapReady":true,
                "lastCallbackAtMs":1800000000001,
                "lastBucketAtMs":null
            }"#
            .as_slice(),
        ] {
            assert_eq!(
                handle_permission_probe_frame(
                    invalid_health,
                    &status,
                    &permissions_store,
                    &journal,
                )
                .err(),
                Some("observer_invalid_input_activity_health")
            );
        }
    }
}
