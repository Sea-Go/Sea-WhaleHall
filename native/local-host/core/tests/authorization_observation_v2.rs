use std::sync::Arc;

use tempfile::TempDir;
use whalehall_local_core::observations::{
    MemoryObservationKeyProvider, ObservationJournal, ObservationJournalConfig,
};
use whalehall_local_protocol::{
    CoverageLevelV2, MonitoringPermissionState, MonitoringPermissions, SemanticContentStateV2,
    SemanticCountClassV2, SemanticQueryParams, semantic_event_kinds,
};

fn journal(directory: &TempDir) -> ObservationJournal {
    let mut config = ObservationJournalConfig::new(
        directory.path().join("observation-journal.sqlite3"),
        Arc::new(MemoryObservationKeyProvider::new([0x27; 32])),
    );
    config.device_id = Some("authorization-test-device".to_owned());
    config.session_id = Some("authorization-test-session".to_owned());
    ObservationJournal::open_with_config(config).expect("open authorization observation journal")
}

fn permissions(
    accessibility: MonitoringPermissionState,
    screen_recording: MonitoringPermissionState,
    input_monitoring: MonitoringPermissionState,
    automation: MonitoringPermissionState,
) -> MonitoringPermissions {
    MonitoringPermissions {
        accessibility,
        screen_recording,
        input_monitoring,
        automation,
    }
}

fn query_all(journal: &ObservationJournal) -> Vec<whalehall_local_protocol::SemanticEventV2> {
    journal
        .query_semantic(&SemanticQueryParams {
            after_cursor: None,
            consumer_id: None,
            limit: 100,
            include_content: true,
        })
        .expect("query authorization semantic events")
        .events
}

#[test]
fn denied_startup_snapshot_is_a_metadata_only_non_counting_boundary() {
    let directory = tempfile::tempdir().expect("create authorization directory");
    let journal = journal(&directory);
    let mut push = journal.subscribe();
    let snapshot = permissions(
        MonitoringPermissionState::Denied,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::NotDetermined,
    );

    let appended = journal
        .append_authorization_change("boot-startup", 1_000, &snapshot, "startup_snapshot")
        .expect("append authorization baseline")
        .expect("denied baseline must be materialized");
    assert_eq!(appended.observation.kind, "authorization.changed");
    assert_eq!(appended.observation.content, None);
    assert_eq!(appended.observation.coverage, [CoverageLevelV2::Metadata]);
    assert_eq!(
        appended.observation.metadata,
        serde_json::json!({
            "permissions": {
                "accessibility": "denied",
                "screenRecording": "granted",
                "inputMonitoring": "granted",
                "automation": "not_determined",
            },
            "changedPermissions": [
                "accessibility",
                "screenRecording",
                "inputMonitoring",
                "automation",
            ],
            "transition": "revoked",
            "reason": "startup_snapshot",
        })
    );
    assert_eq!(
        appended.semantic_event.kind,
        semantic_event_kinds::AUTHORIZATION_CHANGED
    );
    assert_eq!(
        appended.semantic_event.count_class,
        SemanticCountClassV2::Boundary
    );
    assert_eq!(
        appended.semantic_event.content_state,
        SemanticContentStateV2::Available
    );
    assert_eq!(
        appended.semantic_event.payload,
        appended.observation.metadata
    );
    assert_eq!(
        push.try_recv()
            .expect("authorization semantic push")
            .event_id,
        appended.semantic_event.event_id
    );
}

#[test]
fn identical_frames_are_deduplicated_and_restart_uses_the_durable_snapshot() {
    let directory = tempfile::tempdir().expect("create authorization directory");
    let granted = permissions(
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Unsupported,
    );
    let denied = permissions(
        MonitoringPermissionState::Denied,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Unsupported,
    );

    {
        let first = journal(&directory);
        assert!(
            first
                .append_authorization_change("boot-a", 1_000, &granted, "startup_snapshot")
                .expect("append baseline")
                .is_some()
        );
        assert!(
            first
                .append_authorization_change("boot-a", 11_000, &granted, "heartbeat_check")
                .expect("deduplicate heartbeat")
                .is_none()
        );
    }

    let reopened = journal(&directory);
    let revoked = reopened
        .append_authorization_change("boot-b", 20_000, &denied, "startup_snapshot")
        .expect("append offline revocation")
        .expect("durable baseline must detect the change");
    assert_eq!(revoked.semantic_event.payload["transition"], "revoked");
    assert_eq!(
        revoked.semantic_event.payload["changedPermissions"],
        serde_json::json!(["accessibility"])
    );
    assert_eq!(query_all(&reopened).len(), 2);

    let restored = reopened
        .append_authorization_change("boot-b", 21_000, &granted, "manual_refresh")
        .expect("append restored authorization")
        .expect("restoration must be materialized");
    assert_eq!(restored.semantic_event.payload["transition"], "granted");
    assert_eq!(
        restored.semantic_event.payload["changedPermissions"],
        serde_json::json!(["accessibility"])
    );
    assert_eq!(query_all(&reopened).len(), 3);
}

#[test]
fn durable_baseline_survives_audit_retention_cleanup() {
    let directory = tempfile::tempdir().expect("create authorization directory");
    let journal = journal(&directory);
    let granted = permissions(
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Unsupported,
    );
    let denied = MonitoringPermissions {
        input_monitoring: MonitoringPermissionState::Denied,
        ..granted.clone()
    };
    journal
        .append_authorization_change("boot-a", 1_000, &granted, "startup_snapshot")
        .expect("append baseline")
        .expect("baseline must be persisted");

    let retention_ms = 30_i64 * 24 * 60 * 60 * 1_000;
    let cleanup = journal
        .cleanup(1_000 + retention_ms)
        .expect("clean derived authorization audit records");
    assert_eq!(cleanup.deleted_observations, 1);
    assert_eq!(cleanup.deleted_semantic_events, 1);
    assert!(query_all(&journal).is_empty());

    assert!(
        journal
            .append_authorization_change(
                "boot-b",
                1_000 + retention_ms + 1,
                &granted,
                "heartbeat_check",
            )
            .expect("compare retained durable baseline")
            .is_none()
    );
    let revoked = journal
        .append_authorization_change(
            "boot-b",
            1_000 + retention_ms + 2,
            &denied,
            "runtime_change",
        )
        .expect("append real post-retention change")
        .expect("real change must still produce an event");
    assert_eq!(revoked.semantic_event.payload["transition"], "revoked");
}

#[test]
fn not_determined_to_denied_is_a_revocation() {
    let directory = tempfile::tempdir().expect("create authorization directory");
    let journal = journal(&directory);
    let undecided = permissions(
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::NotDetermined,
    );
    let denied = MonitoringPermissions {
        automation: MonitoringPermissionState::Denied,
        ..undecided.clone()
    };
    journal
        .append_authorization_change("boot-a", 1_000, &undecided, "startup_snapshot")
        .expect("append undecided baseline")
        .expect("baseline must be persisted");
    let refusal = journal
        .append_authorization_change("boot-a", 2_000, &denied, "manual_refresh")
        .expect("append user refusal")
        .expect("denial must be persisted");
    assert_eq!(refusal.semantic_event.payload["transition"], "revoked");
    assert_eq!(
        refusal.semantic_event.payload["changedPermissions"],
        serde_json::json!(["automation"])
    );
}

#[test]
fn authorization_api_rejects_unbounded_identity_reason_and_timestamp() {
    let directory = tempfile::tempdir().expect("create authorization directory");
    let journal = journal(&directory);
    let granted = permissions(
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Granted,
        MonitoringPermissionState::Unsupported,
    );
    assert!(
        journal
            .append_authorization_change(
                "boot with captured window title",
                1_000,
                &granted,
                "startup_snapshot",
            )
            .is_err()
    );
    assert!(
        journal
            .append_authorization_change("boot-a", 1_000, &granted, "captured_path")
            .is_err()
    );
    assert!(
        journal
            .append_authorization_change("boot-a", -1, &granted, "runtime_change")
            .is_err()
    );
    assert!(query_all(&journal).is_empty());
}
