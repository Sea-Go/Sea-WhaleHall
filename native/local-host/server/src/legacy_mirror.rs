//! Appends the legacy desktop events that Observer frames mirror to.
//!
//! The append happens only after a frame has been acknowledged, so a slow
//! legacy journal can never make the helper drop observations. A failed
//! append is reported through the monitoring status and never escalates:
//! the observation itself is already durable in the observation journal.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use whalehall_local_core::events::{DesktopEventDraft, EventJournal, EventJournalError};
use whalehall_local_core::legacy_event_mirror::{
    LegacyForegroundSwitch, LegacyMirror, legacy_mirror_foreground_draft,
};
use whalehall_local_protocol::MonitoringStatusResult;

/// `MonitoringStatusResult::last_error` while the latest mirror append failed.
pub(crate) const LEGACY_MIRROR_FAILURE: &str = "observer_legacy_mirror_failed";

/// Upper bounds of the per-session memory. Each map is cleared when exceeded;
/// the helper session restarts with the Observer in any case.
const MAX_REMEMBERED_APPS: usize = 512;
const MAX_REMEMBERED_TABS: usize = 256;

type TabKey = (String, String);
type Page = (Option<String>, Option<String>);

/// The legacy journal of one helper session together with the memory that
/// keeps the mirror from repeating itself. Without a journal nothing is
/// mirrored.
#[derive(Default)]
pub(crate) struct LegacyMirrorSink<'a> {
    journal: Option<&'a EventJournal>,
    /// The newest window title seen for each application.
    known_titles: HashMap<String, String>,
    /// The application and title of the last title event that was appended.
    last_admitted_title: Option<(String, String)>,
    /// The host and title of the last navigation appended for each tab.
    last_navigations: HashMap<TabKey, Page>,
    /// Applications whose newest window or page was withheld as sensitive.
    sensitive_apps: HashSet<String>,
}

impl<'a> LegacyMirrorSink<'a> {
    pub(crate) fn new(journal: Option<&'a EventJournal>) -> Self {
        Self {
            journal,
            ..Default::default()
        }
    }

    pub(crate) fn append(
        &mut self,
        mirror: Option<LegacyMirror>,
        status: &Arc<Mutex<MonitoringStatusResult>>,
    ) {
        let Some(journal) = self.journal else {
            return;
        };
        self.append_with(mirror, status, |draft| journal.append(draft).map(|_| ()));
    }

    fn append_with(
        &mut self,
        mirror: Option<LegacyMirror>,
        status: &Arc<Mutex<MonitoringStatusResult>>,
        append: impl FnOnce(DesktopEventDraft) -> Result<(), EventJournalError>,
    ) {
        let Some(mirror) = mirror else {
            return;
        };
        if let Some(app_id) = mirror.sensitive_app_id.as_ref() {
            if self.sensitive_apps.len() >= MAX_REMEMBERED_APPS
                && !self.sensitive_apps.contains(app_id)
            {
                self.sensitive_apps.clear();
            }
            self.sensitive_apps.insert(app_id.clone());
        }
        // Nothing of an observation that was withheld as sensitive is mirrored.
        let draft = if mirror.sensitive_app_id.is_some() {
            None
        } else {
            mirror.draft
        };
        let draft = match (draft, mirror.foreground) {
            (Some(draft), _) => Some(draft),
            (None, Some(switch)) => self.pair_foreground(&switch),
            (None, None) => None,
        };
        let Some(draft) = draft else {
            return;
        };
        if !self.admit(&draft) {
            return;
        }
        let failed = append(draft.clone()).is_err();
        if !failed {
            self.remember(&draft);
        }
        let mut current = status.lock().unwrap_or_else(|error| error.into_inner());
        current.last_error = next_last_error(current.last_error.as_deref(), failed);
    }

    /// A foreground switch carries no content. It is reported together with
    /// the newest title the bridge has already seen for that application, so
    /// returning to a document whose title did not change is still described.
    fn pair_foreground(&self, switch: &LegacyForegroundSwitch) -> Option<DesktopEventDraft> {
        let title = self.known_titles.get(&switch.app_id)?;
        Some(legacy_mirror_foreground_draft(switch, title))
    }

    /// Decides whether an event adds anything, and records what it shows.
    fn admit(&mut self, draft: &DesktopEventDraft) -> bool {
        let Some(payload) = draft.payload.as_object() else {
            return false;
        };
        let app_id = text(payload, "appId");
        match draft.kind.as_str() {
            "accessibility.documentChanged" => {
                // While an application's window was withheld as sensitive its
                // typing counts would still tell that the user is active there.
                !app_id.is_some_and(|app_id| self.sensitive_apps.contains(app_id))
            }
            "browser.tabNavigated" => {
                let (Some(browser_id), Some(tab_id)) =
                    (text(payload, "browserId"), text(payload, "tabId"))
                else {
                    return false;
                };
                // The journal reports a navigation whenever a page's visible
                // text changes, which says nothing about where the user is.
                let page = (
                    text(payload, "url").map(ToOwned::to_owned),
                    text(payload, "title").map(ToOwned::to_owned),
                );
                let tab = (browser_id.to_owned(), tab_id.to_owned());
                if self.last_navigations.get(&tab) == Some(&page) {
                    return false;
                }
                if self.last_navigations.len() >= MAX_REMEMBERED_TABS
                    && !self.last_navigations.contains_key(&tab)
                {
                    self.last_navigations.clear();
                }
                self.last_navigations.insert(tab, page);
                true
            }
            "application.foregroundChanged" => {
                let (Some(app_id), Some(title)) = (app_id, text(payload, "windowTitle")) else {
                    return false;
                };
                // A title that reached the bridge was not withheld, so the
                // application is no longer treated as sensitive.
                self.sensitive_apps.remove(app_id);
                if self.known_titles.len() >= MAX_REMEMBERED_APPS
                    && !self.known_titles.contains_key(app_id)
                {
                    self.known_titles.clear();
                }
                self.known_titles
                    .insert(app_id.to_owned(), title.to_owned());
                self.last_admitted_title != Some((app_id.to_owned(), title.to_owned()))
            }
            _ => true,
        }
    }

    /// Records an appended event so that a repeat of it is not appended again.
    fn remember(&mut self, draft: &DesktopEventDraft) {
        let Some(payload) = draft.payload.as_object() else {
            return;
        };
        if draft.kind != "application.foregroundChanged" {
            return;
        }
        if let (Some(app_id), Some(title)) = (text(payload, "appId"), text(payload, "windowTitle"))
        {
            self.last_admitted_title = Some((app_id.to_owned(), title.to_owned()));
        }
    }
}

fn text<'a>(payload: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str)
}

/// The mirror's own failure marker is cleared by a later success and never
/// replaces a more specific observer error, so nothing else is hidden by it.
fn next_last_error(previous: Option<&str>, failed: bool) -> Option<String> {
    match (failed, previous) {
        (true, None | Some(LEGACY_MIRROR_FAILURE)) => Some(LEGACY_MIRROR_FAILURE.to_owned()),
        (true, other) => other.map(ToOwned::to_owned),
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

    const AT_MS: i64 = 1_700_000_000_000;

    fn event(
        kind: &str,
        source: &str,
        sensitivity: DesktopEventSensitivity,
        payload: Value,
        key: &str,
    ) -> DesktopEventDraft {
        let mut draft = DesktopEventDraft::metadata(kind, source, AT_MS, payload, key);
        draft.sensitivity = sensitivity;
        draft
    }

    fn title_event(app_id: &str, title: &str, key: &str) -> DesktopEventDraft {
        event(
            "application.foregroundChanged",
            "observer.bridge.workspace",
            DesktopEventSensitivity::Content,
            serde_json::json!({ "appId": app_id, "appName": "App", "windowTitle": title }),
            key,
        )
    }

    fn edit_event(app_id: &str, key: &str) -> DesktopEventDraft {
        event(
            "accessibility.documentChanged",
            "observer.bridge.accessibility",
            DesktopEventSensitivity::Metadata,
            serde_json::json!({ "appId": app_id, "insertedChars": 3, "deletedChars": 0 }),
            key,
        )
    }

    fn bucket_event(key: &str) -> DesktopEventDraft {
        event(
            "input.activityAggregated",
            "observer.bridge.input",
            DesktopEventSensitivity::Metadata,
            serde_json::json!({ "keyCount": 3 }),
            key,
        )
    }

    fn navigation_event(
        tab: &str,
        url: Option<&str>,
        title: Option<&str>,
        key: &str,
    ) -> DesktopEventDraft {
        let mut payload = serde_json::json!({
            "browserId": "com.example.browser",
            "tabId": tab,
        });
        if let Some(url) = url {
            payload["url"] = Value::String(url.to_owned());
        }
        if let Some(title) = title {
            payload["title"] = Value::String(title.to_owned());
        }
        let sensitivity = if url.is_some() || title.is_some() {
            DesktopEventSensitivity::Content
        } else {
            DesktopEventSensitivity::Metadata
        };
        event(
            "browser.tabNavigated",
            "observer.bridge.browser",
            sensitivity,
            payload,
            key,
        )
    }

    fn switch(app_id: &str, key: &str) -> LegacyMirror {
        LegacyMirror {
            draft: None,
            sensitive_app_id: None,
            foreground: Some(LegacyForegroundSwitch {
                app_id: app_id.to_owned(),
                app_name: "App".to_owned(),
                occurred_at_ms: AT_MS,
                observed_at_ms: AT_MS,
                observation_id: key.to_owned(),
            }),
        }
    }

    fn mirrored(draft: DesktopEventDraft) -> LegacyMirror {
        LegacyMirror {
            draft: Some(draft),
            sensitive_app_id: None,
            foreground: None,
        }
    }

    fn sensitive(app_id: &str) -> LegacyMirror {
        LegacyMirror {
            draft: Some(edit_event(app_id, "withheld")),
            sensitive_app_id: Some(app_id.to_owned()),
            foreground: None,
        }
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
            .map(|event| {
                format!(
                    "{}:{}",
                    event.kind,
                    event.payload["windowTitle"].as_str().unwrap_or_default()
                )
            })
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
            Some(mirrored(title_event(
                "com.example.reader",
                "Chapter 1",
                "k1",
            ))),
            &status,
        );
        sink.append(
            Some(mirrored(title_event(
                "com.example.reader",
                "Chapter 1",
                "k2",
            ))),
            &status,
        );
        sink.append(
            Some(mirrored(title_event(
                "com.example.reader",
                "Chapter 2",
                "k3",
            ))),
            &status,
        );
        sink.append(
            Some(mirrored(title_event(
                "com.example.editor",
                "Chapter 1",
                "k4",
            ))),
            &status,
        );

        assert_eq!(
            appended(&journal),
            vec![
                "application.foregroundChanged:Chapter 1",
                "application.foregroundChanged:Chapter 2",
                "application.foregroundChanged:Chapter 1",
            ]
        );
        assert_eq!(last_error(&status), None);
    }

    #[test]
    fn pairs_a_foreground_switch_with_the_title_already_seen_for_that_app() {
        let (_directory, journal) = journal("foreground");
        let status = status();
        let mut sink = LegacyMirrorSink::new(Some(&journal));

        // Notes is described once; an application without a known title adds nothing.
        sink.append(
            Some(mirrored(title_event(
                "com.example.notes",
                "Meeting notes",
                "k1",
            ))),
            &status,
        );
        sink.append(Some(switch("com.example.terminal", "k2")), &status);
        sink.append(Some(switch("com.example.notes", "k3")), &status);
        // Another document takes over, then the user comes back to Notes.
        sink.append(
            Some(mirrored(title_event("com.example.editor", "main.rs", "k4"))),
            &status,
        );
        sink.append(Some(switch("com.example.notes", "k5")), &status);
        sink.append(Some(switch("com.example.notes", "k6")), &status);

        assert_eq!(
            appended(&journal),
            vec![
                "application.foregroundChanged:Meeting notes",
                "application.foregroundChanged:main.rs",
                "application.foregroundChanged:Meeting notes",
            ]
        );
        assert_eq!(last_error(&status), None);
    }

    #[test]
    fn repeats_no_navigation_whose_host_and_title_did_not_change() {
        let (_directory, journal) = journal("navigation");
        let status = status();
        let mut sink = LegacyMirrorSink::new(Some(&journal));

        let page = |tab: &str, title: &str, key: &str| {
            navigation_event(tab, Some("example.com"), Some(title), key)
        };
        sink.append(Some(mirrored(page("tab-1", "Welcome", "k1"))), &status);
        sink.append(Some(mirrored(page("tab-1", "Welcome", "k2"))), &status);
        sink.append(Some(mirrored(page("tab-1", "Chapter 2", "k3"))), &status);
        sink.append(Some(mirrored(page("tab-2", "Chapter 2", "k4"))), &status);

        assert_eq!(appended(&journal), vec!["browser.tabNavigated:"; 3]);
        assert_eq!(last_error(&status), None);
    }

    #[test]
    fn mirrors_nothing_of_an_application_while_its_page_is_sensitive() {
        let (_directory, journal) = journal("sensitive");
        let status = status();
        let mut sink = LegacyMirrorSink::new(Some(&journal));

        sink.append(Some(sensitive("com.example.bank")), &status);
        sink.append(
            Some(mirrored(edit_event("com.example.bank", "k2"))),
            &status,
        );
        // Input buckets carry no application, so they cannot be tied to the page.
        sink.append(Some(mirrored(bucket_event("k3"))), &status);
        sink.append(
            Some(mirrored(edit_event("com.example.notes", "k4"))),
            &status,
        );
        // A later title that was not withheld ends the sensitive period.
        sink.append(
            Some(mirrored(title_event(
                "com.example.bank",
                "Overview - Acme",
                "k5",
            ))),
            &status,
        );
        sink.append(
            Some(mirrored(edit_event("com.example.bank", "k6"))),
            &status,
        );

        assert_eq!(
            appended(&journal),
            vec![
                "input.activityAggregated:",
                "accessibility.documentChanged:",
                "application.foregroundChanged:Overview - Acme",
                "accessibility.documentChanged:",
            ]
        );
        assert_eq!(last_error(&status), None);
    }

    #[test]
    fn appends_every_other_event_once_and_skips_replayed_frames() {
        let (_directory, journal) = journal("append");
        let status = status();
        let mut sink = LegacyMirrorSink::new(Some(&journal));

        sink.append(None, &status);
        sink.append(
            Some(mirrored(bucket_event("observer-mirror:ro2_bucket"))),
            &status,
        );
        sink.append(
            Some(mirrored(bucket_event("observer-mirror:ro2_bucket"))),
            &status,
        );
        sink.append(
            Some(mirrored(bucket_event("observer-mirror:ro2_next"))),
            &status,
        );

        assert_eq!(appended(&journal), vec!["input.activityAggregated:"; 2]);
        assert_eq!(last_error(&status), None);
    }

    #[test]
    fn mirrors_nothing_without_a_legacy_journal() {
        let status = status();
        let mut sink = LegacyMirrorSink::new(None);

        sink.append(
            Some(mirrored(bucket_event("observer-mirror:ro2_bucket"))),
            &status,
        );
        sink.append(Some(switch("com.example.notes", "k1")), &status);

        assert_eq!(last_error(&status), None);
    }

    #[test]
    fn keeps_a_title_retryable_when_its_append_fails() {
        let status = status();
        let mut sink = LegacyMirrorSink::new(None);
        let mut appended = Vec::new();

        sink.append_with(
            Some(mirrored(title_event(
                "com.example.notes",
                "Meeting notes",
                "k1",
            ))),
            &status,
            |_| Err::<(), _>(EventJournalError::Configuration("disk full".to_owned())),
        );
        assert_eq!(last_error(&status).as_deref(), Some(LEGACY_MIRROR_FAILURE));

        // The failed title was not recorded as appended, so the next switch
        // back to the document carries it again.
        sink.append_with(Some(switch("com.example.notes", "k2")), &status, |draft| {
            appended.push(
                draft.payload["windowTitle"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            );
            Ok::<(), EventJournalError>(())
        });
        assert_eq!(appended, vec!["Meeting notes"]);
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
        // A sequence gap reported in the same frame outranks the mirror.
        assert_eq!(
            next_last_error(Some("observer_sequence_gap"), true).as_deref(),
            Some("observer_sequence_gap")
        );
    }
}
