use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::broadcast;
use whalehall_local_protocol::{
    AuditQueryFiveMinutesParams, CoverageLevelV2, EventGoalChangeParams, EvidenceReliabilityV2,
    MAX_SEMANTIC_QUERY_LIMIT, MonitoringPermissionState, MonitoringPermissions,
    ObservationIntervalV2, ObservationSensorV2, ObservationSourceV2, ObservationSubjectV2,
    RAW_OBSERVATION_SCHEMA_VERSION, RawObservationInputV2, RawObservationV2,
    SEMANTIC_EVENT_SCHEMA_VERSION, SEMANTIC_PROJECTOR_VERSION, SEMANTIC_TAXONOMY_VERSION,
    SemanticCommitParams, SemanticCommitResult, SemanticContentStateV2, SemanticCountClassV2,
    SemanticEventV2, SemanticQueryParams, SemanticQueryResult, VaultDeleteBatchParams,
    VaultDeleteBatchResult, VaultDeleteResult, VaultOpenBatchParams, VaultOpenBatchResult,
    VaultOpenResult, VaultSealBatchParams, VaultSealBatchResult, VaultSealResult,
    semantic_event_kinds,
};
use zeroize::Zeroizing;

const SCHEMA_VERSION: i64 = 2;
const RAW_CURSOR_PREFIX: &str = "sc2_";
const SEMANTIC_CURSOR_PREFIX: &str = "sec2_";
const DEFAULT_RAW_CONTENT_RETENTION_DAYS: u64 = 7;
const DEFAULT_DERIVED_RETENTION_DAYS: u64 = 30;
const DEFAULT_BROADCAST_CAPACITY: usize = 256;
const KEY_LOAD_RETRY_DELAYS: [Duration; 5] = [
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(45),
    Duration::from_secs(2 * 60),
    Duration::from_secs(5 * 60),
];
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_CONTENT_BYTES: usize = 64 * 1024;
const MAX_VAULT_RECORD_BYTES: usize = 512 * 1024;
const MAX_VAULT_BATCH_BYTES: usize = 768 * 1024;
const MAX_VAULT_BATCH_RECORDS: usize = 64;
#[cfg(any(target_os = "macos", test))]
pub(crate) const KEY_VERSION: &str = "keychain-v1";
#[cfg(any(target_os = "macos", test))]
pub(crate) const LEGACY_DEV_KEY_VERSION: &str = "keychain-dev-legacy-v1";
const FIVE_MINUTES_MS: i64 = 300_000;
const DEVICE_ID_ENV: &str = "WHALEHALL_DEVICE_ID";
const SESSION_ID_ENV: &str = "WHALEHALL_SESSION_ID";
const AUTHORIZATION_SNAPSHOT_META_KEY: &str = "authorization_snapshot_v1";
const AUTHORIZATION_SNAPSHOT_SCHEMA_VERSION: &str = "authorization-snapshot.v1";
static INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct ObservationJournalConfig {
    pub database_path: PathBuf,
    pub raw_content_retention: Duration,
    pub derived_retention: Duration,
    pub broadcast_capacity: usize,
    pub key_provider: Arc<dyn ObservationKeyProvider>,
    pub device_id: Option<String>,
    pub session_id: Option<String>,
}

impl ObservationJournalConfig {
    pub fn new(
        database_path: impl Into<PathBuf>,
        key_provider: Arc<dyn ObservationKeyProvider>,
    ) -> Self {
        Self {
            database_path: database_path.into(),
            raw_content_retention: Duration::from_secs(
                DEFAULT_RAW_CONTENT_RETENTION_DAYS * 24 * 60 * 60,
            ),
            derived_retention: Duration::from_secs(DEFAULT_DERIVED_RETENTION_DAYS * 24 * 60 * 60),
            broadcast_capacity: DEFAULT_BROADCAST_CAPACITY,
            key_provider,
            device_id: None,
            session_id: None,
        }
    }
}

#[derive(Clone)]
pub struct ObservationKey {
    bytes: Zeroizing<[u8; 32]>,
    version: String,
    storage_mode: ObservationKeyStorageMode,
}

impl ObservationKey {
    pub fn from_bytes(bytes: [u8; 32], version: impl Into<String>) -> Self {
        Self::from_stored_bytes(bytes, version, ObservationKeyStorageMode::Custom)
    }

    pub(crate) fn from_stored_bytes(
        bytes: [u8; 32],
        version: impl Into<String>,
        storage_mode: ObservationKeyStorageMode,
    ) -> Self {
        Self::from_zeroizing_bytes(Zeroizing::new(bytes), version, storage_mode)
    }

    pub(crate) fn from_zeroizing_bytes(
        bytes: Zeroizing<[u8; 32]>,
        version: impl Into<String>,
        storage_mode: ObservationKeyStorageMode,
    ) -> Self {
        Self {
            bytes,
            version: version.into(),
            storage_mode,
        }
    }

    fn bytes(&self) -> &[u8; 32] {
        &self.bytes
    }

    pub(crate) fn version(&self) -> &str {
        &self.version
    }

    pub(crate) fn storage_mode(&self) -> ObservationKeyStorageMode {
        self.storage_mode
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ObservationKeyError {
    #[error("observation encryption key is unavailable")]
    Unavailable,
    #[error("legacy observation encryption key migration is required")]
    MigrationRequired { interactive_available: bool },
    #[error("interactive observation encryption key migration is unsupported")]
    MigrationUnsupported,
    #[error("the observation encryption key migration target contains a different key")]
    MigrationConflict,
    #[error("the migrated observation encryption key failed read-back verification")]
    MigrationVerificationFailed,
    #[error("observation encryption key has an invalid size")]
    InvalidSize,
    #[error("observation encryption key storage failed")]
    Storage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObservationKeyStorageMode {
    DataProtectionKeychain,
    LocalLoginKeychain,
    LegacyDevelopmentKeychain,
    Custom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObservationKeyAvailability {
    Available,
    MigrationRequired,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationKeyStatus {
    pub availability: ObservationKeyAvailability,
    pub storage_mode: Option<ObservationKeyStorageMode>,
    pub key_version: Option<String>,
    pub interactive_migration_available: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationKeyMigrationResult {
    pub migrated: bool,
    pub storage_mode: ObservationKeyStorageMode,
    pub key_version: String,
}

pub trait ObservationKeyProvider: Send + Sync {
    /// Loads or creates the production key without ever allowing Keychain UI.
    fn load_or_create(&self) -> Result<ObservationKey, ObservationKeyError>;

    /// Performs the one operation that may display Keychain UI. Callers must
    /// expose this only behind an explicit user action.
    fn migrate_legacy_key_interactive(
        &self,
    ) -> Result<(ObservationKey, bool), ObservationKeyError> {
        Err(ObservationKeyError::MigrationUnsupported)
    }
}

/// Deterministic provider for unit tests and explicitly constructed embedders.
/// Production server setup never selects it from an environment variable.
#[derive(Clone)]
pub struct MemoryObservationKeyProvider {
    key: ObservationKey,
}

impl MemoryObservationKeyProvider {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self {
            key: ObservationKey::from_bytes(bytes, "memory-test-v1"),
        }
    }
}

impl ObservationKeyProvider for MemoryObservationKeyProvider {
    fn load_or_create(&self) -> Result<ObservationKey, ObservationKeyError> {
        Ok(self.key.clone())
    }
}

#[derive(Clone, Default)]
pub struct UnavailableObservationKeyProvider;

impl ObservationKeyProvider for UnavailableObservationKeyProvider {
    fn load_or_create(&self) -> Result<ObservationKey, ObservationKeyError> {
        Err(ObservationKeyError::Unavailable)
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct MacKeychainObservationKeyProvider {
    signing_identity: MacSigningIdentity,
}

#[cfg(target_os = "macos")]
impl ObservationKeyProvider for MacKeychainObservationKeyProvider {
    fn load_or_create(&self) -> Result<ObservationKey, ObservationKeyError> {
        use security_framework::os::macos::keychain::SecKeychain;

        let _operation_guard = mac_keychain_operation_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _interaction_guard =
            SecKeychain::disable_user_interaction().map_err(|_| ObservationKeyError::Storage)?;
        load_or_create_mac_key(self.signing_identity)
    }

    fn migrate_legacy_key_interactive(
        &self,
    ) -> Result<(ObservationKey, bool), ObservationKeyError> {
        use security_framework::os::macos::keychain::SecKeychain;

        let _operation_guard = mac_keychain_operation_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !SecKeychain::user_interaction_allowed().map_err(|_| ObservationKeyError::Storage)? {
            return Err(ObservationKeyError::MigrationUnsupported);
        }
        migrate_mac_legacy_key(self.signing_identity)
    }
}

#[cfg(target_os = "macos")]
const MAC_KEYCHAIN_SERVICE: &str = "com.seago.whalehall.observation-v2";
#[cfg(target_os = "macos")]
const MAC_LEGACY_DEV_KEYCHAIN_SERVICE: &str = "com.seago.whalehall.observation-v2.dev-legacy";
#[cfg(target_os = "macos")]
const MAC_KEYCHAIN_ACCOUNT: &str = "local-aes-256-gcm-key-v1";
#[cfg(target_os = "macos")]
const MAC_MIGRATED_LEGACY_ACCOUNT: &str = "local-aes-256-gcm-key-from-dev-legacy-v1";
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacSigningIdentity {
    TeamSigned,
    StableLocal,
    AdHoc,
    Unsupported,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacKeychainTarget {
    DataProtection,
}

#[cfg(target_os = "macos")]
impl MacKeychainTarget {
    fn for_signing_identity(identity: MacSigningIdentity) -> Option<Self> {
        match identity {
            MacSigningIdentity::TeamSigned => Some(Self::DataProtection),
            MacSigningIdentity::StableLocal
            | MacSigningIdentity::AdHoc
            | MacSigningIdentity::Unsupported => None,
        }
    }

    fn storage_mode(self) -> ObservationKeyStorageMode {
        match self {
            Self::DataProtection => ObservationKeyStorageMode::DataProtectionKeychain,
        }
    }
}

#[cfg(target_os = "macos")]
enum LegacyMacKey {
    Found(Zeroizing<Vec<u8>>),
    Missing,
    Inaccessible,
}

#[cfg(target_os = "macos")]
fn mac_keychain_operation_lock() -> &'static Mutex<()> {
    static OPERATION_LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    OPERATION_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(target_os = "macos")]
fn current_mac_signing_identity() -> MacSigningIdentity {
    let Ok(executable) = std::env::current_exe() else {
        return MacSigningIdentity::Unsupported;
    };
    let Ok(output) = std::process::Command::new("/usr/bin/codesign")
        .arg("--display")
        .arg("--verbose=4")
        .arg(executable)
        .output()
    else {
        return MacSigningIdentity::Unsupported;
    };
    if !output.status.success() {
        return MacSigningIdentity::Unsupported;
    }
    classify_mac_signing_details(&String::from_utf8_lossy(&output.stderr))
}

#[cfg(target_os = "macos")]
fn classify_mac_signing_details(details: &str) -> MacSigningIdentity {
    let mut is_adhoc = false;
    let mut team_identifier = None;
    let mut has_authority = false;
    for line in details.lines().map(str::trim) {
        if line == "Signature=adhoc" {
            is_adhoc = true;
        } else if let Some(value) = line.strip_prefix("TeamIdentifier=") {
            team_identifier = Some(value);
        } else if line.starts_with("Authority=") {
            has_authority = true;
        }
    }
    if is_adhoc {
        MacSigningIdentity::AdHoc
    } else if team_identifier.is_some_and(|value| !value.is_empty() && value != "not set") {
        MacSigningIdentity::TeamSigned
    } else if has_authority {
        MacSigningIdentity::StableLocal
    } else {
        MacSigningIdentity::Unsupported
    }
}

#[cfg(target_os = "macos")]
fn load_or_create_mac_key(
    signing_identity: MacSigningIdentity,
) -> Result<ObservationKey, ObservationKeyError> {
    let Some(target) = MacKeychainTarget::for_signing_identity(signing_identity) else {
        return Err(ObservationKeyError::Unavailable);
    };

    if let Some(bytes) = read_mac_target_key(target, MAC_MIGRATED_LEGACY_ACCOUNT)? {
        return key_from_stored_slice(&bytes, LEGACY_DEV_KEY_VERSION, target.storage_mode());
    }
    if let Some(bytes) = read_mac_target_key(target, MAC_KEYCHAIN_ACCOUNT)? {
        return key_from_stored_slice(&bytes, KEY_VERSION, target.storage_mode());
    }

    match read_legacy_mac_key() {
        LegacyMacKey::Found(_) | LegacyMacKey::Inaccessible => {
            return Err(ObservationKeyError::MigrationRequired {
                interactive_available: true,
            });
        }
        LegacyMacKey::Missing => {}
    }

    let mut generated = Zeroizing::new([0_u8; 32]);
    getrandom::fill(generated.as_mut()).map_err(|_| ObservationKeyError::Storage)?;
    write_mac_target_key(target, MAC_KEYCHAIN_ACCOUNT, generated.as_ref())?;
    let persisted =
        read_mac_target_key(target, MAC_KEYCHAIN_ACCOUNT)?.ok_or(ObservationKeyError::Storage)?;
    key_from_stored_slice(&persisted, KEY_VERSION, target.storage_mode())
}

#[cfg(target_os = "macos")]
fn migrate_mac_legacy_key(
    signing_identity: MacSigningIdentity,
) -> Result<(ObservationKey, bool), ObservationKeyError> {
    let target = MacKeychainTarget::for_signing_identity(signing_identity)
        .ok_or(ObservationKeyError::MigrationUnsupported)?;
    let source = match read_legacy_mac_key() {
        LegacyMacKey::Found(bytes) => bytes,
        LegacyMacKey::Missing | LegacyMacKey::Inaccessible => {
            return Err(ObservationKeyError::Unavailable);
        }
    };
    if source.len() != 32 {
        return Err(ObservationKeyError::InvalidSize);
    }

    if read_mac_target_key(target, MAC_KEYCHAIN_ACCOUNT)?.is_some() {
        return Err(ObservationKeyError::MigrationConflict);
    }

    let migrated = match read_mac_target_key(target, MAC_MIGRATED_LEGACY_ACCOUNT)? {
        Some(existing) if existing.as_slice() == source.as_slice() => false,
        Some(_) => return Err(ObservationKeyError::MigrationConflict),
        None => {
            write_mac_target_key(target, MAC_MIGRATED_LEGACY_ACCOUNT, source.as_slice())?;
            true
        }
    };
    let persisted = read_mac_target_key(target, MAC_MIGRATED_LEGACY_ACCOUNT)?
        .ok_or(ObservationKeyError::MigrationVerificationFailed)?;
    let key = verified_migrated_key(
        source.as_slice(),
        persisted.as_slice(),
        target.storage_mode(),
    )?;
    Ok((key, migrated))
}

#[cfg(target_os = "macos")]
fn read_legacy_mac_key() -> LegacyMacKey {
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};

    let Ok(keychain) = SecKeychain::default_for_domain(SecPreferencesDomain::User) else {
        return LegacyMacKey::Inaccessible;
    };
    match keychain.find_generic_password(MAC_LEGACY_DEV_KEYCHAIN_SERVICE, MAC_KEYCHAIN_ACCOUNT) {
        Ok((bytes, _)) => LegacyMacKey::Found(Zeroizing::new(bytes.as_ref().to_vec())),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => LegacyMacKey::Missing,
        Err(_) => LegacyMacKey::Inaccessible,
    }
}

#[cfg(target_os = "macos")]
fn read_mac_target_key(
    target: MacKeychainTarget,
    account: &str,
) -> Result<Option<Zeroizing<Vec<u8>>>, ObservationKeyError> {
    use security_framework::passwords::{PasswordOptions, generic_password};

    match target {
        MacKeychainTarget::DataProtection => {
            let mut options = PasswordOptions::new_generic_password(MAC_KEYCHAIN_SERVICE, account);
            options.set_access_synchronized(Some(false));
            options.use_protected_keychain();
            match generic_password(options) {
                Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
                Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
                Err(_) => Err(ObservationKeyError::Unavailable),
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn write_mac_target_key(
    target: MacKeychainTarget,
    account: &str,
    bytes: &[u8],
) -> Result<(), ObservationKeyError> {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{PasswordOptions, set_generic_password_options};

    match target {
        MacKeychainTarget::DataProtection => {
            let access = SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                0,
            )
            .map_err(|_| ObservationKeyError::Storage)?;
            let mut options = PasswordOptions::new_generic_password(MAC_KEYCHAIN_SERVICE, account);
            options.set_access_synchronized(Some(false));
            options.use_protected_keychain();
            options.set_access_control(access);
            set_generic_password_options(bytes, options).map_err(|_| ObservationKeyError::Storage)
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn key_from_stored_slice(
    bytes: &[u8],
    version: impl Into<String>,
    storage_mode: ObservationKeyStorageMode,
) -> Result<ObservationKey, ObservationKeyError> {
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ObservationKeyError::InvalidSize)?;
    Ok(ObservationKey::from_stored_bytes(
        bytes,
        version,
        storage_mode,
    ))
}

#[cfg(any(target_os = "macos", test))]
fn verified_migrated_key(
    source: &[u8],
    persisted: &[u8],
    storage_mode: ObservationKeyStorageMode,
) -> Result<ObservationKey, ObservationKeyError> {
    if source.len() != 32 {
        return Err(ObservationKeyError::InvalidSize);
    }
    if persisted != source {
        return Err(ObservationKeyError::MigrationVerificationFailed);
    }
    key_from_stored_slice(persisted, LEGACY_DEV_KEY_VERSION, storage_mode)
}

fn production_observation_key_provider(database_path: &Path) -> Arc<dyn ObservationKeyProvider> {
    #[cfg(target_os = "macos")]
    {
        match current_mac_signing_identity() {
            MacSigningIdentity::TeamSigned => Arc::new(MacKeychainObservationKeyProvider {
                signing_identity: MacSigningIdentity::TeamSigned,
            }),
            MacSigningIdentity::StableLocal => {
                match crate::vault_broker::VaultBrokerObservationKeyProvider::install_for_database(
                    database_path,
                ) {
                    Ok(provider) => Arc::new(provider),
                    Err(_) => Arc::new(UnavailableObservationKeyProvider),
                }
            }
            MacSigningIdentity::AdHoc | MacSigningIdentity::Unsupported => {
                Arc::new(UnavailableObservationKeyProvider)
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = database_path;
        Arc::new(UnavailableObservationKeyProvider)
    }
}

#[derive(Debug, Error)]
pub enum ObservationJournalError {
    #[error("Observation journal configuration error: {0}")]
    Configuration(String),
    #[error("Observation journal database I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Observation journal database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Observation journal JSON operation failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Observation content encryption is unavailable")]
    KeyUnavailable,
    #[error("Observation encryption key migration failed: {0}")]
    KeyMigration(ObservationKeyError),
    #[error("Observation content encryption failed")]
    Encryption,
    #[error("Observation content authentication failed")]
    Authentication,
    #[error("Invalid semantic cursor: {0}")]
    InvalidCursor(String),
    #[error("Semantic consumer {consumer_id} cannot move backwards from {current} to {attempted}")]
    CursorRegression {
        consumer_id: String,
        current: String,
        attempted: String,
    },
    #[error("Observation idempotency key was reused with different data")]
    IdempotencyConflict,
    #[error("Vault record id was reused with different content")]
    VaultConflict,
    #[error("Vault record is missing, expired, or belongs to another namespace")]
    VaultRecordUnavailable,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ObservationAppendResult {
    pub observation: RawObservationV2,
    pub semantic_event: SemanticEventV2,
    pub inserted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationCleanupResult {
    pub expired_raw_contents: usize,
    pub expired_semantic_contents: usize,
    pub deleted_observations: usize,
    pub deleted_semantic_events: usize,
    pub deleted_coverage_gaps: usize,
    pub deleted_vault_records: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ObservationAuditRangeResult {
    pub from_ms: i64,
    pub to_ms: i64,
    pub coverage: Vec<CoverageLevelV2>,
    pub raw_observations: Vec<RawObservationV2>,
    pub semantic_events: Vec<SemanticEventV2>,
}

#[derive(Clone)]
pub struct ObservationJournal {
    inner: Arc<ObservationJournalInner>,
}

struct ObservationJournalInner {
    database_path: PathBuf,
    device_id: String,
    session_id: String,
    raw_content_retention_ms: i64,
    derived_retention_ms: i64,
    key_provider: Arc<dyn ObservationKeyProvider>,
    key_state: Mutex<ObservationKeyState>,
    write_guard: Mutex<()>,
    publisher: broadcast::Sender<SemanticEventV2>,
}

enum ObservationKeyState {
    Ready(ObservationKey),
    RetryAfter {
        error: ObservationKeyError,
        retry_at: Instant,
        failure_count: usize,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptionAad<'a> {
    owner_kind: &'a str,
    owner_id: &'a str,
    schema_version: &'a str,
    started_at_ms: i64,
    ended_at_ms: i64,
    content_hash: &'a str,
    key_version: &'a str,
}

struct EncryptedValue {
    content_ref: String,
    key_version: String,
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
    content_hash: String,
}

#[derive(Clone)]
struct StoredEncryptedValue {
    owner_kind: String,
    owner_id: String,
    schema_version: String,
    started_at_ms: i64,
    ended_at_ms: i64,
    key_version: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    content_hash: String,
}

impl ObservationJournal {
    pub fn open(database_path: impl Into<PathBuf>) -> Result<Self, ObservationJournalError> {
        let database_path = database_path.into();
        let mut config = ObservationJournalConfig::new(
            database_path.clone(),
            production_observation_key_provider(&database_path),
        );
        config.device_id = identity_from_environment(DEVICE_ID_ENV)?;
        config.session_id = identity_from_environment(SESSION_ID_ENV)?;
        Self::open_with_config(config)
    }

    pub fn open_with_config(
        config: ObservationJournalConfig,
    ) -> Result<Self, ObservationJournalError> {
        if config.broadcast_capacity == 0 {
            return Err(ObservationJournalError::Configuration(
                "semantic broadcast capacity must be greater than zero".to_owned(),
            ));
        }
        let raw_content_retention_ms =
            duration_ms("raw content retention", config.raw_content_retention)?;
        let derived_retention_ms = duration_ms("derived retention", config.derived_retention)?;
        if derived_retention_ms < raw_content_retention_ms {
            return Err(ObservationJournalError::Configuration(
                "derived retention must not be shorter than raw content retention".to_owned(),
            ));
        }
        if let Some(parent) = config
            .database_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            let existed = parent.exists();
            fs::create_dir_all(parent)?;
            if !existed {
                harden_directory_permissions(parent)?;
            }
        }
        let mut connection = connect(&config.database_path)?;
        initialize(&mut connection)?;
        let device_id = match config.device_id.as_deref() {
            Some(device_id) => {
                validate_ascii_identifier("observation device id", device_id, 128)?;
                device_id.to_owned()
            }
            None => load_or_create_meta_id(&connection, "device_id", "device2")?,
        };
        let session_id = match config.session_id.as_deref() {
            Some(session_id) => {
                validate_ascii_identifier("observation session id", session_id, 128)?;
                session_id.to_owned()
            }
            None => generate_instance_id("session2"),
        };
        let (publisher, _) = broadcast::channel(config.broadcast_capacity);
        // Keychain access is attempted once when the journal opens. The
        // production provider is strictly non-interactive. Persist failures in
        // memory so high-frequency content observations cannot turn one
        // unavailable Keychain into an I/O attempt per event.
        let key_state =
            key_state_from_result(config.key_provider.load_or_create(), Instant::now(), 1);
        Ok(Self {
            inner: Arc::new(ObservationJournalInner {
                database_path: config.database_path,
                device_id,
                session_id,
                raw_content_retention_ms,
                derived_retention_ms,
                key_provider: config.key_provider,
                key_state: Mutex::new(key_state),
                write_guard: Mutex::new(()),
                publisher,
            }),
        })
    }

    pub fn database_path(&self) -> &Path {
        &self.inner.database_path
    }

    pub fn device_id(&self) -> &str {
        &self.inner.device_id
    }

    pub fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SemanticEventV2> {
        self.inner.publisher.subscribe()
    }

    pub fn key_available(&self) -> bool {
        self.inner.cached_key().is_some()
    }

    pub fn key_storage_mode(&self) -> Option<ObservationKeyStorageMode> {
        self.inner.cached_key().map(|key| key.storage_mode())
    }

    /// Returns the in-memory encryption status without invoking the provider,
    /// Keychain, `codesign`, or any other I/O.
    pub fn key_status(&self) -> ObservationKeyStatus {
        self.inner.key_status()
    }

    /// Explicitly copies the legacy development key into the stable target for
    /// the current signing identity. This is the only journal API allowed to
    /// invoke an interactive provider operation. The legacy item is retained,
    /// and no key bytes are returned to the caller.
    pub fn migrate_legacy_key_interactive(
        &self,
    ) -> Result<ObservationKeyMigrationResult, ObservationJournalError> {
        let (key, migrated) = self
            .inner
            .key_provider
            .migrate_legacy_key_interactive()
            .map_err(ObservationJournalError::KeyMigration)?;
        let result = ObservationKeyMigrationResult {
            migrated,
            storage_mode: key.storage_mode(),
            key_version: key.version().to_owned(),
        };
        let mut state = self
            .inner
            .key_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *state = ObservationKeyState::Ready(key);
        Ok(result)
    }

    /// Mirrors a validated `event.goal.change` into the v2 observation and
    /// semantic journals. Both the boundary and the new current goal version
    /// are committed in the same v2 transaction. Reusing the same
    /// deduplication key is idempotent.
    pub fn append_goal_change(
        &self,
        params: &EventGoalChangeParams,
    ) -> Result<ObservationAppendResult, ObservationJournalError> {
        let content = serde_json::to_value(json!({
            "previous": params.previous,
            "next": params.next,
        }))?;
        self.ingest(
            &params.deduplication_key,
            RawObservationInputV2 {
                schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
                kind: "goal.changed".to_owned(),
                interval: ObservationIntervalV2 {
                    started_at_ms: params.occurred_at_ms,
                    ended_at_ms: params.occurred_at_ms,
                },
                source: ObservationSourceV2 {
                    sensor: ObservationSensorV2::Workspace,
                    adapter_version: "goal-controller.v2".to_owned(),
                },
                subject: ObservationSubjectV2 {
                    app_id: "com.seago.whalehall".to_owned(),
                    app_name: "WhaleHall".to_owned(),
                    opaque_window_id: None,
                },
                reliability: EvidenceReliabilityV2::High,
                coverage: vec![CoverageLevelV2::Metadata, CoverageLevelV2::Content],
                redactions: Vec::new(),
                metadata: json!({}),
                content: Some(content),
            },
        )
    }

    /// Bootstraps the version marker when the legacy journal reports that the
    /// startup target is already materialized and therefore emits no new
    /// boundary. This stores no goal text.
    pub fn reconcile_current_goal_version(
        &self,
        version: Option<i64>,
    ) -> Result<(), ObservationJournalError> {
        if version.is_some_and(|version| !(0..=MAX_SAFE_INTEGER).contains(&version)) {
            return Err(ObservationJournalError::Configuration(
                "current goal version must be a non-negative safe integer".to_owned(),
            ));
        }
        let _write_guard = self
            .inner
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        set_current_goal_version(&transaction, version)?;
        transaction.commit()?;
        Ok(())
    }

    /// Mirrors a durable presence outbox record into the v2 journal. Presence
    /// transitions carry metadata only and always project as boundary events.
    pub fn append_presence_change(
        &self,
        deduplication_key: &str,
        state: &str,
        occurred_at_ms: i64,
        observed_at_ms: i64,
        idle_for_ms: Option<u64>,
    ) -> Result<ObservationAppendResult, ObservationJournalError> {
        if !matches!(
            state,
            "afk_started" | "afk_ended" | "locked" | "unlocked" | "sleep" | "wake"
        ) {
            return Err(ObservationJournalError::Configuration(
                "presence change state is unsupported".to_owned(),
            ));
        }
        let mut metadata = Map::new();
        metadata.insert("state".to_owned(), Value::String(state.to_owned()));
        if let Some(idle_for_ms) = idle_for_ms {
            metadata.insert("idleForMs".to_owned(), json!(idle_for_ms));
        }
        self.ingest(
            deduplication_key,
            RawObservationInputV2 {
                schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
                kind: "presence.changed".to_owned(),
                interval: ObservationIntervalV2 {
                    started_at_ms: occurred_at_ms,
                    ended_at_ms: observed_at_ms.max(occurred_at_ms),
                },
                source: ObservationSourceV2 {
                    sensor: ObservationSensorV2::Workspace,
                    adapter_version: "presence.sensor.v2".to_owned(),
                },
                subject: ObservationSubjectV2 {
                    app_id: "system.presence".to_owned(),
                    app_name: "macOS".to_owned(),
                    opaque_window_id: None,
                },
                reliability: EvidenceReliabilityV2::High,
                coverage: vec![CoverageLevelV2::Metadata],
                redactions: Vec::new(),
                metadata: Value::Object(metadata),
                content: None,
            },
        )
    }

    /// Persists a metadata-only snapshot whenever the bundled observer's
    /// macOS authorization state changes. The most recent durable snapshot is
    /// the comparison baseline, so an offline revocation is materialized on
    /// the next helper startup and identical heartbeat/status frames are not
    /// repeated as Timeline boundaries.
    pub fn append_authorization_change(
        &self,
        boot_id: &str,
        observed_at_ms: i64,
        permissions: &MonitoringPermissions,
        reason: &str,
    ) -> Result<Option<ObservationAppendResult>, ObservationJournalError> {
        validate_ascii_identifier("observer authorization boot id", boot_id, 128)?;
        if !(0..=MAX_SAFE_INTEGER).contains(&observed_at_ms) {
            return Err(ObservationJournalError::Configuration(
                "observer authorization timestamp must be a non-negative safe integer".to_owned(),
            ));
        }
        if !matches!(
            reason,
            "startup_snapshot"
                | "runtime_change"
                | "manual_refresh"
                | "status_request"
                | "heartbeat_check"
                | "legacy_status"
        ) {
            return Err(ObservationJournalError::Configuration(
                "observer authorization reason is unsupported".to_owned(),
            ));
        }

        let previous = self.latest_authorization_permissions()?;
        if previous.as_ref() == Some(permissions) {
            return Ok(None);
        }
        let changed_permissions = authorization_permission_names(previous.as_ref(), permissions);
        let transition = authorization_transition(previous.as_ref(), permissions);
        let permission_value = serde_json::to_value(permissions)?;
        let metadata = json!({
            "permissions": permission_value,
            "changedPermissions": changed_permissions,
            "transition": transition,
            "reason": reason,
        });
        let snapshot_hash = digest_json(&metadata)?;
        let deduplication_key =
            format!("observer-authorization:{boot_id}:{observed_at_ms}:{snapshot_hash}");
        self.ingest(
            &deduplication_key,
            RawObservationInputV2 {
                schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
                kind: "authorization.changed".to_owned(),
                interval: ObservationIntervalV2 {
                    started_at_ms: observed_at_ms,
                    ended_at_ms: observed_at_ms,
                },
                source: ObservationSourceV2 {
                    sensor: ObservationSensorV2::Workspace,
                    adapter_version: "observer-authorization.v2".to_owned(),
                },
                subject: ObservationSubjectV2 {
                    app_id: "system.authorization".to_owned(),
                    app_name: "macOS".to_owned(),
                    opaque_window_id: None,
                },
                reliability: EvidenceReliabilityV2::High,
                coverage: vec![CoverageLevelV2::Metadata],
                redactions: Vec::new(),
                metadata,
                content: None,
            },
        )
        .map(Some)
    }

    fn latest_authorization_permissions(
        &self,
    ) -> Result<Option<MonitoringPermissions>, ObservationJournalError> {
        let connection = connect(&self.inner.database_path)?;
        let stored = connection
            .query_row(
                "SELECT value FROM journal_meta WHERE key = ?1",
                [AUTHORIZATION_SNAPSHOT_META_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        stored
            .map(|snapshot| {
                let snapshot: Value = serde_json::from_str(&snapshot)?;
                if snapshot.get("schemaVersion").and_then(Value::as_str)
                    != Some(AUTHORIZATION_SNAPSHOT_SCHEMA_VERSION)
                {
                    return Err(ObservationJournalError::Configuration(
                        "stored authorization snapshot has an unsupported schema".to_owned(),
                    ));
                }
                let permissions = snapshot.get("permissions").cloned().ok_or_else(|| {
                    ObservationJournalError::Configuration(
                        "stored authorization snapshot is missing permissions".to_owned(),
                    )
                })?;
                serde_json::from_value(permissions).map_err(ObservationJournalError::from)
            })
            .transpose()
    }

    /// Records an interval where the native observer explicitly reported
    /// missing coverage, or where its durable sequence skipped. Gap rows never
    /// contain captured content and are idempotent by their caller-supplied key.
    pub fn record_coverage_gap(
        &self,
        deduplication_key: &str,
        started_at_ms: i64,
        ended_at_ms: i64,
        reason: &str,
    ) -> Result<bool, ObservationJournalError> {
        validate_ascii_identifier("coverage gap deduplication key", deduplication_key, 256)?;
        validate_ascii_identifier("coverage gap reason", reason, 128)?;
        if started_at_ms < 0 || ended_at_ms < started_at_ms || ended_at_ms > MAX_SAFE_INTEGER {
            return Err(ObservationJournalError::Configuration(
                "coverage gap interval must be an ordered non-negative safe-integer range"
                    .to_owned(),
            ));
        }
        let gap_id = deterministic_id(
            "cg2",
            &[
                &self.inner.device_id,
                &self.inner.session_id,
                deduplication_key,
            ],
        );
        let dedup_hash =
            digest_hex(format!("{started_at_ms}\u{1f}{ended_at_ms}\u{1f}{reason}").as_bytes());
        let _write_guard = self
            .inner
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(stored_hash) = transaction
            .query_row(
                "SELECT dedup_hash FROM observation_coverage_gaps WHERE gap_id = ?1",
                [&gap_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            if stored_hash != dedup_hash {
                return Err(ObservationJournalError::IdempotencyConflict);
            }
            transaction.commit()?;
            return Ok(false);
        }
        transaction.execute(
            "INSERT INTO observation_coverage_gaps (
                gap_id, device_id, session_id, started_at_ms, ended_at_ms,
                reason, dedup_hash, created_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                gap_id,
                self.inner.device_id,
                self.inner.session_id,
                started_at_ms,
                ended_at_ms,
                reason,
                dedup_hash,
                now_ms(),
            ],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    /// Persists one trusted native-observer frame and its deterministic
    /// semantic projection in one IMMEDIATE transaction. The caller may ACK
    /// the native sequence only after this method succeeds.
    pub fn ingest(
        &self,
        deduplication_key: &str,
        input: RawObservationInputV2,
    ) -> Result<ObservationAppendResult, ObservationJournalError> {
        validate_observation_input(deduplication_key, &input)?;
        let sanitized = sanitize_observation(input)?;
        let canonical = serde_json::to_vec(&sanitized)?;
        let dedup_hash = digest_hex(&canonical);
        let observation_id = deterministic_id(
            "ro2",
            &[
                RAW_OBSERVATION_SCHEMA_VERSION,
                &self.inner.device_id,
                &sanitized.source.adapter_version,
                deduplication_key,
            ],
        );

        let content_requested = sanitized.content.is_some();
        let key = if content_requested {
            self.key().ok()
        } else {
            None
        };
        let raw_content = match (sanitized.content.as_ref(), key.as_ref()) {
            (Some(content), Some(key)) => Some(encrypt_value(
                key,
                "raw-observation",
                &observation_id,
                RAW_OBSERVATION_SCHEMA_VERSION,
                sanitized.interval.started_at_ms,
                sanitized.interval.ended_at_ms,
                content,
            )?),
            _ => None,
        };
        let raw_content_state = content_state_for_observation(
            &sanitized,
            raw_content.is_some(),
            content_requested && key.is_none(),
        );
        let effective_coverage = effective_coverage(&sanitized.coverage, raw_content_state);
        let effective_redactions =
            effective_redactions(&sanitized.redactions, content_requested && key.is_none());

        let _write_guard = self
            .inner
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some((stored_hash, raw_sequence)) = transaction
            .query_row(
                "SELECT dedup_hash, sequence
                 FROM observations
                 WHERE observation_id = ?1",
                [&observation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
        {
            if stored_hash != dedup_hash {
                return Err(ObservationJournalError::IdempotencyConflict);
            }
            let semantic =
                load_semantic_by_observation(&transaction, &observation_id, false, None)?
                    .ok_or_else(|| {
                        ObservationJournalError::Configuration(
                            "stored observation is missing its semantic projection".to_owned(),
                        )
                    })?;
            let observation = load_raw_observation(&transaction, raw_sequence, false, None)?;
            transaction.commit()?;
            return Ok(ObservationAppendResult {
                observation,
                semantic_event: semantic,
                inserted: false,
            });
        }

        if let Some(encrypted) = raw_content.as_ref() {
            insert_encrypted_value(
                &transaction,
                encrypted,
                "raw-observation",
                &observation_id,
                RAW_OBSERVATION_SCHEMA_VERSION,
                sanitized.interval.started_at_ms,
                sanitized.interval.ended_at_ms,
            )?;
        }
        let metadata_json = serde_json::to_string(&sanitized.metadata)?;
        let coverage_json = serde_json::to_string(&effective_coverage)?;
        let redactions_json = serde_json::to_string(&effective_redactions)?;
        transaction.execute(
            "INSERT INTO observations (
                observation_id, schema_version, device_id, session_id, kind,
                started_at_ms, ended_at_ms, sensor, adapter_version, app_id,
                app_name, opaque_window_id, reliability, coverage_json,
                redactions_json, metadata_json, content_state, content_ref,
                dedup_hash, deduplication_key, created_at_ms
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
             )",
            params![
                observation_id,
                RAW_OBSERVATION_SCHEMA_VERSION,
                self.inner.device_id,
                self.inner.session_id,
                sanitized.kind,
                sanitized.interval.started_at_ms,
                sanitized.interval.ended_at_ms,
                sensor_name(sanitized.source.sensor),
                sanitized.source.adapter_version,
                sanitized.subject.app_id,
                sanitized.subject.app_name,
                sanitized.subject.opaque_window_id,
                reliability_name(sanitized.reliability),
                coverage_json,
                redactions_json,
                metadata_json,
                content_state_name(raw_content_state),
                raw_content.as_ref().map(|value| value.content_ref.as_str()),
                dedup_hash,
                deduplication_key,
                now_ms(),
            ],
        )?;
        let raw_sequence = transaction.last_insert_rowid();

        let current_goal_version = load_current_goal_version(&transaction)?;
        validate_goal_transition(&sanitized, current_goal_version)?;
        let projected = project_observation(
            &transaction,
            &sanitized,
            raw_content.as_ref(),
            key.as_ref(),
            raw_content_state,
            effective_coverage,
            current_goal_version,
        )?;
        let semantic_event =
            insert_semantic_projection(&transaction, &self.inner, projected, &observation_id)?;
        if sanitized.kind == "goal.changed" {
            set_current_goal_version(&transaction, goal_transition_version(&sanitized, "next")?)?;
        }
        if sanitized.kind == "authorization.changed" {
            set_authorization_snapshot(&transaction, &sanitized)?;
        }
        let observation = load_raw_observation(&transaction, raw_sequence, false, None)?;
        transaction.commit()?;
        let _ = self.inner.publisher.send(semantic_event.clone());
        Ok(ObservationAppendResult {
            observation,
            semantic_event,
            inserted: true,
        })
    }

    pub fn query_semantic(
        &self,
        params: &SemanticQueryParams,
    ) -> Result<SemanticQueryResult, ObservationJournalError> {
        if !(1..=MAX_SEMANTIC_QUERY_LIMIT).contains(&params.limit) {
            return Err(ObservationJournalError::Configuration(format!(
                "semantic.query limit must be between 1 and {MAX_SEMANTIC_QUERY_LIMIT}"
            )));
        }
        if params.after_cursor.is_some() && params.consumer_id.is_some() {
            return Err(ObservationJournalError::Configuration(
                "semantic.query afterCursor and consumerId are mutually exclusive".to_owned(),
            ));
        }
        let resolved_cursor = if let Some(consumer_id) = params.consumer_id.as_deref() {
            self.committed_semantic_cursor(consumer_id)?
        } else {
            params.after_cursor.clone()
        };
        let after_sequence = resolved_cursor
            .as_deref()
            .map(|cursor| decode_cursor(cursor, SEMANTIC_CURSOR_PREFIX))
            .transpose()?
            .unwrap_or(0);
        let connection = connect(&self.inner.database_path)?;
        validate_semantic_cursor(&connection, after_sequence, resolved_cursor.as_deref())?;
        let key = if params.include_content {
            self.key().ok()
        } else {
            None
        };
        let fetch_limit = params.limit.saturating_add(1);
        let mut statement = connection.prepare(
            "SELECT sequence
             FROM semantic_events
             WHERE sequence > ?1
             ORDER BY sequence ASC
             LIMIT ?2",
        )?;
        let sequences = statement
            .query_map(
                params![
                    after_sequence,
                    i64::try_from(fetch_limit).unwrap_or(i64::MAX)
                ],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let mut events = Vec::with_capacity(sequences.len().min(params.limit));
        for sequence in sequences.iter().take(params.limit) {
            events.push(load_semantic_event(
                &connection,
                *sequence,
                params.include_content,
                key.as_ref(),
            )?);
        }
        let has_more = sequences.len() > params.limit;
        let next_cursor = events
            .last()
            .map(|event| event.cursor.clone())
            .or(resolved_cursor);
        Ok(SemanticQueryResult {
            events,
            next_cursor,
            has_more,
        })
    }

    /// Returns exactly one five-minute local audit range. The storage schema
    /// contains no screenshot bytes or paths, so the result is limited to
    /// structured observations and semantic projections.
    pub fn query_five_minute_audit(
        &self,
        params: &AuditQueryFiveMinutesParams,
    ) -> Result<ObservationAuditRangeResult, ObservationJournalError> {
        if params.from_ms < 0
            || params.to_ms > MAX_SAFE_INTEGER
            || params
                .from_ms
                .checked_add(FIVE_MINUTES_MS)
                .is_none_or(|to_ms| to_ms != params.to_ms)
        {
            return Err(ObservationJournalError::Configuration(
                "audit.queryFiveMinutes requires an exact 300000ms safe-integer range".to_owned(),
            ));
        }
        let connection = connect(&self.inner.database_path)?;
        let key = if params.include_decrypted_content {
            self.key().ok()
        } else {
            None
        };
        let raw_sequences = {
            let mut statement = connection.prepare(
                "SELECT sequence
                 FROM observations
                 WHERE ended_at_ms >= ?1 AND started_at_ms < ?2
                 ORDER BY sequence ASC",
            )?;
            statement
                .query_map(params![params.from_ms, params.to_ms], |row| {
                    row.get::<_, i64>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut raw_observations = Vec::with_capacity(raw_sequences.len());
        for sequence in raw_sequences {
            raw_observations.push(load_raw_observation(
                &connection,
                sequence,
                params.include_decrypted_content,
                key.as_ref(),
            )?);
        }
        let semantic_sequences = {
            let mut statement = connection.prepare(
                "SELECT sequence
                 FROM semantic_events
                 WHERE observed_at_ms >= ?1 AND occurred_at_ms < ?2
                 ORDER BY sequence ASC",
            )?;
            statement
                .query_map(params![params.from_ms, params.to_ms], |row| {
                    row.get::<_, i64>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut semantic_events = Vec::with_capacity(semantic_sequences.len());
        for sequence in semantic_sequences {
            semantic_events.push(load_semantic_event(
                &connection,
                sequence,
                params.include_decrypted_content,
                key.as_ref(),
            )?);
        }
        let mut coverage = ordered_coverage(
            raw_observations
                .iter()
                .flat_map(|observation| observation.coverage.iter())
                .chain(
                    semantic_events
                        .iter()
                        .flat_map(|event| event.coverage.iter()),
                ),
        );
        let has_coverage_gap = connection.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM observation_coverage_gaps
                WHERE ended_at_ms >= ?1 AND started_at_ms < ?2
             )",
            params![params.from_ms, params.to_ms],
            |row| row.get::<_, bool>(0),
        )?;
        if has_coverage_gap {
            push_coverage(&mut coverage, CoverageLevelV2::Unavailable);
        }
        Ok(ObservationAuditRangeResult {
            from_ms: params.from_ms,
            to_ms: params.to_ms,
            coverage,
            raw_observations,
            semantic_events,
        })
    }

    pub fn commit_semantic(
        &self,
        params: &SemanticCommitParams,
    ) -> Result<SemanticCommitResult, ObservationJournalError> {
        validate_consumer_id(&params.consumer_id)?;
        let sequence = decode_cursor(&params.cursor, SEMANTIC_CURSOR_PREFIX)?;
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        validate_semantic_cursor(&transaction, sequence, Some(&params.cursor))?;
        let current = transaction
            .query_row(
                "SELECT committed_sequence, committed_cursor
                 FROM semantic_consumers
                 WHERE consumer_id = ?1",
                [&params.consumer_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((current_sequence, current_cursor)) = current {
            if sequence < current_sequence {
                return Err(ObservationJournalError::CursorRegression {
                    consumer_id: params.consumer_id.clone(),
                    current: current_cursor,
                    attempted: params.cursor.clone(),
                });
            }
            if sequence == current_sequence {
                transaction.commit()?;
                return Ok(SemanticCommitResult {
                    consumer_id: params.consumer_id.clone(),
                    cursor: current_cursor,
                    advanced: false,
                });
            }
        }
        transaction.execute(
            "INSERT INTO semantic_consumers (
                consumer_id, committed_sequence, committed_cursor, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(consumer_id) DO UPDATE SET
                committed_sequence = excluded.committed_sequence,
                committed_cursor = excluded.committed_cursor,
                updated_at_ms = excluded.updated_at_ms",
            params![params.consumer_id, sequence, params.cursor, now_ms()],
        )?;
        transaction.commit()?;
        Ok(SemanticCommitResult {
            consumer_id: params.consumer_id.clone(),
            cursor: params.cursor.clone(),
            advanced: true,
        })
    }

    pub fn committed_semantic_cursor(
        &self,
        consumer_id: &str,
    ) -> Result<Option<String>, ObservationJournalError> {
        validate_consumer_id(consumer_id)?;
        let connection = connect(&self.inner.database_path)?;
        connection
            .query_row(
                "SELECT committed_cursor
                 FROM semantic_consumers
                 WHERE consumer_id = ?1",
                [consumer_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn seal_vault_batch(
        &self,
        params: &VaultSealBatchParams,
    ) -> Result<VaultSealBatchResult, ObservationJournalError> {
        validate_vault_seal(params)?;
        let key = self
            .key()
            .map_err(|_| ObservationJournalError::KeyUnavailable)?;
        let created_at_ms = now_ms();
        if params.records.iter().any(|record| {
            record
                .expires_at_ms
                .is_some_and(|value| value < created_at_ms)
        }) {
            return Err(ObservationJournalError::Configuration(
                "vault expiresAtMs must be at or after the seal time".to_owned(),
            ));
        }
        let mut encrypted_records = Vec::with_capacity(params.records.len());
        for record in &params.records {
            let ended_at_ms = record.expires_at_ms.unwrap_or(created_at_ms);
            encrypted_records.push(encrypt_value(
                &key,
                "vault",
                &format!("{}:{}", params.namespace, record.record_id),
                &record.schema_version,
                created_at_ms,
                ended_at_ms,
                &record.content,
            )?);
        }

        let _write_guard = self
            .inner
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut results = Vec::with_capacity(params.records.len());
        for (record, encrypted) in params.records.iter().zip(encrypted_records.iter()) {
            let existing = transaction
                .query_row(
                    "SELECT content_ref, content_hash, key_version,
                            schema_version, expires_at_ms
                     FROM vault_records
                     WHERE namespace = ?1 AND record_id = ?2",
                    params![params.namespace, record.record_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((content_ref, content_hash, key_version, schema_version, expires_at_ms)) =
                existing
            {
                if content_hash != encrypted.content_hash
                    || schema_version != record.schema_version
                    || expires_at_ms != record.expires_at_ms
                {
                    return Err(ObservationJournalError::VaultConflict);
                }
                results.push(VaultSealResult {
                    record_id: record.record_id.clone(),
                    content_ref,
                    content_hash,
                    key_version,
                    inserted: false,
                });
                continue;
            }
            insert_encrypted_value(
                &transaction,
                encrypted,
                "vault",
                &format!("{}:{}", params.namespace, record.record_id),
                &record.schema_version,
                created_at_ms,
                record.expires_at_ms.unwrap_or(created_at_ms),
            )?;
            transaction.execute(
                "INSERT INTO vault_records (
                    namespace, record_id, schema_version, content_ref,
                    content_hash, key_version, created_at_ms, expires_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    params.namespace,
                    record.record_id,
                    record.schema_version,
                    encrypted.content_ref,
                    encrypted.content_hash,
                    encrypted.key_version,
                    created_at_ms,
                    record.expires_at_ms,
                ],
            )?;
            results.push(VaultSealResult {
                record_id: record.record_id.clone(),
                content_ref: encrypted.content_ref.clone(),
                content_hash: encrypted.content_hash.clone(),
                key_version: encrypted.key_version.clone(),
                inserted: true,
            });
        }
        transaction.commit()?;
        Ok(VaultSealBatchResult { records: results })
    }

    pub fn open_vault_batch(
        &self,
        params: &VaultOpenBatchParams,
    ) -> Result<VaultOpenBatchResult, ObservationJournalError> {
        validate_vault_open(params)?;
        let key = self
            .key()
            .map_err(|_| ObservationJournalError::KeyUnavailable)?;
        let connection = connect(&self.inner.database_path)?;
        let now = now_ms();
        let mut results = Vec::with_capacity(params.content_refs.len());
        for content_ref in &params.content_refs {
            let stored = connection
                .query_row(
                    "SELECT record_id, schema_version, content_hash,
                            created_at_ms, expires_at_ms
                     FROM vault_records
                     WHERE namespace = ?1 AND content_ref = ?2",
                    params![params.namespace, content_ref],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                        ))
                    },
                )
                .optional()?
                .ok_or(ObservationJournalError::VaultRecordUnavailable)?;
            if stored.4.is_some_and(|expires_at_ms| expires_at_ms <= now) {
                return Err(ObservationJournalError::VaultRecordUnavailable);
            }
            let encrypted = load_encrypted_value(&connection, content_ref)?
                .ok_or(ObservationJournalError::VaultRecordUnavailable)?;
            let content = decrypt_value(&key, &encrypted)?;
            results.push(VaultOpenResult {
                record_id: stored.0,
                schema_version: stored.1,
                content_ref: content_ref.clone(),
                content_hash: stored.2,
                content,
                created_at_ms: stored.3,
                expires_at_ms: stored.4,
            });
        }
        Ok(VaultOpenBatchResult { records: results })
    }

    pub fn delete_vault_batch(
        &self,
        params: &VaultDeleteBatchParams,
    ) -> Result<VaultDeleteBatchResult, ObservationJournalError> {
        validate_vault_delete(params)?;
        let _write_guard = self
            .inner
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut results = Vec::with_capacity(params.record_ids.len());
        for record_id in &params.record_ids {
            let content_ref = transaction
                .query_row(
                    "SELECT content_ref FROM vault_records
                     WHERE namespace = ?1 AND record_id = ?2",
                    params![params.namespace, record_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let deleted = if let Some(content_ref) = content_ref {
                transaction.execute(
                    "DELETE FROM vault_records
                     WHERE namespace = ?1 AND record_id = ?2 AND content_ref = ?3",
                    params![params.namespace, record_id, content_ref],
                )?;
                transaction.execute(
                    "DELETE FROM encrypted_payloads WHERE content_ref = ?1",
                    [content_ref],
                )?;
                true
            } else {
                false
            };
            results.push(VaultDeleteResult {
                record_id: record_id.clone(),
                deleted,
            });
        }
        transaction.commit()?;
        Ok(VaultDeleteBatchResult { records: results })
    }

    pub fn cleanup(
        &self,
        now_at_ms: i64,
    ) -> Result<ObservationCleanupResult, ObservationJournalError> {
        if !(0..=MAX_SAFE_INTEGER).contains(&now_at_ms) {
            return Err(ObservationJournalError::Configuration(
                "cleanup timestamp must be a non-negative safe integer".to_owned(),
            ));
        }
        let raw_cutoff = now_at_ms.saturating_sub(self.inner.raw_content_retention_ms);
        let derived_cutoff = now_at_ms.saturating_sub(self.inner.derived_retention_ms);
        let _write_guard = self
            .inner
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let raw_refs = {
            let mut statement = transaction.prepare(
                "SELECT content_ref FROM observations
                 WHERE ended_at_ms <= ?1 AND content_ref IS NOT NULL",
            )?;
            statement
                .query_map([raw_cutoff], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let expired_raw_contents = transaction.execute(
            "UPDATE observations
             SET content_ref = NULL, content_state = 'expired'
             WHERE ended_at_ms <= ?1 AND content_ref IS NOT NULL",
            [raw_cutoff],
        )?;
        for content_ref in raw_refs {
            transaction.execute(
                "UPDATE projector_state SET content_ref = NULL
                 WHERE content_ref = ?1",
                [&content_ref],
            )?;
            transaction.execute(
                "DELETE FROM encrypted_payloads WHERE content_ref = ?1",
                [content_ref],
            )?;
        }
        let semantic_content_refs = {
            let mut statement = transaction.prepare(
                "SELECT content_ref FROM semantic_events
                 WHERE observed_at_ms <= ?1 AND content_ref IS NOT NULL",
            )?;
            statement
                .query_map([raw_cutoff], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let expired_semantic_contents = transaction.execute(
            "UPDATE semantic_events
             SET content_ref = NULL, content_state = 'expired'
             WHERE observed_at_ms <= ?1 AND content_ref IS NOT NULL",
            [raw_cutoff],
        )?;
        for content_ref in semantic_content_refs {
            transaction.execute(
                "DELETE FROM encrypted_payloads WHERE content_ref = ?1",
                [content_ref],
            )?;
        }

        let expired_semantic_bounds = transaction.query_row(
            "SELECT MIN(occurred_at_ms), MAX(observed_at_ms), MAX(sequence)
             FROM semantic_events
             WHERE observed_at_ms <= ?1",
            [derived_cutoff],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )?;
        let expired_semantic_range = expired_semantic_bounds
            .0
            .zip(expired_semantic_bounds.1)
            .zip(expired_semantic_bounds.2)
            .map(|((started_at_ms, ended_at_ms), maximum_sequence)| {
                (started_at_ms, ended_at_ms, maximum_sequence)
            });
        let semantic_highwater = semantic_sequence_highwater(&transaction)?;
        let first_retained_sequence = transaction.query_row(
            "SELECT MIN(sequence)
             FROM semantic_events
             WHERE observed_at_ms > ?1",
            [derived_cutoff],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        let retention_floor =
            first_retained_sequence.map_or(semantic_highwater, |sequence| sequence - 1);
        let lagging_consumers =
            if let Some((_, _, maximum_expired_sequence)) = expired_semantic_range {
                transaction.query_row(
                    "SELECT COUNT(*)
                 FROM semantic_consumers
                 WHERE committed_sequence < ?1",
                    [maximum_expired_sequence],
                    |row| row.get::<_, i64>(0),
                )?
            } else {
                0
            };
        if retention_floor > 0 {
            transaction.execute(
                "UPDATE semantic_consumers
                 SET committed_sequence = ?1,
                     committed_cursor = ?2,
                     updated_at_ms = ?3
                 WHERE committed_sequence < ?1",
                params![
                    retention_floor,
                    encode_cursor(retention_floor, SEMANTIC_CURSOR_PREFIX),
                    now_at_ms,
                ],
            )?;
        }
        let semantic_refs = {
            let mut statement = transaction.prepare(
                "SELECT content_ref FROM semantic_events
                 WHERE observed_at_ms <= ?1 AND content_ref IS NOT NULL",
            )?;
            statement
                .query_map([derived_cutoff], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let deleted_semantic_events = transaction.execute(
            "DELETE FROM semantic_events WHERE observed_at_ms <= ?1",
            [derived_cutoff],
        )?;
        for content_ref in semantic_refs {
            transaction.execute(
                "DELETE FROM encrypted_payloads WHERE content_ref = ?1",
                [content_ref],
            )?;
        }
        transaction.execute(
            "DELETE FROM semantic_event_lineage
             WHERE observation_id IN (
                SELECT observation_id
                FROM observations
                WHERE ended_at_ms <= ?1
             )",
            [derived_cutoff],
        )?;
        let deleted_observations = transaction.execute(
            "DELETE FROM observations
             WHERE ended_at_ms <= ?1
               AND observation_id NOT IN (
                   SELECT observation_id FROM semantic_event_lineage
               )",
            [derived_cutoff],
        )?;
        let deleted_coverage_gaps = transaction.execute(
            "DELETE FROM observation_coverage_gaps WHERE created_at_ms <= ?1",
            [derived_cutoff],
        )?;
        if lagging_consumers > 0
            && let Some((started_at_ms, ended_at_ms, maximum_sequence)) = expired_semantic_range
        {
            let gap_id = deterministic_id(
                "cg2",
                &[
                    &self.inner.device_id,
                    &self.inner.session_id,
                    "semantic-retention",
                    &maximum_sequence.to_string(),
                ],
            );
            let reason = "semantic_retention_gap";
            let dedup_hash =
                digest_hex(format!("{started_at_ms}\u{1f}{ended_at_ms}\u{1f}{reason}").as_bytes());
            transaction.execute(
                "INSERT OR IGNORE INTO observation_coverage_gaps (
                    gap_id, device_id, session_id, started_at_ms, ended_at_ms,
                    reason, dedup_hash, created_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    gap_id,
                    self.inner.device_id,
                    self.inner.session_id,
                    started_at_ms,
                    ended_at_ms,
                    reason,
                    dedup_hash,
                    now_at_ms,
                ],
            )?;
        }
        let vault_refs = {
            let mut statement = transaction.prepare(
                "SELECT content_ref FROM vault_records
                 WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?1",
            )?;
            statement
                .query_map([now_at_ms], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        let deleted_vault_records = transaction.execute(
            "DELETE FROM vault_records
             WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?1",
            [now_at_ms],
        )?;
        for content_ref in vault_refs {
            transaction.execute(
                "DELETE FROM encrypted_payloads WHERE content_ref = ?1",
                [content_ref],
            )?;
        }
        transaction.commit()?;
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(ObservationCleanupResult {
            expired_raw_contents,
            expired_semantic_contents,
            deleted_observations,
            deleted_semantic_events,
            deleted_coverage_gaps,
            deleted_vault_records,
        })
    }

    fn key(&self) -> Result<ObservationKey, ObservationKeyError> {
        self.inner.load_key()
    }
}

impl ObservationJournalInner {
    fn key_status(&self) -> ObservationKeyStatus {
        let state = self
            .key_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match &*state {
            ObservationKeyState::Ready(key) => ObservationKeyStatus {
                availability: ObservationKeyAvailability::Available,
                storage_mode: Some(key.storage_mode()),
                key_version: Some(key.version().to_owned()),
                interactive_migration_available: false,
            },
            ObservationKeyState::RetryAfter { error, .. } => {
                let (availability, interactive_migration_available) = match error {
                    ObservationKeyError::MigrationRequired {
                        interactive_available,
                    } => (
                        ObservationKeyAvailability::MigrationRequired,
                        *interactive_available,
                    ),
                    _ => (ObservationKeyAvailability::Unavailable, false),
                };
                ObservationKeyStatus {
                    availability,
                    storage_mode: None,
                    key_version: None,
                    interactive_migration_available,
                }
            }
        }
    }

    fn cached_key(&self) -> Option<ObservationKey> {
        let state = self
            .key_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match &*state {
            ObservationKeyState::Ready(key) => Some(key.clone()),
            ObservationKeyState::RetryAfter { .. } => None,
        }
    }

    fn load_key(&self) -> Result<ObservationKey, ObservationKeyError> {
        let now = Instant::now();
        let mut state = self
            .key_state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match &*state {
            ObservationKeyState::Ready(key) => return Ok(key.clone()),
            ObservationKeyState::RetryAfter {
                error, retry_at, ..
            } if now < *retry_at => return Err(error.clone()),
            ObservationKeyState::RetryAfter { .. } => {}
        }

        let failure_count = match &*state {
            ObservationKeyState::Ready(_) => unreachable!("ready key returned above"),
            ObservationKeyState::RetryAfter { failure_count, .. } => {
                failure_count.saturating_add(1)
            }
        };
        let result = self.key_provider.load_or_create();
        *state = key_state_from_result(result.clone(), Instant::now(), failure_count);
        result
    }
}

fn key_state_from_result(
    result: Result<ObservationKey, ObservationKeyError>,
    now: Instant,
    failure_count: usize,
) -> ObservationKeyState {
    match result {
        Ok(key) => ObservationKeyState::Ready(key),
        Err(error) => ObservationKeyState::RetryAfter {
            error,
            retry_at: now + key_load_retry_delay(failure_count),
            failure_count,
        },
    }
}

fn key_load_retry_delay(failure_count: usize) -> Duration {
    KEY_LOAD_RETRY_DELAYS[failure_count
        .saturating_sub(1)
        .min(KEY_LOAD_RETRY_DELAYS.len() - 1)]
}

struct ProjectedSemantic {
    kind: &'static str,
    source: String,
    occurred_at_ms: i64,
    observed_at_ms: i64,
    goal_version: Option<i64>,
    count_class: SemanticCountClassV2,
    reliability: EvidenceReliabilityV2,
    coverage: Vec<CoverageLevelV2>,
    content_state: SemanticContentStateV2,
    metadata_payload: Value,
    content_payload: Option<Value>,
}

fn load_current_goal_version(
    connection: &Connection,
) -> Result<Option<i64>, ObservationJournalError> {
    let stored = connection
        .query_row(
            "SELECT value FROM journal_meta WHERE key = 'current_goal_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    stored
        .map(|value| {
            value.parse::<i64>().map_err(|_| {
                ObservationJournalError::Configuration(
                    "stored current goal version is invalid".to_owned(),
                )
            })
        })
        .transpose()
}

fn set_current_goal_version(
    transaction: &Transaction<'_>,
    version: Option<i64>,
) -> Result<(), ObservationJournalError> {
    if let Some(version) = version {
        transaction.execute(
            "INSERT INTO journal_meta (key, value)
             VALUES ('current_goal_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [version.to_string()],
        )?;
    } else {
        transaction.execute(
            "DELETE FROM journal_meta WHERE key = 'current_goal_version'",
            [],
        )?;
    }
    Ok(())
}

fn set_authorization_snapshot(
    transaction: &Transaction<'_>,
    observation: &RawObservationInputV2,
) -> Result<(), ObservationJournalError> {
    let permissions = observation
        .metadata
        .get("permissions")
        .cloned()
        .ok_or_else(|| {
            ObservationJournalError::Configuration(
                "authorization.changed is missing validated permissions".to_owned(),
            )
        })?;
    let snapshot = serde_json::to_string(&json!({
        "schemaVersion": AUTHORIZATION_SNAPSHOT_SCHEMA_VERSION,
        "permissions": permissions,
    }))?;
    transaction.execute(
        "INSERT INTO journal_meta (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![AUTHORIZATION_SNAPSHOT_META_KEY, snapshot],
    )?;
    Ok(())
}

fn goal_transition_version(
    observation: &RawObservationInputV2,
    field: &str,
) -> Result<Option<i64>, ObservationJournalError> {
    let value = observation
        .content
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|content| content.get(field))
        .ok_or_else(|| {
            ObservationJournalError::Configuration(format!(
                "goal.changed content is missing {field}"
            ))
        })?;
    if value.is_null() {
        return Ok(None);
    }
    let version = value
        .as_object()
        .and_then(|goal| goal.get("version"))
        .and_then(Value::as_i64)
        .filter(|version| (0..=MAX_SAFE_INTEGER).contains(version))
        .ok_or_else(|| {
            ObservationJournalError::Configuration(format!(
                "goal.changed {field}.version is invalid"
            ))
        })?;
    Ok(Some(version))
}

fn validate_goal_transition(
    observation: &RawObservationInputV2,
    current: Option<i64>,
) -> Result<(), ObservationJournalError> {
    if observation.kind != "goal.changed" {
        return Ok(());
    }
    let previous = goal_transition_version(observation, "previous")?;
    let next = goal_transition_version(observation, "next")?;
    if previous == next || (previous.is_none() && next.is_none()) {
        return Err(ObservationJournalError::Configuration(
            "goal.changed requires distinct previous and next goal versions".to_owned(),
        ));
    }
    if let (Some(previous), Some(next)) = (previous, next)
        && next != previous.saturating_add(1)
    {
        return Err(ObservationJournalError::Configuration(
            "goal.changed next version must follow previous version".to_owned(),
        ));
    }
    // An empty v2 journal may bootstrap from a legacy active goal. Once v2 has
    // materialized a current version, every transition must be contiguous.
    if current.is_some() && current != previous {
        return Err(ObservationJournalError::Configuration(
            "goal.changed previous version does not match the durable current goal".to_owned(),
        ));
    }
    Ok(())
}

fn authorization_permission_names(
    previous: Option<&MonitoringPermissions>,
    current: &MonitoringPermissions,
) -> Vec<&'static str> {
    authorization_permission_states(current)
        .into_iter()
        .filter_map(|(name, state)| {
            let previous_state = previous.and_then(|permissions| {
                authorization_permission_states(permissions)
                    .into_iter()
                    .find_map(|(candidate, state)| (candidate == name).then_some(state))
            });
            (previous_state != Some(state)).then_some(name)
        })
        .collect()
}

fn authorization_transition(
    previous: Option<&MonitoringPermissions>,
    current: &MonitoringPermissions,
) -> &'static str {
    let mut revoked = false;
    let mut granted = false;
    for (name, current_state) in authorization_permission_states(current) {
        let previous_state = previous.and_then(|permissions| {
            authorization_permission_states(permissions)
                .into_iter()
                .find_map(|(candidate, state)| (candidate == name).then_some(state))
        });
        if current_state == MonitoringPermissionState::Granted
            && previous_state.is_some_and(|state| state != MonitoringPermissionState::Granted)
        {
            granted = true;
        }
        if (current_state == MonitoringPermissionState::Denied
            && previous_state != Some(MonitoringPermissionState::Denied))
            || (previous_state == Some(MonitoringPermissionState::Granted)
                && current_state != MonitoringPermissionState::Granted)
        {
            revoked = true;
        }
    }
    match (previous, revoked, granted) {
        (None, true, _) => "revoked",
        (None, false, _) => "baseline",
        (Some(_), true, true) => "mixed",
        (Some(_), true, false) => "revoked",
        (Some(_), false, true) => "granted",
        (Some(_), false, false) => "changed",
    }
}

fn authorization_permission_states(
    permissions: &MonitoringPermissions,
) -> [(&'static str, MonitoringPermissionState); 4] {
    [
        ("accessibility", permissions.accessibility),
        ("screenRecording", permissions.screen_recording),
        ("inputMonitoring", permissions.input_monitoring),
        ("automation", permissions.automation),
    ]
}

fn project_observation(
    transaction: &Transaction<'_>,
    observation: &RawObservationInputV2,
    raw_content: Option<&EncryptedValue>,
    key: Option<&ObservationKey>,
    raw_content_state: SemanticContentStateV2,
    coverage: Vec<CoverageLevelV2>,
    current_goal_version: Option<i64>,
) -> Result<ProjectedSemantic, ObservationJournalError> {
    let mut metadata_payload = Map::new();
    metadata_payload.insert(
        "appId".to_owned(),
        Value::String(observation.subject.app_id.clone()),
    );
    metadata_payload.insert(
        "appName".to_owned(),
        Value::String(observation.subject.app_name.clone()),
    );
    if let Some(window_id) = observation.subject.opaque_window_id.as_ref() {
        metadata_payload.insert(
            "opaqueWindowId".to_owned(),
            Value::String(window_id.clone()),
        );
    }
    let content = observation.content.as_ref().and_then(Value::as_object);
    let metadata = observation
        .metadata
        .as_object()
        .expect("validated observation metadata is an object");
    let source = format!(
        "{}.{}",
        sensor_name(observation.source.sensor),
        observation.source.adapter_version
    );
    let base =
        |kind, count_class, metadata_payload, content_payload, content_state| ProjectedSemantic {
            kind,
            source: source.clone(),
            occurred_at_ms: observation.interval.started_at_ms,
            observed_at_ms: observation.interval.ended_at_ms,
            goal_version: current_goal_version,
            count_class,
            reliability: observation.reliability,
            coverage: coverage.clone(),
            content_state,
            metadata_payload,
            content_payload,
        };

    match observation.kind.as_str() {
        "workspace.foregroundChanged" => {
            let mut semantic_content = Map::new();
            copy_string(content, "windowTitle", &mut semantic_content, "windowTitle");
            Ok(base(
                semantic_event_kinds::APPLICATION_FOREGROUND_CHANGED,
                SemanticCountClassV2::Effective,
                Value::Object(metadata_payload),
                non_empty_object(semantic_content),
                raw_content_state,
            ))
        }
        "ax.focusChanged" => {
            let role = metadata
                .get("focusedRole")
                .and_then(Value::as_str)
                .or_else(|| metadata.get("focusedSubrole").and_then(Value::as_str))
                .unwrap_or("unknown");
            metadata_payload.insert("role".to_owned(), Value::String(role.to_owned()));
            let control_id = metadata.get("opaqueControlId").and_then(Value::as_str);
            if let Some(control_id) = control_id {
                metadata_payload.insert(
                    "opaqueControlId".to_owned(),
                    Value::String(control_id.to_owned()),
                );
            }
            if let Some(current_value) = content
                .and_then(|content| content.get("finalValue"))
                .and_then(Value::as_str)
            {
                let state_key = text_projector_state_key(&observation.subject, role, control_id);
                update_projector_state(
                    transaction,
                    &state_key,
                    &digest_hex(current_value.as_bytes()),
                    raw_content.map(|value| value.content_ref.as_str()),
                    observation.interval.ended_at_ms,
                )?;
            }
            let mut semantic_content = Map::new();
            copy_string(content, "focusedLabel", &mut semantic_content, "label");
            Ok(base(
                semantic_event_kinds::UI_FOCUS_CHANGED,
                SemanticCountClassV2::Effective,
                Value::Object(metadata_payload),
                non_empty_object(semantic_content),
                raw_content_state,
            ))
        }
        "ax.valueChanged" => {
            let role = metadata
                .get("focusedRole")
                .and_then(Value::as_str)
                .or_else(|| metadata.get("focusedSubrole").and_then(Value::as_str))
                .unwrap_or("unknown");
            let current_value = content
                .and_then(|content| content.get("finalValue"))
                .and_then(Value::as_str);
            let control_id = metadata.get("opaqueControlId").and_then(Value::as_str);
            let state_key = text_projector_state_key(&observation.subject, role, control_id);
            let previous_value = if current_value.is_some()
                && let (Some(key), Some(_)) = (key, raw_content)
            {
                load_projector_previous_content(transaction, &state_key, key)?.and_then(|value| {
                    value
                        .get("finalValue")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
            } else {
                None
            };
            let delta_available = previous_value.is_some() && current_value.is_some();
            let (inserted_chars, deleted_chars, added_text) =
                match (previous_value.as_deref(), current_value) {
                    (Some(previous_value), Some(current_value)) => {
                        text_delta(Some(previous_value), current_value)
                    }
                    // Missing prior state is a baseline, never evidence that
                    // the complete current value was newly inserted.
                    _ => (0, 0, String::new()),
                };
            metadata_payload.insert("role".to_owned(), Value::String(role.to_owned()));
            if let Some(control_id) = control_id {
                metadata_payload.insert(
                    "opaqueControlId".to_owned(),
                    Value::String(control_id.to_owned()),
                );
            }
            metadata_payload.insert("insertedChars".to_owned(), json!(inserted_chars));
            metadata_payload.insert("deletedChars".to_owned(), json!(deleted_chars));
            metadata_payload.insert("deltaAvailable".to_owned(), json!(delta_available));
            metadata_payload.insert(
                "inputMethod".to_owned(),
                Value::String("unknown".to_owned()),
            );
            let mut semantic_content = Map::new();
            copy_string(content, "focusedLabel", &mut semantic_content, "label");
            if !added_text.is_empty() {
                semantic_content.insert("addedText".to_owned(), Value::String(added_text));
            }
            if let Some(current_value) = current_value {
                semantic_content.insert(
                    "finalValue".to_owned(),
                    Value::String(current_value.to_owned()),
                );
            }
            if let Some(current_value) = current_value {
                update_projector_state(
                    transaction,
                    &state_key,
                    &digest_hex(current_value.as_bytes()),
                    raw_content.map(|value| value.content_ref.as_str()),
                    observation.interval.ended_at_ms,
                )?;
            }
            Ok(base(
                semantic_event_kinds::APPLICATION_TEXT_VALUE_CHANGED,
                SemanticCountClassV2::Effective,
                Value::Object(metadata_payload),
                non_empty_object(semantic_content),
                raw_content_state,
            ))
        }
        "ax.visibleContentChanged" | "screen.visibleTextChanged" => {
            let mut semantic_content = Map::new();
            copy_string(content, "windowTitle", &mut semantic_content, "windowTitle");
            copy_string(content, "visibleText", &mut semantic_content, "visibleText");
            if !semantic_content.contains_key("visibleText") {
                copy_string(content, "finalValue", &mut semantic_content, "visibleText");
            }
            let marker = digest_json(&Value::Object(semantic_content.clone()))?;
            metadata_payload.insert("contentHash".to_owned(), Value::String(marker));
            Ok(base(
                semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
                SemanticCountClassV2::Effective,
                Value::Object(metadata_payload),
                non_empty_object(semantic_content),
                raw_content_state,
            ))
        }
        "browser.visiblePageChanged" => {
            let url = content
                .and_then(|content| content.get("url"))
                .and_then(Value::as_str);
            let mut semantic_content = Map::new();
            if let Some(domain) = url.and_then(url_domain) {
                semantic_content.insert("domain".to_owned(), Value::String(domain));
            }
            copy_string(content, "url", &mut semantic_content, "url");
            copy_string(content, "title", &mut semantic_content, "title");
            copy_string(content, "visibleText", &mut semantic_content, "visibleText");
            let marker = digest_json(&Value::Object(semantic_content.clone()))?;
            metadata_payload.insert("contentHash".to_owned(), Value::String(marker.clone()));
            let state_key = projector_state_key("browser", &observation.subject, "visible-page");
            let previous_marker = transaction
                .query_row(
                    "SELECT marker FROM projector_state WHERE state_key = ?1",
                    [&state_key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let change_kind = match previous_marker {
                None => "opened",
                Some(previous) if previous == marker => "content_changed",
                Some(_) => "navigated",
            };
            metadata_payload.insert(
                "changeKind".to_owned(),
                Value::String(change_kind.to_owned()),
            );
            update_projector_state(
                transaction,
                &state_key,
                &marker,
                raw_content.map(|value| value.content_ref.as_str()),
                observation.interval.ended_at_ms,
            )?;
            Ok(base(
                semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED,
                SemanticCountClassV2::Effective,
                Value::Object(metadata_payload),
                non_empty_object(semantic_content),
                raw_content_state,
            ))
        }
        "input.activityBucket" => {
            metadata_payload.clear();
            for field in ["keyCount", "clickCount", "scrollDelta", "mouseDistance"] {
                metadata_payload.insert(
                    field.to_owned(),
                    metadata
                        .get(field)
                        .cloned()
                        .expect("validated input bucket field"),
                );
            }
            if let Some(bucket_count) = metadata.get("coalescedBucketCount") {
                metadata_payload.insert("coalescedBucketCount".to_owned(), bucket_count.clone());
            }
            metadata_payload.insert(
                "bucketStartedAtMs".to_owned(),
                json!(observation.interval.started_at_ms),
            );
            metadata_payload.insert(
                "bucketEndedAtMs".to_owned(),
                json!(observation.interval.ended_at_ms),
            );
            Ok(base(
                semantic_event_kinds::INPUT_ACTIVITY_BUCKET,
                SemanticCountClassV2::Effective,
                Value::Object(metadata_payload),
                None,
                SemanticContentStateV2::Available,
            ))
        }
        "ui.controlActivated" => {
            let role = metadata
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            metadata_payload.insert("role".to_owned(), Value::String(role.to_owned()));
            metadata_payload.insert("action".to_owned(), Value::String("activated".to_owned()));
            let mut semantic_content = Map::new();
            copy_string(content, "label", &mut semantic_content, "label");
            Ok(base(
                semantic_event_kinds::UI_CONTROL_ACTIVATED,
                SemanticCountClassV2::Effective,
                Value::Object(metadata_payload),
                non_empty_object(semantic_content),
                raw_content_state,
            ))
        }
        "presence.changed" => Ok(base(
            semantic_event_kinds::PRESENCE_CHANGED,
            SemanticCountClassV2::Boundary,
            observation.metadata.clone(),
            None,
            SemanticContentStateV2::Available,
        )),
        "goal.changed" => Ok(ProjectedSemantic {
            goal_version: goal_transition_version(observation, "previous")?,
            ..base(
                semantic_event_kinds::GOAL_CHANGED,
                SemanticCountClassV2::Boundary,
                json!({}),
                observation.content.clone(),
                raw_content_state,
            )
        }),
        "authorization.changed" => Ok(base(
            semantic_event_kinds::AUTHORIZATION_CHANGED,
            SemanticCountClassV2::Boundary,
            observation.metadata.clone(),
            None,
            SemanticContentStateV2::Available,
        )),
        "application.processObservedBatch" => Ok(base(
            semantic_event_kinds::APPLICATION_PROCESS_OBSERVED_BATCH,
            SemanticCountClassV2::Ignored,
            observation.metadata.clone(),
            None,
            SemanticContentStateV2::Available,
        )),
        "coverage.gap" => Ok(base(
            semantic_event_kinds::COVERAGE_GAP,
            SemanticCountClassV2::Ignored,
            json!({}),
            None,
            SemanticContentStateV2::Redacted,
        )),
        _ => Err(ObservationJournalError::Configuration(
            "unsupported raw observation kind".to_owned(),
        )),
    }
}

fn insert_semantic_projection(
    transaction: &Transaction<'_>,
    journal: &ObservationJournalInner,
    projected: ProjectedSemantic,
    observation_id: &str,
) -> Result<SemanticEventV2, ObservationJournalError> {
    let event_id = deterministic_id(
        "se2",
        &[
            SEMANTIC_EVENT_SCHEMA_VERSION,
            &journal.device_id,
            observation_id,
            projected.kind,
            SEMANTIC_PROJECTOR_VERSION,
        ],
    );
    let key = if projected.content_payload.is_some() {
        journal.load_key().ok()
    } else {
        None
    };
    let encrypted_content = match (projected.content_payload.as_ref(), key.as_ref()) {
        (Some(content), Some(key)) => Some(encrypt_value(
            key,
            "semantic-event",
            &event_id,
            SEMANTIC_EVENT_SCHEMA_VERSION,
            projected.occurred_at_ms,
            projected.observed_at_ms,
            content,
        )?),
        _ => None,
    };
    if let Some(encrypted) = encrypted_content.as_ref() {
        insert_encrypted_value(
            transaction,
            encrypted,
            "semantic-event",
            &event_id,
            SEMANTIC_EVENT_SCHEMA_VERSION,
            projected.occurred_at_ms,
            projected.observed_at_ms,
        )?;
    }
    let content_state = if projected.content_payload.is_some() && encrypted_content.is_none() {
        SemanticContentStateV2::Unavailable
    } else {
        projected.content_state
    };
    let coverage = effective_coverage(&projected.coverage, content_state);
    transaction.execute(
        "INSERT INTO semantic_events (
            event_id, schema_version, device_id, session_id, kind, source,
            occurred_at_ms, observed_at_ms, goal_version, count_class,
            reliability, coverage_json, content_state, taxonomy_version,
            projector_version, payload_json, content_ref, created_at_ms
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18
         )",
        params![
            event_id,
            SEMANTIC_EVENT_SCHEMA_VERSION,
            journal.device_id,
            journal.session_id,
            projected.kind,
            projected.source,
            projected.occurred_at_ms,
            projected.observed_at_ms,
            projected.goal_version,
            count_class_name(projected.count_class),
            reliability_name(projected.reliability),
            serde_json::to_string(&coverage)?,
            content_state_name(content_state),
            SEMANTIC_TAXONOMY_VERSION,
            SEMANTIC_PROJECTOR_VERSION,
            serde_json::to_string(&projected.metadata_payload)?,
            encrypted_content
                .as_ref()
                .map(|value| value.content_ref.as_str()),
            now_ms(),
        ],
    )?;
    let sequence = transaction.last_insert_rowid();
    transaction.execute(
        "INSERT INTO semantic_event_lineage (event_id, observation_id, ordinal)
         VALUES (?1, ?2, 0)",
        params![event_id, observation_id],
    )?;
    load_semantic_event(transaction, sequence, false, None)
}

fn load_semantic_by_observation(
    connection: &Connection,
    observation_id: &str,
    include_content: bool,
    key: Option<&ObservationKey>,
) -> Result<Option<SemanticEventV2>, ObservationJournalError> {
    let sequence = connection
        .query_row(
            "SELECT event.sequence
             FROM semantic_events event
             JOIN semantic_event_lineage lineage
               ON lineage.event_id = event.event_id
             WHERE lineage.observation_id = ?1
             ORDER BY lineage.ordinal ASC
             LIMIT 1",
            [observation_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    sequence
        .map(|sequence| load_semantic_event(connection, sequence, include_content, key))
        .transpose()
}

fn load_semantic_event(
    connection: &Connection,
    sequence: i64,
    include_content: bool,
    key: Option<&ObservationKey>,
) -> Result<SemanticEventV2, ObservationJournalError> {
    let stored = connection.query_row(
        "SELECT event_id, schema_version, device_id, session_id, kind, source,
                occurred_at_ms, observed_at_ms, goal_version, count_class,
                reliability, coverage_json, content_state, taxonomy_version,
                projector_version, payload_json, content_ref
         FROM semantic_events
         WHERE sequence = ?1",
        [sequence],
        |row| {
            Ok(StoredSemanticEvent {
                event_id: row.get(0)?,
                schema_version: row.get(1)?,
                device_id: row.get(2)?,
                session_id: row.get(3)?,
                kind: row.get(4)?,
                source: row.get(5)?,
                occurred_at_ms: row.get(6)?,
                observed_at_ms: row.get(7)?,
                goal_version: row.get(8)?,
                count_class: row.get(9)?,
                reliability: row.get(10)?,
                coverage_json: row.get(11)?,
                content_state: row.get(12)?,
                taxonomy_version: row.get(13)?,
                projector_version: row.get(14)?,
                payload_json: row.get(15)?,
                content_ref: row.get(16)?,
            })
        },
    )?;
    stored.into_event(connection, sequence, include_content, key)
}

struct StoredSemanticEvent {
    event_id: String,
    schema_version: String,
    device_id: String,
    session_id: String,
    kind: String,
    source: String,
    occurred_at_ms: i64,
    observed_at_ms: i64,
    goal_version: Option<i64>,
    count_class: String,
    reliability: String,
    coverage_json: String,
    content_state: String,
    taxonomy_version: String,
    projector_version: String,
    payload_json: String,
    content_ref: Option<String>,
}

impl StoredSemanticEvent {
    fn into_event(
        self,
        connection: &Connection,
        sequence: i64,
        include_content: bool,
        key: Option<&ObservationKey>,
    ) -> Result<SemanticEventV2, ObservationJournalError> {
        let mut payload = serde_json::from_str::<Value>(&self.payload_json)?;
        let mut coverage = serde_json::from_str::<Vec<CoverageLevelV2>>(&self.coverage_json)?;
        let mut content_state = parse_content_state(&self.content_state)?;
        if include_content && let Some(content_ref) = self.content_ref.as_deref() {
            if let Some(key) = key {
                let encrypted = load_encrypted_value(connection, content_ref)?
                    .ok_or(ObservationJournalError::Authentication)?;
                let content = decrypt_value(key, &encrypted)?;
                merge_object(&mut payload, content)?;
            } else {
                content_state = SemanticContentStateV2::Unavailable;
                push_coverage(&mut coverage, CoverageLevelV2::Unavailable);
            }
        }
        let source_observation_ids = {
            let mut statement = connection.prepare(
                "SELECT observation_id
                 FROM semantic_event_lineage
                 WHERE event_id = ?1
                 ORDER BY ordinal ASC",
            )?;
            statement
                .query_map([&self.event_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        Ok(SemanticEventV2 {
            schema_version: self.schema_version,
            event_id: self.event_id,
            cursor: encode_cursor(sequence, SEMANTIC_CURSOR_PREFIX),
            device_id: self.device_id,
            session_id: self.session_id,
            kind: self.kind,
            source: self.source,
            occurred_at_ms: self.occurred_at_ms,
            observed_at_ms: self.observed_at_ms,
            goal_version: self.goal_version,
            count_class: parse_count_class(&self.count_class)?,
            reliability: parse_reliability(&self.reliability)?,
            coverage,
            content_state,
            source_observation_ids,
            taxonomy_version: self.taxonomy_version,
            projector_version: self.projector_version,
            payload,
        })
    }
}

fn load_raw_observation(
    connection: &Connection,
    sequence: i64,
    include_content: bool,
    key: Option<&ObservationKey>,
) -> Result<RawObservationV2, ObservationJournalError> {
    let stored = connection.query_row(
        "SELECT observation_id, schema_version, device_id, session_id, kind,
                started_at_ms, ended_at_ms, sensor, adapter_version, app_id,
                app_name, opaque_window_id, reliability, coverage_json,
                redactions_json, metadata_json, content_state, content_ref,
                dedup_hash
         FROM observations
         WHERE sequence = ?1",
        [sequence],
        |row| {
            Ok(StoredRawObservation {
                observation_id: row.get(0)?,
                schema_version: row.get(1)?,
                device_id: row.get(2)?,
                session_id: row.get(3)?,
                kind: row.get(4)?,
                started_at_ms: row.get(5)?,
                ended_at_ms: row.get(6)?,
                sensor: row.get(7)?,
                adapter_version: row.get(8)?,
                app_id: row.get(9)?,
                app_name: row.get(10)?,
                opaque_window_id: row.get(11)?,
                reliability: row.get(12)?,
                coverage_json: row.get(13)?,
                redactions_json: row.get(14)?,
                metadata_json: row.get(15)?,
                content_state: row.get(16)?,
                content_ref: row.get(17)?,
                dedup_hash: row.get(18)?,
            })
        },
    )?;
    let mut content_state = parse_content_state(&stored.content_state)?;
    let mut coverage = serde_json::from_str::<Vec<CoverageLevelV2>>(&stored.coverage_json)?;
    let content = if include_content {
        match (stored.content_ref.as_deref(), key) {
            (Some(content_ref), Some(key)) => {
                let encrypted = load_encrypted_value(connection, content_ref)?
                    .ok_or(ObservationJournalError::Authentication)?;
                Some(decrypt_value(key, &encrypted)?)
            }
            (Some(_), None) => {
                content_state = SemanticContentStateV2::Unavailable;
                push_coverage(&mut coverage, CoverageLevelV2::Unavailable);
                None
            }
            (None, _) => None,
        }
    } else {
        None
    };
    Ok(RawObservationV2 {
        schema_version: stored.schema_version,
        observation_id: stored.observation_id,
        cursor: encode_cursor(sequence, RAW_CURSOR_PREFIX),
        device_id: stored.device_id,
        session_id: stored.session_id,
        kind: stored.kind,
        interval: ObservationIntervalV2 {
            started_at_ms: stored.started_at_ms,
            ended_at_ms: stored.ended_at_ms,
        },
        source: ObservationSourceV2 {
            sensor: parse_sensor(&stored.sensor)?,
            adapter_version: stored.adapter_version,
        },
        subject: ObservationSubjectV2 {
            app_id: stored.app_id,
            app_name: stored.app_name,
            opaque_window_id: stored.opaque_window_id,
        },
        reliability: parse_reliability(&stored.reliability)?,
        coverage,
        redactions: serde_json::from_str(&stored.redactions_json)?,
        metadata: serde_json::from_str(&stored.metadata_json)?,
        content_state,
        content,
        dedup_hash: stored.dedup_hash,
    })
}

struct StoredRawObservation {
    observation_id: String,
    schema_version: String,
    device_id: String,
    session_id: String,
    kind: String,
    started_at_ms: i64,
    ended_at_ms: i64,
    sensor: String,
    adapter_version: String,
    app_id: String,
    app_name: String,
    opaque_window_id: Option<String>,
    reliability: String,
    coverage_json: String,
    redactions_json: String,
    metadata_json: String,
    content_state: String,
    content_ref: Option<String>,
    dedup_hash: String,
}

fn encrypt_value(
    key: &ObservationKey,
    owner_kind: &str,
    owner_id: &str,
    schema_version: &str,
    started_at_ms: i64,
    ended_at_ms: i64,
    value: &Value,
) -> Result<EncryptedValue, ObservationJournalError> {
    let plaintext = serde_json::to_vec(value)?;
    let content_hash = digest_hex(&plaintext);
    let content_ref = deterministic_id(
        "oc2",
        &[owner_kind, owner_id, schema_version, &content_hash],
    );
    let aad = serde_json::to_vec(&EncryptionAad {
        owner_kind,
        owner_id,
        schema_version,
        started_at_ms,
        ended_at_ms,
        content_hash: &content_hash,
        key_version: key.version(),
    })?;
    let mut nonce = [0_u8; 12];
    getrandom::fill(&mut nonce).map_err(|_| ObservationJournalError::Encryption)?;
    let cipher =
        Aes256Gcm::new_from_slice(key.bytes()).map_err(|_| ObservationJournalError::Encryption)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| ObservationJournalError::Encryption)?;
    Ok(EncryptedValue {
        content_ref,
        key_version: key.version().to_owned(),
        nonce,
        ciphertext,
        content_hash,
    })
}

fn decrypt_value(
    key: &ObservationKey,
    encrypted: &StoredEncryptedValue,
) -> Result<Value, ObservationJournalError> {
    if encrypted.nonce.len() != 12 {
        return Err(ObservationJournalError::Authentication);
    }
    let aad = serde_json::to_vec(&EncryptionAad {
        owner_kind: &encrypted.owner_kind,
        owner_id: &encrypted.owner_id,
        schema_version: &encrypted.schema_version,
        started_at_ms: encrypted.started_at_ms,
        ended_at_ms: encrypted.ended_at_ms,
        content_hash: &encrypted.content_hash,
        key_version: &encrypted.key_version,
    })?;
    let cipher = Aes256Gcm::new_from_slice(key.bytes())
        .map_err(|_| ObservationJournalError::Authentication)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&encrypted.nonce),
            Payload {
                msg: &encrypted.ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| ObservationJournalError::Authentication)?;
    if digest_hex(&plaintext) != encrypted.content_hash {
        return Err(ObservationJournalError::Authentication);
    }
    serde_json::from_slice(&plaintext).map_err(Into::into)
}

fn insert_encrypted_value(
    transaction: &Transaction<'_>,
    encrypted: &EncryptedValue,
    owner_kind: &str,
    owner_id: &str,
    schema_version: &str,
    started_at_ms: i64,
    ended_at_ms: i64,
) -> Result<(), ObservationJournalError> {
    transaction.execute(
        "INSERT INTO encrypted_payloads (
            content_ref, owner_kind, owner_id, schema_version, started_at_ms,
            ended_at_ms, key_version, nonce, ciphertext, content_hash
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            encrypted.content_ref,
            owner_kind,
            owner_id,
            schema_version,
            started_at_ms,
            ended_at_ms,
            encrypted.key_version,
            encrypted.nonce.as_slice(),
            encrypted.ciphertext,
            encrypted.content_hash,
        ],
    )?;
    Ok(())
}

fn load_encrypted_value(
    connection: &Connection,
    content_ref: &str,
) -> Result<Option<StoredEncryptedValue>, ObservationJournalError> {
    connection
        .query_row(
            "SELECT content_ref, owner_kind, owner_id, schema_version,
                    started_at_ms, ended_at_ms, key_version, nonce,
                    ciphertext, content_hash
             FROM encrypted_payloads
             WHERE content_ref = ?1",
            [content_ref],
            |row| {
                Ok(StoredEncryptedValue {
                    owner_kind: row.get(1)?,
                    owner_id: row.get(2)?,
                    schema_version: row.get(3)?,
                    started_at_ms: row.get(4)?,
                    ended_at_ms: row.get(5)?,
                    key_version: row.get(6)?,
                    nonce: row.get(7)?,
                    ciphertext: row.get(8)?,
                    content_hash: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn load_projector_previous_content(
    transaction: &Transaction<'_>,
    state_key: &str,
    key: &ObservationKey,
) -> Result<Option<Value>, ObservationJournalError> {
    let content_ref = transaction
        .query_row(
            "SELECT content_ref
             FROM projector_state
             WHERE state_key = ?1",
            [state_key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let Some(content_ref) = content_ref else {
        return Ok(None);
    };
    let Some(encrypted) = load_encrypted_value(transaction, &content_ref)? else {
        return Ok(None);
    };
    decrypt_value(key, &encrypted).map(Some)
}

fn update_projector_state(
    transaction: &Transaction<'_>,
    state_key: &str,
    marker: &str,
    content_ref: Option<&str>,
    updated_at_ms: i64,
) -> Result<(), ObservationJournalError> {
    transaction.execute(
        "INSERT INTO projector_state (state_key, marker, content_ref, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(state_key) DO UPDATE SET
            marker = excluded.marker,
            content_ref = excluded.content_ref,
            updated_at_ms = excluded.updated_at_ms",
        params![state_key, marker, content_ref, updated_at_ms],
    )?;
    Ok(())
}

fn projector_state_key(
    category: &str,
    subject: &ObservationSubjectV2,
    discriminator: &str,
) -> String {
    deterministic_id(
        "ps2",
        &[
            category,
            &subject.app_id,
            subject.opaque_window_id.as_deref().unwrap_or(""),
            discriminator,
        ],
    )
}

fn text_projector_state_key(
    subject: &ObservationSubjectV2,
    role: &str,
    opaque_control_id: Option<&str>,
) -> String {
    if let Some(opaque_control_id) = opaque_control_id {
        return deterministic_id("ps2", &["text", &subject.app_id, opaque_control_id]);
    }
    projector_state_key("text", subject, role)
}

fn text_delta(previous: Option<&str>, current: &str) -> (usize, usize, String) {
    let previous = previous.unwrap_or_default().chars().collect::<Vec<_>>();
    let current_chars = current.chars().collect::<Vec<_>>();
    let mut prefix = 0;
    while prefix < previous.len()
        && prefix < current_chars.len()
        && previous[prefix] == current_chars[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < previous.len().saturating_sub(prefix)
        && suffix < current_chars.len().saturating_sub(prefix)
        && previous[previous.len() - 1 - suffix] == current_chars[current_chars.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let deleted = previous.len().saturating_sub(prefix + suffix);
    let inserted_slice = &current_chars[prefix..current_chars.len().saturating_sub(suffix)];
    (
        inserted_slice.len(),
        deleted,
        inserted_slice.iter().collect(),
    )
}

fn validate_observation_input(
    deduplication_key: &str,
    input: &RawObservationInputV2,
) -> Result<(), ObservationJournalError> {
    validate_ascii_identifier("observation deduplication key", deduplication_key, 512)?;
    if input.schema_version != RAW_OBSERVATION_SCHEMA_VERSION {
        return Err(ObservationJournalError::Configuration(
            "raw observation schemaVersion must be raw-observation.v2".to_owned(),
        ));
    }
    validate_ascii_identifier("raw observation kind", &input.kind, 128)?;
    if input.interval.started_at_ms < 0
        || input.interval.ended_at_ms < input.interval.started_at_ms
        || input.interval.ended_at_ms > MAX_SAFE_INTEGER
    {
        return Err(ObservationJournalError::Configuration(
            "raw observation interval must be non-negative, ordered safe integers".to_owned(),
        ));
    }
    validate_text_identifier("source adapterVersion", &input.source.adapter_version, 128)?;
    validate_text_identifier("subject appId", &input.subject.app_id, 512)?;
    validate_text_identifier("subject appName", &input.subject.app_name, 512)?;
    if let Some(window_id) = input.subject.opaque_window_id.as_deref() {
        validate_text_identifier("subject opaqueWindowId", window_id, 512)?;
    }
    if input.coverage.is_empty() || input.coverage.len() > 5 {
        return Err(ObservationJournalError::Configuration(
            "raw observation coverage must contain 1 to 5 values".to_owned(),
        ));
    }
    let unique_coverage = input.coverage.iter().copied().collect::<HashSet<_>>();
    if unique_coverage.len() != input.coverage.len() {
        return Err(ObservationJournalError::Configuration(
            "raw observation coverage must not contain duplicates".to_owned(),
        ));
    }
    if input.redactions.len() > 32 {
        return Err(ObservationJournalError::Configuration(
            "raw observation redactions exceed 32 entries".to_owned(),
        ));
    }
    for redaction in &input.redactions {
        validate_ascii_identifier("raw observation redaction", redaction, 128)?;
    }
    if !input.metadata.is_object() {
        return Err(ObservationJournalError::Configuration(
            "raw observation metadata must be an object".to_owned(),
        ));
    }
    validate_json_size(
        "raw observation metadata",
        &input.metadata,
        MAX_METADATA_BYTES,
    )?;
    if let Some(content) = input.content.as_ref() {
        if !content.is_object() {
            return Err(ObservationJournalError::Configuration(
                "raw observation content must be an object".to_owned(),
            ));
        }
        validate_json_size("raw observation content", content, MAX_CONTENT_BYTES)?;
    }
    if contains_forbidden_field(&input.metadata)
        || input.content.as_ref().is_some_and(contains_forbidden_field)
    {
        return Err(ObservationJournalError::Configuration(
            "raw observation contains a forbidden key, credential, clipboard, or coordinate field"
                .to_owned(),
        ));
    }
    validate_kind_payload(input)?;
    Ok(())
}

fn validate_kind_payload(input: &RawObservationInputV2) -> Result<(), ObservationJournalError> {
    let metadata = input
        .metadata
        .as_object()
        .expect("metadata object was checked");
    let content = input.content.as_ref().and_then(Value::as_object);
    let exact_metadata =
        |required: &[&str], optional: &[&str]| exact_object_keys(metadata, required, optional);
    let exact_content = |required: &[&str], optional: &[&str]| {
        content.is_none_or(|content| exact_object_keys(content, required, optional))
    };
    let valid = match input.kind.as_str() {
        "workspace.foregroundChanged" => {
            input.source.sensor == ObservationSensorV2::Workspace
                && exact_metadata(&["processId"], &[])
                && metadata.get("processId").is_some_and(is_u32_json)
                && content.is_none()
        }
        "ax.focusChanged" | "ax.valueChanged" | "ax.visibleContentChanged" => {
            input.source.sensor == ObservationSensorV2::Ax
                && exact_metadata(
                    &["processId", "protectedInput"],
                    &[
                        "focusedRole",
                        "focusedSubrole",
                        "opaqueControlId",
                        "finalValueAvailable",
                    ],
                )
                && metadata.get("processId").is_some_and(is_u32_json)
                && metadata
                    .get("protectedInput")
                    .and_then(Value::as_bool)
                    .is_some()
                && optional_bounded_string(metadata, "focusedRole", 256)
                && optional_bounded_string(metadata, "focusedSubrole", 256)
                && optional_bounded_string(metadata, "opaqueControlId", 512)
                && metadata
                    .get("finalValueAvailable")
                    .is_none_or(|value| value.as_bool().is_some())
                && exact_content(
                    &[],
                    &[
                        "windowTitle",
                        "focusedLabel",
                        "finalValue",
                        "inputOrigin",
                        "selectedText",
                        "visibleText",
                    ],
                )
                && content.is_none_or(|content| {
                    optional_bounded_string(content, "windowTitle", 2_048)
                        && optional_bounded_string(content, "focusedLabel", 2_048)
                        && optional_bounded_string_allow_empty(content, "finalValue", 16_384)
                        && optional_bounded_string(content, "selectedText", 16_384)
                        && optional_bounded_string(content, "visibleText", 16_384)
                        && content
                            .get("inputOrigin")
                            .is_none_or(|value| value.as_str() == Some("unknown"))
                })
                && !(metadata.get("finalValueAvailable").and_then(Value::as_bool) == Some(false)
                    && content
                        .and_then(|value| value.get("finalValue"))
                        .and_then(Value::as_str)
                        .is_some())
                && (input.kind != "ax.valueChanged"
                    || content
                        .and_then(|value| value.get("finalValue"))
                        .and_then(Value::as_str)
                        .is_some()
                    || !input.coverage.contains(&CoverageLevelV2::Content))
        }
        "screen.visibleTextChanged" => {
            input.source.sensor == ObservationSensorV2::Ocr
                && exact_metadata(&["languageHints"], &[])
                && metadata.get("languageHints").is_some_and(|value| {
                    value.as_array().is_some_and(|values| {
                        values.len() <= 8
                            && values.iter().all(|value| {
                                value
                                    .as_str()
                                    .is_some_and(|value| is_bounded_text(value, 64))
                            })
                    })
                })
                && exact_content(&["visibleText"], &[])
                && content
                    .and_then(|value| value.get("visibleText"))
                    .and_then(Value::as_str)
                    .is_some_and(|value| is_bounded_text(value, 16_384))
        }
        "browser.visiblePageChanged" => {
            matches!(
                input.source.sensor,
                ObservationSensorV2::AppleEvents
                    | ObservationSensorV2::Ax
                    | ObservationSensorV2::Ocr
            ) && exact_metadata(&[], &[])
                && exact_content(&["title", "url"], &["visibleText"])
                && content.is_none_or(|content| {
                    required_bounded_string(content, "title", 2_048)
                        && required_bounded_string(content, "url", 16_384)
                        && optional_bounded_string(content, "visibleText", 16_384)
                })
        }
        "input.activityBucket" => {
            let bucket_count = metadata
                .get("coalescedBucketCount")
                .map(|value| value.as_u64().filter(|count| (2..=256).contains(count)));
            let valid_bucket_count = bucket_count.is_none()
                || bucket_count.as_ref().is_some_and(|count| count.is_some());
            let expected_duration = bucket_count.flatten().unwrap_or(1).saturating_mul(5_000);
            input.source.sensor == ObservationSensorV2::CgActivity
                && valid_bucket_count
                && u64::try_from(input.interval.ended_at_ms - input.interval.started_at_ms)
                    .is_ok_and(|duration| duration == expected_duration)
                && exact_metadata(
                    &["keyCount", "clickCount", "scrollDelta", "mouseDistance"],
                    &["coalescedBucketCount"],
                )
                && metadata
                    .get("keyCount")
                    .is_some_and(is_non_negative_integer)
                && metadata
                    .get("clickCount")
                    .is_some_and(is_non_negative_integer)
                && metadata
                    .get("scrollDelta")
                    .is_some_and(|value| is_finite_number(value, -1e12, 1e12))
                && metadata
                    .get("mouseDistance")
                    .is_some_and(|value| is_finite_number(value, 0.0, 1e12))
                && content.is_none()
        }
        "coverage.gap" => {
            let expected_coverage = input
                .redactions
                .first()
                .and_then(|reason| anonymous_coverage_level(input.source.sensor, reason));
            matches!(
                input.source.sensor,
                ObservationSensorV2::Workspace
                    | ObservationSensorV2::Ax
                    | ObservationSensorV2::Ocr
                    | ObservationSensorV2::CgActivity
            ) && input.subject.app_id == "redacted"
                && input.subject.app_name == "Protected application"
                && input.subject.opaque_window_id.is_none()
                && input.reliability == EvidenceReliabilityV2::High
                && input.redactions.len() == 1
                && expected_coverage.is_some()
                && input.coverage.first() == expected_coverage.as_ref()
                && input.coverage.len() == 1
                && exact_metadata(&[], &[])
                && content.is_none()
        }
        "ui.controlActivated" => {
            input.source.sensor == ObservationSensorV2::Ax
                && exact_metadata(&[], &["role"])
                && optional_bounded_string(metadata, "role", 256)
                && exact_content(&[], &["label"])
                && content.is_none_or(|content| optional_bounded_string(content, "label", 2_048))
        }
        "presence.changed" => {
            exact_metadata(&["state"], &["idleForMs"])
                && metadata
                    .get("state")
                    .and_then(Value::as_str)
                    .is_some_and(|state| {
                        matches!(
                            state,
                            "afk_started" | "afk_ended" | "locked" | "unlocked" | "sleep" | "wake"
                        )
                    })
                && metadata
                    .get("idleForMs")
                    .is_none_or(is_non_negative_integer)
                && content.is_none()
        }
        "goal.changed" => {
            exact_metadata(&[], &[])
                && exact_content(&["previous", "next"], &[])
                && content.is_some()
        }
        "authorization.changed" => {
            let transition = metadata.get("transition").and_then(Value::as_str);
            input.source.sensor == ObservationSensorV2::Workspace
                && input.source.adapter_version == "observer-authorization.v2"
                && input.subject.app_id == "system.authorization"
                && input.subject.app_name == "macOS"
                && input.subject.opaque_window_id.is_none()
                && input.reliability == EvidenceReliabilityV2::High
                && input.redactions.is_empty()
                && exact_metadata(
                    &["permissions", "changedPermissions", "transition", "reason"],
                    &[],
                )
                && metadata
                    .get("permissions")
                    .is_some_and(is_authorization_permissions)
                && metadata
                    .get("changedPermissions")
                    .is_some_and(is_changed_permission_list)
                && transition.is_some_and(|transition| {
                    matches!(
                        transition,
                        "baseline" | "changed" | "granted" | "revoked" | "mixed"
                    )
                })
                && metadata
                    .get("reason")
                    .and_then(Value::as_str)
                    .is_some_and(|reason| {
                        matches!(
                            reason,
                            "startup_snapshot"
                                | "runtime_change"
                                | "manual_refresh"
                                | "status_request"
                                | "heartbeat_check"
                                | "legacy_status"
                        )
                    })
                && input.coverage == [CoverageLevelV2::Metadata]
                && content.is_none()
        }
        "application.processObservedBatch" => {
            exact_metadata(&["started", "exited"], &[])
                && ["started", "exited"].iter().all(|field| {
                    metadata.get(*field).is_some_and(|value| {
                        value.as_array().is_some_and(|entries| {
                            entries.len() <= 10_000 && entries.iter().all(is_process_observation)
                        })
                    })
                })
                && content.is_none()
        }
        _ => false,
    };
    if !valid {
        return Err(ObservationJournalError::Configuration(format!(
            "raw observation {} has an invalid source, metadata, or content shape",
            input.kind
        )));
    }
    Ok(())
}

fn sanitize_observation(
    mut input: RawObservationInputV2,
) -> Result<RawObservationInputV2, ObservationJournalError> {
    let protected_flag = input
        .metadata
        .get("protectedInput")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let protected_role = ["focusedRole", "focusedSubrole"]
        .iter()
        .filter_map(|field| input.metadata.get(*field).and_then(Value::as_str))
        .any(|role| {
            let role = role.to_ascii_lowercase();
            role.contains("secure") || role.contains("password")
        });
    let protected = protected_flag || protected_role;
    let hard_excluded =
        is_hard_excluded_application(&input.subject.app_id, &input.subject.app_name);
    let detected_redaction = detect_sensitive_visible_context(&input);
    let explicitly_redacted = input.redactions.iter().any(|reason| {
        matches!(
            reason.as_str(),
            "private_window"
                | "secure_field"
                | "system_auth"
                | "financial_application"
                | "password_manager"
                | "sensitive_application"
                | "sensitive_or_private_window"
                | "protected_input"
                | "sensitive_visible_content"
                | "user_excluded_application"
                | "sensitive_focused_control"
                | "sensitive_final_value"
                | "protected_content"
                | "browser_privacy_state_unavailable"
        )
    });
    if protected || hard_excluded || explicitly_redacted || detected_redaction.is_some() {
        input.content = None;
        push_coverage(&mut input.coverage, CoverageLevelV2::Redacted);
        input
            .coverage
            .retain(|level| *level != CoverageLevelV2::Content);
        if protected {
            push_unique_string(&mut input.redactions, "secure_field");
        }
        if hard_excluded {
            push_unique_string(&mut input.redactions, "excluded_application");
        }
        if let Some(reason) = detected_redaction {
            push_unique_string(&mut input.redactions, reason);
        }
    }
    if let Some(content) = input.content.as_mut().and_then(Value::as_object_mut)
        && let Some(url) = content.get("url").and_then(Value::as_str)
    {
        content.insert("url".to_owned(), Value::String(sanitize_url(url)));
    }
    Ok(input)
}

fn anonymous_coverage_level(sensor: ObservationSensorV2, reason: &str) -> Option<CoverageLevelV2> {
    match sensor {
        ObservationSensorV2::Workspace
            if matches!(
                reason,
                "user_excluded_application" | "sensitive_application"
            ) =>
        {
            Some(CoverageLevelV2::Redacted)
        }
        ObservationSensorV2::Ax
            if matches!(
                reason,
                "user_excluded_application"
                    | "sensitive_application"
                    | "sensitive_or_private_window"
                    | "protected_input"
                    | "private_window"
                    | "sensitive_visible_content"
                    | "sensitive_focused_control"
                    | "sensitive_final_value"
                    | "protected_content"
            ) =>
        {
            Some(CoverageLevelV2::Redacted)
        }
        ObservationSensorV2::Ocr
            if matches!(
                reason,
                "browser_privacy_state_unavailable"
                    | "thermal_critical"
                    | "foreground_window_unavailable"
                    | "screen_capture_failed"
            ) =>
        {
            Some(CoverageLevelV2::Unavailable)
        }
        ObservationSensorV2::CgActivity
            if matches!(
                reason,
                "input_monitoring_unavailable"
                    | "input_event_tap_disabled"
                    | "input_event_tap_start_timeout"
            ) =>
        {
            Some(CoverageLevelV2::Unavailable)
        }
        _ => None,
    }
}

fn content_state_for_observation(
    observation: &RawObservationInputV2,
    encrypted: bool,
    key_unavailable: bool,
) -> SemanticContentStateV2 {
    if key_unavailable
        || observation.coverage.iter().any(|level| {
            matches!(
                level,
                CoverageLevelV2::Denied | CoverageLevelV2::Unavailable
            )
        })
    {
        SemanticContentStateV2::Unavailable
    } else if observation.coverage.contains(&CoverageLevelV2::Redacted)
        || !observation.redactions.is_empty()
    {
        SemanticContentStateV2::Redacted
    } else if observation.content.is_none() || encrypted {
        SemanticContentStateV2::Available
    } else {
        SemanticContentStateV2::Unavailable
    }
}

fn effective_coverage(
    original: &[CoverageLevelV2],
    content_state: SemanticContentStateV2,
) -> Vec<CoverageLevelV2> {
    let mut result = original.to_vec();
    match content_state {
        SemanticContentStateV2::Available => {}
        SemanticContentStateV2::Redacted => {
            result.retain(|level| *level != CoverageLevelV2::Content);
            push_coverage(&mut result, CoverageLevelV2::Redacted);
        }
        SemanticContentStateV2::Expired | SemanticContentStateV2::Unavailable => {
            result.retain(|level| *level != CoverageLevelV2::Content);
            push_coverage(&mut result, CoverageLevelV2::Unavailable);
        }
    }
    result
}

fn effective_redactions(original: &[String], key_unavailable: bool) -> Vec<String> {
    let mut result = original.to_vec();
    if key_unavailable {
        push_unique_string(&mut result, "key_unavailable");
    }
    result
}

fn is_hard_excluded_application(app_id: &str, app_name: &str) -> bool {
    let value = format!("{app_id} {app_name}").to_lowercase();
    [
        "1password",
        "bitwarden",
        "keepass",
        "lastpass",
        "dashlane",
        "password",
        "keychain access",
        "com.apple.keychainaccess",
        "com.apple.securityagent",
        "securityagent",
        "authorizationhost",
        "coreauthui",
        "localauthentication.uiagent",
        "loginwindow",
        "wallet",
        "metamask",
        "paypal",
        "alipay",
        "bank",
        "银行",
        "支付",
        "钱包",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn detect_sensitive_visible_context(observation: &RawObservationInputV2) -> Option<&'static str> {
    let content = observation.content.as_ref()?.as_object()?;
    let text = content
        .values()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    if text.is_empty() {
        return None;
    }
    if observation.kind == "browser.visiblePageChanged"
        && [
            "incognito",
            "inprivate",
            "private browsing",
            "private window",
            "无痕",
            "隐私浏览",
        ]
        .iter()
        .any(|marker| text.contains(marker))
    {
        return Some("private_window");
    }
    if observation.kind == "browser.visiblePageChanged"
        && [
            "paypal",
            "alipay",
            "stripe.com/checkout",
            "coinbase",
            "binance",
            "metamask",
            "wallet",
            "online banking",
            "网上银行",
            "手机银行",
            "支付",
            "钱包",
        ]
        .iter()
        .any(|marker| text.contains(marker))
    {
        return Some("financial_application");
    }
    if [
        "one-time password",
        "one-time code",
        "verification code",
        "authenticator code",
        "动态口令",
        "一次性密码",
        "验证码",
    ]
    .iter()
    .any(|marker| text.contains(marker))
    {
        return Some("otp_detected");
    }
    if [
        "-----begin private key-----",
        "-----begin openssh private key-----",
        "\"api_key\":",
        "\"apikey\":",
        "api_key=",
        "access_token=",
        "client_secret=",
    ]
    .iter()
    .any(|marker| text.contains(marker))
    {
        return Some("credential_detected");
    }
    None
}

fn sanitize_url(url: &str) -> String {
    let without_fragment = url.split('#').next().unwrap_or_default();
    let (base, query) = without_fragment
        .split_once('?')
        .map_or((without_fragment, None), |(base, query)| {
            (base, Some(query))
        });
    let mut base = base.to_owned();
    if let Some(scheme_end) = base.find("://") {
        let authority_start = scheme_end + 3;
        let authority_end = base[authority_start..]
            .find('/')
            .map_or(base.len(), |offset| authority_start + offset);
        if let Some(at_offset) = base[authority_start..authority_end].rfind('@') {
            base.replace_range(authority_start..authority_start + at_offset + 1, "");
        }
    }
    let Some(query) = query else {
        return base;
    };
    let retained = query
        .split('&')
        .filter(|pair| {
            let key = pair
                .split_once('=')
                .map_or(*pair, |(key, _)| key)
                .to_ascii_lowercase();
            ![
                "token",
                "code",
                "session",
                "auth",
                "password",
                "passwd",
                "secret",
                "api_key",
                "apikey",
                "access_key",
            ]
            .iter()
            .any(|sensitive| key == *sensitive || key.ends_with(sensitive))
        })
        .collect::<Vec<_>>();
    if retained.is_empty() {
        base
    } else {
        format!("{base}?{}", retained.join("&"))
    }
}

fn validate_vault_seal(params: &VaultSealBatchParams) -> Result<(), ObservationJournalError> {
    validate_ascii_identifier("vault namespace", &params.namespace, 128)?;
    if params.records.is_empty() || params.records.len() > MAX_VAULT_BATCH_RECORDS {
        return Err(ObservationJournalError::Configuration(format!(
            "vault.sealBatch requires 1 to {MAX_VAULT_BATCH_RECORDS} records"
        )));
    }
    let mut ids = HashSet::new();
    let mut total = 0_usize;
    for record in &params.records {
        validate_ascii_identifier("vault recordId", &record.record_id, 256)?;
        validate_ascii_identifier("vault schemaVersion", &record.schema_version, 128)?;
        if !ids.insert(record.record_id.as_str()) {
            return Err(ObservationJournalError::Configuration(
                "vault.sealBatch recordId values must be unique".to_owned(),
            ));
        }
        if record
            .expires_at_ms
            .is_some_and(|expires_at_ms| !(0..=MAX_SAFE_INTEGER).contains(&expires_at_ms))
        {
            return Err(ObservationJournalError::Configuration(
                "vault expiresAtMs must be a non-negative safe integer".to_owned(),
            ));
        }
        let bytes = serde_json::to_vec(&record.content)?.len();
        if bytes > MAX_VAULT_RECORD_BYTES {
            return Err(ObservationJournalError::Configuration(format!(
                "vault record content exceeds {MAX_VAULT_RECORD_BYTES} bytes"
            )));
        }
        total = total.saturating_add(bytes);
    }
    if total > MAX_VAULT_BATCH_BYTES {
        return Err(ObservationJournalError::Configuration(format!(
            "vault batch content exceeds {MAX_VAULT_BATCH_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_vault_open(params: &VaultOpenBatchParams) -> Result<(), ObservationJournalError> {
    validate_ascii_identifier("vault namespace", &params.namespace, 128)?;
    if params.content_refs.is_empty() || params.content_refs.len() > MAX_VAULT_BATCH_RECORDS {
        return Err(ObservationJournalError::Configuration(format!(
            "vault.openBatch requires 1 to {MAX_VAULT_BATCH_RECORDS} contentRefs"
        )));
    }
    let mut refs = HashSet::new();
    for content_ref in &params.content_refs {
        validate_ascii_identifier("vault contentRef", content_ref, 256)?;
        if !refs.insert(content_ref) {
            return Err(ObservationJournalError::Configuration(
                "vault.openBatch contentRefs must be unique".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_vault_delete(params: &VaultDeleteBatchParams) -> Result<(), ObservationJournalError> {
    validate_ascii_identifier("vault namespace", &params.namespace, 128)?;
    if params.record_ids.is_empty() || params.record_ids.len() > MAX_VAULT_BATCH_RECORDS {
        return Err(ObservationJournalError::Configuration(format!(
            "vault.deleteBatch requires 1 to {MAX_VAULT_BATCH_RECORDS} recordIds"
        )));
    }
    let mut ids = HashSet::new();
    for record_id in &params.record_ids {
        validate_ascii_identifier("vault recordId", record_id, 256)?;
        if !ids.insert(record_id) {
            return Err(ObservationJournalError::Configuration(
                "vault.deleteBatch recordId values must be unique".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_json_size(
    label: &str,
    value: &Value,
    maximum: usize,
) -> Result<(), ObservationJournalError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > maximum {
        return Err(ObservationJournalError::Configuration(format!(
            "{label} exceeds {maximum} bytes"
        )));
    }
    if contains_nul(value) {
        return Err(ObservationJournalError::Configuration(format!(
            "{label} contains a NUL character"
        )));
    }
    Ok(())
}

fn contains_nul(value: &Value) -> bool {
    match value {
        Value::String(value) => value.contains('\0'),
        Value::Array(values) => values.iter().any(contains_nul),
        Value::Object(values) => {
            values.keys().any(|key| key.contains('\0')) || values.values().any(contains_nul)
        }
        _ => false,
    }
}

fn contains_forbidden_field(value: &Value) -> bool {
    const FORBIDDEN: &[&str] = &[
        "key",
        "key_name",
        "keycode",
        "key_code",
        "raw_key",
        "password",
        "passcode",
        "otp",
        "clipboard",
        "absolute_x",
        "absolute_y",
        "screen_x",
        "screen_y",
        "mouse_x",
        "mouse_y",
    ];
    match value {
        Value::Array(values) => values.iter().any(contains_forbidden_field),
        Value::Object(values) => values.iter().any(|(key, child)| {
            let key = to_snake_case(key);
            FORBIDDEN.contains(&key.as_str()) || contains_forbidden_field(child)
        }),
        _ => false,
    }
}

fn to_snake_case(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for (index, character) in value.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if index > 0 {
                result.push('_');
            }
            result.push(character.to_ascii_lowercase());
        } else if matches!(character, '-' | ' ') {
            result.push('_');
        } else {
            result.push(character);
        }
    }
    result
}

fn exact_object_keys(object: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn is_authorization_permissions(value: &Value) -> bool {
    let Some(permissions) = value.as_object() else {
        return false;
    };
    exact_object_keys(
        permissions,
        &[
            "accessibility",
            "screenRecording",
            "inputMonitoring",
            "automation",
        ],
        &[],
    ) && permissions.values().all(|state| {
        state.as_str().is_some_and(|state| {
            matches!(
                state,
                "unknown" | "granted" | "denied" | "not_determined" | "unsupported"
            )
        })
    })
}

fn is_changed_permission_list(value: &Value) -> bool {
    let Some(values) = value.as_array() else {
        return false;
    };
    let mut unique = HashSet::new();
    !values.is_empty()
        && values.len() <= 4
        && values.iter().all(|value| {
            value.as_str().is_some_and(|permission| {
                matches!(
                    permission,
                    "accessibility" | "screenRecording" | "inputMonitoring" | "automation"
                ) && unique.insert(permission)
            })
        })
}

fn is_u32_json(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|value| value <= u64::from(u32::MAX))
}

fn is_non_negative_integer(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|value| value <= MAX_SAFE_INTEGER as u64)
}

fn is_finite_number(value: &Value, minimum: f64, maximum: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|value| value.is_finite() && value >= minimum && value <= maximum)
}

fn required_bounded_string(object: &Map<String, Value>, key: &str, maximum: usize) -> bool {
    object
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| is_bounded_text(value, maximum))
}

fn optional_bounded_string(object: &Map<String, Value>, key: &str, maximum: usize) -> bool {
    object.get(key).is_none_or(|value| {
        value
            .as_str()
            .is_some_and(|value| is_bounded_text(value, maximum))
    })
}

fn optional_bounded_string_allow_empty(
    object: &Map<String, Value>,
    key: &str,
    maximum: usize,
) -> bool {
    object.get(key).is_none_or(|value| {
        value
            .as_str()
            .is_some_and(|value| value.chars().count() <= maximum && !value.contains('\0'))
    })
}

fn is_bounded_text(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.chars().count() <= maximum && !value.contains('\0')
}

fn is_process_observation(value: &Value) -> bool {
    let Some(value) = value.as_object() else {
        return false;
    };
    exact_object_keys(value, &["processId", "appId", "appName"], &[])
        && value.get("processId").is_some_and(is_u32_json)
        && required_bounded_string(value, "appId", 512)
        && required_bounded_string(value, "appName", 512)
}

fn validate_ascii_identifier(
    label: &str,
    value: &str,
    maximum: usize,
) -> Result<(), ObservationJournalError> {
    if value.is_empty()
        || value.len() > maximum
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-' | b'/')
        })
    {
        return Err(ObservationJournalError::Configuration(format!(
            "{label} must contain 1 to {maximum} safe ASCII bytes"
        )));
    }
    Ok(())
}

fn identity_from_environment(name: &str) -> Result<Option<String>, ObservationJournalError> {
    match std::env::var(name) {
        Ok(value) => {
            validate_ascii_identifier(name, &value, 128)?;
            Ok(Some(value))
        }
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(ObservationJournalError::Configuration(
            format!("{name} must be valid UTF-8"),
        )),
    }
}

fn validate_text_identifier(
    label: &str,
    value: &str,
    maximum: usize,
) -> Result<(), ObservationJournalError> {
    if !is_bounded_text(value, maximum)
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\t'))
    {
        return Err(ObservationJournalError::Configuration(format!(
            "{label} must contain 1 to {maximum} non-control characters"
        )));
    }
    Ok(())
}

fn validate_consumer_id(value: &str) -> Result<(), ObservationJournalError> {
    validate_ascii_identifier("semantic consumerId", value, 128)
}

fn merge_object(target: &mut Value, source: Value) -> Result<(), ObservationJournalError> {
    let target = target.as_object_mut().ok_or_else(|| {
        ObservationJournalError::Configuration(
            "stored semantic metadata payload is not an object".to_owned(),
        )
    })?;
    let source = source.as_object().ok_or_else(|| {
        ObservationJournalError::Configuration(
            "stored semantic content payload is not an object".to_owned(),
        )
    })?;
    for (key, value) in source {
        if target.insert(key.clone(), value.clone()).is_some() {
            return Err(ObservationJournalError::Authentication);
        }
    }
    Ok(())
}

fn copy_string(
    source: Option<&Map<String, Value>>,
    source_key: &str,
    target: &mut Map<String, Value>,
    target_key: &str,
) {
    if let Some(value) = source
        .and_then(|source| source.get(source_key))
        .and_then(Value::as_str)
    {
        target.insert(target_key.to_owned(), Value::String(value.to_owned()));
    }
}

fn non_empty_object(value: Map<String, Value>) -> Option<Value> {
    (!value.is_empty()).then_some(Value::Object(value))
}

fn digest_json(value: &Value) -> Result<String, ObservationJournalError> {
    Ok(digest_hex(&serde_json::to_vec(value)?))
}

fn push_coverage(values: &mut Vec<CoverageLevelV2>, value: CoverageLevelV2) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn ordered_coverage<'a>(values: impl Iterator<Item = &'a CoverageLevelV2>) -> Vec<CoverageLevelV2> {
    let present = values.copied().collect::<HashSet<_>>();
    [
        CoverageLevelV2::Content,
        CoverageLevelV2::Metadata,
        CoverageLevelV2::Redacted,
        CoverageLevelV2::Denied,
        CoverageLevelV2::Unavailable,
    ]
    .into_iter()
    .filter(|value| present.contains(value))
    .collect()
}

fn push_unique_string(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|candidate| candidate == value) {
        values.push(value.to_owned());
    }
}

fn url_domain(url: &str) -> Option<String> {
    let after_scheme = url
        .split_once("://")
        .map_or(url, |(_, remainder)| remainder);
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = if host_port.starts_with('[') {
        host_port
            .split(']')
            .next()
            .map(|value| format!("{value}]"))?
    } else {
        host_port.split(':').next()?.to_owned()
    };
    (!host.is_empty()).then_some(host.to_ascii_lowercase())
}

fn initialize(connection: &mut Connection) -> Result<(), ObservationJournalError> {
    let version = connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    if version > SCHEMA_VERSION {
        return Err(ObservationJournalError::Configuration(format!(
            "observation database schema {version} is newer than supported schema {SCHEMA_VERSION}"
        )));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if version == 0 {
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS journal_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS encrypted_payloads (
                content_ref TEXT PRIMARY KEY,
                owner_kind TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
                ended_at_ms INTEGER NOT NULL CHECK (ended_at_ms >= started_at_ms),
                key_version TEXT NOT NULL,
                nonce BLOB NOT NULL CHECK (length(nonce) = 12),
                ciphertext BLOB NOT NULL,
                content_hash TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS observations (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                observation_id TEXT NOT NULL UNIQUE,
                schema_version TEXT NOT NULL,
                device_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
                ended_at_ms INTEGER NOT NULL CHECK (ended_at_ms >= started_at_ms),
                sensor TEXT NOT NULL,
                adapter_version TEXT NOT NULL,
                app_id TEXT NOT NULL,
                app_name TEXT NOT NULL,
                opaque_window_id TEXT,
                reliability TEXT NOT NULL CHECK (
                    reliability IN ('high', 'medium', 'low')
                ),
                coverage_json TEXT NOT NULL,
                redactions_json TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                content_state TEXT NOT NULL CHECK (
                    content_state IN ('available', 'redacted', 'expired', 'unavailable')
                ),
                content_ref TEXT,
                dedup_hash TEXT NOT NULL,
                deduplication_key TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
                FOREIGN KEY(content_ref) REFERENCES encrypted_payloads(content_ref)
             );
             CREATE INDEX IF NOT EXISTS observations_time_sequence
                ON observations(ended_at_ms, sequence);
             CREATE INDEX IF NOT EXISTS observations_kind_sequence
                ON observations(kind, sequence);
             CREATE TABLE IF NOT EXISTS semantic_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                schema_version TEXT NOT NULL,
                device_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                source TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
                observed_at_ms INTEGER NOT NULL CHECK (
                    observed_at_ms >= occurred_at_ms
                ),
                goal_version INTEGER CHECK (goal_version >= 0),
                count_class TEXT NOT NULL CHECK (
                    count_class IN ('effective', 'boundary', 'context', 'ignored')
                ),
                reliability TEXT NOT NULL CHECK (
                    reliability IN ('high', 'medium', 'low')
                ),
                coverage_json TEXT NOT NULL,
                content_state TEXT NOT NULL CHECK (
                    content_state IN ('available', 'redacted', 'expired', 'unavailable')
                ),
                taxonomy_version TEXT NOT NULL,
                projector_version TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                content_ref TEXT,
                created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
                FOREIGN KEY(content_ref) REFERENCES encrypted_payloads(content_ref)
             );
             CREATE INDEX IF NOT EXISTS semantic_events_time_sequence
                ON semantic_events(observed_at_ms, sequence);
             CREATE INDEX IF NOT EXISTS semantic_events_kind_sequence
                ON semantic_events(kind, sequence);
             CREATE TABLE IF NOT EXISTS semantic_event_lineage (
                event_id TEXT NOT NULL,
                observation_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
                PRIMARY KEY(event_id, observation_id),
                UNIQUE(event_id, ordinal),
                FOREIGN KEY(event_id) REFERENCES semantic_events(event_id)
                    ON DELETE CASCADE,
                FOREIGN KEY(observation_id) REFERENCES observations(observation_id)
                    ON DELETE RESTRICT
             );
             CREATE INDEX IF NOT EXISTS semantic_lineage_observation
                ON semantic_event_lineage(observation_id, event_id);
             CREATE TABLE IF NOT EXISTS observation_coverage_gaps (
                gap_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
                ended_at_ms INTEGER NOT NULL CHECK (ended_at_ms >= started_at_ms),
                reason TEXT NOT NULL,
                dedup_hash TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
             );
             CREATE INDEX IF NOT EXISTS observation_coverage_gaps_time
                ON observation_coverage_gaps(ended_at_ms, started_at_ms);
             CREATE TABLE IF NOT EXISTS semantic_consumers (
                consumer_id TEXT PRIMARY KEY,
                committed_sequence INTEGER NOT NULL CHECK (committed_sequence >= 0),
                committed_cursor TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
             );
             CREATE TABLE IF NOT EXISTS projector_state (
                state_key TEXT PRIMARY KEY,
                marker TEXT NOT NULL,
                content_ref TEXT,
                updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
                FOREIGN KEY(content_ref) REFERENCES encrypted_payloads(content_ref)
             );
             CREATE TABLE IF NOT EXISTS vault_records (
                namespace TEXT NOT NULL,
                record_id TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                content_ref TEXT NOT NULL UNIQUE,
                content_hash TEXT NOT NULL,
                key_version TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
                expires_at_ms INTEGER CHECK (expires_at_ms >= created_at_ms),
                PRIMARY KEY(namespace, record_id),
                FOREIGN KEY(content_ref) REFERENCES encrypted_payloads(content_ref)
             );
             CREATE INDEX IF NOT EXISTS vault_records_expiry
                ON vault_records(expires_at_ms)
                WHERE expires_at_ms IS NOT NULL;",
        )?;
    }
    if version < 2 {
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS observation_coverage_gaps (
                gap_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
                ended_at_ms INTEGER NOT NULL CHECK (ended_at_ms >= started_at_ms),
                reason TEXT NOT NULL,
                dedup_hash TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
             );
             CREATE INDEX IF NOT EXISTS observation_coverage_gaps_time
                ON observation_coverage_gaps(ended_at_ms, started_at_ms);",
        )?;
    }
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

fn connect(path: &Path) -> Result<Connection, ObservationJournalError> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA secure_delete = ON;",
    )?;
    harden_sqlite_permissions(path)?;
    Ok(connection)
}

fn load_or_create_meta_id(
    connection: &Connection,
    key: &str,
    prefix: &str,
) -> Result<String, ObservationJournalError> {
    if let Some(value) = connection
        .query_row(
            "SELECT value FROM journal_meta WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(value);
    }
    let generated = generate_instance_id(prefix);
    connection.execute(
        "INSERT OR IGNORE INTO journal_meta (key, value) VALUES (?1, ?2)",
        params![key, generated],
    )?;
    connection
        .query_row(
            "SELECT value FROM journal_meta WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn validate_semantic_cursor(
    connection: &Connection,
    sequence: i64,
    cursor: Option<&str>,
) -> Result<(), ObservationJournalError> {
    let maximum = semantic_sequence_highwater(connection)?;
    if sequence > maximum {
        return Err(ObservationJournalError::InvalidCursor(
            cursor.unwrap_or_default().to_owned(),
        ));
    }
    Ok(())
}

fn semantic_sequence_highwater(connection: &Connection) -> Result<i64, ObservationJournalError> {
    connection
        .query_row(
            "SELECT COALESCE(
                (
                    SELECT seq
                    FROM sqlite_sequence
                    WHERE name = 'semantic_events'
                ),
                0
             )",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(Into::into)
}

fn encode_cursor(sequence: i64, prefix: &str) -> String {
    format!("{prefix}{sequence:016x}")
}

fn decode_cursor(cursor: &str, prefix: &str) -> Result<i64, ObservationJournalError> {
    let Some(encoded) = cursor.strip_prefix(prefix) else {
        return Err(ObservationJournalError::InvalidCursor(cursor.to_owned()));
    };
    if encoded.len() != 16
        || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit())
        || encoded.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(ObservationJournalError::InvalidCursor(cursor.to_owned()));
    }
    let sequence = u64::from_str_radix(encoded, 16)
        .ok()
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(|| ObservationJournalError::InvalidCursor(cursor.to_owned()))?;
    if encode_cursor(sequence, prefix) != cursor {
        return Err(ObservationJournalError::InvalidCursor(cursor.to_owned()));
    }
    Ok(sequence)
}

fn duration_ms(label: &str, duration: Duration) -> Result<i64, ObservationJournalError> {
    let value = i64::try_from(duration.as_millis())
        .map_err(|_| ObservationJournalError::Configuration(format!("{label} is too large")))?;
    if value <= 0 {
        return Err(ObservationJournalError::Configuration(format!(
            "{label} must be positive"
        )));
    }
    Ok(value)
}

fn deterministic_id(prefix: &str, values: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.len().to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{prefix}_{}", digest_hex(&hasher.finalize()))
}

fn generate_instance_id(prefix: &str) -> String {
    let material = format!(
        "{prefix}:{}:{}:{}",
        now_ms(),
        std::process::id(),
        INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    format!("{prefix}_{}", &digest_hex(material.as_bytes())[..32])
}

fn digest_hex(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn sensor_name(value: ObservationSensorV2) -> &'static str {
    match value {
        ObservationSensorV2::Workspace => "workspace",
        ObservationSensorV2::Ax => "ax",
        ObservationSensorV2::Ocr => "ocr",
        ObservationSensorV2::AppleEvents => "apple_events",
        ObservationSensorV2::CgActivity => "cg_activity",
    }
}

fn parse_sensor(value: &str) -> Result<ObservationSensorV2, ObservationJournalError> {
    match value {
        "workspace" => Ok(ObservationSensorV2::Workspace),
        "ax" => Ok(ObservationSensorV2::Ax),
        "ocr" => Ok(ObservationSensorV2::Ocr),
        "apple_events" => Ok(ObservationSensorV2::AppleEvents),
        "cg_activity" => Ok(ObservationSensorV2::CgActivity),
        _ => Err(ObservationJournalError::Configuration(
            "stored observation has an unknown sensor".to_owned(),
        )),
    }
}

fn reliability_name(value: EvidenceReliabilityV2) -> &'static str {
    match value {
        EvidenceReliabilityV2::High => "high",
        EvidenceReliabilityV2::Medium => "medium",
        EvidenceReliabilityV2::Low => "low",
    }
}

fn parse_reliability(value: &str) -> Result<EvidenceReliabilityV2, ObservationJournalError> {
    match value {
        "high" => Ok(EvidenceReliabilityV2::High),
        "medium" => Ok(EvidenceReliabilityV2::Medium),
        "low" => Ok(EvidenceReliabilityV2::Low),
        _ => Err(ObservationJournalError::Configuration(
            "stored observation has an unknown reliability".to_owned(),
        )),
    }
}

fn count_class_name(value: SemanticCountClassV2) -> &'static str {
    match value {
        SemanticCountClassV2::Effective => "effective",
        SemanticCountClassV2::Boundary => "boundary",
        SemanticCountClassV2::Context => "context",
        SemanticCountClassV2::Ignored => "ignored",
    }
}

fn parse_count_class(value: &str) -> Result<SemanticCountClassV2, ObservationJournalError> {
    match value {
        "effective" => Ok(SemanticCountClassV2::Effective),
        "boundary" => Ok(SemanticCountClassV2::Boundary),
        "context" => Ok(SemanticCountClassV2::Context),
        "ignored" => Ok(SemanticCountClassV2::Ignored),
        _ => Err(ObservationJournalError::Configuration(
            "stored semantic event has an unknown count class".to_owned(),
        )),
    }
}

fn content_state_name(value: SemanticContentStateV2) -> &'static str {
    match value {
        SemanticContentStateV2::Available => "available",
        SemanticContentStateV2::Redacted => "redacted",
        SemanticContentStateV2::Expired => "expired",
        SemanticContentStateV2::Unavailable => "unavailable",
    }
}

fn parse_content_state(value: &str) -> Result<SemanticContentStateV2, ObservationJournalError> {
    match value {
        "available" => Ok(SemanticContentStateV2::Available),
        "redacted" => Ok(SemanticContentStateV2::Redacted),
        "expired" => Ok(SemanticContentStateV2::Expired),
        "unavailable" => Ok(SemanticContentStateV2::Unavailable),
        _ => Err(ObservationJournalError::Configuration(
            "stored record has an unknown content state".to_owned(),
        )),
    }
}

#[cfg(unix)]
fn harden_directory_permissions(path: &Path) -> Result<(), ObservationJournalError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn harden_directory_permissions(_path: &Path) -> Result<(), ObservationJournalError> {
    Ok(())
}

#[cfg(unix)]
fn harden_sqlite_permissions(path: &Path) -> Result<(), ObservationJournalError> {
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = OsString::from(path.as_os_str());
        sidecar.push(suffix);
        match fs::set_permissions(PathBuf::from(sidecar), fs::Permissions::from_mode(0o600)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_sqlite_permissions(_path: &Path) -> Result<(), ObservationJournalError> {
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod macos_keychain_policy_tests {
    use super::{MacKeychainTarget, MacSigningIdentity, classify_mac_signing_details};

    #[test]
    fn only_team_signed_builds_select_a_direct_keychain_target() {
        assert_eq!(
            classify_mac_signing_details("Signature=adhoc\nTeamIdentifier=not set\n"),
            MacSigningIdentity::AdHoc
        );
        assert_eq!(
            classify_mac_signing_details(
                "Authority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\n"
            ),
            MacSigningIdentity::TeamSigned
        );
        assert_eq!(
            classify_mac_signing_details(
                "Authority=WhaleHall Local Development\nTeamIdentifier=not set\n"
            ),
            MacSigningIdentity::StableLocal
        );
        assert_eq!(
            classify_mac_signing_details("TeamIdentifier=not set\n"),
            MacSigningIdentity::Unsupported
        );
        assert_eq!(
            MacKeychainTarget::for_signing_identity(MacSigningIdentity::TeamSigned),
            Some(MacKeychainTarget::DataProtection)
        );
        assert_eq!(
            MacKeychainTarget::for_signing_identity(MacSigningIdentity::StableLocal),
            None
        );
        assert_eq!(
            MacKeychainTarget::for_signing_identity(MacSigningIdentity::AdHoc),
            None
        );
        assert_eq!(
            MacKeychainTarget::for_signing_identity(MacSigningIdentity::Unsupported),
            None
        );
    }
}

#[cfg(test)]
mod key_cache_policy_tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    struct RecoveringKeyProvider {
        calls: AtomicUsize,
    }

    impl RecoveringKeyProvider {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl ObservationKeyProvider for RecoveringKeyProvider {
        fn load_or_create(&self) -> Result<ObservationKey, ObservationKeyError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(ObservationKeyError::Unavailable)
            } else {
                Ok(ObservationKey::from_bytes([0x2a; 32], "recovering-test-v1"))
            }
        }
    }

    struct MigratingKeyProvider {
        load_calls: AtomicUsize,
        migration_calls: AtomicUsize,
        migrated: AtomicBool,
    }

    impl MigratingKeyProvider {
        fn new() -> Self {
            Self {
                load_calls: AtomicUsize::new(0),
                migration_calls: AtomicUsize::new(0),
                migrated: AtomicBool::new(false),
            }
        }

        fn migrated_key() -> ObservationKey {
            ObservationKey::from_stored_bytes(
                [0x3c; 32],
                LEGACY_DEV_KEY_VERSION,
                ObservationKeyStorageMode::LocalLoginKeychain,
            )
        }
    }

    impl ObservationKeyProvider for MigratingKeyProvider {
        fn load_or_create(&self) -> Result<ObservationKey, ObservationKeyError> {
            self.load_calls.fetch_add(1, Ordering::SeqCst);
            if self.migrated.load(Ordering::SeqCst) {
                Ok(Self::migrated_key())
            } else {
                Err(ObservationKeyError::MigrationRequired {
                    interactive_available: true,
                })
            }
        }

        fn migrate_legacy_key_interactive(
            &self,
        ) -> Result<(ObservationKey, bool), ObservationKeyError> {
            self.migration_calls.fetch_add(1, Ordering::SeqCst);
            let migrated = !self.migrated.swap(true, Ordering::SeqCst);
            Ok((Self::migrated_key(), migrated))
        }
    }

    #[test]
    fn retry_schedule_caps_at_five_minutes() {
        assert_eq!(key_load_retry_delay(0), Duration::from_secs(5));
        assert_eq!(key_load_retry_delay(1), Duration::from_secs(5));
        assert_eq!(key_load_retry_delay(2), Duration::from_secs(15));
        assert_eq!(key_load_retry_delay(3), Duration::from_secs(45));
        assert_eq!(key_load_retry_delay(4), Duration::from_secs(2 * 60));
        assert_eq!(key_load_retry_delay(5), Duration::from_secs(5 * 60));
        assert_eq!(key_load_retry_delay(500), Duration::from_secs(5 * 60));
    }

    #[test]
    fn an_expired_failure_retries_once_and_then_caches_success() {
        let directory = tempfile::tempdir().expect("create key retry directory");
        let provider = Arc::new(RecoveringKeyProvider::new());
        let journal = ObservationJournal::open_with_config(ObservationJournalConfig::new(
            directory.path().join("key-retry.sqlite3"),
            provider.clone(),
        ))
        .expect("open key retry journal");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert!(!journal.key_available());
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);

        {
            let mut state = journal
                .inner
                .key_state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            match &mut *state {
                ObservationKeyState::RetryAfter { retry_at, .. } => {
                    *retry_at = Instant::now();
                }
                ObservationKeyState::Ready(_) => panic!("first key load must fail"),
            }
        }

        assert!(journal.key().is_ok());
        assert!(journal.key_available());
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        for _ in 0..100 {
            assert!(journal.key().is_ok());
            assert!(journal.key_available());
        }
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            2,
            "a successful retry must remain cached"
        );
    }

    #[test]
    fn status_is_pure_memory_and_explicit_migration_caches_the_verified_key() {
        let directory = tempfile::tempdir().expect("create key migration directory");
        let provider = Arc::new(MigratingKeyProvider::new());
        let journal = ObservationJournal::open_with_config(ObservationJournalConfig::new(
            directory.path().join("key-migration.sqlite3"),
            provider.clone(),
        ))
        .expect("open migration-required journal");

        for _ in 0..100 {
            assert_eq!(
                journal.key_status(),
                ObservationKeyStatus {
                    availability: ObservationKeyAvailability::MigrationRequired,
                    storage_mode: None,
                    key_version: None,
                    interactive_migration_available: true,
                }
            );
        }
        assert_eq!(provider.load_calls.load(Ordering::SeqCst), 1);
        assert_eq!(provider.migration_calls.load(Ordering::SeqCst), 0);

        let result = journal
            .migrate_legacy_key_interactive()
            .expect("perform explicit migration");
        assert!(result.migrated);
        assert_eq!(
            result.storage_mode,
            ObservationKeyStorageMode::LocalLoginKeychain
        );
        assert_eq!(result.key_version, LEGACY_DEV_KEY_VERSION);
        assert_eq!(provider.load_calls.load(Ordering::SeqCst), 1);
        assert_eq!(provider.migration_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            journal.key_status(),
            ObservationKeyStatus {
                availability: ObservationKeyAvailability::Available,
                storage_mode: Some(ObservationKeyStorageMode::LocalLoginKeychain),
                key_version: Some(LEGACY_DEV_KEY_VERSION.to_owned()),
                interactive_migration_available: false,
            }
        );
    }

    #[test]
    fn migrated_key_readback_must_match_and_never_exposes_bytes() {
        let source = [0x4d; 32];
        let verified = verified_migrated_key(
            &source,
            &source,
            ObservationKeyStorageMode::DataProtectionKeychain,
        )
        .expect("equal readback");
        assert_eq!(verified.bytes(), &source);
        assert_eq!(verified.version(), LEGACY_DEV_KEY_VERSION);
        assert_eq!(
            verified.storage_mode(),
            ObservationKeyStorageMode::DataProtectionKeychain
        );
        assert!(matches!(
            verified_migrated_key(
                &source,
                &[0x5e; 32],
                ObservationKeyStorageMode::DataProtectionKeychain,
            ),
            Err(ObservationKeyError::MigrationVerificationFailed)
        ));
        assert!(matches!(
            verified_migrated_key(
                &[0x4d; 31],
                &[0x4d; 31],
                ObservationKeyStorageMode::DataProtectionKeychain,
            ),
            Err(ObservationKeyError::InvalidSize)
        ));
    }

    #[test]
    fn ciphertext_key_version_is_authenticated_but_not_a_storage_location() {
        let legacy_key = ObservationKey::from_stored_bytes(
            [0x6f; 32],
            LEGACY_DEV_KEY_VERSION,
            ObservationKeyStorageMode::LegacyDevelopmentKeychain,
        );
        let encrypted = encrypt_value(
            &legacy_key,
            "raw",
            "observation-1",
            "raw-observation.v2",
            1_000,
            1_000,
            &json!({"visibleText": "legacy ciphertext"}),
        )
        .expect("encrypt with legacy key version");
        let stored = StoredEncryptedValue {
            owner_kind: "raw".to_owned(),
            owner_id: "observation-1".to_owned(),
            schema_version: "raw-observation.v2".to_owned(),
            started_at_ms: 1_000,
            ended_at_ms: 1_000,
            key_version: encrypted.key_version,
            nonce: encrypted.nonce.to_vec(),
            ciphertext: encrypted.ciphertext,
            content_hash: encrypted.content_hash,
        };
        let migrated_key = ObservationKey::from_stored_bytes(
            [0x6f; 32],
            KEY_VERSION,
            ObservationKeyStorageMode::LocalLoginKeychain,
        );
        assert_eq!(
            decrypt_value(&migrated_key, &stored)
                .expect("decrypt legacy ciphertext after migration"),
            json!({"visibleText": "legacy ciphertext"})
        );
        let wrong_key = ObservationKey::from_stored_bytes(
            [0x70; 32],
            KEY_VERSION,
            ObservationKeyStorageMode::LocalLoginKeychain,
        );
        assert!(matches!(
            decrypt_value(&wrong_key, &stored),
            Err(ObservationJournalError::Authentication)
        ));
    }
}

#[cfg(test)]
mod coverage_gap_policy_tests {
    use super::{CoverageLevelV2, ObservationSensorV2, anonymous_coverage_level};

    #[test]
    fn native_gap_reason_allowlist_is_sensor_scoped_and_complete() {
        for reason in ["user_excluded_application", "sensitive_application"] {
            assert_eq!(
                anonymous_coverage_level(ObservationSensorV2::Workspace, reason),
                Some(CoverageLevelV2::Redacted)
            );
        }
        for reason in [
            "user_excluded_application",
            "sensitive_application",
            "sensitive_or_private_window",
            "protected_input",
            "private_window",
            "sensitive_visible_content",
            "sensitive_focused_control",
            "sensitive_final_value",
            "protected_content",
        ] {
            assert_eq!(
                anonymous_coverage_level(ObservationSensorV2::Ax, reason),
                Some(CoverageLevelV2::Redacted)
            );
        }
        for reason in [
            "input_monitoring_unavailable",
            "input_event_tap_disabled",
            "input_event_tap_start_timeout",
        ] {
            assert_eq!(
                anonymous_coverage_level(ObservationSensorV2::CgActivity, reason),
                Some(CoverageLevelV2::Unavailable)
            );
        }
        for reason in [
            "browser_privacy_state_unavailable",
            "thermal_critical",
            "foreground_window_unavailable",
            "screen_capture_failed",
        ] {
            assert_eq!(
                anonymous_coverage_level(ObservationSensorV2::Ocr, reason),
                Some(CoverageLevelV2::Unavailable)
            );
        }
        assert_eq!(
            anonymous_coverage_level(
                ObservationSensorV2::Workspace,
                "browser_privacy_state_unavailable"
            ),
            None
        );
        assert_eq!(
            anonymous_coverage_level(ObservationSensorV2::Ocr, "sensitive_application"),
            None
        );
        assert_eq!(
            anonymous_coverage_level(ObservationSensorV2::AppleEvents, "thermal_critical"),
            None
        );
        assert_eq!(
            anonymous_coverage_level(ObservationSensorV2::Ocr, "invented_reason"),
            None
        );
        assert_eq!(
            anonymous_coverage_level(ObservationSensorV2::CgActivity, "screen_capture_failed"),
            None
        );
    }
}
