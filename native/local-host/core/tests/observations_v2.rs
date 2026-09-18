use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::json;
use tempfile::TempDir;
use whalehall_local_core::observations::{
    MemoryObservationKeyProvider, ObservationJournal, ObservationJournalConfig, ObservationKey,
    ObservationKeyError, ObservationKeyProvider, UnavailableObservationKeyProvider,
};
use whalehall_local_protocol::{
    AuditQueryFiveMinutesParams, CoverageLevelV2, EventGoalChangeParams, EvidenceReliabilityV2,
    GoalContext, ObservationIntervalV2, ObservationSensorV2, ObservationSourceV2,
    ObservationSubjectV2, RAW_OBSERVATION_SCHEMA_VERSION, RawObservationInputV2,
    SemanticCommitParams, SemanticContentStateV2, SemanticCountClassV2, SemanticQueryParams,
    VaultDeleteBatchParams, VaultListRecordsParams, VaultOpenBatchParams, VaultSealBatchParams,
    VaultSealRecord, semantic_event_kinds,
};

const SECRET: &str = "绝不能出现在SQLite明文里的浏览器正文";

#[derive(Default)]
struct CountingUnavailableKeyProvider {
    calls: AtomicUsize,
}

impl CountingUnavailableKeyProvider {
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl ObservationKeyProvider for CountingUnavailableKeyProvider {
    fn load_or_create(&self) -> Result<ObservationKey, ObservationKeyError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(ObservationKeyError::Unavailable)
    }
}

fn memory_journal(directory: &TempDir, raw_retention: Duration) -> ObservationJournal {
    memory_journal_with_retentions(
        directory,
        raw_retention,
        Duration::from_secs(30 * 24 * 60 * 60),
    )
}

fn memory_journal_with_retentions(
    directory: &TempDir,
    raw_retention: Duration,
    derived_retention: Duration,
) -> ObservationJournal {
    ObservationJournal::open_with_config(ObservationJournalConfig {
        database_path: directory.path().join("observation-journal.sqlite3"),
        raw_content_retention: raw_retention,
        derived_retention,
        broadcast_capacity: 16,
        key_provider: Arc::new(MemoryObservationKeyProvider::new([0x5a; 32])),
        device_id: None,
        session_id: None,
    })
    .expect("open encrypted observation journal")
}

#[test]
fn schema_v2_upgrade_indexes_encrypted_payload_references() {
    let directory = tempfile::tempdir().expect("create observation schema directory");
    let database_path = directory.path().join("observation-journal.sqlite3");
    drop(memory_journal(&directory, Duration::from_secs(60)));

    let connection = Connection::open(&database_path).expect("open schema v2 fixture");
    connection
        .execute_batch(
            "DROP INDEX IF EXISTS observations_content_ref;
             DROP INDEX IF EXISTS semantic_events_content_ref;
             DROP INDEX IF EXISTS projector_state_content_ref;
             INSERT INTO semantic_consumers (
                consumer_id, committed_sequence, committed_cursor, updated_at_ms
             ) VALUES ('schema-upgrade-consumer', 0, 'sec2_0000000000000000', 1234);
             PRAGMA user_version = 2;",
        )
        .expect("downgrade schema fixture to v2");
    drop(connection);

    drop(memory_journal(&directory, Duration::from_secs(60)));
    let connection = Connection::open(&database_path).expect("inspect upgraded schema");
    let version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .expect("read upgraded schema version");
    assert_eq!(version, 3);
    for index in [
        "observations_content_ref",
        "semantic_events_content_ref",
        "projector_state_content_ref",
    ] {
        let present = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'index' AND name = ?1
                 )",
                [index],
                |row| row.get::<_, bool>(0),
            )
            .expect("query migrated content reference index");
        assert!(present, "missing migrated index {index}");
    }
    let consumer = connection
        .query_row(
            "SELECT committed_sequence, committed_cursor, updated_at_ms
             FROM semantic_consumers WHERE consumer_id = 'schema-upgrade-consumer'",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .expect("read preserved semantic consumer");
    assert_eq!(consumer, (0, "sec2_0000000000000000".to_owned(), 1234));

    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign key query planning");
    let mut statement = connection
        .prepare(
            "EXPLAIN QUERY PLAN
             DELETE FROM encrypted_payloads WHERE content_ref = 'ct2_missing'",
        )
        .expect("prepare encrypted payload delete plan");
    let plan = statement
        .query_map([], |row| row.get::<_, String>(3))
        .expect("query encrypted payload delete plan")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect encrypted payload delete plan")
        .join("\n");
    for table in [
        "observations",
        "semantic_events",
        "projector_state",
        "vault_records",
    ] {
        assert!(
            !plan.contains(&format!("SCAN {table}")),
            "encrypted payload delete still scans {table}: {plan}"
        );
    }
}

fn browser_observation(at_ms: i64, title: &str) -> RawObservationInputV2 {
    RawObservationInputV2 {
        schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
        kind: "browser.visiblePageChanged".to_owned(),
        interval: ObservationIntervalV2 {
            started_at_ms: at_ms,
            ended_at_ms: at_ms,
        },
        source: ObservationSourceV2 {
            sensor: ObservationSensorV2::AppleEvents,
            adapter_version: "observer-test.v2".to_owned(),
        },
        subject: ObservationSubjectV2 {
            app_id: "com.google.Chrome".to_owned(),
            app_name: "Chrome".to_owned(),
            opaque_window_id: Some("window-opaque-1".to_owned()),
        },
        reliability: EvidenceReliabilityV2::High,
        coverage: vec![CoverageLevelV2::Metadata, CoverageLevelV2::Content],
        redactions: Vec::new(),
        metadata: json!({}),
        content: Some(json!({
            "title": title,
            "url": "https://example.com/issues/123?token=should-be-sanitized",
            "visibleText": title,
        })),
    }
}

fn ax_text_observation(
    at_ms: i64,
    kind: &str,
    opaque_control_id: &str,
    final_value: Option<&str>,
    final_value_available: bool,
) -> RawObservationInputV2 {
    let coverage = if final_value.is_some() {
        vec![CoverageLevelV2::Content]
    } else if final_value_available {
        vec![CoverageLevelV2::Metadata]
    } else {
        vec![CoverageLevelV2::Unavailable]
    };
    let redactions = if final_value_available {
        Vec::new()
    } else {
        vec!["final_value_unavailable".to_owned()]
    };
    let content = final_value.map(|final_value| {
        if kind == "ax.valueChanged" {
            json!({
                "finalValue": final_value,
                "inputOrigin": "unknown",
            })
        } else {
            json!({"finalValue": final_value})
        }
    });
    RawObservationInputV2 {
        schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
        kind: kind.to_owned(),
        interval: ObservationIntervalV2 {
            started_at_ms: at_ms,
            ended_at_ms: at_ms,
        },
        source: ObservationSourceV2 {
            sensor: ObservationSensorV2::Ax,
            adapter_version: "observer-test.v2".to_owned(),
        },
        subject: ObservationSubjectV2 {
            app_id: "com.example.Editor".to_owned(),
            app_name: "Editor".to_owned(),
            opaque_window_id: Some("window-opaque-editor".to_owned()),
        },
        reliability: EvidenceReliabilityV2::High,
        coverage,
        redactions,
        metadata: json!({
            "processId": 42,
            "protectedInput": false,
            "focusedRole": "AXTextArea",
            "opaqueControlId": opaque_control_id,
            "finalValueAvailable": final_value_available,
        }),
        content,
    }
}

fn query_all(
    journal: &ObservationJournal,
    include_content: bool,
) -> Vec<whalehall_local_protocol::SemanticEventV2> {
    journal
        .query_semantic(&SemanticQueryParams {
            after_cursor: None,
            consumer_id: None,
            limit: 100,
            include_content,
        })
        .expect("query semantic events")
        .events
}

fn assert_file_does_not_contain(path: &Path, needle: &[u8]) {
    if let Ok(bytes) = fs::read(path) {
        assert!(
            !bytes.windows(needle.len()).any(|window| window == needle),
            "{} contains sensitive plaintext",
            path.display()
        );
    }
}

fn sqlite_paths(database_path: &Path) -> [PathBuf; 3] {
    [
        database_path.to_owned(),
        PathBuf::from(format!("{}-wal", database_path.display())),
        PathBuf::from(format!("{}-shm", database_path.display())),
    ]
}

#[test]
fn encrypted_content_round_trips_without_plaintext_in_sqlite_or_sidecars() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));
    let appended = journal
        .ingest("browser-frame-1", browser_observation(1_000, SECRET))
        .expect("ingest browser observation");
    assert!(appended.inserted);
    assert_eq!(
        appended.semantic_event.kind,
        semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED
    );
    assert_eq!(
        appended.semantic_event.count_class,
        SemanticCountClassV2::Effective
    );
    assert_eq!(appended.semantic_event.source_observation_ids.len(), 1);

    let without_content = query_all(&journal, false);
    assert_eq!(without_content.len(), 1);
    assert!(without_content[0].payload.get("title").is_none());
    let with_content = query_all(&journal, true);
    assert_eq!(with_content[0].payload["title"], SECRET);
    assert_eq!(with_content[0].payload["visibleText"], SECRET);
    assert_eq!(with_content[0].payload["domain"], "example.com");
    assert!(
        !with_content[0].payload["url"]
            .as_str()
            .unwrap()
            .contains("token=")
    );

    for path in sqlite_paths(journal.database_path()) {
        assert_file_does_not_contain(&path, SECRET.as_bytes());
        assert_file_does_not_contain(&path, b"should-be-sanitized");
        assert_file_does_not_contain(&path, b"example.com");
    }
}

#[test]
fn ax_focus_seeds_per_control_text_baselines_and_first_values_are_not_insertions() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));

    let focus_a = journal
        .ingest(
            "ax-focus-a",
            ax_text_observation(
                1_000,
                "ax.focusChanged",
                "oc1_control_a",
                Some("alpha"),
                true,
            ),
        )
        .expect("seed control A baseline");
    assert_eq!(
        focus_a.semantic_event.payload["opaqueControlId"],
        "oc1_control_a"
    );

    journal
        .ingest(
            "ax-focus-b",
            ax_text_observation(
                1_100,
                "ax.focusChanged",
                "oc1_control_b",
                Some("bravo"),
                true,
            ),
        )
        .expect("seed control B baseline");

    let mut moved_window_value = ax_text_observation(
        1_200,
        "ax.valueChanged",
        "oc1_control_a",
        Some("alpha!"),
        true,
    );
    moved_window_value.subject.opaque_window_id = Some("window-opaque-editor-moved".to_owned());
    let changed_a = journal
        .ingest("ax-value-a", moved_window_value)
        .expect("project control A delta after window identity changes");
    assert_eq!(
        changed_a.semantic_event.payload["opaqueControlId"],
        "oc1_control_a"
    );
    assert_eq!(changed_a.semantic_event.payload["insertedChars"], 1);
    assert_eq!(changed_a.semantic_event.payload["deletedChars"], 0);
    assert_eq!(changed_a.semantic_event.payload["deltaAvailable"], true);

    let changed_b = journal
        .ingest(
            "ax-value-b",
            ax_text_observation(
                1_300,
                "ax.valueChanged",
                "oc1_control_b",
                Some("bravo?"),
                true,
            ),
        )
        .expect("project control B delta");
    assert_eq!(changed_b.semantic_event.payload["insertedChars"], 1);
    assert_eq!(changed_b.semantic_event.payload["deletedChars"], 0);
    assert_eq!(changed_b.semantic_event.payload["deltaAvailable"], true);

    let first_value = journal
        .ingest(
            "ax-value-without-focus",
            ax_text_observation(
                1_400,
                "ax.valueChanged",
                "oc1_control_c",
                Some("already present"),
                true,
            ),
        )
        .expect("establish missing control baseline");
    assert_eq!(first_value.semantic_event.payload["insertedChars"], 0);
    assert_eq!(first_value.semantic_event.payload["deletedChars"], 0);
    assert_eq!(first_value.semantic_event.payload["deltaAvailable"], false);

    let events = query_all(&journal, true);
    let focus_a_event = events
        .iter()
        .find(|event| event.event_id == focus_a.semantic_event.event_id)
        .expect("find decrypted focus baseline event");
    assert!(focus_a_event.payload.get("finalValue").is_none());
    assert!(focus_a_event.payload.get("insertedChars").is_none());
    let changed_a = events
        .iter()
        .find(|event| event.event_id == changed_a.semantic_event.event_id)
        .expect("find decrypted control A event");
    assert_eq!(changed_a.payload["addedText"], "!");
    let first_value = events
        .iter()
        .find(|event| event.event_id == first_value.semantic_event.event_id)
        .expect("find first value event");
    assert!(first_value.payload.get("addedText").is_none());
    assert_eq!(first_value.payload["finalValue"], "already present");
}

#[test]
fn ax_empty_and_unavailable_final_values_preserve_delta_baseline_and_coverage() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));

    journal
        .ingest(
            "ax-empty-focus",
            ax_text_observation(2_000, "ax.focusChanged", "oc1_editor", Some("abc"), true),
        )
        .expect("seed text before deletion");
    let emptied = journal
        .ingest(
            "ax-empty-value",
            ax_text_observation(2_100, "ax.valueChanged", "oc1_editor", Some(""), true),
        )
        .expect("project deletion to an empty final value");
    assert_eq!(emptied.semantic_event.payload["insertedChars"], 0);
    assert_eq!(emptied.semantic_event.payload["deletedChars"], 3);
    assert_eq!(emptied.semantic_event.payload["deltaAvailable"], true);

    let unavailable = journal
        .ingest(
            "ax-unavailable-value",
            ax_text_observation(2_200, "ax.valueChanged", "oc1_editor", None, false),
        )
        .expect("retain unavailable final-value diagnostic");
    assert_eq!(
        unavailable.semantic_event.content_state,
        SemanticContentStateV2::Unavailable
    );
    assert!(
        unavailable
            .semantic_event
            .coverage
            .contains(&CoverageLevelV2::Unavailable)
    );
    assert_eq!(unavailable.semantic_event.payload["insertedChars"], 0);
    assert_eq!(unavailable.semantic_event.payload["deletedChars"], 0);
    assert_eq!(unavailable.semantic_event.payload["deltaAvailable"], false);

    let resumed = journal
        .ingest(
            "ax-value-after-unavailable",
            ax_text_observation(2_300, "ax.valueChanged", "oc1_editor", Some("x"), true),
        )
        .expect("resume from the last available empty baseline");
    assert_eq!(resumed.semantic_event.payload["insertedChars"], 1);
    assert_eq!(resumed.semantic_event.payload["deletedChars"], 0);
    assert_eq!(resumed.semantic_event.payload["deltaAvailable"], true);

    let metadata_only = journal
        .ingest(
            "ax-metadata-only-value",
            ax_text_observation(2_400, "ax.valueChanged", "oc1_metadata", None, true),
        )
        .expect("accept content-disabled value notification");
    assert_eq!(
        metadata_only.semantic_event.content_state,
        SemanticContentStateV2::Available
    );
    assert_eq!(metadata_only.semantic_event.payload["insertedChars"], 0);
    assert_eq!(metadata_only.semantic_event.payload["deletedChars"], 0);
    assert_eq!(
        metadata_only.semantic_event.payload["deltaAvailable"],
        false
    );

    let events = query_all(&journal, true);
    let emptied = events
        .iter()
        .find(|event| event.event_id == emptied.semantic_event.event_id)
        .expect("find decrypted empty-value event");
    assert_eq!(emptied.payload["finalValue"], "");
}

#[test]
fn explicit_trusted_identity_is_validated_and_applied_to_raw_and_semantic_rows() {
    let directory = tempfile::tempdir().expect("create identity directory");
    let mut config = ObservationJournalConfig::new(
        directory.path().join("identity.sqlite3"),
        Arc::new(MemoryObservationKeyProvider::new([3; 32])),
    );
    config.device_id = Some("device_shared_1".to_owned());
    config.session_id = Some("session_shared_1".to_owned());
    let journal = ObservationJournal::open_with_config(config).expect("open identity journal");
    let appended = journal
        .ingest("identity-frame", browser_observation(1_000, "Identity"))
        .expect("append identity observation");
    assert_eq!(appended.observation.device_id, "device_shared_1");
    assert_eq!(appended.observation.session_id, "session_shared_1");
    assert_eq!(appended.semantic_event.device_id, "device_shared_1");
    assert_eq!(appended.semantic_event.session_id, "session_shared_1");

    let mut invalid = ObservationJournalConfig::new(
        directory.path().join("invalid-identity.sqlite3"),
        Arc::new(MemoryObservationKeyProvider::new([4; 32])),
    );
    invalid.device_id = Some("device id with spaces".to_owned());
    assert!(ObservationJournal::open_with_config(invalid).is_err());
}

#[test]
fn unavailable_key_fails_closed_and_never_persists_content() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = ObservationJournal::open_with_config(ObservationJournalConfig {
        database_path: directory.path().join("observation-journal.sqlite3"),
        raw_content_retention: Duration::from_secs(7 * 24 * 60 * 60),
        derived_retention: Duration::from_secs(30 * 24 * 60 * 60),
        broadcast_capacity: 8,
        key_provider: Arc::new(UnavailableObservationKeyProvider),
        device_id: None,
        session_id: None,
    })
    .expect("open journal with unavailable key");
    let appended = journal
        .ingest("key-unavailable-frame", browser_observation(2_000, SECRET))
        .expect("metadata-only ingest must remain available");
    assert_eq!(
        appended.semantic_event.content_state,
        SemanticContentStateV2::Unavailable
    );
    assert!(
        appended
            .semantic_event
            .coverage
            .contains(&CoverageLevelV2::Unavailable)
    );
    let events = query_all(&journal, true);
    assert_eq!(events.len(), 1);
    assert!(events[0].payload.get("title").is_none());
    assert!(events[0].payload.get("domain").is_none());
    for path in sqlite_paths(journal.database_path()) {
        assert_file_does_not_contain(&path, SECRET.as_bytes());
        assert_file_does_not_contain(&path, b"example.com");
    }
}

#[test]
fn unavailable_key_is_backed_off_and_status_queries_never_trigger_key_io() {
    let directory = tempfile::tempdir().expect("create test directory");
    let provider = Arc::new(CountingUnavailableKeyProvider::default());
    let journal = ObservationJournal::open_with_config(ObservationJournalConfig {
        database_path: directory.path().join("observation-journal.sqlite3"),
        raw_content_retention: Duration::from_secs(7 * 24 * 60 * 60),
        derived_retention: Duration::from_secs(30 * 24 * 60 * 60),
        broadcast_capacity: 8,
        key_provider: provider.clone(),
        device_id: None,
        session_id: None,
    })
    .expect("open journal with counting unavailable key");
    assert_eq!(
        provider.calls(),
        1,
        "journal open performs one key preflight"
    );

    for _ in 0..100 {
        assert!(!journal.key_available());
        assert_eq!(journal.key_storage_mode(), None);
    }
    assert_eq!(
        provider.calls(),
        1,
        "pure key status queries must never perform Keychain I/O"
    );

    for index in 0..10 {
        let appended = journal
            .ingest(
                &format!("key-backoff-frame-{index}"),
                browser_observation(3_000 + index, SECRET),
            )
            .expect("metadata-only ingest must remain available during key backoff");
        assert_eq!(
            appended.semantic_event.content_state,
            SemanticContentStateV2::Unavailable
        );
    }
    assert_eq!(
        provider.calls(),
        1,
        "content events inside the retry interval must reuse the cached failure"
    );
}

#[test]
fn goal_boundary_updates_durable_version_for_following_semantic_events() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));
    let goal = GoalContext {
        goal_id: "goal-1".to_owned(),
        plan_id: None,
        version: 1,
        text: "修复 WhaleHall 事件采集".to_owned(),
        activated_at_ms: 1_000,
    };
    let goal_change = EventGoalChangeParams {
        previous: None,
        next: Some(goal.clone()),
        occurred_at_ms: 1_000,
        deduplication_key: "goal-change:goal-1:1".to_owned(),
    };
    let boundary = journal
        .append_goal_change(&goal_change)
        .expect("append v2 goal boundary");
    assert_eq!(boundary.semantic_event.goal_version, None);
    assert_eq!(
        boundary.semantic_event.count_class,
        SemanticCountClassV2::Boundary
    );
    assert!(!journal.append_goal_change(&goal_change).unwrap().inserted);

    journal
        .ingest(
            "browser-after-goal",
            browser_observation(2_000, "Issue 123"),
        )
        .expect("append event under active goal");
    let clear = EventGoalChangeParams {
        previous: Some(goal),
        next: None,
        occurred_at_ms: 3_000,
        deduplication_key: "goal-change:clear:1".to_owned(),
    };
    journal
        .append_goal_change(&clear)
        .expect("append clear boundary");
    journal
        .ingest("browser-after-clear", browser_observation(4_000, "Home"))
        .expect("append event without active goal");

    let events = query_all(&journal, true);
    assert_eq!(events.len(), 4);
    assert_eq!(events[0].kind, semantic_event_kinds::GOAL_CHANGED);
    assert_eq!(events[0].goal_version, None);
    assert_eq!(events[1].goal_version, Some(1));
    assert_eq!(events[2].goal_version, Some(1));
    assert_eq!(events[3].goal_version, None);
    assert_eq!(events[0].payload["next"]["goalId"], "goal-1");

    let committed = journal
        .commit_semantic(&SemanticCommitParams {
            consumer_id: "timeline-v2".to_owned(),
            cursor: events[2].cursor.clone(),
        })
        .expect("commit semantic cursor");
    assert!(committed.advanced);
    let resumed = journal
        .query_semantic(&SemanticQueryParams {
            consumer_id: Some("timeline-v2".to_owned()),
            include_content: true,
            ..SemanticQueryParams::default()
        })
        .expect("resume from semantic cursor");
    assert_eq!(resumed.events.len(), 1);
    assert_eq!(resumed.events[0].event_id, events[3].event_id);
}

#[test]
fn five_minute_audit_range_is_exact_decrypts_only_on_request_and_excludes_end_boundary() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));
    journal
        .ingest("audit-in-range", browser_observation(1_000, SECRET))
        .expect("append in-range observation");
    journal
        .ingest(
            "audit-at-end",
            browser_observation(300_000, "outside range"),
        )
        .expect("append end-boundary observation");

    let redacted = journal
        .query_five_minute_audit(&AuditQueryFiveMinutesParams {
            from_ms: 0,
            to_ms: 300_000,
            include_decrypted_content: false,
        })
        .expect("query redacted audit");
    assert_eq!(redacted.raw_observations.len(), 1);
    assert_eq!(redacted.semantic_events.len(), 1);
    assert!(redacted.raw_observations[0].content.is_none());
    assert!(redacted.semantic_events[0].payload.get("title").is_none());
    assert!(redacted.coverage.contains(&CoverageLevelV2::Content));

    let decrypted = journal
        .query_five_minute_audit(&AuditQueryFiveMinutesParams {
            from_ms: 0,
            to_ms: 300_000,
            include_decrypted_content: true,
        })
        .expect("query decrypted audit");
    assert_eq!(
        decrypted.raw_observations[0].content.as_ref().unwrap()["title"],
        SECRET
    );
    assert_eq!(decrypted.semantic_events[0].payload["title"], SECRET);
    assert!(
        journal
            .query_five_minute_audit(&AuditQueryFiveMinutesParams {
                from_ms: 0,
                to_ms: 299_999,
                include_decrypted_content: false,
            })
            .is_err()
    );
}

#[test]
fn coverage_gap_is_idempotent_auditable_and_range_bounded() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));
    assert!(
        journal
            .record_coverage_gap(
                "observer:boot-1:sequence-gap:2:4",
                120_000,
                121_000,
                "observer_sequence_gap",
            )
            .expect("persist coverage gap")
    );
    assert!(
        !journal
            .record_coverage_gap(
                "observer:boot-1:sequence-gap:2:4",
                120_000,
                121_000,
                "observer_sequence_gap",
            )
            .expect("replay coverage gap")
    );
    assert!(
        journal
            .record_coverage_gap(
                "observer:boot-2:reported-gap:600000",
                600_000,
                600_000,
                "observer_reported_gap",
            )
            .expect("persist outside gap")
    );

    let first_range = journal
        .query_five_minute_audit(&AuditQueryFiveMinutesParams {
            from_ms: 0,
            to_ms: 300_000,
            include_decrypted_content: false,
        })
        .expect("query first range");
    assert_eq!(first_range.coverage, vec![CoverageLevelV2::Unavailable]);

    let second_range = journal
        .query_five_minute_audit(&AuditQueryFiveMinutesParams {
            from_ms: 300_000,
            to_ms: 600_000,
            include_decrypted_content: false,
        })
        .expect("query second range");
    assert!(second_range.coverage.is_empty());

    let connection = Connection::open(journal.database_path()).expect("inspect coverage gaps");
    let stored: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM observation_coverage_gaps",
            [],
            |row| row.get(0),
        )
        .expect("count coverage gaps");
    assert_eq!(stored, 2);
}

#[test]
fn every_native_sensitive_redaction_code_drops_content_before_storage() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));
    let redaction_codes = [
        "sensitive_application",
        "sensitive_or_private_window",
        "protected_input",
        "private_window",
        "sensitive_visible_content",
        "user_excluded_application",
    ];
    for (index, code) in redaction_codes.iter().enumerate() {
        let mut input = browser_observation(
            10_000 + i64::try_from(index).unwrap(),
            &format!("{SECRET}-{code}"),
        );
        input.redactions = vec![(*code).to_owned()];
        let result = journal
            .ingest(&format!("redaction-{index}"), input)
            .expect("ingest redacted observation");
        assert_eq!(
            result.observation.content_state,
            SemanticContentStateV2::Redacted
        );
        assert_eq!(
            result.semantic_event.content_state,
            SemanticContentStateV2::Redacted
        );
        assert!(result.observation.content.is_none());
        assert!(
            result
                .observation
                .coverage
                .contains(&CoverageLevelV2::Redacted)
        );
    }
    for path in sqlite_paths(journal.database_path()) {
        assert_file_does_not_contain(&path, SECRET.as_bytes());
        assert_file_does_not_contain(&path, b"example.com");
    }
}

#[test]
fn coalesced_input_bucket_is_one_effective_event_with_strict_duration() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));
    let input = RawObservationInputV2 {
        schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
        kind: "input.activityBucket".to_owned(),
        interval: ObservationIntervalV2 {
            started_at_ms: 10_000,
            ended_at_ms: 25_000,
        },
        source: ObservationSourceV2 {
            sensor: ObservationSensorV2::CgActivity,
            adapter_version: "observer-test.v2".to_owned(),
        },
        subject: ObservationSubjectV2 {
            app_id: "com.example.Editor".to_owned(),
            app_name: "Editor".to_owned(),
            opaque_window_id: None,
        },
        reliability: EvidenceReliabilityV2::High,
        coverage: vec![CoverageLevelV2::Metadata],
        redactions: vec![
            "key_values_not_collected".to_owned(),
            "pointer_coordinates_not_collected".to_owned(),
        ],
        metadata: json!({
            "keyCount": 9,
            "clickCount": 2,
            "scrollDelta": 42.5,
            "mouseDistance": 100.25,
            "coalescedBucketCount": 3,
        }),
        content: None,
    };
    let appended = journal
        .ingest("coalesced-input-1", input.clone())
        .expect("ingest coalesced input");
    assert_eq!(
        appended.semantic_event.count_class,
        SemanticCountClassV2::Effective
    );
    assert_eq!(appended.semantic_event.payload["coalescedBucketCount"], 3);

    let mut wrong_duration = input.clone();
    wrong_duration.interval.ended_at_ms -= 1;
    assert!(
        journal
            .ingest("coalesced-input-wrong-duration", wrong_duration)
            .is_err()
    );
    let mut invalid_count = input;
    invalid_count.metadata["coalescedBucketCount"] = json!(1);
    invalid_count.interval.ended_at_ms = 15_000;
    assert!(
        journal
            .ingest("coalesced-input-invalid-count", invalid_count)
            .is_err()
    );
}

#[test]
fn anonymous_coverage_gap_is_ignored_and_rejects_real_application_identity() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));
    let gap = RawObservationInputV2 {
        schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
        kind: "coverage.gap".to_owned(),
        interval: ObservationIntervalV2 {
            started_at_ms: 12_000,
            ended_at_ms: 12_000,
        },
        source: ObservationSourceV2 {
            sensor: ObservationSensorV2::Ax,
            adapter_version: "observer-test.v2".to_owned(),
        },
        subject: ObservationSubjectV2 {
            app_id: "redacted".to_owned(),
            app_name: "Protected application".to_owned(),
            opaque_window_id: None,
        },
        reliability: EvidenceReliabilityV2::High,
        coverage: vec![CoverageLevelV2::Redacted],
        redactions: vec!["user_excluded_application".to_owned()],
        metadata: json!({}),
        content: None,
    };
    let appended = journal
        .ingest("anonymous-gap:ax:user-excluded", gap.clone())
        .expect("ingest anonymous coverage gap");
    assert_eq!(appended.semantic_event.kind, "coverage.gap");
    assert_eq!(
        appended.semantic_event.count_class,
        SemanticCountClassV2::Ignored
    );
    assert_eq!(appended.semantic_event.payload, json!({}));
    assert_eq!(
        appended.semantic_event.content_state,
        SemanticContentStateV2::Redacted
    );

    for (index, reason) in [
        "browser_privacy_state_unavailable",
        "thermal_critical",
        "foreground_window_unavailable",
        "screen_capture_failed",
    ]
    .iter()
    .enumerate()
    {
        let mut unavailable = gap.clone();
        unavailable.interval.started_at_ms += 1 + i64::try_from(index).unwrap();
        unavailable.interval.ended_at_ms = unavailable.interval.started_at_ms;
        unavailable.source.sensor = ObservationSensorV2::Ocr;
        unavailable.coverage = vec![CoverageLevelV2::Unavailable];
        unavailable.redactions = vec![(*reason).to_owned()];
        let stored = journal
            .ingest(&format!("anonymous-gap:ocr:{reason}"), unavailable)
            .expect("ingest native OCR coverage gap");
        assert_eq!(
            stored.semantic_event.count_class,
            SemanticCountClassV2::Ignored
        );
        assert!(
            stored
                .semantic_event
                .coverage
                .contains(&CoverageLevelV2::Unavailable)
        );
    }
    for (index, reason) in [
        "input_monitoring_unavailable",
        "input_event_tap_disabled",
        "input_event_tap_start_timeout",
    ]
    .iter()
    .enumerate()
    {
        let mut unavailable = gap.clone();
        unavailable.interval.started_at_ms += 100 + i64::try_from(index).unwrap();
        unavailable.interval.ended_at_ms = unavailable.interval.started_at_ms;
        unavailable.source.sensor = ObservationSensorV2::CgActivity;
        unavailable.coverage = vec![CoverageLevelV2::Unavailable];
        unavailable.redactions = vec![(*reason).to_owned()];
        let stored = journal
            .ingest(&format!("anonymous-gap:cg-activity:{reason}"), unavailable)
            .expect("ingest native input activity coverage gap");
        assert_eq!(
            stored.semantic_event.count_class,
            SemanticCountClassV2::Ignored
        );
        assert!(
            stored
                .semantic_event
                .coverage
                .contains(&CoverageLevelV2::Unavailable)
        );
    }
    let mut browser_privacy_boundary = browser_observation(13_000, "must not be persisted");
    browser_privacy_boundary.content = None;
    browser_privacy_boundary.coverage = vec![CoverageLevelV2::Unavailable];
    browser_privacy_boundary.redactions = vec!["browser_privacy_state_unavailable".to_owned()];
    browser_privacy_boundary.reliability = EvidenceReliabilityV2::Low;
    let browser_boundary = journal
        .ingest(
            "browser-privacy-state-unavailable",
            browser_privacy_boundary,
        )
        .expect("persist unavailable browser privacy boundary");
    assert!(
        browser_boundary
            .semantic_event
            .coverage
            .contains(&CoverageLevelV2::Unavailable)
    );
    for path in sqlite_paths(journal.database_path()) {
        assert_file_does_not_contain(&path, b"must not be persisted");
    }
    let audit = journal
        .query_five_minute_audit(&AuditQueryFiveMinutesParams {
            from_ms: 0,
            to_ms: 300_000,
            include_decrypted_content: false,
        })
        .expect("audit native gap reasons");
    assert!(audit.coverage.contains(&CoverageLevelV2::Unavailable));

    let mut unknown_reason = gap.clone();
    unknown_reason.redactions = vec!["unknown_gap_reason".to_owned()];
    assert!(
        journal
            .ingest("anonymous-gap-unknown-reason", unknown_reason)
            .is_err()
    );
    let mut wrong_sensor = gap.clone();
    wrong_sensor.source.sensor = ObservationSensorV2::Ocr;
    assert!(
        journal
            .ingest("anonymous-gap-wrong-sensor", wrong_sensor)
            .is_err()
    );
    let mut wrong_coverage = gap.clone();
    wrong_coverage.coverage = vec![CoverageLevelV2::Unavailable];
    assert!(
        journal
            .ingest("anonymous-gap-wrong-coverage", wrong_coverage)
            .is_err()
    );

    let mut identifying_gap = gap;
    identifying_gap.subject.app_id = "com.secret.bank".to_owned();
    identifying_gap.subject.app_name = "Secret Bank".to_owned();
    assert!(
        journal
            .ingest("identifying-gap-must-fail", identifying_gap)
            .is_err()
    );
    for path in sqlite_paths(journal.database_path()) {
        assert_file_does_not_contain(&path, b"com.secret.bank");
        assert_file_does_not_contain(&path, b"Secret Bank");
    }
}

#[test]
fn derived_retention_is_hard_and_advances_only_the_expired_consumer_prefix() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal =
        memory_journal_with_retentions(&directory, Duration::from_secs(1), Duration::from_secs(2));
    journal
        .ingest("retention-old-1", browser_observation(1_000, "old one"))
        .expect("append first old event");
    journal
        .ingest("retention-old-2", browser_observation(2_000, "old two"))
        .expect("append second old event");
    journal
        .ingest(
            "retention-still-live",
            browser_observation(10_000, "still live"),
        )
        .expect("append retained event");
    let before = query_all(&journal, false);
    assert_eq!(before.len(), 3);
    journal
        .commit_semantic(&SemanticCommitParams {
            consumer_id: "slow-timeline".to_owned(),
            cursor: before[0].cursor.clone(),
        })
        .expect("commit slow cursor");

    let cleanup = journal.cleanup(5_000).expect("enforce hard retention");
    assert_eq!(cleanup.deleted_semantic_events, 2);
    assert_eq!(cleanup.deleted_observations, 2);
    assert_eq!(
        journal
            .committed_semantic_cursor("slow-timeline")
            .expect("load advanced cursor")
            .as_deref(),
        Some("sec2_0000000000000002")
    );
    let resumed = journal
        .query_semantic(&SemanticQueryParams {
            consumer_id: Some("slow-timeline".to_owned()),
            include_content: false,
            ..SemanticQueryParams::default()
        })
        .expect("resume after retention jump");
    assert_eq!(resumed.events.len(), 1);
    assert_eq!(resumed.events[0].event_id, before[2].event_id);
    journal
        .commit_semantic(&SemanticCommitParams {
            consumer_id: "slow-timeline".to_owned(),
            cursor: resumed.events[0].cursor.clone(),
        })
        .expect("commit retained event after synthetic cursor");

    let connection = Connection::open(journal.database_path()).expect("inspect retained lineage");
    let raw_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM observations", [], |row| row.get(0))
        .expect("count raw rows");
    let lineage_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM semantic_event_lineage", [], |row| {
            row.get(0)
        })
        .expect("count lineage rows");
    let retention_gaps: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM observation_coverage_gaps
             WHERE reason = 'semantic_retention_gap'",
            [],
            |row| row.get(0),
        )
        .expect("count retention gaps");
    assert_eq!(raw_count, 1);
    assert_eq!(lineage_count, 1);
    assert_eq!(retention_gaps, 1);
    drop(connection);

    let audit = journal
        .query_five_minute_audit(&AuditQueryFiveMinutesParams {
            from_ms: 0,
            to_ms: 300_000,
            include_decrypted_content: false,
        })
        .expect("audit retention range");
    assert!(audit.coverage.contains(&CoverageLevelV2::Unavailable));
}

#[test]
fn process_inventory_is_ignored_vault_is_idempotent_and_exact_retention_expires_raw() {
    let directory = tempfile::tempdir().expect("create test directory");
    let retention = Duration::from_secs(7 * 24 * 60 * 60);
    let journal = memory_journal(&directory, retention);
    let process = RawObservationInputV2 {
        schema_version: RAW_OBSERVATION_SCHEMA_VERSION.to_owned(),
        kind: "application.processObservedBatch".to_owned(),
        interval: ObservationIntervalV2 {
            started_at_ms: 1_000,
            ended_at_ms: 1_000,
        },
        source: ObservationSourceV2 {
            sensor: ObservationSensorV2::Workspace,
            adapter_version: "observer-test.v2".to_owned(),
        },
        subject: ObservationSubjectV2 {
            app_id: "system.processes".to_owned(),
            app_name: "Processes".to_owned(),
            opaque_window_id: None,
        },
        reliability: EvidenceReliabilityV2::High,
        coverage: vec![CoverageLevelV2::Metadata],
        redactions: Vec::new(),
        metadata: json!({
            "started": [{"processId": 42, "appId": "com.example.App", "appName": "App"}],
            "exited": [],
        }),
        content: None,
    };
    let process_event = journal.ingest("process-batch-1", process).unwrap();
    assert_eq!(
        process_event.semantic_event.count_class,
        SemanticCountClassV2::Ignored
    );

    journal
        .ingest("retained-browser", browser_observation(1_000, SECRET))
        .expect("append retained content");
    let vault = journal
        .seal_vault_batch(&VaultSealBatchParams {
            namespace: "timeline-v2".to_owned(),
            records: vec![VaultSealRecord {
                record_id: "timeline-1".to_owned(),
                schema_version: "timeline.v2".to_owned(),
                content: json!({"summary": SECRET}),
                expires_at_ms: None,
            }],
        })
        .expect("seal vault");
    assert!(vault.records[0].inserted);
    let replay = journal
        .seal_vault_batch(&VaultSealBatchParams {
            namespace: "timeline-v2".to_owned(),
            records: vec![VaultSealRecord {
                record_id: "timeline-1".to_owned(),
                schema_version: "timeline.v2".to_owned(),
                content: json!({"summary": SECRET}),
                expires_at_ms: None,
            }],
        })
        .expect("replay vault seal");
    assert!(!replay.records[0].inserted);
    assert!(
        journal
            .seal_vault_batch(&VaultSealBatchParams {
                namespace: "timeline-v2".to_owned(),
                records: vec![VaultSealRecord {
                    record_id: "timeline-1".to_owned(),
                    schema_version: "different-schema.v2".to_owned(),
                    content: json!({"summary": SECRET}),
                    expires_at_ms: None,
                }],
            })
            .is_err()
    );
    let opened = journal
        .open_vault_batch(&VaultOpenBatchParams {
            namespace: "timeline-v2".to_owned(),
            content_refs: vec![vault.records[0].content_ref.clone()],
        })
        .expect("open vault");
    assert_eq!(opened.records[0].content["summary"], SECRET);

    let before = journal
        .cleanup(1_000 + i64::try_from(retention.as_millis()).unwrap() - 1)
        .expect("cleanup immediately before expiry");
    assert_eq!(before.expired_raw_contents, 0);
    let at_expiry = journal
        .cleanup(1_000 + i64::try_from(retention.as_millis()).unwrap())
        .expect("cleanup at exact expiry");
    assert_eq!(at_expiry.expired_raw_contents, 1);
    assert_eq!(at_expiry.expired_semantic_contents, 1);
    let expired_semantic = query_all(&journal, true);
    let expired_browser = expired_semantic
        .iter()
        .find(|event| event.kind == semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED)
        .expect("find expired browser event");
    assert_eq!(
        expired_browser.content_state,
        SemanticContentStateV2::Expired
    );
    assert!(expired_browser.payload.get("title").is_none());
    let connection = Connection::open(journal.database_path()).expect("inspect raw content state");
    let content_state: String = connection
        .query_row(
            "SELECT content_state FROM observations WHERE kind = 'browser.visiblePageChanged'",
            [],
            |row| row.get(0),
        )
        .expect("load raw content state");
    assert_eq!(content_state, "expired");

    drop(connection);
    let derived_retention_ms = 30_i64 * 24 * 60 * 60 * 1_000;
    let derived_expiry = journal
        .cleanup(1_000 + derived_retention_ms)
        .expect("cleanup derived records at exact expiry");
    assert!(derived_expiry.deleted_semantic_events >= 2);
    let connection = Connection::open(journal.database_path()).expect("inspect encrypted payloads");
    let semantic_payloads: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM encrypted_payloads WHERE owner_kind = 'semantic-event'",
            [],
            |row| row.get(0),
        )
        .expect("count semantic encrypted payloads");
    assert_eq!(semantic_payloads, 0);
}

#[test]
fn exact_vault_deletion_keeps_high_frequency_mutable_storage_bounded() {
    let directory = tempfile::tempdir().expect("create test directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));
    let namespace = "timeline.collector.v2";
    let snapshot_body = "x".repeat(64 * 1024);
    let mut previous_record_id: Option<String> = None;

    for revision in 0..96 {
        let record_id = format!("collector-candidate-{revision}");
        journal
            .seal_vault_batch(&VaultSealBatchParams {
                namespace: namespace.to_owned(),
                records: vec![VaultSealRecord {
                    record_id: record_id.clone(),
                    schema_version: "timeline-collector.v2".to_owned(),
                    content: json!({
                        "revision": revision,
                        "snapshot": snapshot_body,
                    }),
                    expires_at_ms: None,
                }],
            })
            .expect("seal collector candidate");
        if let Some(previous) = previous_record_id.replace(record_id) {
            let deleted = journal
                .delete_vault_batch(&VaultDeleteBatchParams {
                    namespace: namespace.to_owned(),
                    record_ids: vec![previous.clone()],
                })
                .expect("delete retired collector candidate");
            assert_eq!(deleted.records[0].record_id, previous);
            assert!(deleted.records[0].deleted);
        }
    }

    let missing = journal
        .delete_vault_batch(&VaultDeleteBatchParams {
            namespace: namespace.to_owned(),
            record_ids: vec!["collector-candidate-missing".to_owned()],
        })
        .expect("repeat an already absent deletion");
    assert!(!missing.records[0].deleted);

    let connection = Connection::open(journal.database_path()).expect("inspect bounded vault");
    let retained: (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(p.ciphertext)), 0)
             FROM vault_records v
             JOIN encrypted_payloads p ON p.content_ref = v.content_ref
             WHERE v.namespace = ?1",
            [namespace],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("count retained collector payloads");
    assert_eq!(retained.0, 1);
    assert!(retained.1 < 70 * 1024);
    let page_size: i64 = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .expect("read page size");
    let page_count: i64 = connection
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .expect("read page count");
    assert!(page_size * page_count < 4 * 1024 * 1024);
}

#[test]
fn vault_metadata_inventory_is_namespace_scoped_paginated_and_key_independent() {
    let directory = tempfile::tempdir().expect("create vault inventory directory");
    let journal = memory_journal(&directory, Duration::from_secs(7 * 24 * 60 * 60));
    let secret = "inventory-must-never-return-this-content";
    journal
        .seal_vault_batch(&VaultSealBatchParams {
            namespace: "planning.runtime.v1".to_owned(),
            records: ["record-b", "record-a", "record-c"]
                .into_iter()
                .map(|record_id| VaultSealRecord {
                    record_id: record_id.to_owned(),
                    schema_version: "planning.runtime.chunk.v1".to_owned(),
                    content: json!({"secret": secret, "recordId": record_id}),
                    expires_at_ms: None,
                })
                .collect(),
        })
        .expect("seal planning inventory fixtures");
    journal
        .seal_vault_batch(&VaultSealBatchParams {
            namespace: "another.namespace".to_owned(),
            records: vec![VaultSealRecord {
                record_id: "record-hidden".to_owned(),
                schema_version: "other.v1".to_owned(),
                content: json!({"secret": secret}),
                expires_at_ms: None,
            }],
        })
        .expect("seal other namespace fixture");

    let first = journal
        .list_vault_records(&VaultListRecordsParams {
            namespace: "planning.runtime.v1".to_owned(),
            created_before_ms: 9_007_199_254_740_991,
            cursor: None,
            limit: 2,
        })
        .expect("list first metadata page");
    assert_eq!(
        first
            .records
            .iter()
            .map(|record| record.record_id.as_str())
            .collect::<Vec<_>>(),
        ["record-a", "record-b"]
    );
    assert!(first.next_cursor.is_some());
    let encoded = serde_json::to_string(&first).expect("serialize metadata page");
    assert!(!encoded.contains(secret));
    assert!(!encoded.contains("contentHash"));
    assert!(!encoded.contains("keyVersion"));

    drop(journal);
    let unavailable = ObservationJournal::open_with_config(ObservationJournalConfig {
        database_path: directory.path().join("observation-journal.sqlite3"),
        raw_content_retention: Duration::from_secs(7 * 24 * 60 * 60),
        derived_retention: Duration::from_secs(30 * 24 * 60 * 60),
        broadcast_capacity: 16,
        key_provider: Arc::new(UnavailableObservationKeyProvider),
        device_id: None,
        session_id: None,
    })
    .expect("reopen metadata inventory without a content key");
    let second = unavailable
        .list_vault_records(&VaultListRecordsParams {
            namespace: "planning.runtime.v1".to_owned(),
            created_before_ms: 9_007_199_254_740_991,
            cursor: first.next_cursor.clone(),
            limit: 2,
        })
        .expect("list second metadata page without decrypting");
    assert_eq!(second.records.len(), 1);
    assert_eq!(second.records[0].record_id, "record-c");
    assert!(second.next_cursor.is_none());

    let wrong_scope = unavailable.list_vault_records(&VaultListRecordsParams {
        namespace: "another.namespace".to_owned(),
        created_before_ms: 9_007_199_254_740_991,
        cursor: first.next_cursor,
        limit: 2,
    });
    assert!(
        wrong_scope.is_err(),
        "cursor must be bound to its namespace"
    );

    unavailable
        .delete_vault_batch(&VaultDeleteBatchParams {
            namespace: "planning.runtime.v1".to_owned(),
            record_ids: vec!["record-b".to_owned()],
        })
        .expect("delete one exact inventory record without a content key");
    let remaining = unavailable
        .list_vault_records(&VaultListRecordsParams {
            namespace: "planning.runtime.v1".to_owned(),
            created_before_ms: 9_007_199_254_740_991,
            cursor: None,
            limit: 10,
        })
        .expect("list metadata after exact deletion");
    assert_eq!(
        remaining
            .records
            .iter()
            .map(|record| record.record_id.as_str())
            .collect::<Vec<_>>(),
        ["record-a", "record-c"]
    );
}
