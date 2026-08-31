use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, TransactionBehavior, params, params_from_iter};

use super::model::format_timestamp;
use super::{
    ActivityCacheScope, ActivityCleanupResult, ActivityError, ActivityQuery, ForegroundApp,
    UsageSession,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;

const SCHEMA_VERSION: i64 = 2;

#[derive(Clone, Debug)]
pub(crate) struct ActivityEventOutboxRecord {
    pub id: i64,
    pub occurred_at_ms: i64,
    pub app_id: String,
    pub app_name: String,
    pub deduplication_key: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ActivityStore {
    path: PathBuf,
}

impl ActivityStore {
    pub(crate) fn open(path: impl Into<PathBuf>) -> Result<Self, ActivityError> {
        let path = path.into();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let store = Self { path };
        store.initialize()?;
        Ok(store)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn open_foreground_baseline(&self) -> Result<Option<ForegroundApp>, ActivityError> {
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT app_id, app_name, executable_path, process_id, window_title
             FROM usage_sessions
             WHERE ended_at_ms IS NULL
             ORDER BY id DESC
             LIMIT 1",
        )?;
        let mut rows = statement.query([])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(ForegroundApp {
            app_id: row.get(0)?,
            app_name: row.get(1)?,
            executable_path: row.get(2)?,
            process_id: u64::try_from(row.get::<_, i64>(3)?).unwrap_or_default(),
            window_title: row.get(4)?,
        }))
    }

    pub(crate) fn recover_open_sessions(&self) -> Result<usize, ActivityError> {
        let connection = self.connect()?;
        let changed = connection.execute(
            "UPDATE usage_sessions
             SET ended_at_ms = last_seen_at_ms,
                 duration_ms = MAX(0, last_seen_at_ms - started_at_ms),
                 end_reason = 'recovered_after_unclean_shutdown'
             WHERE ended_at_ms IS NULL",
            [],
        )?;
        Ok(changed)
    }

    pub(crate) fn transition(
        &self,
        current_id: Option<i64>,
        next: Option<&ForegroundApp>,
        observed_at_ms: i64,
        end_reason: &str,
        enqueue_foreground_event: bool,
    ) -> Result<Option<i64>, ActivityError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(current_id) = current_id {
            transaction.execute(
                "UPDATE usage_sessions
                 SET last_seen_at_ms = MAX(last_seen_at_ms, ?1),
                     ended_at_ms = MAX(started_at_ms, ?1),
                     duration_ms = MAX(0, ?1 - started_at_ms),
                     end_reason = ?2
                 WHERE id = ?3 AND ended_at_ms IS NULL",
                params![observed_at_ms, end_reason, current_id],
            )?;
        }

        let next_id = if let Some(app) = next {
            transaction.execute(
                "INSERT INTO usage_sessions (
                    app_id, app_name, executable_path, process_id, window_title,
                    started_at_ms, last_seen_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    app.app_id,
                    app.app_name,
                    app.executable_path,
                    i64::try_from(app.process_id).unwrap_or(i64::MAX),
                    app.window_title,
                    observed_at_ms,
                ],
            )?;
            let next_id = transaction.last_insert_rowid();
            if enqueue_foreground_event {
                transaction.execute(
                    "INSERT OR IGNORE INTO activity_event_outbox (
                        occurred_at_ms, app_id, app_name, deduplication_key
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        observed_at_ms,
                        app.app_id,
                        app.app_name,
                        format!("foreground:{observed_at_ms}:{next_id}"),
                    ],
                )?;
            }
            Some(next_id)
        } else {
            None
        };
        transaction.commit()?;
        Ok(next_id)
    }

    pub(crate) fn pending_foreground_events(
        &self,
        limit: usize,
    ) -> Result<Vec<ActivityEventOutboxRecord>, ActivityError> {
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT id, occurred_at_ms, app_id, app_name, deduplication_key
             FROM activity_event_outbox ORDER BY id LIMIT ?1",
        )?;
        let rows = statement.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
            Ok(ActivityEventOutboxRecord {
                id: row.get(0)?,
                occurred_at_ms: row.get(1)?,
                app_id: row.get(2)?,
                app_name: row.get(3)?,
                deduplication_key: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub(crate) fn delete_foreground_event(&self, id: i64) -> Result<(), ActivityError> {
        let connection = self.connect()?;
        connection.execute("DELETE FROM activity_event_outbox WHERE id = ?1", [id])?;
        Ok(())
    }

    pub(crate) fn touch(&self, session_id: i64, observed_at_ms: i64) -> Result<(), ActivityError> {
        let connection = self.connect()?;
        connection.execute(
            "UPDATE usage_sessions
             SET last_seen_at_ms = MAX(last_seen_at_ms, ?1)
             WHERE id = ?2 AND ended_at_ms IS NULL",
            params![observed_at_ms, session_id],
        )?;
        Ok(())
    }

    pub(crate) fn query(&self, query: &ActivityQuery) -> Result<Vec<UsageSession>, ActivityError> {
        query.validate()?;
        let connection = self.connect()?;
        let mut clauses = Vec::new();
        let mut values = Vec::<SqlValue>::new();
        if !query.include_open {
            clauses.push("ended_at_ms IS NOT NULL");
        }
        if let Some(from_ms) = query.from_ms {
            clauses.push("COALESCE(ended_at_ms, last_seen_at_ms) >= ?");
            values.push(SqlValue::Integer(from_ms));
        }
        if let Some(to_ms) = query.to_ms {
            clauses.push("started_at_ms <= ?");
            values.push(SqlValue::Integer(to_ms));
        }
        if let Some(app_id) = &query.app_id {
            clauses.push("app_id = ?");
            values.push(SqlValue::Text(app_id.clone()));
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        values.push(SqlValue::Integer(query.limit as i64));
        let sql = format!(
            "SELECT id, app_id, app_name, executable_path, process_id, window_title,
                    started_at_ms, last_seen_at_ms, ended_at_ms, duration_ms, end_reason
             FROM usage_sessions{where_clause}
             ORDER BY started_at_ms DESC, id DESC
             LIMIT ?"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| {
            let started_at_ms = row.get::<_, i64>(6)?;
            let last_seen_at_ms = row.get::<_, i64>(7)?;
            let ended_at_ms = row.get::<_, Option<i64>>(8)?;
            Ok(UsageSession {
                id: row.get(0)?,
                app_id: row.get(1)?,
                app_name: row.get(2)?,
                executable_path: row.get(3)?,
                process_id: u64::try_from(row.get::<_, i64>(4)?).unwrap_or_default(),
                window_title: row.get(5)?,
                started_at_ms,
                started_at: format_timestamp(started_at_ms),
                last_seen_at_ms,
                last_seen_at: format_timestamp(last_seen_at_ms),
                ended_at_ms,
                ended_at: ended_at_ms.map(format_timestamp),
                duration_ms: row.get(9)?,
                end_reason: row.get(10)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub(crate) fn cleanup(
        &self,
        scope: ActivityCacheScope,
        now_ms: i64,
    ) -> Result<ActivityCleanupResult, ActivityError> {
        let connection = self.connect()?;
        let retention_days = scope.retention_days();
        let cutoff_at_ms = retention_days.map(|days| now_ms.saturating_sub(days * DAY_MS));
        let deleted_sessions = match cutoff_at_ms {
            Some(cutoff) => connection.execute(
                "DELETE FROM usage_sessions
                 WHERE ended_at_ms IS NOT NULL AND ended_at_ms < ?1",
                [cutoff],
            )?,
            None => connection.execute("DELETE FROM usage_sessions", [])?,
        };
        Ok(ActivityCleanupResult {
            scope,
            deleted_sessions,
            retention_days,
            cutoff_at_ms,
            cutoff_at: cutoff_at_ms.map(format_timestamp),
        })
    }

    fn initialize(&self) -> Result<(), ActivityError> {
        let connection = self.connect()?;
        let version =
            connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
        if version > SCHEMA_VERSION {
            return Err(ActivityError::Configuration(format!(
                "activity database schema {version} is newer than supported schema {SCHEMA_VERSION}"
            )));
        }
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    app_id TEXT NOT NULL,
                    app_name TEXT NOT NULL,
                    executable_path TEXT NOT NULL,
                    process_id INTEGER NOT NULL CHECK (process_id >= 0),
                    window_title TEXT NOT NULL DEFAULT '',
                    started_at_ms INTEGER NOT NULL,
                    last_seen_at_ms INTEGER NOT NULL,
                    ended_at_ms INTEGER,
                    duration_ms INTEGER,
                    end_reason TEXT,
                    CHECK (last_seen_at_ms >= started_at_ms),
                    CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
                    CHECK (duration_ms IS NULL OR duration_ms >= 0)
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS usage_sessions_one_open
                    ON usage_sessions((1)) WHERE ended_at_ms IS NULL;
                 CREATE INDEX IF NOT EXISTS usage_sessions_started_at
                    ON usage_sessions(started_at_ms DESC);
                 CREATE INDEX IF NOT EXISTS usage_sessions_app_started_at
                    ON usage_sessions(app_id, started_at_ms DESC);
             CREATE TABLE IF NOT EXISTS activity_event_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at_ms INTEGER NOT NULL,
                app_id TEXT NOT NULL,
                app_name TEXT NOT NULL,
                deduplication_key TEXT NOT NULL UNIQUE
             );
             CREATE INDEX IF NOT EXISTS activity_event_outbox_order
                ON activity_event_outbox(id);
             PRAGMA user_version = 2;",
        )?;
        Ok(())
    }

    fn connect(&self) -> Result<Connection, ActivityError> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(connection)
    }
}
