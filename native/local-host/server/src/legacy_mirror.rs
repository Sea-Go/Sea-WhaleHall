//! Appends the legacy desktop events that Observer frames mirror to.
//!
//! The append happens only after a frame has been acknowledged, so a slow
//! legacy journal can never make the helper drop observations. A failed
//! append is reported through the monitoring status and never escalates:
//! the observation itself is already durable in the observation journal.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use whalehall_local_core::events::{DesktopEventDraft, EventJournal};
use whalehall_local_protocol::MonitoringStatusResult;

/// `MonitoringStatusResult::last_error` while the latest mirror append failed.
pub(crate) const LEGACY_MIRROR_FAILURE: &str = "observer_legacy_mirror_failed";

/// The legacy journal of one helper session together with the memory that
/// suppresses repeated window titles. Without a journal nothing is mirrored.
#[derive(Default)]
pub(crate) struct LegacyMirrorSink<'a> {
    journal: Option<&'a EventJournal>,
    last_window_titles: HashMap<String, String>,
}

impl<'a> LegacyMirrorSink<'a> {
    pub(crate) fn new(journal: Option<&'a EventJournal>) -> Self {
        Self {
            journal,
            last_window_titles: HashMap::new(),
        }
    }

    pub(crate) fn append(
        &mut self,
        draft: Option<DesktopEventDraft>,
        status: &Arc<Mutex<MonitoringStatusResult>>,
    ) {
        let (Some(journal), Some(draft)) = (self.journal, draft) else {
            return;
        };
        if !self.admit(&draft) {
            return;
        }
        let failed = journal.append(draft).is_err();
        let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
        current.last_error = next_last_error(current.last_error.as_deref(), failed);
    }

    /// A window title is reported when it changes. Repeated content changes
    /// in the same document carry nothing new.
    fn admit(&mut self, draft: &DesktopEventDraft) -> bool {
        if draft.kind != "application.foregroundChanged" {
            return true;
        }
        let Some(payload) = draft.payload.as_object() else {
            return false;
        };
        let app_id = payload.get("appId").and_then(Value::as_str);
        let title = payload.get("windowTitle").and_then(Value::as_str);
        let (Some(app_id), Some(title)) = (app_id, title) else {
            return false;
        };
        if self
            .last_window_titles
            .get(app_id)
            .is_some_and(|last| last == title)
        {
            return false;
        }
        self.last_window_titles
            .insert(app_id.to_owned(), title.to_owned());
        true
    }
}

/// Only the mirror's own failure marker is cleared by a later success, so a
/// more serious observer error is never hidden by it.
fn next_last_error(previous: Option<&str>, failed: bool) -> Option<String> {
    match (failed, previous) {
        (true, _) => Some(LEGACY_MIRROR_FAILURE.to_owned()),
        (false, Some(LEGACY_MIRROR_FAILURE)) => None,
        (false, other) => other.map(ToOwned::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use whalehall_local_protocol::{
        DesktopEventSensitivity, EventQueryParams, MonitoringPermissionCheckState,
        MonitoringPermissions, MonitoringState,
    };

    fn title_event(app_id: &str, title: &str, key: &str) -> DesktopEventDraft {
        let mut draft = DesktopEventDraft::metadata(
            "application.foregroundChanged",
            "observer.bridge.workspace",
            1_700_000_000_000,
            serde_json::json!({ "appId": app_id, "appName": "App", "windowTitle": title }),
            key,
        );
        draft.sensitivity = DesktopEventSensitivity::Content;
        draft
    }

    fn bucket_event(key: &str) -> DesktopEventDraft {
        DesktopEventDraft::metadata(
            "input.activityAggregated",
            "observer.bridge.input",
            1_700_000_000_000,
            serde_json::json!({ "keyCount": 3 }),
            key,
        )
    }

    fn status() -> Arc<Mutex<MonitoringStatusResult>> {
        Arc::new(Mutex::new(MonitoringStatusResult {
            state: MonitoringState::Running,
            enabled: true,
            capture_content: true,
            excluded_bundle_ids: Vec::new(),
            helper_pid: Some(42),
            helper_path_available: true,
            boot_id: None,
            last_sequence: None,
            last_acked_sequence: None,
            last_heartbeat_at_ms: None,
            tap_ready: true,
            last_callback_at_ms: None,
            last_bucket_at_ms: None,
            permissions: MonitoringPermissions::default(),
            permission_check_state: MonitoringPermissionCheckState::Checking,
            permissions_checked_at_ms: None,
            permission_setup_available: true,
            permission_setup_attempted: false,
            coverage: Vec::new(),
            last_error: None,
        }))
    }

    fn last_error(status: &Arc<Mutex<MonitoringStatusResult>>) -> Option<String> {
        status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .last_error
            .clone()
    }

    fn appended(journal: &EventJournal) -> Vec<String> {
        journal
            .query(&EventQueryParams {
                after_cursor: None,
                consumer_id: None,
                limit: 10,
            })
            .expect("query the legacy journal")
            .events
            .into_iter()
            .map(|event| event.source)
            .collect()
    }

    fn journal(tag: &str) -> (tempfile::TempDir, EventJournal) {
        let directory = tempfile::tempdir().expect("create legacy journal directory");
        let path = directory.path().join(format!("{tag}.sqlite3"));
        let journal = EventJournal::open(&path).expect("open legacy journal");
        (directory, journal)
    }

    #[test]
    fn reports_a_window_title_only_when_it_changes() {
        let (_directory, journal) = journal("titles");
        let status = status();
        let mut sink = LegacyMirrorSink::new(Some(&journal));

        sink.append(
            Some(title_event("com.example.reader", "Chapter 1", "k1")),
            &status,
        );
        sink.append(
            Some(title_event("com.example.reader", "Chapter 1", "k2")),
            &status,
        );
        sink.append(
            Some(title_event("com.example.reader", "Chapter 2", "k3")),
            &status,
        );
        sink.append(
            Some(title_event("com.example.editor", "Chapter 1", "k4")),
            &status,
        );

        assert_eq!(appended(&journal), vec!["observer.bridge.workspace"; 3]);
        assert_eq!(last_error(&status), None);
    }

    #[test]
    fn appends_every_other_event_once_and_skips_replayed_frames() {
        let (_directory, journal) = journal("append");
        let status = status();
        let mut sink = LegacyMirrorSink::new(Some(&journal));

        sink.append(None, &status);
        sink.append(Some(bucket_event("observer-mirror:ro2_bucket")), &status);
        sink.append(Some(bucket_event("observer-mirror:ro2_bucket")), &status);
        sink.append(Some(bucket_event("observer-mirror:ro2_next")), &status);

        assert_eq!(appended(&journal), vec!["observer.bridge.input"; 2]);
        assert_eq!(last_error(&status), None);
    }

    #[test]
    fn mirrors_nothing_without_a_legacy_journal() {
        let status = status();
        let mut sink = LegacyMirrorSink::new(None);

        sink.append(Some(bucket_event("observer-mirror:ro2_bucket")), &status);

        assert_eq!(last_error(&status), None);
    }

    #[test]
    fn a_failed_append_is_reported_until_the_next_success_and_hides_nothing_else() {
        assert_eq!(
            next_last_error(None, true).as_deref(),
            Some(LEGACY_MIRROR_FAILURE)
        );
        assert_eq!(next_last_error(Some(LEGACY_MIRROR_FAILURE), false), None);
        assert_eq!(
            next_last_error(Some("observer_reported_gap"), false).as_deref(),
            Some("observer_reported_gap")
        );
        assert_eq!(
            next_last_error(Some("observer_reported_gap"), true).as_deref(),
            Some(LEGACY_MIRROR_FAILURE)
        );
    }
}
