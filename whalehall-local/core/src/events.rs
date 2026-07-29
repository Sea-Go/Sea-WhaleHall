use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::broadcast;
use whalehall_local_protocol::{
    DESKTOP_EVENT_SCHEMA_VERSION, DesktopEvent, DesktopEventSensitivity, EventCommitParams,
    EventCommitResult, EventQueryParams, EventQueryResult, MAX_EVENT_QUERY_LIMIT,
    desktop_event_kinds,
};

const SCHEMA_VERSION: i64 = 1;
const DEFAULT_BROADCAST_CAPACITY: usize = 256;
const DEFAULT_RETENTION_DAYS: u64 = 30;
const MAX_EVENT_PAYLOAD_BYTES: usize = 256 * 1024;
const CURSOR_PREFIX: &str = "ec1_";
pub const EVENT_START_CURSOR: &str = "ec1_0000000000000000";
const RETAINED_THROUGH_KEY: &str = "retained_through_sequence";
const DEVICE_ID_KEY: &str = "device_id";

static INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct EventJournalConfig {
    pub database_path: PathBuf,
    pub retention: Duration,
    pub broadcast_capacity: usize,
}

impl EventJournalConfig {
    pub fn new(database_path: impl Into<PathBuf>) -> Self {
        Self {
            database_path: database_path.into(),
            retention: Duration::from_secs(DEFAULT_RETENTION_DAYS * 24 * 60 * 60),
            broadcast_capacity: DEFAULT_BROADCAST_CAPACITY,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesktopEventDraft {
    pub kind: String,
    pub source: String,
    pub occurred_at_ms: i64,
    pub observed_at_ms: i64,
    pub goal_version: Option<i64>,
    pub sensitivity: DesktopEventSensitivity,
    pub payload: Value,
    pub deduplication_key: String,
}

impl DesktopEventDraft {
    pub fn metadata(
        kind: impl Into<String>,
        source: impl Into<String>,
        occurred_at_ms: i64,
        payload: Value,
        deduplication_key: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            source: source.into(),
            occurred_at_ms,
            observed_at_ms: occurred_at_ms,
            goal_version: None,
            sensitivity: DesktopEventSensitivity::Metadata,
            payload,
            deduplication_key: deduplication_key.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventAppendResult {
    pub event: DesktopEvent,
    pub inserted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventRetentionResult {
    pub deleted_events: usize,
    pub cutoff_at_ms: i64,
    pub retained_through_cursor: String,
    pub protected_by_consumer_cursor: Option<String>,
}

#[derive(Debug, Error)]
pub enum EventJournalError {
    #[error("Event journal configuration error: {0}")]
    Configuration(String),
    #[error("Event journal database I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Event journal database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Event journal JSON operation failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid event cursor: {0}")]
    InvalidCursor(String),
    #[error("Event cursor is older than retained history: {0}")]
    CursorExpired(String),
    #[error(
        "Consumer {consumer_id} cannot move its cursor backwards from {current} to {attempted}"
    )]
    CursorRegression {
        consumer_id: String,
        current: String,
        attempted: String,
    },
    #[error("Event idempotency key was reused with different event data: {event_id}")]
    IdempotencyConflict { event_id: String },
}

#[derive(Clone)]
pub struct EventJournal {
    inner: Arc<EventJournalInner>,
}

struct EventJournalInner {
    database_path: PathBuf,
    retention_ms: i64,
    device_id: String,
    session_id: String,
    publisher: broadcast::Sender<DesktopEvent>,
    append_guard: Mutex<()>,
}

impl EventJournal {
    pub fn open(database_path: impl Into<PathBuf>) -> Result<Self, EventJournalError> {
        Self::open_with_config(EventJournalConfig::new(database_path))
    }

    pub fn open_with_config(config: EventJournalConfig) -> Result<Self, EventJournalError> {
        if config.broadcast_capacity == 0 {
            return Err(EventJournalError::Configuration(
                "event broadcast capacity must be greater than zero".to_owned(),
            ));
        }
        let retention_ms = i64::try_from(config.retention.as_millis()).map_err(|_| {
            EventJournalError::Configuration("event retention duration is too large".to_owned())
        })?;
        if retention_ms <= 0 {
            return Err(EventJournalError::Configuration(
                "event retention duration must be greater than zero".to_owned(),
            ));
        }
        if let Some(parent) = config
            .database_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            let parent_already_existed = parent.exists();
            fs::create_dir_all(parent)?;
            if !parent_already_existed {
                harden_directory_permissions(parent)?;
            }
        }

        let mut connection = connect(&config.database_path)?;
        initialize(&mut connection)?;
        let device_id = load_or_create_device_id(&connection)?;
        let session_id = generate_instance_id("session");
        let (publisher, _) = broadcast::channel(config.broadcast_capacity);
        Ok(Self {
            inner: Arc::new(EventJournalInner {
                database_path: config.database_path,
                retention_ms,
                device_id,
                session_id,
                publisher,
                append_guard: Mutex::new(()),
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

    pub fn subscribe(&self) -> broadcast::Receiver<DesktopEvent> {
        self.inner.publisher.subscribe()
    }

    pub fn append(&self, draft: DesktopEventDraft) -> Result<EventAppendResult, EventJournalError> {
        validate_draft(&draft)?;
        let payload_json = serde_json::to_string(&draft.payload)?;
        if payload_json.len() > MAX_EVENT_PAYLOAD_BYTES {
            return Err(EventJournalError::Configuration(format!(
                "event payload exceeds {MAX_EVENT_PAYLOAD_BYTES} bytes"
            )));
        }
        let event_id = deterministic_event_id(
            &self.inner.device_id,
            &draft.source,
            &draft.deduplication_key,
        )?;
        let _append_guard = self
            .inner
            .append_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = transaction.execute(
            "INSERT INTO desktop_events (
                event_id, schema_version, device_id, session_id, kind, source,
                occurred_at_ms, observed_at_ms, goal_version, sensitivity, payload_json,
                deduplication_key
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(event_id) DO NOTHING",
            params![
                event_id,
                DESKTOP_EVENT_SCHEMA_VERSION,
                self.inner.device_id,
                self.inner.session_id,
                draft.kind,
                draft.source,
                draft.occurred_at_ms,
                draft.observed_at_ms,
                draft.goal_version,
                sensitivity_name(&draft.sensitivity),
                payload_json,
                draft.deduplication_key,
            ],
        )? == 1;
        let stored = select_event_by_id(&transaction, &event_id)?.ok_or_else(|| {
            EventJournalError::Configuration(format!(
                "event {event_id} was not readable after append"
            ))
        })?;
        let event = stored.into_event()?;
        if !inserted && !same_idempotent_event(&event, &draft) {
            return Err(EventJournalError::IdempotencyConflict { event_id });
        }
        transaction.commit()?;
        if inserted {
            let _ = self.inner.publisher.send(event.clone());
        }
        Ok(EventAppendResult { event, inserted })
    }

    pub fn query(&self, params: &EventQueryParams) -> Result<EventQueryResult, EventJournalError> {
        if !(1..=MAX_EVENT_QUERY_LIMIT).contains(&params.limit) {
            return Err(EventJournalError::Configuration(format!(
                "event.query limit must be between 1 and {MAX_EVENT_QUERY_LIMIT}"
            )));
        }
        if params.after_cursor.is_some() && params.consumer_id.is_some() {
            return Err(EventJournalError::Configuration(
                "event.query afterCursor and consumerId are mutually exclusive".to_owned(),
            ));
        }
        let resolved_after_cursor = if let Some(consumer_id) = params.consumer_id.as_deref() {
            self.committed_cursor(consumer_id)?
        } else {
            params.after_cursor.clone()
        };
        let after_sequence = match resolved_after_cursor.as_deref() {
            Some(cursor) => decode_cursor(cursor)?,
            None => 0,
        };
        let connection = connect(&self.inner.database_path)?;
        if let Some(cursor) = resolved_after_cursor.as_deref() {
            validate_cursor_position(&connection, after_sequence, cursor)?;
        }

        let fetch_limit = params.limit.saturating_add(1);
        let mut statement = connection.prepare(
            "SELECT sequence, event_id, schema_version, device_id, session_id,
                    kind, source, occurred_at_ms, observed_at_ms, goal_version,
                    sensitivity, payload_json
             FROM desktop_events
             WHERE sequence > ?1
             ORDER BY sequence ASC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![
                after_sequence,
                i64::try_from(fetch_limit).unwrap_or(i64::MAX)
            ],
            stored_event_from_row,
        )?;
        let mut events = rows
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(StoredEvent::into_event)
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = events.len() > params.limit;
        if has_more {
            events.pop();
        }
        let next_cursor = events
            .last()
            .map(|event| event.cursor.clone())
            .or(resolved_after_cursor);
        Ok(EventQueryResult {
            events,
            next_cursor,
            has_more,
        })
    }

    pub fn commit(
        &self,
        params: &EventCommitParams,
    ) -> Result<EventCommitResult, EventJournalError> {
        validate_consumer_id(&params.consumer_id)?;
        let sequence = decode_cursor(&params.cursor)?;
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        validate_cursor_position(&transaction, sequence, &params.cursor)?;
        let current = transaction
            .query_row(
                "SELECT committed_sequence, committed_cursor
                 FROM event_consumers
                 WHERE consumer_id = ?1",
                [&params.consumer_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((current_sequence, current_cursor)) = current {
            if sequence < current_sequence {
                return Err(EventJournalError::CursorRegression {
                    consumer_id: params.consumer_id.clone(),
                    current: current_cursor,
                    attempted: params.cursor.clone(),
                });
            }
            if sequence == current_sequence {
                transaction.commit()?;
                return Ok(EventCommitResult {
                    consumer_id: params.consumer_id.clone(),
                    cursor: current_cursor,
                    advanced: false,
                });
            }
        }

        transaction.execute(
            "INSERT INTO event_consumers (
                consumer_id, committed_sequence, committed_cursor, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(consumer_id) DO UPDATE SET
                committed_sequence = excluded.committed_sequence,
                committed_cursor = excluded.committed_cursor,
                updated_at_ms = excluded.updated_at_ms",
            params![params.consumer_id, sequence, params.cursor, now_ms()],
        )?;
        transaction.commit()?;
        Ok(EventCommitResult {
            consumer_id: params.consumer_id.clone(),
            cursor: params.cursor.clone(),
            advanced: true,
        })
    }

    pub fn committed_cursor(&self, consumer_id: &str) -> Result<Option<String>, EventJournalError> {
        validate_consumer_id(consumer_id)?;
        let connection = connect(&self.inner.database_path)?;
        connection
            .query_row(
                "SELECT committed_cursor
                 FROM event_consumers
                 WHERE consumer_id = ?1",
                [consumer_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Returns the most recent durable grant/revoke state that names a
    /// permission, or `None` when that permission has no recorded boundary.
    ///
    /// Sensors use this to close a revoke with a grant even when the process
    /// restarts between the two operating-system permission transitions.
    pub fn latest_authorization_state(
        &self,
        permission: &str,
    ) -> Result<Option<bool>, EventJournalError> {
        validate_identifier("authorization permission", permission, 128)?;
        let connection = connect(&self.inner.database_path)?;
        let mut statement = connection.prepare(
            "SELECT kind, payload_json
             FROM desktop_events
             WHERE kind IN (?1, ?2)
             ORDER BY sequence DESC",
        )?;
        let rows = statement.query_map(
            params![
                desktop_event_kinds::AUTHORIZATION_GRANTED,
                desktop_event_kinds::AUTHORIZATION_REVOKED,
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        for row in rows {
            let (kind, payload_json) = row?;
            let payload = serde_json::from_str::<Value>(&payload_json)?;
            let names_permission = payload
                .get("permissions")
                .and_then(Value::as_array)
                .is_some_and(|permissions| {
                    permissions
                        .iter()
                        .any(|candidate| candidate.as_str() == Some(permission))
                });
            if names_permission {
                return Ok(Some(kind == desktop_event_kinds::AUTHORIZATION_GRANTED));
            }
        }
        Ok(None)
    }

    pub fn cleanup(&self, now_at_ms: i64) -> Result<EventRetentionResult, EventJournalError> {
        let cutoff_at_ms = now_at_ms.saturating_sub(self.inner.retention_ms);
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let minimum_consumer_sequence = transaction.query_row(
            "SELECT MIN(committed_sequence) FROM event_consumers",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        let maximum_sequence = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM desktop_events",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        let consumer_guard = minimum_consumer_sequence.unwrap_or(maximum_sequence);
        let first_not_expired = transaction.query_row(
            "SELECT MIN(sequence)
             FROM desktop_events
             WHERE observed_at_ms >= ?1",
            [cutoff_at_ms],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        let expiry_guard = first_not_expired
            .map(|sequence| sequence.saturating_sub(1))
            .unwrap_or(maximum_sequence);
        let deletion_through = consumer_guard.min(expiry_guard).min(maximum_sequence);
        let maximum_deleted = if deletion_through > 0 {
            transaction.query_row(
                "SELECT MAX(sequence)
                 FROM desktop_events
                 WHERE sequence <= ?1 AND observed_at_ms < ?2",
                params![deletion_through, cutoff_at_ms],
                |row| row.get::<_, Option<i64>>(0),
            )?
        } else {
            None
        };
        let deleted_events = if deletion_through > 0 {
            transaction.execute(
                "DELETE FROM desktop_events
                 WHERE sequence <= ?1 AND observed_at_ms < ?2",
                params![deletion_through, cutoff_at_ms],
            )?
        } else {
            0
        };
        let retained_through = retained_through_sequence(&transaction)?;
        let retained_through = maximum_deleted
            .map(|sequence| sequence.max(retained_through))
            .unwrap_or(retained_through);
        if maximum_deleted.is_some() {
            transaction.execute(
                "UPDATE journal_meta SET value = ?1 WHERE key = ?2",
                params![retained_through.to_string(), RETAINED_THROUGH_KEY],
            )?;
        }
        transaction.commit()?;
        Ok(EventRetentionResult {
            deleted_events,
            cutoff_at_ms,
            retained_through_cursor: encode_cursor(retained_through),
            protected_by_consumer_cursor: minimum_consumer_sequence.map(encode_cursor),
        })
    }
}

fn validate_draft(draft: &DesktopEventDraft) -> Result<(), EventJournalError> {
    validate_identifier("event kind", &draft.kind, 128)?;
    validate_identifier("event source", &draft.source, 128)?;
    validate_identifier("event deduplication key", &draft.deduplication_key, 512)?;
    if draft.occurred_at_ms < 0 || draft.observed_at_ms < 0 {
        return Err(EventJournalError::Configuration(
            "event timestamps must not be negative".to_owned(),
        ));
    }
    if draft.observed_at_ms < draft.occurred_at_ms {
        return Err(EventJournalError::Configuration(
            "event observedAtMs must be at or after occurredAtMs".to_owned(),
        ));
    }
    if draft.goal_version.is_some_and(|version| version < 0) {
        return Err(EventJournalError::Configuration(
            "event goalVersion must not be negative".to_owned(),
        ));
    }
    if !draft.payload.is_object() {
        return Err(EventJournalError::Configuration(
            "event payload must be a JSON object".to_owned(),
        ));
    }
    Ok(())
}

fn validate_identifier(
    label: &str,
    value: &str,
    maximum_length: usize,
) -> Result<(), EventJournalError> {
    if value.is_empty() || value.len() > maximum_length || value.chars().any(char::is_control) {
        return Err(EventJournalError::Configuration(format!(
            "{label} must contain 1 to {maximum_length} non-control bytes"
        )));
    }
    Ok(())
}

fn validate_consumer_id(consumer_id: &str) -> Result<(), EventJournalError> {
    if consumer_id.is_empty()
        || consumer_id.len() > 128
        || !consumer_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(EventJournalError::Configuration(
            "event consumerId must contain 1 to 128 ASCII letters, digits, '.', '_', ':', or '-'"
                .to_owned(),
        ));
    }
    Ok(())
}

fn same_idempotent_event(event: &DesktopEvent, draft: &DesktopEventDraft) -> bool {
    event.schema_version == DESKTOP_EVENT_SCHEMA_VERSION
        && event.kind == draft.kind
        && event.source == draft.source
        && event.occurred_at_ms == draft.occurred_at_ms
        && event.observed_at_ms == draft.observed_at_ms
        && event.goal_version == draft.goal_version
        && event.sensitivity == draft.sensitivity
        && event.payload == draft.payload
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventIdentity<'a> {
    schema_version: &'static str,
    device_id: &'a str,
    source: &'a str,
    deduplication_key: &'a str,
}

fn deterministic_event_id(
    device_id: &str,
    source: &str,
    deduplication_key: &str,
) -> Result<String, EventJournalError> {
    let material = serde_json::to_vec(&EventIdentity {
        schema_version: DESKTOP_EVENT_SCHEMA_VERSION,
        device_id,
        source,
        deduplication_key,
    })?;
    Ok(format!("de1_{}", digest_hex(&material)))
}

fn generate_instance_id(prefix: &str) -> String {
    let sequence = INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let material = format!("{prefix}:{timestamp}:{}:{sequence}", std::process::id());
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

fn sensitivity_name(sensitivity: &DesktopEventSensitivity) -> &'static str {
    match sensitivity {
        DesktopEventSensitivity::Metadata => "metadata",
        DesktopEventSensitivity::Content => "content",
    }
}

fn parse_sensitivity(value: &str) -> Result<DesktopEventSensitivity, EventJournalError> {
    match value {
        "metadata" => Ok(DesktopEventSensitivity::Metadata),
        "content" => Ok(DesktopEventSensitivity::Content),
        value => Err(EventJournalError::Configuration(format!(
            "stored event has unknown sensitivity {value}"
        ))),
    }
}

fn encode_cursor(sequence: i64) -> String {
    format!("{CURSOR_PREFIX}{sequence:016x}")
}

fn decode_cursor(cursor: &str) -> Result<i64, EventJournalError> {
    let Some(encoded) = cursor.strip_prefix(CURSOR_PREFIX) else {
        return Err(EventJournalError::InvalidCursor(cursor.to_owned()));
    };
    if encoded.len() != 16
        || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit())
        || encoded.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(EventJournalError::InvalidCursor(cursor.to_owned()));
    }
    let sequence = u64::from_str_radix(encoded, 16)
        .ok()
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(|| EventJournalError::InvalidCursor(cursor.to_owned()))?;
    if encode_cursor(sequence) != cursor {
        return Err(EventJournalError::InvalidCursor(cursor.to_owned()));
    }
    Ok(sequence)
}

fn validate_cursor_position(
    connection: &Connection,
    sequence: i64,
    cursor: &str,
) -> Result<(), EventJournalError> {
    let retained_through = retained_through_sequence(connection)?;
    if sequence < retained_through {
        return Err(EventJournalError::CursorExpired(cursor.to_owned()));
    }
    let maximum_sequence = connection.query_row(
        "SELECT COALESCE(MAX(sequence), 0) FROM desktop_events",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if sequence > maximum_sequence && sequence > retained_through {
        return Err(EventJournalError::InvalidCursor(cursor.to_owned()));
    }
    if sequence > retained_through && sequence > 0 {
        let exists = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM desktop_events WHERE sequence = ?1)",
            [sequence],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(EventJournalError::InvalidCursor(cursor.to_owned()));
        }
    }
    Ok(())
}

fn retained_through_sequence(connection: &Connection) -> Result<i64, EventJournalError> {
    let value = connection.query_row(
        "SELECT value FROM journal_meta WHERE key = ?1",
        [RETAINED_THROUGH_KEY],
        |row| row.get::<_, String>(0),
    )?;
    value.parse::<i64>().map_err(|error| {
        EventJournalError::Configuration(format!(
            "stored retention cursor is not an integer: {error}"
        ))
    })
}

fn load_or_create_device_id(connection: &Connection) -> Result<String, EventJournalError> {
    if let Some(device_id) = connection
        .query_row(
            "SELECT value FROM journal_meta WHERE key = ?1",
            [DEVICE_ID_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(device_id);
    }
    let generated = generate_instance_id("device");
    connection.execute(
        "INSERT OR IGNORE INTO journal_meta (key, value) VALUES (?1, ?2)",
        params![DEVICE_ID_KEY, generated],
    )?;
    connection
        .query_row(
            "SELECT value FROM journal_meta WHERE key = ?1",
            [DEVICE_ID_KEY],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn initialize(connection: &mut Connection) -> Result<(), EventJournalError> {
    let version = connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    if version > SCHEMA_VERSION {
        return Err(EventJournalError::Configuration(format!(
            "event database schema {version} is newer than supported schema {SCHEMA_VERSION}"
        )));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if version == 0 {
        // IF NOT EXISTS makes an interrupted database from the former
        // non-transactional initializer reentrant. The surrounding immediate
        // transaction makes all DDL, seed metadata, and user_version visible
        // atomically for new databases.
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS desktop_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                schema_version TEXT NOT NULL,
                device_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                source TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
                observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= occurred_at_ms),
                goal_version INTEGER CHECK (goal_version >= 0),
                sensitivity TEXT NOT NULL CHECK (sensitivity IN ('metadata', 'content')),
                payload_json TEXT NOT NULL,
                deduplication_key TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS desktop_events_observed_sequence
                ON desktop_events(observed_at_ms, sequence);
             CREATE INDEX IF NOT EXISTS desktop_events_kind_sequence
                ON desktop_events(kind, sequence);
             CREATE TABLE IF NOT EXISTS event_consumers (
                consumer_id TEXT PRIMARY KEY,
                committed_sequence INTEGER NOT NULL CHECK (committed_sequence >= 0),
                committed_cursor TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
             );
             CREATE TABLE IF NOT EXISTS journal_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );
             INSERT OR IGNORE INTO journal_meta (key, value)
                VALUES ('retained_through_sequence', '0');",
        )?;
    }
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

fn connect(path: &Path) -> Result<Connection, EventJournalError> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    harden_sqlite_permissions(path)?;
    Ok(connection)
}

#[cfg(unix)]
fn harden_directory_permissions(path: &Path) -> Result<(), EventJournalError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn harden_directory_permissions(_path: &Path) -> Result<(), EventJournalError> {
    Ok(())
}

#[cfg(unix)]
fn harden_sqlite_permissions(path: &Path) -> Result<(), EventJournalError> {
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = OsString::from(path.as_os_str());
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        match fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_sqlite_permissions(_path: &Path) -> Result<(), EventJournalError> {
    Ok(())
}

struct StoredEvent {
    sequence: i64,
    event_id: String,
    schema_version: String,
    device_id: String,
    session_id: String,
    kind: String,
    source: String,
    occurred_at_ms: i64,
    observed_at_ms: i64,
    goal_version: Option<i64>,
    sensitivity: String,
    payload_json: String,
}

impl StoredEvent {
    fn into_event(self) -> Result<DesktopEvent, EventJournalError> {
        Ok(DesktopEvent {
            schema_version: self.schema_version,
            event_id: self.event_id,
            cursor: encode_cursor(self.sequence),
            device_id: self.device_id,
            session_id: self.session_id,
            kind: self.kind,
            source: self.source,
            occurred_at_ms: self.occurred_at_ms,
            observed_at_ms: self.observed_at_ms,
            goal_version: self.goal_version,
            sensitivity: parse_sensitivity(&self.sensitivity)?,
            payload: serde_json::from_str(&self.payload_json)?,
        })
    }
}

fn stored_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredEvent> {
    Ok(StoredEvent {
        sequence: row.get(0)?,
        event_id: row.get(1)?,
        schema_version: row.get(2)?,
        device_id: row.get(3)?,
        session_id: row.get(4)?,
        kind: row.get(5)?,
        source: row.get(6)?,
        occurred_at_ms: row.get(7)?,
        observed_at_ms: row.get(8)?,
        goal_version: row.get(9)?,
        sensitivity: row.get(10)?,
        payload_json: row.get(11)?,
    })
}

fn select_event_by_id(
    connection: &Connection,
    event_id: &str,
) -> Result<Option<StoredEvent>, EventJournalError> {
    connection
        .query_row(
            "SELECT sequence, event_id, schema_version, device_id, session_id,
                    kind, source, occurred_at_ms, observed_at_ms, goal_version,
                    sensitivity, payload_json
             FROM desktop_events
             WHERE event_id = ?1",
            [event_id],
            stored_event_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;
    use whalehall_local_protocol::{EventCommitParams, EventQueryParams, desktop_event_kinds};

    use super::*;

    fn test_journal() -> (TempDir, EventJournal) {
        let directory = tempfile::tempdir().expect("create event journal test directory");
        let journal = EventJournal::open_with_config(EventJournalConfig {
            database_path: directory.path().join("events.sqlite3"),
            retention: Duration::from_secs(30),
            broadcast_capacity: 8,
        })
        .expect("open event journal");
        (directory, journal)
    }

    fn draft(key: &str, timestamp_ms: i64) -> DesktopEventDraft {
        DesktopEventDraft::metadata(
            desktop_event_kinds::APPLICATION_FOREGROUND_CHANGED,
            "test.sensor",
            timestamp_ms,
            serde_json::json!({ "key": key }),
            key,
        )
    }

    #[test]
    fn appends_in_cursor_order_and_deduplicates_deterministically() {
        let (_directory, journal) = test_journal();
        let first = journal.append(draft("first", 1_000)).unwrap();
        let duplicate = journal.append(draft("first", 1_000)).unwrap();
        let second = journal.append(draft("second", 1_001)).unwrap();

        assert!(first.inserted);
        assert!(!duplicate.inserted);
        assert_eq!(first.event.event_id, duplicate.event.event_id);
        assert_eq!(first.event.cursor, duplicate.event.cursor);
        assert!(first.event.cursor < second.event.cursor);

        let result = journal.query(&EventQueryParams::default()).unwrap();
        assert_eq!(result.events.len(), 2);
        assert_eq!(result.events[0].event_id, first.event.event_id);
        assert_eq!(result.events[1].event_id, second.event.event_id);
        assert!(!result.has_more);
    }

    #[test]
    fn durable_authorization_state_is_scoped_by_permission() {
        let (_directory, journal) = test_journal();
        assert_eq!(
            journal
                .latest_authorization_state("input.monitoring")
                .unwrap(),
            None
        );
        journal
            .append(DesktopEventDraft::metadata(
                desktop_event_kinds::AUTHORIZATION_REVOKED,
                "test.sensor",
                1_000,
                serde_json::json!({ "permissions": ["input.monitoring"] }),
                "input-revoked",
            ))
            .unwrap();
        journal
            .append(DesktopEventDraft::metadata(
                desktop_event_kinds::AUTHORIZATION_GRANTED,
                "test.sensor",
                1_001,
                serde_json::json!({ "permissions": ["screen.recording"] }),
                "screen-granted",
            ))
            .unwrap();
        assert_eq!(
            journal
                .latest_authorization_state("input.monitoring")
                .unwrap(),
            Some(false)
        );
        assert_eq!(
            journal
                .latest_authorization_state("screen.recording")
                .unwrap(),
            Some(true)
        );
        journal
            .append(DesktopEventDraft::metadata(
                desktop_event_kinds::AUTHORIZATION_GRANTED,
                "test.sensor",
                1_002,
                serde_json::json!({ "permissions": ["input.monitoring"] }),
                "input-granted",
            ))
            .unwrap();
        assert_eq!(
            journal
                .latest_authorization_state("input.monitoring")
                .unwrap(),
            Some(true)
        );
    }

    #[test]
    fn partial_v0_event_schema_is_completed_reentrantly() {
        let directory = tempfile::tempdir().expect("create event migration directory");
        let database_path = directory.path().join("events.sqlite3");
        let connection = Connection::open(&database_path).expect("open partial event database");
        connection
            .execute_batch(
                "CREATE TABLE journal_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                 );
                 PRAGMA user_version = 0;",
            )
            .expect("create interrupted v0 event schema");
        drop(connection);

        let journal = EventJournal::open(&database_path).expect("recover partial event schema");
        journal.append(draft("after-migration", 1_000)).unwrap();
        let connection = connect(&database_path).expect("connect migrated event schema");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM desktop_events", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn failed_v0_event_migration_rolls_back_all_new_ddl() {
        let directory = tempfile::tempdir().expect("create rollback directory");
        let database_path = directory.path().join("events.sqlite3");
        let connection = Connection::open(&database_path).expect("open broken event database");
        connection
            .execute_batch(
                "CREATE TABLE journal_meta (broken TEXT);
                 PRAGMA user_version = 0;",
            )
            .expect("create incompatible partial schema");
        drop(connection);

        assert!(EventJournal::open(&database_path).is_err());
        let connection = Connection::open(&database_path).expect("reopen rolled-back database");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'table' AND name = 'desktop_events'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn hardens_event_database_permissions_for_content_bearing_events() {
        use std::os::unix::fs::PermissionsExt;

        let (_directory, journal) = test_journal();
        journal.append(draft("permission-check", 1_000)).unwrap();
        let mode = fs::metadata(journal.database_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn rejects_reusing_an_idempotency_key_for_different_data() {
        let (_directory, journal) = test_journal();
        journal.append(draft("same-key", 1_000)).unwrap();
        let mut conflicting = draft("same-key", 1_000);
        conflicting.payload = serde_json::json!({ "key": "different-data" });

        assert!(matches!(
            journal.append(conflicting),
            Err(EventJournalError::IdempotencyConflict { .. })
        ));
        assert_eq!(
            journal
                .query(&EventQueryParams::default())
                .unwrap()
                .events
                .len(),
            1
        );
    }

    #[test]
    fn query_after_cursor_paginates_without_repeating_events() {
        let (_directory, journal) = test_journal();
        for index in 0..5 {
            journal
                .append(draft(&format!("event-{index}"), 1_000 + index))
                .unwrap();
        }
        let first = journal
            .query(&EventQueryParams {
                after_cursor: None,
                consumer_id: None,
                limit: 2,
            })
            .unwrap();
        assert_eq!(first.events.len(), 2);
        assert!(first.has_more);
        let second = journal
            .query(&EventQueryParams {
                after_cursor: first.next_cursor,
                consumer_id: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(second.events.len(), 3);
        assert_eq!(second.events[0].payload["key"], "event-2");
        assert!(!second.has_more);
    }

    #[test]
    fn named_consumer_commit_is_monotonic() {
        let (_directory, journal) = test_journal();
        let first = journal.append(draft("first", 1_000)).unwrap().event;
        let second = journal.append(draft("second", 1_001)).unwrap().event;
        let consumer_id = "reflection-runtime";

        let initial = journal
            .commit(&EventCommitParams {
                consumer_id: consumer_id.to_owned(),
                cursor: first.cursor.clone(),
            })
            .unwrap();
        assert!(initial.advanced);
        let repeated = journal
            .commit(&EventCommitParams {
                consumer_id: consumer_id.to_owned(),
                cursor: first.cursor.clone(),
            })
            .unwrap();
        assert!(!repeated.advanced);
        let advanced = journal
            .commit(&EventCommitParams {
                consumer_id: consumer_id.to_owned(),
                cursor: second.cursor.clone(),
            })
            .unwrap();
        assert!(advanced.advanced);
        assert!(matches!(
            journal.commit(&EventCommitParams {
                consumer_id: consumer_id.to_owned(),
                cursor: first.cursor,
            }),
            Err(EventJournalError::CursorRegression { .. })
        ));
        assert_eq!(
            journal.committed_cursor(consumer_id).unwrap(),
            Some(second.cursor)
        );
    }

    #[test]
    fn reopens_wal_database_without_losing_events_or_identity() {
        let directory = tempfile::tempdir().expect("create recovery directory");
        let path = directory.path().join("events.sqlite3");
        let journal = EventJournal::open(&path).unwrap();
        let device_id = journal.device_id().to_owned();
        let event = journal
            .append(draft("before-restart", 1_000))
            .unwrap()
            .event;
        drop(journal);

        let recovered = EventJournal::open(&path).unwrap();
        assert_eq!(recovered.device_id(), device_id);
        let result = recovered.query(&EventQueryParams::default()).unwrap();
        assert_eq!(result.events, vec![event]);
        let connection = connect(&path).unwrap();
        let mode = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap();
        assert_eq!(mode.to_ascii_lowercase(), "wal");
    }

    #[test]
    fn consumer_query_resumes_from_persisted_commit_after_restart() {
        let directory = tempfile::tempdir().expect("create consumer recovery directory");
        let path = directory.path().join("events.sqlite3");
        let journal = EventJournal::open(&path).unwrap();
        let first = journal.append(draft("first", 1_000)).unwrap().event;
        let second = journal.append(draft("second", 1_001)).unwrap().event;
        let third = journal.append(draft("third", 1_002)).unwrap().event;
        journal
            .commit(&EventCommitParams {
                consumer_id: "reflection-runtime".to_owned(),
                cursor: first.cursor,
            })
            .unwrap();
        drop(journal);

        let recovered = EventJournal::open(&path).unwrap();
        let result = recovered
            .query(&EventQueryParams {
                after_cursor: None,
                consumer_id: Some("reflection-runtime".to_owned()),
                limit: 10,
            })
            .unwrap();
        assert_eq!(result.events, vec![second, third]);
    }

    #[test]
    fn query_rejects_ambiguous_cursor_sources() {
        let (_directory, journal) = test_journal();
        assert!(matches!(
            journal.query(&EventQueryParams {
                after_cursor: Some(EVENT_START_CURSOR.to_owned()),
                consumer_id: Some("reflection-runtime".to_owned()),
                limit: 10,
            }),
            Err(EventJournalError::Configuration(_))
        ));
    }

    #[test]
    fn retention_never_deletes_past_the_slowest_named_consumer() {
        let directory = tempfile::tempdir().expect("create retention directory");
        let journal = EventJournal::open_with_config(EventJournalConfig {
            database_path: directory.path().join("events.sqlite3"),
            retention: Duration::from_millis(100),
            broadcast_capacity: 8,
        })
        .unwrap();
        let first = journal.append(draft("first", 1_000)).unwrap().event;
        let second = journal.append(draft("second", 1_001)).unwrap().event;
        let third = journal.append(draft("third", 1_002)).unwrap().event;
        journal
            .commit(&EventCommitParams {
                consumer_id: "slow-consumer".to_owned(),
                cursor: first.cursor.clone(),
            })
            .unwrap();

        let cleanup = journal.cleanup(2_000).unwrap();
        assert_eq!(cleanup.deleted_events, 1);
        let remaining = journal.query(&EventQueryParams::default()).unwrap();
        assert_eq!(remaining.events, vec![second, third]);
        assert!(matches!(
            journal.query(&EventQueryParams {
                after_cursor: Some(EVENT_START_CURSOR.to_owned()),
                consumer_id: None,
                limit: 10,
            }),
            Err(EventJournalError::CursorExpired(_))
        ));
        let after_committed = journal
            .query(&EventQueryParams {
                after_cursor: Some(first.cursor),
                consumer_id: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(after_committed.events.len(), 2);
    }

    #[tokio::test]
    async fn publishes_only_newly_inserted_events_in_process() {
        let (_directory, journal) = test_journal();
        let mut receiver = journal.subscribe();
        let first = journal.append(draft("published", 1_000)).unwrap();
        journal.append(draft("published", 1_000)).unwrap();

        assert_eq!(receiver.recv().await.unwrap(), first.event);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), receiver.recv())
                .await
                .is_err()
        );
    }
}
