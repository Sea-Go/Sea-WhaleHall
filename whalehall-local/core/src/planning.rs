//! Durable local projections for plans and calendars.
//!
//! Plan goals, conversation messages, task titles, and calendar titles are
//! content-sensitive. The v1 store deliberately emits no live content frames
//! and accepts only kind-specific content-free outbox payloads. At rest, v1 relies
//! on an owner-only directory and owner-only SQLite files; unlike the
//! observation vault, snapshot JSON is not yet encrypted. Callers must not
//! treat this filesystem boundary as equivalent to vault-backed encryption.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, NaiveDate};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use whalehall_local_protocol::{
    CALENDAR_SCHEMA_VERSION, CalendarEventKind, CalendarEventState, CalendarGetParams,
    CalendarGetResult, CalendarListParams, CalendarListResult, CalendarMutateParams,
    CalendarMutation, CalendarMutationActor, CalendarMutationOutcome, CalendarMutationResult,
    CalendarSchedule, MAX_PLANNING_LIST_LIMIT, MAX_PLANNING_OUTBOX_LIMIT,
    MAX_PLANNING_VAULT_REFERENCE_LIMIT, PLANNING_SCHEMA_VERSION, PlanConversationMessage,
    PlanEstimate, PlanObservationEvidence, PlanRevision, PlanSchedulingWindow, PlanSnapshot,
    PlanStatus, PlanTask, PlanTaskStatus, PlanningCalendarEvent, PlanningGetParams,
    PlanningGetResult, PlanningListParams, PlanningListResult, PlanningMutateParams,
    PlanningMutationResult, PlanningOperationGetParams, PlanningOperationGetResult,
    PlanningOutboxAckParams, PlanningOutboxAckResult, PlanningOutboxDraft, PlanningOutboxEntry,
    PlanningOutboxKind, PlanningOutboxListParams, PlanningOutboxListResult, PlanningOutboxStatus,
    PlanningUpsertParams, PlanningVaultReference, PlanningVaultReferenceSource,
    PlanningVaultReferencesParams, PlanningVaultReferencesResult, REDACTED_PLAN_CALENDAR_TITLE,
};

const SCHEMA_VERSION: i64 = 1;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_GOAL_CHARS: usize = 100_000;
const MAX_CONTENT_CHARS: usize = 100_000;
const MAX_SNAPSHOT_BYTES: usize = 900 * 1024;
const MAX_OUTBOX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_COLLECTION_ITEMS: usize = 10_000;
const PLANNING_VAULT_REFERENCE_CURSOR_PREFIX: &str = "pvr1";

#[derive(Clone)]
pub struct PlanningStore {
    inner: Arc<PlanningStoreInner>,
}

struct PlanningStoreInner {
    database_path: PathBuf,
    write_guard: Mutex<()>,
}

#[derive(Debug, Error)]
pub enum PlanningStoreError {
    #[error("Planning store configuration error: {0}")]
    Configuration(String),
    #[error("Planning store database I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Planning store database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Planning store JSON operation failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{aggregate_type} {aggregate_id} does not exist")]
    NotFound {
        aggregate_type: &'static str,
        aggregate_id: String,
    },
    #[error(
        "Stale {aggregate_type} version for {aggregate_id}: expected {expected:?}, actual {actual:?}"
    )]
    StaleVersion {
        aggregate_type: &'static str,
        aggregate_id: String,
        expected: Option<i64>,
        actual: Option<i64>,
    },
    #[error("operationId {operation_id} was reused with different request data")]
    IdempotencyConflict { operation_id: String },
    #[error("Immutable planning history changed: {0}")]
    ImmutableHistory(String),
}

impl PlanningStore {
    pub fn open(database_path: impl Into<PathBuf>) -> Result<Self, PlanningStoreError> {
        let database_path = database_path.into();
        if let Some(parent) = database_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
            harden_directory_permissions(parent)?;
        }
        let mut connection = connect(&database_path)?;
        initialize(&mut connection)?;
        harden_sqlite_permissions(&database_path)?;
        Ok(Self {
            inner: Arc::new(PlanningStoreInner {
                database_path,
                write_guard: Mutex::new(()),
            }),
        })
    }

    pub fn database_path(&self) -> &Path {
        &self.inner.database_path
    }

    pub fn list_plans(
        &self,
        params: &PlanningListParams,
    ) -> Result<PlanningListResult, PlanningStoreError> {
        if !(1..=MAX_PLANNING_LIST_LIMIT).contains(&params.limit) {
            return Err(PlanningStoreError::Configuration(format!(
                "planning.list limit must be between 1 and {MAX_PLANNING_LIST_LIMIT}"
            )));
        }
        let connection = connect(&self.inner.database_path)?;
        let mut statement = connection
            .prepare("SELECT snapshot_json FROM plans ORDER BY updated_at_ms DESC, plan_id ASC")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut plans = Vec::new();
        for row in rows {
            let plan: PlanSnapshot = serde_json::from_str(&row?)?;
            if !params.statuses.is_empty() && !params.statuses.contains(&plan.status) {
                continue;
            }
            plans.push(plan);
            if plans.len() == params.limit {
                break;
            }
        }
        Ok(PlanningListResult { plans })
    }

    pub fn get_plan(
        &self,
        params: &PlanningGetParams,
    ) -> Result<PlanningGetResult, PlanningStoreError> {
        validate_identifier("planId", &params.plan_id)?;
        let connection = connect(&self.inner.database_path)?;
        Ok(PlanningGetResult {
            plan: select_plan(&connection, &params.plan_id)?,
        })
    }

    /// Enumerates every sealed planning aggregate reference retained by the
    /// current projection, immutable history, or idempotent operation ledger.
    /// One page is read from one SQLite snapshot and returns no plan content.
    /// Callers must finish all pages before treating the result as a GC proof.
    pub fn list_vault_references(
        &self,
        params: &PlanningVaultReferencesParams,
    ) -> Result<PlanningVaultReferencesResult, PlanningStoreError> {
        let after = validate_planning_vault_reference_params(params)?;
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let fetch_limit = i64::try_from(params.limit.saturating_add(1)).map_err(|_| {
            PlanningStoreError::Configuration(
                "planning.vaultReferences limit is too large".to_owned(),
            )
        })?;
        let (after_rank, after_key, after_version) =
            after.as_ref().map_or((-1_i64, "", 0_i64), |cursor| {
                (
                    cursor.source_rank,
                    cursor.source_key.as_str(),
                    cursor.source_version,
                )
            });
        let mut statement = transaction.prepare(
            "SELECT source_rank, source_key, source_version, snapshot_json
             FROM (
                SELECT 0 AS source_rank, plan_id AS source_key,
                       0 AS source_version, snapshot_json
                  FROM plans
                UNION ALL
                SELECT 1 AS source_rank, plan_id AS source_key,
                       version AS source_version, snapshot_json
                  FROM plan_history
                UNION ALL
                SELECT 2 AS source_rank, operation_id AS source_key,
                       0 AS source_version, result_json AS snapshot_json
                  FROM idempotent_operations
                 WHERE method IN ('planning.upsert', 'planning.mutate')
             )
             WHERE source_rank > ?1
                OR (
                    source_rank = ?1
                    AND (
                        source_key > ?2
                        OR (source_key = ?2 AND source_version > ?3)
                    )
                )
             ORDER BY source_rank ASC, source_key ASC, source_version ASC
             LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![after_rank, after_key, after_version, fetch_limit],
            |row| {
                Ok(PlanningVaultReferenceRow {
                    source_rank: row.get(0)?,
                    source_key: row.get(1)?,
                    source_version: row.get(2)?,
                    snapshot_json: row.get(3)?,
                })
            },
        )?;
        let mut rows = rows.collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let has_more = rows.len() > params.limit;
        if has_more {
            rows.pop();
        }
        let next_cursor = has_more
            .then(|| rows.last())
            .flatten()
            .map(format_planning_vault_reference_cursor);
        let mut references = Vec::new();
        for row in rows {
            if let Some(reference) = planning_vault_reference_from_row(&row)? {
                references.push(reference);
            }
        }
        transaction.commit()?;
        Ok(PlanningVaultReferencesResult {
            references,
            next_cursor,
        })
    }

    pub fn get_operation_result(
        &self,
        params: &PlanningOperationGetParams,
    ) -> Result<PlanningOperationGetResult, PlanningStoreError> {
        validate_operation_id(&params.operation_id)?;
        let connection = connect(&self.inner.database_path)?;
        let stored = connection
            .query_row(
                "SELECT method, result_json
                 FROM idempotent_operations WHERE operation_id = ?1",
                [&params.operation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((method, result_json)) = stored else {
            return Ok(PlanningOperationGetResult {
                operation_id: params.operation_id.clone(),
                method: None,
                plan: None,
                result: None,
            });
        };
        let result: Value = serde_json::from_str(&result_json)?;
        let plan = result
            .get("plan")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?;
        Ok(PlanningOperationGetResult {
            operation_id: params.operation_id.clone(),
            method: Some(method),
            plan,
            result: Some(result),
        })
    }

    pub fn upsert_plan(
        &self,
        params: &PlanningUpsertParams,
    ) -> Result<PlanningMutationResult, PlanningStoreError> {
        let request_hash = request_hash(params)?;
        self.write_plan(
            "planning.upsert",
            &params.operation_id,
            request_hash,
            params.expected_version,
            false,
            &params.plan,
            params.calendar_events.as_deref(),
            &params.outbox,
        )
    }

    pub fn mutate_plan(
        &self,
        params: &PlanningMutateParams,
    ) -> Result<PlanningMutationResult, PlanningStoreError> {
        let request_hash = request_hash(params)?;
        self.write_plan(
            "planning.mutate",
            &params.operation_id,
            request_hash,
            Some(params.expected_version),
            true,
            &params.plan,
            params.calendar_events.as_deref(),
            &params.outbox,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn write_plan(
        &self,
        method: &'static str,
        operation_id: &str,
        request_hash: String,
        expected_version: Option<i64>,
        require_existing: bool,
        plan: &PlanSnapshot,
        calendar_events: Option<&[PlanningCalendarEvent]>,
        outbox: &[PlanningOutboxDraft],
    ) -> Result<PlanningMutationResult, PlanningStoreError> {
        validate_operation_id(operation_id)?;
        let _write_guard = self
            .inner
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(replayed) = replay_operation::<PlanningMutationResult>(
            &transaction,
            operation_id,
            method,
            &request_hash,
        )? {
            transaction.commit()?;
            return Ok(replayed);
        }

        validate_plan(plan)?;
        validate_outbox_drafts(outbox)?;
        if let Some(events) = calendar_events {
            validate_plan_calendar_projection(plan, events)?;
        }

        let previous = select_plan(&transaction, &plan.plan_id)?;
        if require_existing && previous.is_none() {
            return Err(PlanningStoreError::NotFound {
                aggregate_type: "plan",
                aggregate_id: plan.plan_id.clone(),
            });
        }
        match (&previous, expected_version) {
            (None, None) => {
                if plan.version != 1 {
                    return Err(PlanningStoreError::StaleVersion {
                        aggregate_type: "plan",
                        aggregate_id: plan.plan_id.clone(),
                        expected: None,
                        actual: None,
                    });
                }
            }
            (None, Some(expected)) => {
                return Err(PlanningStoreError::StaleVersion {
                    aggregate_type: "plan",
                    aggregate_id: plan.plan_id.clone(),
                    expected: Some(expected),
                    actual: None,
                });
            }
            (Some(previous), Some(expected)) if previous.version == expected => {
                if plan.version != expected.saturating_add(1) {
                    return Err(PlanningStoreError::Configuration(format!(
                        "plan.version must advance exactly once from {expected} to {}",
                        plan.version
                    )));
                }
                validate_plan_update(previous, plan)?;
            }
            (Some(previous), supplied) => {
                return Err(PlanningStoreError::StaleVersion {
                    aggregate_type: "plan",
                    aggregate_id: plan.plan_id.clone(),
                    expected: supplied,
                    actual: Some(previous.version),
                });
            }
        }

        persist_plan(&transaction, plan, operation_id)?;
        if let Some(events) = calendar_events {
            replace_plan_calendar_projection(&transaction, plan, events)?;
        }
        let outbox = insert_outbox(&transaction, operation_id, outbox)?;
        let calendar_events = select_calendar_for_plan(&transaction, &plan.plan_id)?;
        let result = PlanningMutationResult {
            plan: plan.clone(),
            calendar_events,
            outbox,
        };
        record_operation(
            &transaction,
            operation_id,
            method,
            &request_hash,
            &result,
            plan.updated_at_ms,
        )?;
        transaction.commit()?;
        harden_sqlite_permissions(&self.inner.database_path)?;
        Ok(result)
    }

    pub fn list_calendar(
        &self,
        params: &CalendarListParams,
    ) -> Result<CalendarListResult, PlanningStoreError> {
        if let Some(plan_id) = params.source_plan_id.as_deref() {
            validate_identifier("sourcePlanId", plan_id)?;
        }
        if let Some(task_id) = params.source_task_id.as_deref() {
            validate_identifier("sourceTaskId", task_id)?;
        }
        let range = match (&params.from_date, &params.to_date_exclusive) {
            (None, None) => None,
            (Some(from), Some(to)) => {
                let from = parse_date("calendar.list.fromDate", from)?;
                let to = parse_date("calendar.list.toDateExclusive", to)?;
                if to <= from {
                    return Err(PlanningStoreError::Configuration(
                        "calendar.list toDateExclusive must be after fromDate".to_owned(),
                    ));
                }
                Some((from, to))
            }
            _ => {
                return Err(PlanningStoreError::Configuration(
                    "calendar.list fromDate and toDateExclusive must be provided together"
                        .to_owned(),
                ));
            }
        };
        let connection = connect(&self.inner.database_path)?;
        let mut statement =
            connection.prepare("SELECT event_json FROM calendar_events ORDER BY event_id ASC")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut events = Vec::new();
        for row in rows {
            let event: PlanningCalendarEvent = serde_json::from_str(&row?)?;
            if params
                .source_plan_id
                .as_ref()
                .is_some_and(|plan_id| event.source_plan_id.as_ref() != Some(plan_id))
            {
                continue;
            }
            if params
                .source_task_id
                .as_ref()
                .is_some_and(|task_id| event.source_task_id.as_ref() != Some(task_id))
            {
                continue;
            }
            if range.is_some_and(|range| !calendar_event_overlaps_dates(&event, range)) {
                continue;
            }
            events.push(event);
        }
        Ok(CalendarListResult { events })
    }

    pub fn get_calendar_event(
        &self,
        params: &CalendarGetParams,
    ) -> Result<CalendarGetResult, PlanningStoreError> {
        validate_identifier("eventId", &params.event_id)?;
        let connection = connect(&self.inner.database_path)?;
        Ok(CalendarGetResult {
            event: select_calendar_event(&connection, &params.event_id)?,
        })
    }

    pub fn mutate_calendar(
        &self,
        params: &CalendarMutateParams,
    ) -> Result<CalendarMutationResult, PlanningStoreError> {
        validate_operation_id(&params.operation_id)?;
        let request_hash = request_hash(params)?;
        let _write_guard = self
            .inner
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(replayed) = replay_operation::<CalendarMutationResult>(
            &transaction,
            &params.operation_id,
            "calendar.mutate",
            &request_hash,
        )? {
            transaction.commit()?;
            return Ok(replayed);
        }

        if params.mutations.is_empty() || params.mutations.len() > MAX_COLLECTION_ITEMS {
            return Err(PlanningStoreError::Configuration(format!(
                "calendar.mutate requires between 1 and {MAX_COLLECTION_ITEMS} mutations"
            )));
        }
        validate_outbox_drafts(&params.outbox)?;
        let mut event_ids = HashSet::new();
        for mutation in &params.mutations {
            let event_id = match mutation {
                CalendarMutation::Upsert { event, .. } => {
                    validate_calendar_event(event)?;
                    &event.event_id
                }
                CalendarMutation::Delete { event_id, .. } => {
                    validate_identifier("eventId", event_id)?;
                    event_id
                }
            };
            if !event_ids.insert(event_id.clone()) {
                return Err(PlanningStoreError::Configuration(format!(
                    "calendar.mutate contains duplicate eventId {event_id}"
                )));
            }
        }
        let mut outcomes = Vec::with_capacity(params.mutations.len());
        for mutation in &params.mutations {
            match mutation {
                CalendarMutation::Upsert {
                    expected_version,
                    event,
                } => {
                    validate_calendar_ownership(&transaction, event)?;
                    let previous = select_calendar_event(&transaction, &event.event_id)?;
                    if previous.as_ref().is_some_and(|event| !event.editable) {
                        return Err(PlanningStoreError::Configuration(format!(
                            "calendar event {} is read-only",
                            event.event_id
                        )));
                    }
                    if let Some(previous) = previous.as_ref() {
                        validate_calendar_update_ownership(previous, event)?;
                    }
                    match params.actor {
                        CalendarMutationActor::User => {
                            validate_user_calendar_upsert(previous.as_ref(), event)?;
                        }
                        CalendarMutationActor::PlanningRuntime => {
                            validate_planning_runtime_calendar_upsert(
                                &transaction,
                                previous.as_ref(),
                                event,
                            )?;
                        }
                    }
                    match (&previous, expected_version) {
                        (None, None) if event.version == 1 => {}
                        (None, None) => {
                            return Err(PlanningStoreError::Configuration(
                                "new calendar event version must be 1".to_owned(),
                            ));
                        }
                        (None, Some(expected)) => {
                            return Err(PlanningStoreError::StaleVersion {
                                aggregate_type: "calendar-event",
                                aggregate_id: event.event_id.clone(),
                                expected: Some(*expected),
                                actual: None,
                            });
                        }
                        (Some(previous), Some(expected)) if previous.version == *expected => {
                            if event.version != expected.saturating_add(1) {
                                return Err(PlanningStoreError::Configuration(format!(
                                    "calendar event version must advance exactly once from {expected} to {}",
                                    event.version
                                )));
                            }
                        }
                        (Some(previous), supplied) => {
                            return Err(PlanningStoreError::StaleVersion {
                                aggregate_type: "calendar-event",
                                aggregate_id: event.event_id.clone(),
                                expected: *supplied,
                                actual: Some(previous.version),
                            });
                        }
                    }
                    persist_calendar_event(&transaction, event)?;
                    outcomes.push(CalendarMutationOutcome {
                        event_id: event.event_id.clone(),
                        event: Some(event.as_ref().clone()),
                    });
                }
                CalendarMutation::Delete {
                    event_id,
                    expected_version,
                } => {
                    let previous =
                        select_calendar_event(&transaction, event_id)?.ok_or_else(|| {
                            PlanningStoreError::NotFound {
                                aggregate_type: "calendar-event",
                                aggregate_id: event_id.clone(),
                            }
                        })?;
                    if !previous.editable {
                        return Err(PlanningStoreError::Configuration(format!(
                            "calendar event {event_id} is read-only"
                        )));
                    }
                    if previous.version != *expected_version {
                        return Err(PlanningStoreError::StaleVersion {
                            aggregate_type: "calendar-event",
                            aggregate_id: event_id.clone(),
                            expected: Some(*expected_version),
                            actual: Some(previous.version),
                        });
                    }
                    if params.actor == CalendarMutationActor::PlanningRuntime {
                        validate_planning_runtime_calendar_delete(&transaction, &previous)?;
                    }
                    transaction.execute(
                        "DELETE FROM calendar_events WHERE event_id = ?1",
                        [event_id],
                    )?;
                    outcomes.push(CalendarMutationOutcome {
                        event_id: event_id.clone(),
                        event: None,
                    });
                }
            }
        }
        let outbox = insert_outbox(&transaction, &params.operation_id, &params.outbox)?;
        let result = CalendarMutationResult { outcomes, outbox };
        record_operation(
            &transaction,
            &params.operation_id,
            "calendar.mutate",
            &request_hash,
            &result,
            maximum_outbox_timestamp(&params.outbox),
        )?;
        transaction.commit()?;
        harden_sqlite_permissions(&self.inner.database_path)?;
        Ok(result)
    }

    pub fn list_outbox(
        &self,
        params: &PlanningOutboxListParams,
    ) -> Result<PlanningOutboxListResult, PlanningStoreError> {
        if !(1..=MAX_PLANNING_OUTBOX_LIMIT).contains(&params.limit) {
            return Err(PlanningStoreError::Configuration(format!(
                "planning.outbox.list limit must be between 1 and {MAX_PLANNING_OUTBOX_LIMIT}"
            )));
        }
        let connection = connect(&self.inner.database_path)?;
        let mut statement = connection.prepare(
            "SELECT entry_id, kind, aggregate_id, payload_json, status,
                    created_at_ms, delivered_at_ms
             FROM planning_outbox
             ORDER BY created_at_ms ASC, entry_id ASC",
        )?;
        let rows = statement.query_map([], stored_outbox_from_row)?;
        let mut entries = Vec::new();
        for row in rows {
            let entry = row?.into_entry()?;
            if params.status.is_some_and(|status| status != entry.status) {
                continue;
            }
            entries.push(entry);
            if entries.len() == params.limit {
                break;
            }
        }
        Ok(PlanningOutboxListResult { entries })
    }

    pub fn acknowledge_outbox(
        &self,
        params: &PlanningOutboxAckParams,
    ) -> Result<PlanningOutboxAckResult, PlanningStoreError> {
        validate_operation_id(&params.operation_id)?;
        let request_hash = request_hash(params)?;
        let _write_guard = self
            .inner
            .write_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut connection = connect(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(replayed) = replay_operation::<PlanningOutboxAckResult>(
            &transaction,
            &params.operation_id,
            "planning.outbox.ack",
            &request_hash,
        )? {
            transaction.commit()?;
            return Ok(replayed);
        }

        validate_timestamp("deliveredAtMs", params.delivered_at_ms)?;
        if params.entry_ids.is_empty() || params.entry_ids.len() > MAX_COLLECTION_ITEMS {
            return Err(PlanningStoreError::Configuration(format!(
                "planning.outbox.ack requires between 1 and {MAX_COLLECTION_ITEMS} entryIds"
            )));
        }
        let mut unique = HashSet::new();
        for entry_id in &params.entry_ids {
            validate_identifier("entryId", entry_id)?;
            if !unique.insert(entry_id) {
                return Err(PlanningStoreError::Configuration(format!(
                    "planning.outbox.ack contains duplicate entryId {entry_id}"
                )));
            }
        }
        let mut entries = Vec::with_capacity(params.entry_ids.len());
        for entry_id in &params.entry_ids {
            let stored = select_outbox(&transaction, entry_id)?.ok_or_else(|| {
                PlanningStoreError::NotFound {
                    aggregate_type: "outbox-entry",
                    aggregate_id: entry_id.clone(),
                }
            })?;
            if stored.status == "pending" {
                transaction.execute(
                    "UPDATE planning_outbox
                     SET status = 'delivered', delivered_at_ms = ?1
                     WHERE entry_id = ?2",
                    params![params.delivered_at_ms, entry_id],
                )?;
            }
            entries.push(
                select_outbox(&transaction, entry_id)?
                    .expect("outbox row remains after acknowledgement")
                    .into_entry()?,
            );
        }
        let result = PlanningOutboxAckResult { entries };
        record_operation(
            &transaction,
            &params.operation_id,
            "planning.outbox.ack",
            &request_hash,
            &result,
            params.delivered_at_ms,
        )?;
        transaction.commit()?;
        harden_sqlite_permissions(&self.inner.database_path)?;
        Ok(result)
    }
}

fn validate_plan(plan: &PlanSnapshot) -> Result<(), PlanningStoreError> {
    if plan.schema_version != PLANNING_SCHEMA_VERSION {
        return Err(PlanningStoreError::Configuration(format!(
            "plan schemaVersion must be {PLANNING_SCHEMA_VERSION}"
        )));
    }
    validate_identifier("planId", &plan.plan_id)?;
    validate_positive_version("plan.version", plan.version)?;
    if let Some(goal) = plan.goal.as_deref() {
        validate_content("plan.goal", goal, MAX_GOAL_CHARS)?;
    }
    if let Some(reference) = plan.sealed_content_ref.as_deref() {
        validate_identifier("sealedContentRef", reference)?;
    }
    if plan.goal.is_none() && plan.sealed_content_ref.is_none() && !plan.redacted_content {
        return Err(PlanningStoreError::Configuration(
            "plan requires goal, sealedContentRef, or redactedContent".to_owned(),
        ));
    }
    if plan.goal.is_some() && (plan.sealed_content_ref.is_some() || plan.redacted_content) {
        return Err(PlanningStoreError::Configuration(
            "plaintext goal cannot be combined with sealedContentRef or redactedContent".to_owned(),
        ));
    }
    if let Some(diagnostic) = plan.analysis_diagnostic.as_deref() {
        validate_identifier("analysisDiagnostic", diagnostic)?;
    }
    validate_time_zone(&plan.time_zone)?;
    match (&plan.effective_start_date, &plan.scheduling_window) {
        (None, None) => {}
        (None, Some(window)) => {
            validate_window(window)?;
        }
        (Some(effective_start), Some(window)) => {
            let effective_start = parse_date("effectiveStartDate", effective_start)?;
            let window_start = validate_window(window)?;
            if effective_start > window_start {
                return Err(PlanningStoreError::Configuration(
                    "effectiveStartDate cannot be after schedulingWindow.startDate".to_owned(),
                ));
            }
        }
        _ => {
            return Err(PlanningStoreError::Configuration(
                "effectiveStartDate requires schedulingWindow".to_owned(),
            ));
        }
    }
    if let Some(estimate) = &plan.current_estimate {
        validate_estimate(estimate)?;
    }
    validate_timestamp("createdAtMs", plan.created_at_ms)?;
    validate_timestamp("updatedAtMs", plan.updated_at_ms)?;
    if plan.updated_at_ms < plan.created_at_ms {
        return Err(PlanningStoreError::Configuration(
            "updatedAtMs cannot be before createdAtMs".to_owned(),
        ));
    }
    validate_tasks(&plan.tasks)?;
    validate_messages(&plan.conversation)?;
    validate_revisions(&plan.revisions, plan.version)?;
    let revision_ids = plan
        .revisions
        .iter()
        .map(|revision| revision.revision_id.as_str())
        .collect::<HashSet<_>>();
    for (label, revision_id) in [
        ("activeRevisionId", plan.active_revision_id.as_deref()),
        ("proposedRevisionId", plan.proposed_revision_id.as_deref()),
    ] {
        if let Some(revision_id) = revision_id {
            validate_identifier(label, revision_id)?;
            if !revision_ids.contains(revision_id) {
                return Err(PlanningStoreError::Configuration(format!(
                    "{label} must reference a stored revision"
                )));
            }
        }
    }
    validate_estimate_snapshots(&plan.estimate_snapshots, plan.version)?;
    validate_observations(&plan.observation_evidence)?;
    validate_adjustments(&plan.adjustments, plan.version)?;
    validate_collection_bound("tasks", plan.tasks.len())?;
    validate_collection_bound("conversation", plan.conversation.len())?;
    validate_collection_bound("revisions", plan.revisions.len())?;
    validate_collection_bound("estimateSnapshots", plan.estimate_snapshots.len())?;
    validate_collection_bound("observationEvidence", plan.observation_evidence.len())?;
    validate_collection_bound("adjustments", plan.adjustments.len())?;
    if !plan.runtime_payload.is_object() {
        return Err(PlanningStoreError::Configuration(
            "runtimePayload must be a JSON object".to_owned(),
        ));
    }
    if matches!(
        plan.status,
        PlanStatus::Active | PlanStatus::Paused | PlanStatus::Completed
    ) && (plan.plan_type.is_none()
        || plan.effective_start_date.is_none()
        || plan.scheduling_window.is_none()
        || plan.current_estimate.is_none())
    {
        return Err(PlanningStoreError::Configuration(
            "active, paused, and completed plans require planType, effectiveStartDate, schedulingWindow, and currentEstimate"
                .to_owned(),
        ));
    }
    let encoded = serde_json::to_vec(plan)?;
    if encoded.len() > MAX_SNAPSHOT_BYTES {
        return Err(PlanningStoreError::Configuration(format!(
            "plan snapshot exceeds {MAX_SNAPSHOT_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_plan_update(
    previous: &PlanSnapshot,
    next: &PlanSnapshot,
) -> Result<(), PlanningStoreError> {
    if previous.plan_id != next.plan_id {
        return Err(PlanningStoreError::ImmutableHistory(
            "planId cannot change".to_owned(),
        ));
    }
    if previous.created_at_ms != next.created_at_ms {
        return Err(PlanningStoreError::ImmutableHistory(
            "createdAtMs cannot change".to_owned(),
        ));
    }
    if next.updated_at_ms < previous.updated_at_ms {
        return Err(PlanningStoreError::Configuration(
            "updatedAtMs cannot move backwards".to_owned(),
        ));
    }
    ensure_prefix("revisions", &previous.revisions, &next.revisions)?;
    ensure_prefix(
        "estimateSnapshots",
        &previous.estimate_snapshots,
        &next.estimate_snapshots,
    )?;
    ensure_prefix(
        "observationEvidence",
        &previous.observation_evidence,
        &next.observation_evidence,
    )?;
    ensure_prefix("adjustments", &previous.adjustments, &next.adjustments)?;

    let next_task_ids = next
        .tasks
        .iter()
        .map(|task| task.task_id.as_str())
        .collect::<HashSet<_>>();
    if let Some(removed) = previous
        .tasks
        .iter()
        .find(|task| !next_task_ids.contains(task.task_id.as_str()))
    {
        return Err(PlanningStoreError::ImmutableHistory(format!(
            "stable taskId {} cannot be removed",
            removed.task_id
        )));
    }
    let next_messages = next
        .conversation
        .iter()
        .map(|message| (message.message_id.as_str(), message))
        .collect::<HashMap<_, _>>();
    for previous_message in &previous.conversation {
        let Some(next_message) = next_messages.get(previous_message.message_id.as_str()) else {
            return Err(PlanningStoreError::ImmutableHistory(format!(
                "conversation message {} cannot be removed",
                previous_message.message_id
            )));
        };
        if previous_message.role != next_message.role
            || previous_message.content != next_message.content
            || previous_message.created_at_ms != next_message.created_at_ms
        {
            return Err(PlanningStoreError::ImmutableHistory(format!(
                "conversation message {} identity/content cannot change",
                previous_message.message_id
            )));
        }
    }
    Ok(())
}

fn ensure_prefix<T: PartialEq>(
    label: &str,
    previous: &[T],
    next: &[T],
) -> Result<(), PlanningStoreError> {
    if next.len() < previous.len() || next[..previous.len()] != *previous {
        return Err(PlanningStoreError::ImmutableHistory(format!(
            "{label} must be append-only"
        )));
    }
    Ok(())
}

fn validate_window(window: &PlanSchedulingWindow) -> Result<NaiveDate, PlanningStoreError> {
    let start = parse_date("schedulingWindow.startDate", &window.start_date)?;
    let end = parse_date(
        "schedulingWindow.endDateInclusive",
        &window.end_date_inclusive,
    )?;
    if end.signed_duration_since(start).num_days() != 6 {
        return Err(PlanningStoreError::Configuration(
            "schedulingWindow must contain exactly 7 consecutive local dates".to_owned(),
        ));
    }
    Ok(start)
}

fn validate_estimate(estimate: &PlanEstimate) -> Result<(), PlanningStoreError> {
    parse_date(
        "estimate.estimatedCompletionDate",
        &estimate.estimated_completion_date,
    )?;
    if !estimate.confidence.is_finite() || !(0.0..=1.0).contains(&estimate.confidence) {
        return Err(PlanningStoreError::Configuration(
            "estimate.confidence must be finite and between 0 and 1".to_owned(),
        ));
    }
    validate_timestamp("estimate.assessedAtMs", estimate.assessed_at_ms)?;
    if let Some(evidence_through_ms) = estimate.evidence_through_ms {
        validate_timestamp("estimate.evidenceThroughMs", evidence_through_ms)?;
        if evidence_through_ms > estimate.assessed_at_ms {
            return Err(PlanningStoreError::Configuration(
                "estimate.evidenceThroughMs cannot be after assessedAtMs".to_owned(),
            ));
        }
    }
    validate_content("estimate.basis", &estimate.basis, MAX_CONTENT_CHARS)?;
    validate_identifier("estimate.modelVersion", &estimate.model_version)?;
    Ok(())
}

fn validate_tasks(tasks: &[PlanTask]) -> Result<(), PlanningStoreError> {
    let mut ids = HashSet::new();
    for task in tasks {
        validate_identifier("taskId", &task.task_id)?;
        validate_content("task.title", &task.title, MAX_CONTENT_CHARS)?;
        if task.description.chars().count() > MAX_CONTENT_CHARS {
            return Err(PlanningStoreError::Configuration(
                "task.description is too long".to_owned(),
            ));
        }
        if task.estimated_effort_minutes <= 0 || task.estimated_effort_minutes > MAX_SAFE_INTEGER {
            return Err(PlanningStoreError::Configuration(
                "task.estimatedEffortMinutes must be a positive safe integer".to_owned(),
            ));
        }
        if !ids.insert(task.task_id.as_str()) {
            return Err(PlanningStoreError::Configuration(format!(
                "duplicate taskId {}",
                task.task_id
            )));
        }
    }
    let by_id = tasks
        .iter()
        .map(|task| (task.task_id.as_str(), task))
        .collect::<HashMap<_, _>>();
    let mut indegree = tasks
        .iter()
        .map(|task| (task.task_id.as_str(), task.dependency_task_ids.len()))
        .collect::<HashMap<_, _>>();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for task in tasks {
        let mut dependencies = HashSet::new();
        for dependency in &task.dependency_task_ids {
            validate_identifier("dependencyTaskId", dependency)?;
            if dependency == &task.task_id {
                return Err(PlanningStoreError::Configuration(format!(
                    "task {} cannot depend on itself",
                    task.task_id
                )));
            }
            if !dependencies.insert(dependency.as_str()) {
                return Err(PlanningStoreError::Configuration(format!(
                    "task {} contains duplicate dependency {}",
                    task.task_id, dependency
                )));
            }
            if !by_id.contains_key(dependency.as_str()) {
                return Err(PlanningStoreError::Configuration(format!(
                    "task {} depends on missing task {}",
                    task.task_id, dependency
                )));
            }
            dependents
                .entry(dependency.as_str())
                .or_default()
                .push(task.task_id.as_str());
        }
    }
    let mut ready = indegree
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect::<VecDeque<_>>();
    let mut visited = 0;
    while let Some(id) = ready.pop_front() {
        visited += 1;
        for dependent in dependents.get(id).into_iter().flatten() {
            let count = indegree
                .get_mut(dependent)
                .expect("dependent task has indegree");
            *count -= 1;
            if *count == 0 {
                ready.push_back(dependent);
            }
        }
    }
    if visited != tasks.len() {
        return Err(PlanningStoreError::Configuration(
            "task dependencies must not contain a cycle".to_owned(),
        ));
    }
    Ok(())
}

fn validate_messages(messages: &[PlanConversationMessage]) -> Result<(), PlanningStoreError> {
    let mut ids = HashSet::new();
    for message in messages {
        validate_identifier("messageId", &message.message_id)?;
        validate_content("message.content", &message.content, MAX_CONTENT_CHARS)?;
        validate_timestamp("message.createdAtMs", message.created_at_ms)?;
        if !ids.insert(message.message_id.as_str()) {
            return Err(PlanningStoreError::Configuration(format!(
                "duplicate messageId {}",
                message.message_id
            )));
        }
        if let Some(category) = message.failure_category.as_deref() {
            validate_identifier("message.failureCategory", category)?;
        }
    }
    Ok(())
}

fn validate_revisions(
    revisions: &[PlanRevision],
    plan_version: i64,
) -> Result<(), PlanningStoreError> {
    let mut ids = HashSet::new();
    let mut last_version = 0;
    for revision in revisions {
        validate_identifier("revisionId", &revision.revision_id)?;
        validate_positive_version("revision.planVersion", revision.plan_version)?;
        if revision.plan_version < last_version || revision.plan_version > plan_version {
            return Err(PlanningStoreError::Configuration(
                "revision.planVersion must be ordered and cannot exceed plan.version".to_owned(),
            ));
        }
        last_version = revision.plan_version;
        validate_timestamp("revision.createdAtMs", revision.created_at_ms)?;
        validate_content("revision.reason", &revision.reason, MAX_CONTENT_CHARS)?;
        if let Some(estimate) = &revision.estimate {
            validate_estimate(estimate)?;
        }
        if !ids.insert(revision.revision_id.as_str()) {
            return Err(PlanningStoreError::Configuration(format!(
                "duplicate revisionId {}",
                revision.revision_id
            )));
        }
    }
    Ok(())
}

fn validate_estimate_snapshots(
    snapshots: &[whalehall_local_protocol::PlanEstimateSnapshot],
    plan_version: i64,
) -> Result<(), PlanningStoreError> {
    let mut ids = HashSet::new();
    for snapshot in snapshots {
        validate_identifier("estimateId", &snapshot.estimate_id)?;
        validate_positive_version("estimateSnapshot.planVersion", snapshot.plan_version)?;
        if snapshot.plan_version > plan_version {
            return Err(PlanningStoreError::Configuration(
                "estimateSnapshot.planVersion cannot exceed plan.version".to_owned(),
            ));
        }
        validate_estimate(&snapshot.estimate)?;
        if !ids.insert(snapshot.estimate_id.as_str()) {
            return Err(PlanningStoreError::Configuration(format!(
                "duplicate estimateId {}",
                snapshot.estimate_id
            )));
        }
    }
    Ok(())
}

fn validate_observations(
    observations: &[PlanObservationEvidence],
) -> Result<(), PlanningStoreError> {
    let mut ids = HashSet::new();
    for evidence in observations {
        validate_identifier("evidenceId", &evidence.evidence_id)?;
        if let Some(task_id) = evidence.task_id.as_deref() {
            validate_identifier("observation.taskId", task_id)?;
        }
        validate_timestamp("observation.startedAtMs", evidence.started_at_ms)?;
        validate_timestamp("observation.endedAtMs", evidence.ended_at_ms)?;
        validate_timestamp("observation.createdAtMs", evidence.created_at_ms)?;
        if evidence.ended_at_ms <= evidence.started_at_ms {
            return Err(PlanningStoreError::Configuration(
                "observation endedAtMs must be after startedAtMs".to_owned(),
            ));
        }
        if !evidence.relevance_confidence.is_finite()
            || !(0.0..=1.0).contains(&evidence.relevance_confidence)
        {
            return Err(PlanningStoreError::Configuration(
                "observation relevanceConfidence must be finite and between 0 and 1".to_owned(),
            ));
        }
        for event_id in &evidence.source_event_ids {
            validate_identifier("observation.sourceEventId", event_id)?;
        }
        if !ids.insert(evidence.evidence_id.as_str()) {
            return Err(PlanningStoreError::Configuration(format!(
                "duplicate evidenceId {}",
                evidence.evidence_id
            )));
        }
    }
    Ok(())
}

fn validate_adjustments(
    adjustments: &[whalehall_local_protocol::PlanAdjustment],
    plan_version: i64,
) -> Result<(), PlanningStoreError> {
    let mut ids = HashSet::new();
    for adjustment in adjustments {
        validate_identifier("adjustmentId", &adjustment.adjustment_id)?;
        validate_positive_version("adjustment.fromVersion", adjustment.from_version)?;
        validate_positive_version("adjustment.toVersion", adjustment.to_version)?;
        if adjustment.to_version <= adjustment.from_version || adjustment.to_version > plan_version
        {
            return Err(PlanningStoreError::Configuration(
                "adjustment versions must advance and cannot exceed plan.version".to_owned(),
            ));
        }
        validate_content("adjustment.reason", &adjustment.reason, MAX_CONTENT_CHARS)?;
        validate_timestamp("adjustment.createdAtMs", adjustment.created_at_ms)?;
        if let Some(undo_id) = adjustment.undo_of_adjustment_id.as_deref() {
            validate_identifier("undoOfAdjustmentId", undo_id)?;
        }
        if !ids.insert(adjustment.adjustment_id.as_str()) {
            return Err(PlanningStoreError::Configuration(format!(
                "duplicate adjustmentId {}",
                adjustment.adjustment_id
            )));
        }
    }
    Ok(())
}

fn validate_plan_calendar_projection(
    plan: &PlanSnapshot,
    events: &[PlanningCalendarEvent],
) -> Result<(), PlanningStoreError> {
    validate_collection_bound("calendarEvents", events.len())?;
    let task_ids = plan
        .tasks
        .iter()
        .map(|task| task.task_id.as_str())
        .collect::<HashSet<_>>();
    let mut event_ids = HashSet::new();
    for event in events {
        validate_calendar_event(event)?;
        if event.source_plan_id.as_deref() != Some(plan.plan_id.as_str()) {
            return Err(PlanningStoreError::Configuration(format!(
                "calendar event {} in a plan projection must use sourcePlanId {}",
                event.event_id, plan.plan_id
            )));
        }
        if let Some(task_id) = event.source_task_id.as_deref()
            && !task_ids.contains(task_id)
        {
            return Err(PlanningStoreError::Configuration(format!(
                "calendar event {} references missing sourceTaskId {task_id}",
                event.event_id
            )));
        }
        if !event_ids.insert(event.event_id.as_str()) {
            return Err(PlanningStoreError::Configuration(format!(
                "duplicate calendar eventId {}",
                event.event_id
            )));
        }
    }
    Ok(())
}

fn validate_calendar_ownership(
    connection: &Connection,
    event: &PlanningCalendarEvent,
) -> Result<(), PlanningStoreError> {
    let Some(plan_id) = event.source_plan_id.as_deref() else {
        return Ok(());
    };
    let plan = select_plan(connection, plan_id)?.ok_or_else(|| PlanningStoreError::NotFound {
        aggregate_type: "plan",
        aggregate_id: plan_id.to_owned(),
    })?;
    if let Some(task_id) = event.source_task_id.as_deref()
        && !plan.tasks.iter().any(|task| task.task_id == task_id)
    {
        return Err(PlanningStoreError::NotFound {
            aggregate_type: "plan-task",
            aggregate_id: format!("{plan_id}/{task_id}"),
        });
    }
    Ok(())
}

fn validate_user_calendar_upsert(
    previous: Option<&PlanningCalendarEvent>,
    event: &PlanningCalendarEvent,
) -> Result<(), PlanningStoreError> {
    let Some(previous) = previous else {
        if event.kind == CalendarEventKind::Plan
            && (event.schedule_origin
                != Some(whalehall_local_protocol::CalendarScheduleOrigin::User)
                || !event.user_locked)
        {
            return Err(PlanningStoreError::Configuration(
                "a user-created plan calendar event must be user-origin and locked".to_owned(),
            ));
        }
        return Ok(());
    };
    if previous.kind != CalendarEventKind::Plan || previous == event {
        return Ok(());
    }

    // A user may explicitly return a locked model event to PlanningRuntime,
    // but that operation is deliberately restricted to the lock bit and the
    // required version increment. Every other interactive edit must lock it.
    let mut unlocked = previous.clone();
    unlocked.user_locked = false;
    unlocked.version = event.version;
    let only_unlock_changed = previous.schedule_origin
        == Some(whalehall_local_protocol::CalendarScheduleOrigin::Model)
        && previous.user_locked
        && !event.user_locked
        && unlocked == *event;
    if !only_unlock_changed && !event.user_locked {
        return Err(PlanningStoreError::Configuration(format!(
            "editing plan calendar event {} must set userLocked",
            event.event_id
        )));
    }
    Ok(())
}

fn validate_planning_runtime_calendar_upsert(
    connection: &Connection,
    previous: Option<&PlanningCalendarEvent>,
    event: &PlanningCalendarEvent,
) -> Result<(), PlanningStoreError> {
    if event.kind != CalendarEventKind::Plan
        || event.schedule_origin != Some(whalehall_local_protocol::CalendarScheduleOrigin::Model)
        || event.user_locked
        || !event.editable
        || event.state != CalendarEventState::Committed
    {
        return Err(PlanningStoreError::Configuration(
            "PlanningRuntime may only upsert committed, editable, unlocked model plan events"
                .to_owned(),
        ));
    }
    let plan = planning_runtime_event_plan(connection, event)?;
    if !matches!(plan.status, PlanStatus::Active | PlanStatus::Paused) {
        return Err(PlanningStoreError::Configuration(
            "PlanningRuntime may only schedule active or paused plans".to_owned(),
        ));
    }
    let task_id = event
        .source_task_id
        .as_deref()
        .expect("validated plan event sourceTaskId");
    let task = plan
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .expect("calendar ownership validated task");
    let placement_changed = previous.is_none_or(|previous| {
        previous.schedule != event.schedule
            || previous.recurrence != event.recurrence
            || previous.occurrence_id != event.occurrence_id
    });
    if placement_changed && task.status != PlanTaskStatus::Pending {
        return Err(PlanningStoreError::Configuration(format!(
            "PlanningRuntime cannot create or move calendar placement for terminal task {task_id}"
        )));
    }

    if let Some(previous) = previous
        && (previous.kind != CalendarEventKind::Plan
            || previous.schedule_origin
                != Some(whalehall_local_protocol::CalendarScheduleOrigin::Model)
            || previous.user_locked
            || !previous.editable
            || previous.state != CalendarEventState::Committed
            || previous.source_plan_id != event.source_plan_id
            || previous.source_task_id != event.source_task_id)
    {
        return Err(PlanningStoreError::Configuration(format!(
            "PlanningRuntime cannot replace protected calendar event {}",
            event.event_id
        )));
    }
    Ok(())
}

fn validate_planning_runtime_calendar_delete(
    connection: &Connection,
    previous: &PlanningCalendarEvent,
) -> Result<(), PlanningStoreError> {
    if previous.kind != CalendarEventKind::Plan
        || previous.schedule_origin != Some(whalehall_local_protocol::CalendarScheduleOrigin::Model)
        || previous.user_locked
        || !previous.editable
        || previous.state != CalendarEventState::Committed
    {
        return Err(PlanningStoreError::Configuration(format!(
            "PlanningRuntime cannot delete protected calendar event {}",
            previous.event_id
        )));
    }
    planning_runtime_event_plan(connection, previous)?;
    Ok(())
}

fn planning_runtime_event_plan(
    connection: &Connection,
    event: &PlanningCalendarEvent,
) -> Result<PlanSnapshot, PlanningStoreError> {
    let plan_id = event.source_plan_id.as_deref().ok_or_else(|| {
        PlanningStoreError::Configuration(
            "PlanningRuntime calendar event requires sourcePlanId".to_owned(),
        )
    })?;
    let task_id = event.source_task_id.as_deref().ok_or_else(|| {
        PlanningStoreError::Configuration(
            "PlanningRuntime calendar event requires sourceTaskId".to_owned(),
        )
    })?;
    let plan = select_plan(connection, plan_id)?.ok_or_else(|| PlanningStoreError::NotFound {
        aggregate_type: "plan",
        aggregate_id: plan_id.to_owned(),
    })?;
    if !plan.tasks.iter().any(|task| task.task_id == task_id) {
        return Err(PlanningStoreError::NotFound {
            aggregate_type: "plan-task",
            aggregate_id: format!("{plan_id}/{task_id}"),
        });
    }
    Ok(plan)
}

fn validate_calendar_update_ownership(
    previous: &PlanningCalendarEvent,
    event: &PlanningCalendarEvent,
) -> Result<(), PlanningStoreError> {
    if previous.kind != event.kind
        || previous.source_plan_id != event.source_plan_id
        || previous.source_task_id != event.source_task_id
        || previous.schedule_origin != event.schedule_origin
    {
        return Err(PlanningStoreError::Configuration(format!(
            "calendar event {} ownership is immutable across updates",
            event.event_id
        )));
    }
    Ok(())
}

fn validate_calendar_event(event: &PlanningCalendarEvent) -> Result<(), PlanningStoreError> {
    if event.schema_version != CALENDAR_SCHEMA_VERSION {
        return Err(PlanningStoreError::Configuration(format!(
            "calendar event schemaVersion must be {CALENDAR_SCHEMA_VERSION}"
        )));
    }
    validate_identifier("eventId", &event.event_id)?;
    validate_content("calendar.title", &event.title, MAX_CONTENT_CHARS)?;
    if let Some(reference) = event.sealed_content_ref.as_deref() {
        validate_identifier("calendar.sealedContentRef", reference)?;
    }
    let content_is_protected = event.sealed_content_ref.is_some() || event.redacted_content;
    if content_is_protected && event.title != REDACTED_PLAN_CALENDAR_TITLE {
        return Err(PlanningStoreError::Configuration(format!(
            "protected calendar title must use the fixed {REDACTED_PLAN_CALENDAR_TITLE} placeholder"
        )));
    }
    validate_positive_version("calendar.version", event.version)?;
    if let Some(plan_id) = event.source_plan_id.as_deref() {
        validate_identifier("sourcePlanId", plan_id)?;
    }
    if let Some(task_id) = event.source_task_id.as_deref() {
        validate_identifier("sourceTaskId", task_id)?;
        if event.source_plan_id.is_none() {
            return Err(PlanningStoreError::Configuration(
                "sourceTaskId requires sourcePlanId".to_owned(),
            ));
        }
    }
    if event.kind != CalendarEventKind::Plan
        && (event.source_plan_id.is_some()
            || event.source_task_id.is_some()
            || event.schedule_origin.is_some()
            || event.user_locked)
    {
        return Err(PlanningStoreError::Configuration(
            "non-plan calendar events cannot carry planning ownership or userLocked metadata"
                .to_owned(),
        ));
    }
    if event.kind == CalendarEventKind::External && event.editable {
        return Err(PlanningStoreError::Configuration(
            "external calendar events are read-only by default".to_owned(),
        ));
    }
    if event.kind == CalendarEventKind::Plan
        && (event.source_plan_id.is_none()
            || event.source_task_id.is_none()
            || event.schedule_origin.is_none())
    {
        return Err(PlanningStoreError::Configuration(
            "plan calendar events require sourcePlanId, sourceTaskId, and scheduleOrigin"
                .to_owned(),
        ));
    }
    if event.schedule_origin == Some(whalehall_local_protocol::CalendarScheduleOrigin::Model)
        && (event.source_plan_id.is_none() || event.source_task_id.is_none())
    {
        return Err(PlanningStoreError::Configuration(
            "model calendar events require sourcePlanId and sourceTaskId".to_owned(),
        ));
    }
    if event.schedule_origin == Some(whalehall_local_protocol::CalendarScheduleOrigin::Model)
        && !content_is_protected
    {
        return Err(PlanningStoreError::Configuration(
            "model calendar events must seal or redact their content".to_owned(),
        ));
    }
    match &event.schedule {
        CalendarSchedule::Timed(schedule) => {
            if schedule.all_day {
                return Err(PlanningStoreError::Configuration(
                    "timed calendar schedule allDay must be false".to_owned(),
                ));
            }
            validate_time_zone(&schedule.time_zone)?;
            let start = DateTime::parse_from_rfc3339(&schedule.start).map_err(|_| {
                PlanningStoreError::Configuration(
                    "timed calendar start must be an RFC 3339 instant".to_owned(),
                )
            })?;
            let end = DateTime::parse_from_rfc3339(&schedule.end).map_err(|_| {
                PlanningStoreError::Configuration(
                    "timed calendar end must be an RFC 3339 instant".to_owned(),
                )
            })?;
            if end <= start {
                return Err(PlanningStoreError::Configuration(
                    "timed calendar end must be after start".to_owned(),
                ));
            }
        }
        CalendarSchedule::AllDay(schedule) => {
            if !schedule.all_day {
                return Err(PlanningStoreError::Configuration(
                    "all-day calendar schedule allDay must be true".to_owned(),
                ));
            }
            let start = parse_date("calendar.startDate", &schedule.start_date)?;
            let end = parse_date("calendar.endDateExclusive", &schedule.end_date_exclusive)?;
            if end <= start {
                return Err(PlanningStoreError::Configuration(
                    "all-day endDateExclusive must be after startDate".to_owned(),
                ));
            }
        }
    }
    if let Some(recurrence) = &event.recurrence {
        validate_identifier("recurrence.seriesId", &recurrence.series_id)?;
        validate_content("recurrence.rrule", &recurrence.rrule, 8_192)?;
        validate_time_zone(&recurrence.time_zone)?;
        for date in &recurrence.exception_dates {
            parse_date("recurrence.exceptionDate", date)?;
        }
    }
    if let Some(occurrence_id) = event.occurrence_id.as_deref() {
        validate_identifier("occurrenceId", occurrence_id)?;
        if event.recurrence.is_none() {
            return Err(PlanningStoreError::Configuration(
                "occurrenceId requires recurrence".to_owned(),
            ));
        }
    }
    Ok(())
}

fn calendar_event_overlaps_dates(
    event: &PlanningCalendarEvent,
    (from, to): (NaiveDate, NaiveDate),
) -> bool {
    let (start, end_exclusive) = match &event.schedule {
        CalendarSchedule::Timed(schedule) => {
            let Ok(start) = DateTime::parse_from_rfc3339(&schedule.start) else {
                return false;
            };
            let Ok(end) = DateTime::parse_from_rfc3339(&schedule.end) else {
                return false;
            };
            let end_date_exclusive = if end.time() == chrono::NaiveTime::MIN {
                end.date_naive()
            } else {
                end.date_naive().succ_opt().unwrap_or(end.date_naive())
            };
            (start.date_naive(), end_date_exclusive)
        }
        CalendarSchedule::AllDay(schedule) => {
            let Ok(start) = NaiveDate::parse_from_str(&schedule.start_date, "%Y-%m-%d") else {
                return false;
            };
            let Ok(end) = NaiveDate::parse_from_str(&schedule.end_date_exclusive, "%Y-%m-%d")
            else {
                return false;
            };
            (start, end)
        }
    };
    start < to && end_exclusive > from
}

fn validate_outbox_drafts(drafts: &[PlanningOutboxDraft]) -> Result<(), PlanningStoreError> {
    validate_collection_bound("outbox", drafts.len())?;
    let mut ids = HashSet::new();
    for draft in drafts {
        validate_identifier("outbox.entryId", &draft.entry_id)?;
        validate_identifier("outbox.aggregateId", &draft.aggregate_id)?;
        validate_timestamp("outbox.createdAtMs", draft.created_at_ms)?;
        if !ids.insert(draft.entry_id.as_str()) {
            return Err(PlanningStoreError::Configuration(format!(
                "duplicate outbox entryId {}",
                draft.entry_id
            )));
        }
        let encoded = serde_json::to_vec(&draft.payload)?;
        if encoded.len() > MAX_OUTBOX_PAYLOAD_BYTES {
            return Err(PlanningStoreError::Configuration(format!(
                "outbox payload exceeds {MAX_OUTBOX_PAYLOAD_BYTES} bytes"
            )));
        }
        validate_outbox_payload(draft.kind, &draft.aggregate_id, &draft.payload)?;
    }
    Ok(())
}

fn validate_outbox_payload(
    kind: PlanningOutboxKind,
    aggregate_id: &str,
    value: &Value,
) -> Result<(), PlanningStoreError> {
    let object = value.as_object().ok_or_else(|| {
        PlanningStoreError::Configuration("outbox payload must be an object".to_owned())
    })?;
    match kind {
        PlanningOutboxKind::PlanChanged => {
            require_exact_outbox_keys(object, &["planId", "version"])?;
            let plan_id = outbox_identifier(object, "planId")?;
            if plan_id != aggregate_id {
                return Err(PlanningStoreError::Configuration(
                    "plan-changed aggregateId must equal payload.planId".to_owned(),
                ));
            }
            outbox_positive_integer(object, "version")?;
        }
        PlanningOutboxKind::CalendarChanged => {
            let change_set_shape = has_exact_outbox_keys(object, &["changeSetId", "planId"]);
            let user_batch_shape = has_exact_outbox_keys(
                object,
                &[
                    "batchId",
                    "mutationCount",
                    "planIds",
                    "requiresPlanningReestimate",
                ],
            );
            if change_set_shape {
                outbox_identifier(object, "changeSetId")?;
                let plan_id = outbox_identifier(object, "planId")?;
                if plan_id != aggregate_id {
                    return Err(PlanningStoreError::Configuration(
                        "calendar change-set aggregateId must equal payload.planId".to_owned(),
                    ));
                }
            } else if user_batch_shape {
                outbox_identifier(object, "batchId")?;
                outbox_positive_integer(object, "mutationCount")?;
                let plan_ids =
                    object
                        .get("planIds")
                        .and_then(Value::as_array)
                        .ok_or_else(|| {
                            PlanningStoreError::Configuration(
                                "calendar user-batch planIds must be an array".to_owned(),
                            )
                        })?;
                validate_collection_bound("calendar outbox planIds", plan_ids.len())?;
                for plan_id in plan_ids {
                    let plan_id = plan_id.as_str().ok_or_else(|| {
                        PlanningStoreError::Configuration(
                            "calendar user-batch planIds must contain identifiers".to_owned(),
                        )
                    })?;
                    validate_identifier("calendar outbox planId", plan_id)?;
                }
                if object
                    .get("requiresPlanningReestimate")
                    .and_then(Value::as_bool)
                    .is_none()
                {
                    return Err(PlanningStoreError::Configuration(
                        "calendar user-batch requiresPlanningReestimate must be boolean".to_owned(),
                    ));
                }
            } else {
                return Err(PlanningStoreError::Configuration(
                    "calendar-changed payload must match the change-set or user-batch allowlist"
                        .to_owned(),
                ));
            }
        }
        PlanningOutboxKind::Notification => {
            let allowed = [
                "code",
                "planId",
                "version",
                "adjustmentId",
                "added",
                "moved",
                "cancelled",
                "unscheduled",
                "etaChanged",
            ];
            if object.is_empty() || object.keys().any(|key| !allowed.contains(&key.as_str())) {
                return Err(PlanningStoreError::Configuration(
                    "notification payload contains a field outside its content-free allowlist"
                        .to_owned(),
                ));
            }
            outbox_identifier(object, "code")?;
            if object.contains_key("planId") {
                outbox_identifier(object, "planId")?;
            }
            if object.contains_key("adjustmentId") {
                outbox_identifier(object, "adjustmentId")?;
            }
            for key in ["version", "added", "moved", "cancelled", "unscheduled"] {
                if object.contains_key(key) {
                    outbox_non_negative_integer(object, key)?;
                }
            }
            if object.contains_key("etaChanged")
                && object.get("etaChanged").and_then(Value::as_bool).is_none()
            {
                return Err(PlanningStoreError::Configuration(
                    "notification etaChanged must be boolean".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn require_exact_outbox_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
) -> Result<(), PlanningStoreError> {
    if !has_exact_outbox_keys(object, expected) {
        return Err(PlanningStoreError::Configuration(
            "outbox payload does not match its kind-specific allowlist".to_owned(),
        ));
    }
    Ok(())
}

fn has_exact_outbox_keys(object: &serde_json::Map<String, Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn outbox_identifier<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, PlanningStoreError> {
    let value = object.get(key).and_then(Value::as_str).ok_or_else(|| {
        PlanningStoreError::Configuration(format!("outbox {key} must be an identifier"))
    })?;
    validate_identifier(&format!("outbox.{key}"), value)?;
    Ok(value)
}

fn outbox_positive_integer(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<i64, PlanningStoreError> {
    let value = outbox_non_negative_integer(object, key)?;
    if value == 0 {
        return Err(PlanningStoreError::Configuration(format!(
            "outbox {key} must be positive"
        )));
    }
    Ok(value)
}

fn outbox_non_negative_integer(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<i64, PlanningStoreError> {
    let value = object.get(key).and_then(Value::as_i64).ok_or_else(|| {
        PlanningStoreError::Configuration(format!(
            "outbox {key} must be a non-negative safe integer"
        ))
    })?;
    validate_timestamp(&format!("outbox.{key}"), value)?;
    Ok(value)
}

fn validate_identifier(label: &str, value: &str) -> Result<(), PlanningStoreError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-' | b'/')
        })
    {
        return Err(PlanningStoreError::Configuration(format!(
            "{label} must contain 1 to {MAX_IDENTIFIER_BYTES} ASCII letters, digits, '.', '_', ':', '-', or '/'"
        )));
    }
    Ok(())
}

fn validate_operation_id(operation_id: &str) -> Result<(), PlanningStoreError> {
    validate_identifier("operationId", operation_id)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PlanningVaultReferenceCursor {
    source_rank: i64,
    source_key: String,
    source_version: i64,
}

struct PlanningVaultReferenceRow {
    source_rank: i64,
    source_key: String,
    source_version: i64,
    snapshot_json: String,
}

fn validate_planning_vault_reference_params(
    params: &PlanningVaultReferencesParams,
) -> Result<Option<PlanningVaultReferenceCursor>, PlanningStoreError> {
    if !(1..=MAX_PLANNING_VAULT_REFERENCE_LIMIT).contains(&params.limit) {
        return Err(PlanningStoreError::Configuration(format!(
            "planning.vaultReferences limit must be between 1 and {MAX_PLANNING_VAULT_REFERENCE_LIMIT}"
        )));
    }
    params
        .cursor
        .as_deref()
        .map(parse_planning_vault_reference_cursor)
        .transpose()
}

fn format_planning_vault_reference_cursor(row: &PlanningVaultReferenceRow) -> String {
    format!(
        "{PLANNING_VAULT_REFERENCE_CURSOR_PREFIX}_{}_{:016x}_{}",
        row.source_rank,
        row.source_version,
        encode_hex(row.source_key.as_bytes())
    )
}

fn parse_planning_vault_reference_cursor(
    cursor: &str,
) -> Result<PlanningVaultReferenceCursor, PlanningStoreError> {
    let invalid = || {
        PlanningStoreError::Configuration("planning.vaultReferences cursor is malformed".to_owned())
    };
    let mut parts = cursor.splitn(4, '_');
    if parts.next() != Some(PLANNING_VAULT_REFERENCE_CURSOR_PREFIX) {
        return Err(invalid());
    }
    let source_rank = parts
        .next()
        .ok_or_else(&invalid)?
        .parse::<i64>()
        .map_err(|_| invalid())?;
    let source_version =
        i64::from_str_radix(parts.next().ok_or_else(&invalid)?, 16).map_err(|_| invalid())?;
    let source_key = String::from_utf8(decode_hex(parts.next().ok_or_else(&invalid)?)?)
        .map_err(|_| invalid())?;
    match source_rank {
        0 => {
            if source_version != 0 {
                return Err(invalid());
            }
            validate_identifier("planning vault cursor planId", &source_key)
                .map_err(|_| invalid())?;
        }
        1 => {
            if !(1..=MAX_SAFE_INTEGER).contains(&source_version) {
                return Err(invalid());
            }
            validate_identifier("planning vault cursor planId", &source_key)
                .map_err(|_| invalid())?;
        }
        2 => {
            if source_version != 0 {
                return Err(invalid());
            }
            validate_operation_id(&source_key).map_err(|_| invalid())?;
        }
        _ => return Err(invalid()),
    }
    Ok(PlanningVaultReferenceCursor {
        source_rank,
        source_key,
        source_version,
    })
}

fn planning_vault_reference_from_row(
    row: &PlanningVaultReferenceRow,
) -> Result<Option<PlanningVaultReference>, PlanningStoreError> {
    let (source, plan) = match row.source_rank {
        0 => (
            PlanningVaultReferenceSource::Current,
            serde_json::from_str::<PlanSnapshot>(&row.snapshot_json)?,
        ),
        1 => (
            PlanningVaultReferenceSource::History,
            serde_json::from_str::<PlanSnapshot>(&row.snapshot_json)?,
        ),
        2 => {
            let result = serde_json::from_str::<Value>(&row.snapshot_json)?;
            let plan = result.get("plan").cloned().ok_or_else(|| {
                PlanningStoreError::Configuration(
                    "planning operation ledger result is missing its plan snapshot".to_owned(),
                )
            })?;
            (
                PlanningVaultReferenceSource::Operation,
                serde_json::from_value::<PlanSnapshot>(plan)?,
            )
        }
        _ => {
            return Err(PlanningStoreError::Configuration(
                "planning vault reference source is invalid".to_owned(),
            ));
        }
    };
    if row.source_rank <= 1 && row.source_key != plan.plan_id {
        return Err(PlanningStoreError::Configuration(
            "planning vault reference row has mismatched plan identity".to_owned(),
        ));
    }
    if row.source_rank == 1 && row.source_version != plan.version {
        return Err(PlanningStoreError::Configuration(
            "planning history vault reference has mismatched version".to_owned(),
        ));
    }
    if row.source_rank == 2 {
        validate_operation_id(&row.source_key)?;
    }
    let manifest_record_id = match plan.runtime_payload.get("manifestRecordId") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            validate_identifier("planning manifestRecordId", value)?;
            Some(value.clone())
        }
        Some(_) => {
            return Err(PlanningStoreError::Configuration(
                "planning runtimePayload manifestRecordId must be a string".to_owned(),
            ));
        }
    };
    let Some(sealed_content_ref) = plan.sealed_content_ref else {
        if manifest_record_id.is_some() {
            return Err(PlanningStoreError::Configuration(
                "planning manifestRecordId requires sealedContentRef".to_owned(),
            ));
        }
        return Ok(None);
    };
    validate_identifier("planning sealedContentRef", &sealed_content_ref)?;
    Ok(Some(PlanningVaultReference {
        source,
        plan_id: plan.plan_id,
        version: plan.version,
        sealed_content_ref,
        manifest_record_id,
    }))
}

fn encode_hex(value: &[u8]) -> String {
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn decode_hex(value: &str) -> Result<Vec<u8>, PlanningStoreError> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES * 2 || !value.len().is_multiple_of(2)
    {
        return Err(PlanningStoreError::Configuration(
            "planning.vaultReferences cursor is malformed".to_owned(),
        ));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let encoded = std::str::from_utf8(pair).map_err(|_| {
                PlanningStoreError::Configuration(
                    "planning.vaultReferences cursor is malformed".to_owned(),
                )
            })?;
            u8::from_str_radix(encoded, 16).map_err(|_| {
                PlanningStoreError::Configuration(
                    "planning.vaultReferences cursor is malformed".to_owned(),
                )
            })
        })
        .collect()
}

fn validate_time_zone(time_zone: &str) -> Result<(), PlanningStoreError> {
    if time_zone.is_empty()
        || time_zone.len() > 128
        || !time_zone.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+' | b'.')
        })
    {
        return Err(PlanningStoreError::Configuration(
            "timeZone must be a bounded IANA timezone identifier".to_owned(),
        ));
    }
    Ok(())
}

fn validate_content(label: &str, value: &str, max_chars: usize) -> Result<(), PlanningStoreError> {
    let count = value.chars().count();
    if value.trim().is_empty() || count > max_chars {
        return Err(PlanningStoreError::Configuration(format!(
            "{label} must contain 1 to {max_chars} characters"
        )));
    }
    Ok(())
}

fn validate_positive_version(label: &str, value: i64) -> Result<(), PlanningStoreError> {
    if !(1..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(PlanningStoreError::Configuration(format!(
            "{label} must be a positive safe integer"
        )));
    }
    Ok(())
}

fn validate_timestamp(label: &str, value: i64) -> Result<(), PlanningStoreError> {
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(PlanningStoreError::Configuration(format!(
            "{label} must be a non-negative safe integer"
        )));
    }
    Ok(())
}

fn validate_collection_bound(label: &str, len: usize) -> Result<(), PlanningStoreError> {
    if len > MAX_COLLECTION_ITEMS {
        return Err(PlanningStoreError::Configuration(format!(
            "{label} cannot contain more than {MAX_COLLECTION_ITEMS} items"
        )));
    }
    Ok(())
}

fn parse_date(label: &str, value: &str) -> Result<NaiveDate, PlanningStoreError> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| {
        PlanningStoreError::Configuration(format!(
            "{label} must be an ISO calendar date (YYYY-MM-DD)"
        ))
    })?;
    if date.format("%Y-%m-%d").to_string() != value {
        return Err(PlanningStoreError::Configuration(format!(
            "{label} must be an ISO calendar date (YYYY-MM-DD)"
        )));
    }
    Ok(date)
}

fn persist_plan(
    transaction: &Transaction<'_>,
    plan: &PlanSnapshot,
    operation_id: &str,
) -> Result<(), PlanningStoreError> {
    let snapshot_json = serde_json::to_string(plan)?;
    transaction.execute(
        "INSERT INTO plans (
            plan_id, schema_version, version, status, updated_at_ms, snapshot_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(plan_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            version = excluded.version,
            status = excluded.status,
            updated_at_ms = excluded.updated_at_ms,
            snapshot_json = excluded.snapshot_json",
        params![
            plan.plan_id,
            plan.schema_version,
            plan.version,
            plan_status_name(plan.status),
            plan.updated_at_ms,
            snapshot_json,
        ],
    )?;
    transaction.execute(
        "INSERT INTO plan_history (
            plan_id, version, operation_id, created_at_ms, snapshot_json
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            plan.plan_id,
            plan.version,
            operation_id,
            plan.updated_at_ms,
            snapshot_json,
        ],
    )?;
    Ok(())
}

fn replace_plan_calendar_projection(
    transaction: &Transaction<'_>,
    plan: &PlanSnapshot,
    events: &[PlanningCalendarEvent],
) -> Result<(), PlanningStoreError> {
    let plan_id = &plan.plan_id;
    let existing = select_calendar_for_plan(transaction, plan_id)?;
    let incoming = events
        .iter()
        .map(|event| (event.event_id.as_str(), event))
        .collect::<HashMap<_, _>>();
    for previous in &existing {
        let next = incoming.get(previous.event_id.as_str()).copied();
        let task_completed = previous.source_task_id.as_deref().is_some_and(|task_id| {
            plan.tasks.iter().any(|task| {
                task.task_id == task_id
                    && task.status == whalehall_local_protocol::PlanTaskStatus::Completed
            })
        });
        let protected = previous.user_locked
            || previous.schedule_origin
                != Some(whalehall_local_protocol::CalendarScheduleOrigin::Model)
            || task_completed;
        if protected && next != Some(previous) {
            return Err(PlanningStoreError::Configuration(format!(
                "plan calendar replacement cannot change or remove protected event {}",
                previous.event_id
            )));
        }
        if let Some(next) = next {
            if next == previous {
                continue;
            }
            if next.version != previous.version.saturating_add(1) {
                return Err(PlanningStoreError::StaleVersion {
                    aggregate_type: "calendar-event",
                    aggregate_id: next.event_id.clone(),
                    expected: next.version.checked_sub(1),
                    actual: Some(previous.version),
                });
            }
        }
    }
    for event in events {
        if let Some(previous) = select_calendar_event(transaction, &event.event_id)? {
            if previous.source_plan_id.as_deref() != Some(plan_id) {
                return Err(PlanningStoreError::Configuration(format!(
                    "calendar eventId {} already belongs outside plan {plan_id}",
                    event.event_id
                )));
            }
        } else if event.version != 1 {
            return Err(PlanningStoreError::Configuration(format!(
                "new calendar event {} version must be 1",
                event.event_id
            )));
        }
    }
    transaction.execute(
        "DELETE FROM calendar_events WHERE source_plan_id = ?1",
        [plan_id],
    )?;
    for event in events {
        persist_calendar_event(transaction, event)?;
    }
    Ok(())
}

fn persist_calendar_event(
    transaction: &Transaction<'_>,
    event: &PlanningCalendarEvent,
) -> Result<(), PlanningStoreError> {
    let event_json = serde_json::to_string(event)?;
    transaction.execute(
        "INSERT INTO calendar_events (
            event_id, schema_version, version, source_plan_id, source_task_id,
            kind, state, user_locked, event_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(event_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            version = excluded.version,
            source_plan_id = excluded.source_plan_id,
            source_task_id = excluded.source_task_id,
            kind = excluded.kind,
            state = excluded.state,
            user_locked = excluded.user_locked,
            event_json = excluded.event_json",
        params![
            event.event_id,
            event.schema_version,
            event.version,
            event.source_plan_id,
            event.source_task_id,
            calendar_kind_name(event.kind),
            calendar_state_name(event.state),
            event.user_locked,
            event_json,
        ],
    )?;
    Ok(())
}

fn insert_outbox(
    transaction: &Transaction<'_>,
    operation_id: &str,
    drafts: &[PlanningOutboxDraft],
) -> Result<Vec<PlanningOutboxEntry>, PlanningStoreError> {
    let mut entries = Vec::with_capacity(drafts.len());
    for draft in drafts {
        let payload_json = serde_json::to_string(&draft.payload)?;
        let inserted = transaction.execute(
            "INSERT INTO planning_outbox (
                entry_id, operation_id, kind, aggregate_id, payload_json,
                status, created_at_ms, delivered_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, NULL)
             ON CONFLICT(entry_id) DO NOTHING",
            params![
                draft.entry_id,
                operation_id,
                outbox_kind_name(draft.kind),
                draft.aggregate_id,
                payload_json,
                draft.created_at_ms,
            ],
        )? == 1;
        if !inserted {
            return Err(PlanningStoreError::Configuration(format!(
                "outbox entryId {} already exists",
                draft.entry_id
            )));
        }
        entries.push(
            select_outbox(transaction, &draft.entry_id)?
                .expect("inserted outbox row is readable")
                .into_entry()?,
        );
    }
    Ok(entries)
}

fn select_plan(
    connection: &Connection,
    plan_id: &str,
) -> Result<Option<PlanSnapshot>, PlanningStoreError> {
    let snapshot_json = connection
        .query_row(
            "SELECT snapshot_json FROM plans WHERE plan_id = ?1",
            [plan_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    snapshot_json
        .map(|json| serde_json::from_str(&json).map_err(Into::into))
        .transpose()
}

fn select_calendar_event(
    connection: &Connection,
    event_id: &str,
) -> Result<Option<PlanningCalendarEvent>, PlanningStoreError> {
    let event_json = connection
        .query_row(
            "SELECT event_json FROM calendar_events WHERE event_id = ?1",
            [event_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    event_json
        .map(|json| serde_json::from_str(&json).map_err(Into::into))
        .transpose()
}

fn select_calendar_for_plan(
    connection: &Connection,
    plan_id: &str,
) -> Result<Vec<PlanningCalendarEvent>, PlanningStoreError> {
    let mut statement = connection.prepare(
        "SELECT event_json FROM calendar_events
         WHERE source_plan_id = ?1 ORDER BY event_id ASC",
    )?;
    let rows = statement.query_map([plan_id], |row| row.get::<_, String>(0))?;
    rows.map(|row| {
        let json = row?;
        serde_json::from_str(&json).map_err(Into::into)
    })
    .collect()
}

struct StoredOutbox {
    entry_id: String,
    kind: String,
    aggregate_id: String,
    payload_json: String,
    status: String,
    created_at_ms: i64,
    delivered_at_ms: Option<i64>,
}

impl StoredOutbox {
    fn into_entry(self) -> Result<PlanningOutboxEntry, PlanningStoreError> {
        Ok(PlanningOutboxEntry {
            entry_id: self.entry_id,
            kind: parse_outbox_kind(&self.kind)?,
            aggregate_id: self.aggregate_id,
            payload: serde_json::from_str(&self.payload_json)?,
            status: parse_outbox_status(&self.status)?,
            created_at_ms: self.created_at_ms,
            delivered_at_ms: self.delivered_at_ms,
        })
    }
}

fn stored_outbox_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredOutbox> {
    Ok(StoredOutbox {
        entry_id: row.get(0)?,
        kind: row.get(1)?,
        aggregate_id: row.get(2)?,
        payload_json: row.get(3)?,
        status: row.get(4)?,
        created_at_ms: row.get(5)?,
        delivered_at_ms: row.get(6)?,
    })
}

fn select_outbox(
    connection: &Connection,
    entry_id: &str,
) -> Result<Option<StoredOutbox>, PlanningStoreError> {
    connection
        .query_row(
            "SELECT entry_id, kind, aggregate_id, payload_json, status,
                    created_at_ms, delivered_at_ms
             FROM planning_outbox WHERE entry_id = ?1",
            [entry_id],
            stored_outbox_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn replay_operation<T: DeserializeOwned>(
    connection: &Connection,
    operation_id: &str,
    method: &str,
    request_hash: &str,
) -> Result<Option<T>, PlanningStoreError> {
    let stored = connection
        .query_row(
            "SELECT method, request_hash, result_json
             FROM idempotent_operations WHERE operation_id = ?1",
            [operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((stored_method, stored_hash, result_json)) = stored else {
        return Ok(None);
    };
    if stored_method != method || stored_hash != request_hash {
        return Err(PlanningStoreError::IdempotencyConflict {
            operation_id: operation_id.to_owned(),
        });
    }
    Ok(Some(serde_json::from_str(&result_json)?))
}

fn record_operation<T: Serialize>(
    transaction: &Transaction<'_>,
    operation_id: &str,
    method: &str,
    request_hash: &str,
    result: &T,
    created_at_ms: i64,
) -> Result<(), PlanningStoreError> {
    validate_timestamp("operation.createdAtMs", created_at_ms)?;
    transaction.execute(
        "INSERT INTO idempotent_operations (
            operation_id, method, request_hash, result_json, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            operation_id,
            method,
            request_hash,
            serde_json::to_string(result)?,
            created_at_ms,
        ],
    )?;
    Ok(())
}

fn request_hash<T: Serialize>(value: &T) -> Result<String, PlanningStoreError> {
    let encoded = serde_json::to_vec(value)?;
    Ok(digest_hex(&encoded))
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

fn maximum_outbox_timestamp(outbox: &[PlanningOutboxDraft]) -> i64 {
    outbox
        .iter()
        .map(|entry| entry.created_at_ms)
        .max()
        .unwrap_or_default()
}

fn plan_status_name(status: PlanStatus) -> &'static str {
    match status {
        PlanStatus::Draft => "draft",
        PlanStatus::AwaitingConfirmation => "awaiting-confirmation",
        PlanStatus::Active => "active",
        PlanStatus::Paused => "paused",
        PlanStatus::Completed => "completed",
        PlanStatus::Archived => "archived",
    }
}

fn calendar_kind_name(kind: CalendarEventKind) -> &'static str {
    match kind {
        CalendarEventKind::Plan => "plan",
        CalendarEventKind::ManualBlock => "manual-block",
        CalendarEventKind::External => "external",
        CalendarEventKind::Break => "break",
    }
}

fn calendar_state_name(state: whalehall_local_protocol::CalendarEventState) -> &'static str {
    match state {
        whalehall_local_protocol::CalendarEventState::Proposed => "proposed",
        whalehall_local_protocol::CalendarEventState::Committed => "committed",
    }
}

fn outbox_kind_name(kind: PlanningOutboxKind) -> &'static str {
    match kind {
        PlanningOutboxKind::PlanChanged => "plan-changed",
        PlanningOutboxKind::CalendarChanged => "calendar-changed",
        PlanningOutboxKind::Notification => "notification",
    }
}

fn parse_outbox_kind(value: &str) -> Result<PlanningOutboxKind, PlanningStoreError> {
    match value {
        "plan-changed" => Ok(PlanningOutboxKind::PlanChanged),
        "calendar-changed" => Ok(PlanningOutboxKind::CalendarChanged),
        "notification" => Ok(PlanningOutboxKind::Notification),
        value => Err(PlanningStoreError::Configuration(format!(
            "stored outbox has unknown kind {value}"
        ))),
    }
}

fn parse_outbox_status(value: &str) -> Result<PlanningOutboxStatus, PlanningStoreError> {
    match value {
        "pending" => Ok(PlanningOutboxStatus::Pending),
        "delivered" => Ok(PlanningOutboxStatus::Delivered),
        value => Err(PlanningStoreError::Configuration(format!(
            "stored outbox has unknown status {value}"
        ))),
    }
}

fn initialize(connection: &mut Connection) -> Result<(), PlanningStoreError> {
    let version = connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    if version > SCHEMA_VERSION {
        return Err(PlanningStoreError::Configuration(format!(
            "planning database schema {version} is newer than supported schema {SCHEMA_VERSION}"
        )));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if version == 0 {
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS plans (
                plan_id TEXT PRIMARY KEY,
                schema_version TEXT NOT NULL,
                version INTEGER NOT NULL CHECK (version > 0),
                status TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
                snapshot_json TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS plans_status_updated
                ON plans(status, updated_at_ms DESC);
             CREATE TABLE IF NOT EXISTS plan_history (
                plan_id TEXT NOT NULL,
                version INTEGER NOT NULL CHECK (version > 0),
                operation_id TEXT NOT NULL UNIQUE,
                created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
                snapshot_json TEXT NOT NULL,
                PRIMARY KEY(plan_id, version),
                FOREIGN KEY(plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS calendar_events (
                event_id TEXT PRIMARY KEY,
                schema_version TEXT NOT NULL,
                version INTEGER NOT NULL CHECK (version > 0),
                source_plan_id TEXT,
                source_task_id TEXT,
                kind TEXT NOT NULL,
                state TEXT NOT NULL,
                user_locked INTEGER NOT NULL CHECK (user_locked IN (0, 1)),
                event_json TEXT NOT NULL,
                FOREIGN KEY(source_plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS calendar_events_plan_task
                ON calendar_events(source_plan_id, source_task_id, event_id);
             CREATE TABLE IF NOT EXISTS planning_outbox (
                entry_id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                aggregate_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
                created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
                delivered_at_ms INTEGER CHECK (delivered_at_ms >= 0)
             );
             CREATE INDEX IF NOT EXISTS planning_outbox_status_created
                ON planning_outbox(status, created_at_ms, entry_id);
             CREATE TABLE IF NOT EXISTS idempotent_operations (
                operation_id TEXT PRIMARY KEY,
                method TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
             );",
        )?;
    }
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

fn connect(path: &Path) -> Result<Connection, PlanningStoreError> {
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
fn harden_directory_permissions(path: &Path) -> Result<(), PlanningStoreError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn harden_directory_permissions(_path: &Path) -> Result<(), PlanningStoreError> {
    Ok(())
}

#[cfg(unix)]
fn harden_sqlite_permissions(path: &Path) -> Result<(), PlanningStoreError> {
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    match fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
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
fn harden_sqlite_permissions(_path: &Path) -> Result<(), PlanningStoreError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use whalehall_local_protocol::{CalendarEventState, CalendarScheduleOrigin, PlanAnalysisState};

    fn test_store() -> (tempfile::TempDir, PlanningStore) {
        let directory = tempfile::tempdir().expect("create planning test directory");
        let store = PlanningStore::open(directory.path().join("planning.sqlite3"))
            .expect("open planning store");
        (directory, store)
    }

    fn draft_plan() -> PlanSnapshot {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": PLANNING_SCHEMA_VERSION,
            "planId": "plan-1",
            "version": 1,
            "planType": null,
            "status": "draft",
            "analysisState": "awaiting-analysis",
            "analysisDiagnostic": null,
            "goal": "在本地完成动态计划闭环",
            "sealedContentRef": null,
            "redactedContent": false,
            "startToday": false,
            "timeZone": "Asia/Shanghai",
            "effectiveStartDate": null,
            "schedulingWindow": null,
            "activeRevisionId": null,
            "proposedRevisionId": null,
            "currentEstimate": null,
            "tasks": [],
            "conversation": [{
                "messageId": "message-1",
                "role": "user",
                "status": "pending-analysis",
                "content": "请帮我制定计划",
                "createdAtMs": 1_000,
                "failureCategory": null
            }],
            "revisions": [],
            "estimateSnapshots": [],
            "observationEvidence": [],
            "adjustments": [],
            "autoScheduleAuthorized": false,
            "monitoringMode": "manual-only",
            "createdAtMs": 1_000,
            "updatedAtMs": 1_000
        }))
        .expect("draft fixture matches protocol")
    }

    fn ready_plan() -> PlanSnapshot {
        let mut plan = draft_plan();
        plan.version = 2;
        plan.status = PlanStatus::AwaitingConfirmation;
        plan.analysis_state = PlanAnalysisState::Ready;
        plan.plan_type = Some(whalehall_local_protocol::PlanType::ShortTerm);
        plan.effective_start_date = Some("2026-08-14".to_owned());
        plan.scheduling_window = Some(PlanSchedulingWindow {
            start_date: "2026-08-14".to_owned(),
            end_date_inclusive: "2026-08-20".to_owned(),
        });
        let estimate = PlanEstimate {
            estimated_completion_date: "2026-08-20".to_owned(),
            confidence: 0.8,
            assessed_at_ms: 2_000,
            evidence_through_ms: Some(1_500),
            basis: "根据首轮任务容量估算".to_owned(),
            model_version: "qwen3:4b".to_owned(),
        };
        plan.current_estimate = Some(estimate.clone());
        plan.tasks = vec![PlanTask {
            task_id: "task-1".to_owned(),
            title: "实现持久化".to_owned(),
            description: String::new(),
            dependency_task_ids: Vec::new(),
            estimated_effort_minutes: 60,
            status: whalehall_local_protocol::PlanTaskStatus::Pending,
        }];
        plan.conversation[0].status =
            whalehall_local_protocol::PlanConversationMessageStatus::Analyzed;
        plan.revisions = vec![PlanRevision {
            revision_id: "revision-2".to_owned(),
            plan_version: 2,
            created_at_ms: 2_000,
            reason: "首轮分析".to_owned(),
            estimate: Some(estimate.clone()),
            payload: serde_json::json!({"taskCount": 1}),
        }];
        plan.estimate_snapshots = vec![whalehall_local_protocol::PlanEstimateSnapshot {
            estimate_id: "estimate-2".to_owned(),
            plan_version: 2,
            estimate,
        }];
        plan.proposed_revision_id = Some("revision-2".to_owned());
        plan.updated_at_ms = 2_000;
        plan
    }

    fn proposal_plan_before_confirmation() -> PlanSnapshot {
        let mut plan = draft_plan();
        plan.version = 2;
        plan.status = PlanStatus::AwaitingConfirmation;
        plan.analysis_state = PlanAnalysisState::Ready;
        plan.plan_type = None;
        plan.effective_start_date = None;
        plan.scheduling_window = None;
        plan.current_estimate = None;
        plan.conversation[0].status =
            whalehall_local_protocol::PlanConversationMessageStatus::Analyzed;
        plan.revisions = vec![PlanRevision {
            revision_id: "proposal-revision-2".to_owned(),
            plan_version: 2,
            created_at_ms: 2_000,
            reason: "等待用户确认的模型提案".to_owned(),
            estimate: None,
            payload: serde_json::json!({
                "planType": "short-term",
                "estimatedCompletionDate": "2026-08-20",
                "schedulingWindowDays": 7
            }),
        }];
        plan.proposed_revision_id = Some("proposal-revision-2".to_owned());
        plan.updated_at_ms = 2_000;
        plan
    }

    fn plan_event(version: i64) -> PlanningCalendarEvent {
        PlanningCalendarEvent {
            schema_version: CALENDAR_SCHEMA_VERSION.to_owned(),
            event_id: "event-1".to_owned(),
            title: REDACTED_PLAN_CALENDAR_TITLE.to_owned(),
            sealed_content_ref: None,
            redacted_content: true,
            kind: CalendarEventKind::Plan,
            state: CalendarEventState::Proposed,
            schedule: CalendarSchedule::Timed(whalehall_local_protocol::CalendarTimedSchedule {
                all_day: false,
                start: "2026-08-14T09:00:00+08:00".to_owned(),
                end: "2026-08-14T10:00:00+08:00".to_owned(),
                time_zone: "Asia/Shanghai".to_owned(),
            }),
            recurrence: None,
            occurrence_id: None,
            source_plan_id: Some("plan-1".to_owned()),
            source_task_id: Some("task-1".to_owned()),
            schedule_origin: Some(CalendarScheduleOrigin::Model),
            user_locked: false,
            editable: true,
            version,
        }
    }

    fn committed_plan_event(version: i64) -> PlanningCalendarEvent {
        let mut event = plan_event(version);
        event.state = CalendarEventState::Committed;
        event
    }

    fn moved_plan_event(
        mut event: PlanningCalendarEvent,
        version: i64,
        local_date: &str,
    ) -> PlanningCalendarEvent {
        event.version = version;
        if let CalendarSchedule::Timed(schedule) = &mut event.schedule {
            schedule.start = format!("{local_date}T09:00:00+08:00");
            schedule.end = format!("{local_date}T10:00:00+08:00");
        }
        event
    }

    fn active_plan_for_calendar_actor() -> PlanSnapshot {
        let mut plan = ready_plan();
        plan.status = PlanStatus::Active;
        plan.active_revision_id = plan.proposed_revision_id.take();
        plan
    }

    fn persist_active_plan(
        store: &PlanningStore,
        plan: PlanSnapshot,
        calendar_events: Option<Vec<PlanningCalendarEvent>>,
    ) {
        create_draft(store);
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "activate-plan-for-calendar-actor".to_owned(),
                expected_version: 1,
                plan,
                calendar_events,
                outbox: Vec::new(),
            })
            .expect("persist active plan for calendar actor test");
    }

    fn create_draft(store: &PlanningStore) -> PlanningMutationResult {
        store
            .upsert_plan(&PlanningUpsertParams {
                operation_id: "create-plan-1".to_owned(),
                expected_version: None,
                plan: draft_plan(),
                calendar_events: None,
                outbox: vec![PlanningOutboxDraft {
                    entry_id: "outbox-create-plan-1".to_owned(),
                    kind: PlanningOutboxKind::PlanChanged,
                    aggregate_id: "plan-1".to_owned(),
                    payload: serde_json::json!({"planId": "plan-1", "version": 1}),
                    created_at_ms: 1_000,
                }],
            })
            .expect("create draft")
    }

    #[test]
    fn persists_unanalysed_draft_restarts_and_replays_operation() {
        let (directory, store) = test_store();
        let params = PlanningUpsertParams {
            operation_id: "create-plan-1".to_owned(),
            expected_version: None,
            plan: draft_plan(),
            calendar_events: None,
            outbox: vec![PlanningOutboxDraft {
                entry_id: "outbox-create-plan-1".to_owned(),
                kind: PlanningOutboxKind::PlanChanged,
                aggregate_id: "plan-1".to_owned(),
                payload: serde_json::json!({"planId": "plan-1", "version": 1}),
                created_at_ms: 1_000,
            }],
        };
        let first = store.upsert_plan(&params).expect("persist draft");
        assert_eq!(first.plan.plan_type, None);
        assert_eq!(first.plan.current_estimate, None);
        assert_eq!(first.plan.scheduling_window, None);
        assert_eq!(store.upsert_plan(&params).expect("replay"), first);
        let recovered = store
            .get_operation_result(&PlanningOperationGetParams {
                operation_id: "create-plan-1".to_owned(),
            })
            .expect("recover committed operation");
        assert_eq!(recovered.method.as_deref(), Some("planning.upsert"));
        assert_eq!(recovered.plan, Some(first.plan.clone()));
        assert!(recovered.result.is_some());
        drop(store);

        let reopened = PlanningStore::open(directory.path().join("planning.sqlite3"))
            .expect("reopen planning store");
        assert_eq!(
            reopened
                .get_plan(&PlanningGetParams {
                    plan_id: "plan-1".to_owned()
                })
                .expect("read persisted plan")
                .plan,
            Some(first.plan)
        );
        assert_eq!(
            reopened
                .list_outbox(&PlanningOutboxListParams {
                    status: Some(PlanningOutboxStatus::Pending),
                    limit: 10,
                })
                .expect("list durable outbox")
                .entries
                .len(),
            1
        );
    }

    #[test]
    fn persists_ready_proposal_without_committing_type_or_effective_start_date() {
        let (_directory, store) = test_store();
        create_draft(&store);
        let proposal = proposal_plan_before_confirmation();
        let result = store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "save-proposal-before-confirmation".to_owned(),
                expected_version: 1,
                plan: proposal.clone(),
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect("proposal must persist before confirmation date is computed");
        assert_eq!(result.plan, proposal);
        assert_eq!(result.plan.status, PlanStatus::AwaitingConfirmation);
        assert_eq!(result.plan.analysis_state, PlanAnalysisState::Ready);
        assert_eq!(result.plan.plan_type, None);
        assert_eq!(result.plan.effective_start_date, None);
        assert_eq!(result.plan.scheduling_window, None);
        assert_eq!(result.plan.current_estimate, None);
    }

    #[test]
    fn persists_active_staged_reanalysis_without_discarding_committed_baseline() {
        let (_directory, store) = test_store();
        create_draft(&store);
        let mut active = ready_plan();
        active.status = PlanStatus::Active;
        active.active_revision_id = active.proposed_revision_id.take();
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "activate-plan-1".to_owned(),
                expected_version: 1,
                plan: active.clone(),
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect("activate plan");

        active.version = 3;
        active.analysis_state = PlanAnalysisState::AwaitingAnalysis;
        active.analysis_diagnostic = Some("pending-task-reestimate".to_owned());
        active.updated_at_ms = 3_000;
        active.revisions.push(PlanRevision {
            revision_id: "revision-3".to_owned(),
            plan_version: 3,
            created_at_ms: 3_000,
            reason: "任务状态变化后等待动态重估".to_owned(),
            estimate: active.current_estimate.clone(),
            payload: serde_json::json!({"trigger": "task-status"}),
        });
        let result = store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "stage-active-reestimate".to_owned(),
                expected_version: 2,
                plan: active,
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect("active plan must persist staged analysis before model result");
        assert_eq!(result.plan.status, PlanStatus::Active);
        assert_eq!(
            result.plan.analysis_state,
            PlanAnalysisState::AwaitingAnalysis
        );
        assert!(result.plan.plan_type.is_some());
        assert!(result.plan.effective_start_date.is_some());
        assert!(result.plan.scheduling_window.is_some());
        assert!(result.plan.current_estimate.is_some());
    }

    #[test]
    fn rejects_operation_id_reuse_with_changed_payload() {
        let (_directory, store) = test_store();
        create_draft(&store);
        let mut changed = draft_plan();
        changed.goal = Some("不同目标".to_owned());
        let error = store
            .upsert_plan(&PlanningUpsertParams {
                operation_id: "create-plan-1".to_owned(),
                expected_version: None,
                plan: changed,
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect_err("changed idempotent operation must fail");
        assert!(matches!(
            error,
            PlanningStoreError::IdempotencyConflict { .. }
        ));
    }

    #[test]
    fn atomically_mutates_plan_calendar_history_and_outbox() {
        let (_directory, store) = test_store();
        create_draft(&store);
        let result = store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "analyse-plan-1".to_owned(),
                expected_version: 1,
                plan: ready_plan(),
                calendar_events: Some(vec![plan_event(1)]),
                outbox: vec![
                    PlanningOutboxDraft {
                        entry_id: "outbox-plan-2".to_owned(),
                        kind: PlanningOutboxKind::PlanChanged,
                        aggregate_id: "plan-1".to_owned(),
                        payload: serde_json::json!({"planId": "plan-1", "version": 2}),
                        created_at_ms: 2_000,
                    },
                    PlanningOutboxDraft {
                        entry_id: "outbox-calendar-2".to_owned(),
                        kind: PlanningOutboxKind::CalendarChanged,
                        aggregate_id: "plan-1".to_owned(),
                        payload: serde_json::json!({
                            "changeSetId": "change-set-plan-2",
                            "planId": "plan-1"
                        }),
                        created_at_ms: 2_000,
                    },
                ],
            })
            .expect("analyse and schedule atomically");
        assert_eq!(result.plan.version, 2);
        assert_eq!(result.calendar_events, vec![plan_event(1)]);
        assert_eq!(result.outbox.len(), 2);

        let connection = connect(store.database_path()).expect("inspect history");
        let versions = connection
            .query_row("SELECT COUNT(*) FROM plan_history", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count history");
        assert_eq!(versions, 2);
    }

    #[test]
    fn stale_plan_version_rolls_back_calendar_replacement_and_outbox() {
        let (_directory, store) = test_store();
        create_draft(&store);
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "analyse-plan-1".to_owned(),
                expected_version: 1,
                plan: ready_plan(),
                calendar_events: Some(vec![plan_event(1)]),
                outbox: Vec::new(),
            })
            .expect("seed ready plan");
        let mut stale_plan = ready_plan();
        stale_plan.updated_at_ms = 3_000;
        let mut replacement = plan_event(2);
        if let CalendarSchedule::Timed(schedule) = &mut replacement.schedule {
            schedule.start = "2026-08-15T09:00:00+08:00".to_owned();
            schedule.end = "2026-08-15T10:00:00+08:00".to_owned();
        }
        let error = store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "stale-adjustment".to_owned(),
                expected_version: 1,
                plan: stale_plan,
                calendar_events: Some(vec![replacement]),
                outbox: vec![PlanningOutboxDraft {
                    entry_id: "must-not-commit".to_owned(),
                    kind: PlanningOutboxKind::CalendarChanged,
                    aggregate_id: "plan-1".to_owned(),
                    payload: serde_json::json!({
                        "changeSetId": "change-set-stale",
                        "planId": "plan-1"
                    }),
                    created_at_ms: 3_000,
                }],
            })
            .expect_err("stale mutation must fail");
        assert!(matches!(error, PlanningStoreError::StaleVersion { .. }));
        assert_eq!(
            store
                .get_calendar_event(&CalendarGetParams {
                    event_id: "event-1".to_owned()
                })
                .expect("read unchanged calendar")
                .event,
            Some(plan_event(1))
        );
        assert!(
            store
                .list_outbox(&PlanningOutboxListParams::default())
                .expect("read outbox")
                .entries
                .iter()
                .all(|entry| entry.entry_id != "must-not-commit")
        );
    }

    #[test]
    fn calendar_batch_is_atomic_and_date_filter_is_explicit() {
        let (_directory, store) = test_store();
        create_draft(&store);
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "analyse-plan-1".to_owned(),
                expected_version: 1,
                plan: ready_plan(),
                calendar_events: Some(vec![plan_event(1)]),
                outbox: Vec::new(),
            })
            .expect("seed event");

        let mut moved = plan_event(2);
        moved.user_locked = true;
        if let CalendarSchedule::Timed(schedule) = &mut moved.schedule {
            schedule.start = "2026-08-15T09:00:00+08:00".to_owned();
            schedule.end = "2026-08-15T10:00:00+08:00".to_owned();
        }
        let error = store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "atomic-calendar-failure".to_owned(),
                actor: CalendarMutationActor::User,
                mutations: vec![
                    CalendarMutation::Upsert {
                        expected_version: Some(1),
                        event: Box::new(moved),
                    },
                    CalendarMutation::Delete {
                        event_id: "missing-event".to_owned(),
                        expected_version: 1,
                    },
                ],
                outbox: Vec::new(),
            })
            .expect_err("second mutation failure rolls back first");
        assert!(matches!(error, PlanningStoreError::NotFound { .. }));
        assert_eq!(
            store
                .get_calendar_event(&CalendarGetParams {
                    event_id: "event-1".to_owned()
                })
                .expect("read rollback")
                .event,
            Some(plan_event(1))
        );
        assert_eq!(
            store
                .list_calendar(&CalendarListParams {
                    source_plan_id: Some("plan-1".to_owned()),
                    source_task_id: None,
                    from_date: Some("2026-08-14".to_owned()),
                    to_date_exclusive: Some("2026-08-15".to_owned()),
                })
                .expect("filter calendar")
                .events,
            vec![plan_event(1)]
        );

        let mut ends_at_midnight = plan_event(1);
        if let CalendarSchedule::Timed(schedule) = &mut ends_at_midnight.schedule {
            schedule.start = "2026-08-13T23:00:00+08:00".to_owned();
            schedule.end = "2026-08-14T00:00:00+08:00".to_owned();
        }
        assert!(calendar_event_overlaps_dates(
            &ends_at_midnight,
            (
                NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(),
            )
        ));
        assert!(!calendar_event_overlaps_dates(
            &ends_at_midnight,
            (
                NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 15).unwrap(),
            )
        ));
    }

    #[test]
    fn calendar_actor_allows_auto_move_for_pending_task_and_exact_user_unlock_only() {
        let (_directory, store) = test_store();
        persist_active_plan(&store, active_plan_for_calendar_actor(), None);

        let created = committed_plan_event(1);
        store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "runtime-create-event".to_owned(),
                actor: CalendarMutationActor::PlanningRuntime,
                mutations: vec![CalendarMutation::Upsert {
                    expected_version: None,
                    event: Box::new(created.clone()),
                }],
                outbox: Vec::new(),
            })
            .expect("PlanningRuntime creates a committed model event for a pending task");
        let moved = moved_plan_event(created, 2, "2026-08-15");
        store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "runtime-move-event".to_owned(),
                actor: CalendarMutationActor::PlanningRuntime,
                mutations: vec![CalendarMutation::Upsert {
                    expected_version: Some(1),
                    event: Box::new(moved.clone()),
                }],
                outbox: Vec::new(),
            })
            .expect("PlanningRuntime moves its unlocked event");

        let unlocked_user_edit = moved_plan_event(moved.clone(), 3, "2026-08-16");
        let default_user_params: CalendarMutateParams = serde_json::from_value(serde_json::json!({
            "operationId": "default-user-unlocked-edit",
            "mutations": [{
                "action": "upsert",
                "expectedVersion": 2,
                "event": unlocked_user_edit
            }],
            "outbox": []
        }))
        .expect("deserialize actor-less calendar request");
        assert_eq!(default_user_params.actor, CalendarMutationActor::User);
        assert!(
            store.mutate_calendar(&default_user_params).is_err(),
            "default user actor cannot update an unlocked plan event"
        );

        let mut locked = moved_plan_event(moved, 3, "2026-08-16");
        locked.user_locked = true;
        store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "user-lock-and-move-event".to_owned(),
                actor: CalendarMutationActor::User,
                mutations: vec![CalendarMutation::Upsert {
                    expected_version: Some(2),
                    event: Box::new(locked.clone()),
                }],
                outbox: Vec::new(),
            })
            .expect("interactive edit locks the model event");
        let runtime_locked_move = moved_plan_event(locked.clone(), 4, "2026-08-17");
        assert!(
            store
                .mutate_calendar(&CalendarMutateParams {
                    operation_id: "runtime-cannot-move-locked-event".to_owned(),
                    actor: CalendarMutationActor::PlanningRuntime,
                    mutations: vec![CalendarMutation::Upsert {
                        expected_version: Some(3),
                        event: Box::new(runtime_locked_move),
                    }],
                    outbox: Vec::new(),
                })
                .is_err(),
            "PlanningRuntime cannot move a user-locked event"
        );

        let mut unlocked = locked;
        unlocked.user_locked = false;
        unlocked.version = 4;
        store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "user-exact-unlock-event".to_owned(),
                actor: CalendarMutationActor::User,
                mutations: vec![CalendarMutation::Upsert {
                    expected_version: Some(3),
                    event: Box::new(unlocked.clone()),
                }],
                outbox: Vec::new(),
            })
            .expect("user may change only the lock bit and version to unlock");
        assert_eq!(
            store
                .get_calendar_event(&CalendarGetParams {
                    event_id: unlocked.event_id.clone(),
                })
                .expect("read unlocked event")
                .event,
            Some(unlocked)
        );
    }

    #[test]
    fn planning_runtime_rejects_user_origin_and_ownership_transfer() {
        let (_directory, store) = test_store();
        let mut active = active_plan_for_calendar_actor();
        let mut second_task = active.tasks[0].clone();
        second_task.task_id = "task-2".to_owned();
        active.tasks.push(second_task);
        let mut user_origin = committed_plan_event(1);
        user_origin.schedule_origin = Some(CalendarScheduleOrigin::User);
        persist_active_plan(&store, active, Some(vec![user_origin.clone()]));

        let moved_user_origin = moved_plan_event(user_origin, 2, "2026-08-15");
        assert!(
            store
                .mutate_calendar(&CalendarMutateParams {
                    operation_id: "runtime-cannot-move-user-origin".to_owned(),
                    actor: CalendarMutationActor::PlanningRuntime,
                    mutations: vec![CalendarMutation::Upsert {
                        expected_version: Some(1),
                        event: Box::new(moved_user_origin),
                    }],
                    outbox: Vec::new(),
                })
                .is_err(),
            "PlanningRuntime cannot update a user-origin event"
        );

        let mut owned = committed_plan_event(1);
        owned.event_id = "owned-event".to_owned();
        store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "runtime-create-owned-event".to_owned(),
                actor: CalendarMutationActor::PlanningRuntime,
                mutations: vec![CalendarMutation::Upsert {
                    expected_version: None,
                    event: Box::new(owned.clone()),
                }],
                outbox: Vec::new(),
            })
            .expect("create model-owned event");
        let mut transferred = moved_plan_event(owned, 2, "2026-08-15");
        transferred.source_task_id = Some("task-2".to_owned());
        assert!(
            store
                .mutate_calendar(&CalendarMutateParams {
                    operation_id: "runtime-cannot-transfer-ownership".to_owned(),
                    actor: CalendarMutationActor::PlanningRuntime,
                    mutations: vec![CalendarMutation::Upsert {
                        expected_version: Some(1),
                        event: Box::new(transferred),
                    }],
                    outbox: Vec::new(),
                })
                .is_err(),
            "calendar ownership is immutable across updates"
        );
    }

    #[test]
    fn planning_runtime_cannot_create_or_move_terminal_task_but_may_delete() {
        let (_directory, store) = test_store();
        let mut active = active_plan_for_calendar_actor();
        active.tasks[0].status = PlanTaskStatus::Completed;
        let existing = committed_plan_event(1);
        persist_active_plan(&store, active, Some(vec![existing.clone()]));

        let mut new_terminal = committed_plan_event(1);
        new_terminal.event_id = "terminal-new-event".to_owned();
        assert!(
            store
                .mutate_calendar(&CalendarMutateParams {
                    operation_id: "runtime-terminal-create".to_owned(),
                    actor: CalendarMutationActor::PlanningRuntime,
                    mutations: vec![CalendarMutation::Upsert {
                        expected_version: None,
                        event: Box::new(new_terminal),
                    }],
                    outbox: Vec::new(),
                })
                .is_err(),
            "terminal task cannot receive a new calendar placement"
        );
        let moved_terminal = moved_plan_event(existing.clone(), 2, "2026-08-15");
        assert!(
            store
                .mutate_calendar(&CalendarMutateParams {
                    operation_id: "runtime-terminal-move".to_owned(),
                    actor: CalendarMutationActor::PlanningRuntime,
                    mutations: vec![CalendarMutation::Upsert {
                        expected_version: Some(1),
                        event: Box::new(moved_terminal),
                    }],
                    outbox: Vec::new(),
                })
                .is_err(),
            "terminal task placement cannot be moved"
        );
        store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "runtime-terminal-delete".to_owned(),
                actor: CalendarMutationActor::PlanningRuntime,
                mutations: vec![CalendarMutation::Delete {
                    event_id: existing.event_id,
                    expected_version: 1,
                }],
                outbox: Vec::new(),
            })
            .expect("terminal task event may be removed from the future calendar");
    }

    #[test]
    fn plan_replacement_cannot_move_user_locked_calendar_event() {
        let (_directory, store) = test_store();
        create_draft(&store);
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "analyse-plan-1".to_owned(),
                expected_version: 1,
                plan: ready_plan(),
                calendar_events: Some(vec![plan_event(1)]),
                outbox: Vec::new(),
            })
            .expect("seed model event");

        let mut locked = plan_event(2);
        locked.user_locked = true;
        store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "user-lock-event-1".to_owned(),
                actor: CalendarMutationActor::User,
                mutations: vec![CalendarMutation::Upsert {
                    expected_version: Some(1),
                    event: Box::new(locked.clone()),
                }],
                outbox: Vec::new(),
            })
            .expect("user edit locks event");

        let mut adjusted = ready_plan();
        adjusted.version = 3;
        adjusted.updated_at_ms = 3_000;
        adjusted.revisions.push(PlanRevision {
            revision_id: "revision-3".to_owned(),
            plan_version: 3,
            created_at_ms: 3_000,
            reason: "尝试自动移动".to_owned(),
            estimate: adjusted.current_estimate.clone(),
            payload: serde_json::json!({"trigger": "calendar-change"}),
        });
        let mut moved = locked.clone();
        moved.version = 3;
        if let CalendarSchedule::Timed(schedule) = &mut moved.schedule {
            schedule.start = "2026-08-15T09:00:00+08:00".to_owned();
            schedule.end = "2026-08-15T10:00:00+08:00".to_owned();
        }
        let error = store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "forbidden-auto-move".to_owned(),
                expected_version: 2,
                plan: adjusted,
                calendar_events: Some(vec![moved]),
                outbox: Vec::new(),
            })
            .expect_err("planning replacement must preserve user lock");
        assert!(matches!(error, PlanningStoreError::Configuration(_)));
        assert_eq!(
            store
                .get_calendar_event(&CalendarGetParams {
                    event_id: "event-1".to_owned(),
                })
                .expect("read protected event")
                .event,
            Some(locked)
        );
        assert_eq!(
            store
                .get_plan(&PlanningGetParams {
                    plan_id: "plan-1".to_owned(),
                })
                .expect("read rolled back plan")
                .plan
                .expect("plan remains")
                .version,
            2
        );
    }

    #[test]
    fn calendar_mutation_validates_plan_task_ownership_and_read_only_events() {
        let (_directory, store) = test_store();
        create_draft(&store);
        let ownership_error = store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "missing-task-ownership".to_owned(),
                actor: CalendarMutationActor::User,
                mutations: vec![CalendarMutation::Upsert {
                    expected_version: None,
                    event: Box::new(plan_event(1)),
                }],
                outbox: Vec::new(),
            })
            .expect_err("calendar plan event requires a durable source task");
        assert!(matches!(
            ownership_error,
            PlanningStoreError::NotFound { .. }
        ));

        let external = PlanningCalendarEvent {
            event_id: "external-1".to_owned(),
            title: "外部只读日程".to_owned(),
            redacted_content: false,
            kind: CalendarEventKind::External,
            state: CalendarEventState::Committed,
            source_plan_id: None,
            source_task_id: None,
            schedule_origin: None,
            user_locked: false,
            editable: false,
            ..plan_event(1)
        };
        store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "import-external-event".to_owned(),
                actor: CalendarMutationActor::User,
                mutations: vec![CalendarMutation::Upsert {
                    expected_version: None,
                    event: Box::new(external.clone()),
                }],
                outbox: Vec::new(),
            })
            .expect("persist initial external projection");
        let read_only_error = store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "delete-external-event".to_owned(),
                actor: CalendarMutationActor::User,
                mutations: vec![CalendarMutation::Delete {
                    event_id: "external-1".to_owned(),
                    expected_version: 1,
                }],
                outbox: Vec::new(),
            })
            .expect_err("external event mutation must be rejected");
        assert!(matches!(
            read_only_error,
            PlanningStoreError::Configuration(_)
        ));
        assert_eq!(
            store
                .get_calendar_event(&CalendarGetParams {
                    event_id: "external-1".to_owned(),
                })
                .expect("read external event")
                .event,
            Some(external)
        );
    }

    #[test]
    fn model_calendar_events_persist_only_placeholder_content() {
        let (_directory, store) = test_store();
        create_draft(&store);
        let mut unsafe_event = plan_event(1);
        unsafe_event.title = "真实的敏感任务标题".to_owned();
        unsafe_event.redacted_content = false;
        let error = store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "unsafe-model-calendar-title".to_owned(),
                expected_version: 1,
                plan: ready_plan(),
                calendar_events: Some(vec![unsafe_event]),
                outbox: Vec::new(),
            })
            .expect_err("model calendar title must be sealed or redacted");
        assert!(matches!(error, PlanningStoreError::Configuration(_)));

        let safe = plan_event(1);
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "safe-model-calendar-title".to_owned(),
                expected_version: 1,
                plan: ready_plan(),
                calendar_events: Some(vec![safe.clone()]),
                outbox: Vec::new(),
            })
            .expect("redacted model calendar title is accepted");
        let connection = connect(store.database_path()).expect("inspect stored calendar JSON");
        let stored = connection
            .query_row(
                "SELECT event_json FROM calendar_events WHERE event_id = 'event-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("read stored event JSON");
        assert!(stored.contains(REDACTED_PLAN_CALENDAR_TITLE));
        assert!(!stored.contains("真实的敏感任务标题"));
        assert_eq!(
            serde_json::from_str::<PlanningCalendarEvent>(&stored)
                .expect("parse stored event")
                .title,
            REDACTED_PLAN_CALENDAR_TITLE
        );
    }

    #[test]
    fn immutable_revision_history_and_sensitive_outbox_fields_are_rejected() {
        let (_directory, store) = test_store();
        create_draft(&store);
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "analyse-plan-1".to_owned(),
                expected_version: 1,
                plan: ready_plan(),
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect("seed revision");
        let mut changed = ready_plan();
        changed.version = 3;
        changed.updated_at_ms = 3_000;
        changed.revisions[0].reason = "篡改历史".to_owned();
        let error = store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "rewrite-history".to_owned(),
                expected_version: 2,
                plan: changed,
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect_err("revision must be immutable");
        assert!(matches!(error, PlanningStoreError::ImmutableHistory(_)));

        let error = store
            .mutate_calendar(&CalendarMutateParams {
                operation_id: "leaky-outbox".to_owned(),
                actor: CalendarMutationActor::User,
                mutations: vec![CalendarMutation::Upsert {
                    expected_version: None,
                    event: Box::new(PlanningCalendarEvent {
                        event_id: "manual-1".to_owned(),
                        title: "私人日程".to_owned(),
                        kind: CalendarEventKind::ManualBlock,
                        source_plan_id: None,
                        source_task_id: None,
                        schedule_origin: None,
                        ..plan_event(1)
                    }),
                }],
                outbox: vec![PlanningOutboxDraft {
                    entry_id: "leaky-entry".to_owned(),
                    kind: PlanningOutboxKind::Notification,
                    aggregate_id: "manual-1".to_owned(),
                    payload: serde_json::json!({"title": "私人日程"}),
                    created_at_ms: 3_000,
                }],
            })
            .expect_err("content must not enter outbox");
        assert!(matches!(error, PlanningStoreError::Configuration(_)));
    }

    #[test]
    fn outbox_payloads_use_kind_specific_content_free_allowlists() {
        let valid = vec![
            PlanningOutboxDraft {
                entry_id: "allow-plan".to_owned(),
                kind: PlanningOutboxKind::PlanChanged,
                aggregate_id: "plan-1".to_owned(),
                payload: serde_json::json!({"planId": "plan-1", "version": 2}),
                created_at_ms: 2_000,
            },
            PlanningOutboxDraft {
                entry_id: "allow-change-set".to_owned(),
                kind: PlanningOutboxKind::CalendarChanged,
                aggregate_id: "plan-1".to_owned(),
                payload: serde_json::json!({
                    "changeSetId": "change-set-1",
                    "planId": "plan-1"
                }),
                created_at_ms: 2_000,
            },
            PlanningOutboxDraft {
                entry_id: "allow-user-batch".to_owned(),
                kind: PlanningOutboxKind::CalendarChanged,
                aggregate_id: "calendar".to_owned(),
                payload: serde_json::json!({
                    "batchId": "batch-1",
                    "mutationCount": 2,
                    "planIds": ["plan-1"],
                    "requiresPlanningReestimate": true
                }),
                created_at_ms: 2_000,
            },
            PlanningOutboxDraft {
                entry_id: "allow-notification".to_owned(),
                kind: PlanningOutboxKind::Notification,
                aggregate_id: "plan-1".to_owned(),
                payload: serde_json::json!({
                    "code": "adjustment-applied",
                    "planId": "plan-1",
                    "version": 2,
                    "moved": 1,
                    "etaChanged": true
                }),
                created_at_ms: 2_000,
            },
        ];
        validate_outbox_drafts(&valid).expect("accept only reviewed content-free shapes");

        let mut unknown = valid[0].clone();
        unknown.entry_id = "reject-unknown".to_owned();
        unknown.payload = serde_json::json!({
            "planId": "plan-1",
            "version": 2,
            "summary": "would have bypassed a content-field denylist"
        });
        assert!(validate_outbox_drafts(&[unknown]).is_err());
    }

    #[test]
    fn replacing_one_plan_calendar_projection_does_not_touch_another_plan() {
        let (_directory, store) = test_store();
        create_draft(&store);
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "analyse-plan-1".to_owned(),
                expected_version: 1,
                plan: ready_plan(),
                calendar_events: Some(vec![plan_event(1)]),
                outbox: Vec::new(),
            })
            .expect("seed first plan");

        let mut second_draft = draft_plan();
        second_draft.plan_id = "plan-2".to_owned();
        store
            .upsert_plan(&PlanningUpsertParams {
                operation_id: "create-plan-2".to_owned(),
                expected_version: None,
                plan: second_draft,
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect("create second plan");
        let mut second_ready = ready_plan();
        second_ready.plan_id = "plan-2".to_owned();
        let mut second_event = plan_event(1);
        second_event.event_id = "event-2".to_owned();
        second_event.source_plan_id = Some("plan-2".to_owned());
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "analyse-plan-2".to_owned(),
                expected_version: 1,
                plan: second_ready,
                calendar_events: Some(vec![second_event.clone()]),
                outbox: Vec::new(),
            })
            .expect("seed second plan");

        let mut third = ready_plan();
        third.version = 3;
        third.updated_at_ms = 3_000;
        third.revisions.push(PlanRevision {
            revision_id: "revision-3".to_owned(),
            plan_version: 3,
            created_at_ms: 3_000,
            reason: "清空第一份计划的未来投影".to_owned(),
            estimate: third.current_estimate.clone(),
            payload: serde_json::json!({"eventCount": 0}),
        });
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "replace-plan-1-calendar".to_owned(),
                expected_version: 2,
                plan: third,
                calendar_events: Some(Vec::new()),
                outbox: Vec::new(),
            })
            .expect("replace first plan projection");

        assert_eq!(
            store
                .list_calendar(&CalendarListParams {
                    source_plan_id: Some("plan-1".to_owned()),
                    ..CalendarListParams::default()
                })
                .expect("read first projection")
                .events,
            Vec::new()
        );
        assert_eq!(
            store
                .list_calendar(&CalendarListParams {
                    source_plan_id: Some("plan-2".to_owned()),
                    ..CalendarListParams::default()
                })
                .expect("read second projection")
                .events,
            vec![second_event]
        );
    }

    #[test]
    fn supports_future_sealed_content_envelope_without_plaintext_goal() {
        let (_directory, store) = test_store();
        let mut sealed = draft_plan();
        sealed.plan_id = "plan-sealed".to_owned();
        sealed.goal = None;
        sealed.conversation.clear();
        sealed.sealed_content_ref = Some("planning/plan-sealed/v1".to_owned());
        let result = store
            .upsert_plan(&PlanningUpsertParams {
                operation_id: "create-sealed-plan".to_owned(),
                expected_version: None,
                plan: sealed,
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect("persist sealed envelope projection");
        assert!(result.plan.goal.is_none());
        assert_eq!(
            result.plan.sealed_content_ref.as_deref(),
            Some("planning/plan-sealed/v1")
        );
    }

    #[test]
    fn vault_reference_inventory_pages_current_history_and_operation_without_content() {
        let (_directory, store) = test_store();
        let mut first = draft_plan();
        first.plan_id = "plan-sealed-inventory".to_owned();
        first.goal = None;
        first.conversation.clear();
        first.sealed_content_ref = Some("vault-content-ref-v1".to_owned());
        first.runtime_payload = serde_json::json!({
            "schemaVersion": "planning.runtime.reference.v1",
            "manifestRecordId": "manifest-record-v1"
        });
        store
            .upsert_plan(&PlanningUpsertParams {
                operation_id: "inventory-create-v1".to_owned(),
                expected_version: None,
                plan: first.clone(),
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect("persist first sealed reference");

        let mut second = first;
        second.version = 2;
        second.updated_at_ms = 2_000;
        second.sealed_content_ref = Some("vault-content-ref-v2".to_owned());
        second.runtime_payload = serde_json::json!({
            "schemaVersion": "planning.runtime.reference.v1",
            "manifestRecordId": "manifest-record-v2"
        });
        store
            .mutate_plan(&PlanningMutateParams {
                operation_id: "inventory-update-v2".to_owned(),
                expected_version: 1,
                plan: second,
                calendar_events: None,
                outbox: Vec::new(),
            })
            .expect("persist second sealed reference");

        let mut cursor = None;
        let mut references = Vec::new();
        loop {
            let page = store
                .list_vault_references(&PlanningVaultReferencesParams { cursor, limit: 1 })
                .expect("page every authoritative planning reference");
            references.extend(page.references);
            let Some(next) = page.next_cursor else {
                break;
            };
            cursor = Some(next);
        }
        assert_eq!(references.len(), 5);
        assert_eq!(
            references
                .iter()
                .filter(|reference| { reference.source == PlanningVaultReferenceSource::Current })
                .count(),
            1
        );
        assert_eq!(
            references
                .iter()
                .filter(|reference| { reference.source == PlanningVaultReferenceSource::History })
                .count(),
            2
        );
        assert_eq!(
            references
                .iter()
                .filter(|reference| { reference.source == PlanningVaultReferenceSource::Operation })
                .count(),
            2
        );
        assert!(references.iter().all(|reference| {
            reference.plan_id == "plan-sealed-inventory"
                && reference.manifest_record_id.is_some()
                && reference
                    .sealed_content_ref
                    .starts_with("vault-content-ref-v")
        }));
        let encoded = serde_json::to_string(&references).expect("encode safe reference inventory");
        assert!(!encoded.contains("runtimePayload"));
        assert!(!encoded.contains("conversation"));
        assert!(
            store
                .list_vault_references(&PlanningVaultReferencesParams {
                    cursor: Some("pvr1_9_0000000000000000_00".to_owned()),
                    limit: 1,
                })
                .is_err(),
            "unknown cursor source must fail closed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn hardens_planning_directory_database_and_sidecars_to_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("create permission test root");
        let data = root.path().join("planning-data");
        fs::create_dir(&data).expect("create permissive data directory");
        fs::set_permissions(&data, fs::Permissions::from_mode(0o755))
            .expect("set permissive fixture mode");
        let path = data.join("planning.sqlite3");
        let store = PlanningStore::open(&path).expect("open hardened store");
        store
            .list_plans(&PlanningListParams::default())
            .expect("exercise WAL connection");

        assert_eq!(
            fs::metadata(&data)
                .expect("read directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path)
                .expect("read database metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
            if sidecar.exists() {
                assert_eq!(
                    fs::metadata(sidecar)
                        .expect("read sidecar metadata")
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        }
    }

    #[test]
    fn partial_v0_schema_is_completed_transactionally_and_newer_schema_is_rejected() {
        let partial_directory = tempfile::tempdir().expect("create partial schema directory");
        let partial_path = partial_directory.path().join("planning.sqlite3");
        let partial = Connection::open(&partial_path).expect("open partial database");
        partial
            .execute_batch(
                "CREATE TABLE plans (
                    plan_id TEXT PRIMARY KEY,
                    schema_version TEXT NOT NULL,
                    version INTEGER NOT NULL CHECK (version > 0),
                    status TEXT NOT NULL,
                    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
                    snapshot_json TEXT NOT NULL
                 );
                 PRAGMA user_version = 0;",
            )
            .expect("seed partial schema");
        drop(partial);
        let completed = PlanningStore::open(&partial_path).expect("complete partial schema");
        let connection = connect(completed.database_path()).expect("inspect completed schema");
        for table in [
            "plans",
            "plan_history",
            "calendar_events",
            "planning_outbox",
            "idempotent_operations",
        ] {
            let exists = connection
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
                     )",
                    [table],
                    |row| row.get::<_, bool>(0),
                )
                .expect("query schema table");
            assert!(exists, "{table} must exist after v0 completion");
        }
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("read completed version"),
            SCHEMA_VERSION
        );

        let future_directory = tempfile::tempdir().expect("create future schema directory");
        let future_path = future_directory.path().join("planning.sqlite3");
        let future = Connection::open(&future_path).expect("open future database");
        future
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .expect("mark future schema");
        drop(future);
        let error = match PlanningStore::open(&future_path) {
            Ok(_) => panic!("newer schema must fail closed"),
            Err(error) => error,
        };
        assert!(matches!(error, PlanningStoreError::Configuration(_)));
    }
}
