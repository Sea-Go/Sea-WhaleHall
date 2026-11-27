//! Projects a bounded subset of Observer semantic projections into legacy
//! desktop events for the activity reflection journal.
//!
//! Only signal counts and window or page titles cross this bridge. Visible
//! text, typed text, control labels and full URLs never do: the reflection
//! needs to tell editing from reading, not to read the screen.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use whalehall_local_protocol::{
    CoverageLevelV2, DesktopEventSensitivity, SemanticContentStateV2, SemanticCountClassV2,
    semantic_event_kinds,
};

use crate::events::DesktopEventDraft;

pub const MIRROR_DEDUP_PREFIX: &str = "observer-mirror:";
pub const MIRROR_SOURCE_INPUT: &str = "observer.bridge.input";
pub const MIRROR_SOURCE_ACCESSIBILITY: &str = "observer.bridge.accessibility";
pub const MIRROR_SOURCE_BROWSER: &str = "observer.bridge.browser";
pub const MIRROR_SOURCE_WORKSPACE: &str = "observer.bridge.workspace";

/// The most title characters one mirrored event carries.
pub const MAX_TITLE_CHARS: usize = 120;

const INPUT_BUCKET_MS: i64 = 5_000;
const MAX_COALESCED_BUCKETS: i64 = 256;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_INPUT_MAGNITUDE: f64 = 1e12;

/// Title or host fragments that describe a page the user would not want
/// summarized. Matched case-insensitively as substrings.
const SENSITIVE_MARKERS: &[&str] = &[
    "password",
    "passwd",
    "passcode",
    "密码",
    "口令",
    "login",
    "log in",
    "sign in",
    "signin",
    "登录",
    "登陆",
    "checkout",
    "alipay",
    "paypal",
    "stripe",
    "支付",
    "付款",
    "网银",
    "银行",
    "bank",
    "wallet",
    "钱包",
    "转账",
    "信用卡",
    "credit card",
    "otp",
    "验证码",
    "动态码",
    "2fa",
    "双重认证",
    "incognito",
    "inprivate",
    "隐身",
    "无痕",
];

/// The fields of one semantic projection that the bridge may read.
pub struct LegacyMirrorProjection<'a> {
    pub kind: &'a str,
    pub count_class: SemanticCountClassV2,
    pub content_state: SemanticContentStateV2,
    pub coverage: &'a [CoverageLevelV2],
    /// Why the journal withheld content of the observation.
    pub redactions: &'a [String],
    pub metadata: &'a Value,
    pub content: Option<&'a Value>,
    pub occurred_at_ms: i64,
    pub observed_at_ms: i64,
    pub observation_id: &'a str,
}

struct Mirrored {
    kind: &'static str,
    source: &'static str,
    sensitivity: DesktopEventSensitivity,
    payload: Map<String, Value>,
}

/// A foreground switch. It carries no content of its own, so the bridge pairs
/// it with the newest title it has already seen for that application.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyForegroundSwitch {
    pub app_id: String,
    pub app_name: String,
    pub occurred_at_ms: i64,
    pub observed_at_ms: i64,
    pub observation_id: String,
}

/// What one inserted observation contributes to the legacy reflection journal.
#[derive(Clone, Debug, PartialEq)]
pub struct LegacyMirror {
    /// The event to append. It is always absent for a sensitive observation.
    pub draft: Option<DesktopEventDraft>,
    /// The application whose window title or page was withheld as sensitive.
    /// Nothing of that application is mirrored until its title changes.
    pub sensitive_app_id: Option<String>,
    pub foreground: Option<LegacyForegroundSwitch>,
}

/// Returns what a projection contributes to the legacy reflection journal, or
/// `None` when it contributes nothing.
pub fn project_legacy_mirror(projection: &LegacyMirrorProjection<'_>) -> Option<LegacyMirror> {
    if projection.count_class != SemanticCountClassV2::Effective {
        return None;
    }
    if projection.kind == semantic_event_kinds::APPLICATION_FOREGROUND_CHANGED {
        // A redacted switch belongs to an excluded or protected application.
        if projection.coverage.contains(&CoverageLevelV2::Redacted) {
            return None;
        }
        let metadata = metadata_object(projection)?;
        let (Some(app_id), Some(app_name)) = (
            bounded_string(metadata.get("appId"), 512),
            bounded_string(metadata.get("appName"), 512),
        ) else {
            return None;
        };
        return Some(LegacyMirror {
            draft: None,
            sensitive_app_id: None,
            foreground: Some(LegacyForegroundSwitch {
                app_id,
                app_name,
                occurred_at_ms: projection.occurred_at_ms,
                observed_at_ms: projection.observed_at_ms,
                observation_id: projection.observation_id.to_owned(),
            }),
        });
    }
    let sensitive_app_id = sensitive_app(projection);
    // Nothing of an observation that was withheld as sensitive is mirrored:
    // a title alone would still tell which page the user is on.
    let draft = if sensitive_app_id.is_some() {
        None
    } else {
        legacy_mirror_draft(projection)
    };
    if draft.is_none() && sensitive_app_id.is_none() {
        return None;
    }
    Some(LegacyMirror {
        draft,
        sensitive_app_id,
        foreground: None,
    })
}

/// The title-bearing event of a foreground switch. The caller supplies a title
/// the bridge has already admitted through [`legacy_mirror_draft`].
pub fn legacy_mirror_foreground_draft(
    switch: &LegacyForegroundSwitch,
    title: &str,
) -> DesktopEventDraft {
    let mut payload = Map::new();
    payload.insert("appId".to_owned(), Value::String(switch.app_id.clone()));
    payload.insert("appName".to_owned(), Value::String(switch.app_name.clone()));
    payload.insert("windowTitle".to_owned(), Value::String(title.to_owned()));
    let mut draft = DesktopEventDraft::metadata(
        "application.foregroundChanged",
        MIRROR_SOURCE_WORKSPACE,
        switch.occurred_at_ms,
        Value::Object(payload),
        format!("{MIRROR_DEDUP_PREFIX}{}", switch.observation_id),
    );
    draft.observed_at_ms = switch.observed_at_ms.max(switch.occurred_at_ms);
    draft.sensitivity = DesktopEventSensitivity::Content;
    draft
}

/// Returns the legacy desktop event a projection mirrors to, if any.
///
/// The deduplication key is derived from the observation, so replaying the
/// same observation appends nothing twice.
pub fn legacy_mirror_draft(projection: &LegacyMirrorProjection<'_>) -> Option<DesktopEventDraft> {
    if projection.count_class != SemanticCountClassV2::Effective {
        return None;
    }
    let mirrored = match projection.kind {
        semantic_event_kinds::INPUT_ACTIVITY_BUCKET => input_activity(projection),
        semantic_event_kinds::APPLICATION_TEXT_VALUE_CHANGED => document_change(projection),
        semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED => browser_navigation(projection),
        semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED => window_title(projection),
        _ => None,
    }?;
    let mut draft = DesktopEventDraft::metadata(
        mirrored.kind,
        mirrored.source,
        projection.occurred_at_ms,
        Value::Object(mirrored.payload),
        format!("{MIRROR_DEDUP_PREFIX}{}", projection.observation_id),
    );
    draft.observed_at_ms = projection.observed_at_ms.max(projection.occurred_at_ms);
    draft.sensitivity = mirrored.sensitivity;
    Some(draft)
}

fn input_activity(projection: &LegacyMirrorProjection<'_>) -> Option<Mirrored> {
    let metadata = metadata_object(projection)?;
    let started_at_ms = safe_integer(metadata.get("bucketStartedAtMs"))?;
    let ended_at_ms = safe_integer(metadata.get("bucketEndedAtMs"))?;
    let key_count = safe_integer(metadata.get("keyCount"))?;
    let click_count = safe_integer(metadata.get("clickCount"))?;
    let scroll_delta = finite_number(metadata.get("scrollDelta"))?;
    let mouse_distance = finite_number(metadata.get("mouseDistance"))?;
    // Pointer travel alone says nothing about sustained input.
    if key_count == 0 && click_count == 0 && scroll_delta == 0.0 {
        return None;
    }
    if scroll_delta.abs() > MAX_INPUT_MAGNITUDE
        || !(0.0..=MAX_INPUT_MAGNITUDE).contains(&mouse_distance)
    {
        return None;
    }
    let coalesced = match metadata.get("coalescedBucketCount") {
        None => 1,
        Some(value) => safe_integer(Some(value))?,
    };
    if !(1..=MAX_COALESCED_BUCKETS).contains(&coalesced)
        || ended_at_ms - started_at_ms != coalesced * INPUT_BUCKET_MS
    {
        return None;
    }
    // Keep the observer's own number representation on the wire.
    let scroll_delta_value = metadata.get("scrollDelta").cloned()?;
    let mouse_distance_value = metadata.get("mouseDistance").cloned()?;
    let mut payload = Map::new();
    payload.insert("bucketStartedAtMs".to_owned(), json!(started_at_ms));
    payload.insert("bucketEndedAtMs".to_owned(), json!(ended_at_ms));
    payload.insert("keyCount".to_owned(), json!(key_count));
    payload.insert("clickCount".to_owned(), json!(click_count));
    payload.insert("scrollDelta".to_owned(), scroll_delta_value);
    payload.insert("mouseDistance".to_owned(), mouse_distance_value);
    if coalesced > 1 {
        payload.insert("coalescedBucketCount".to_owned(), json!(coalesced));
    }
    Some(Mirrored {
        kind: "input.activityAggregated",
        source: MIRROR_SOURCE_INPUT,
        sensitivity: DesktopEventSensitivity::Metadata,
        payload,
    })
}

fn document_change(projection: &LegacyMirrorProjection<'_>) -> Option<Mirrored> {
    let metadata = metadata_object(projection)?;
    // A redacted change belongs to a field the observer refuses to describe.
    if projection.content_state == SemanticContentStateV2::Redacted
        || projection.coverage.contains(&CoverageLevelV2::Redacted)
    {
        return None;
    } // Without a prior value the projector reports a zero baseline, and caret
    // moves report zero deltas. Neither is evidence of an edit.
    if metadata.get("deltaAvailable") != Some(&Value::Bool(true)) {
        return None;
    }
    let inserted_chars = safe_integer(metadata.get("insertedChars"))?;
    let deleted_chars = safe_integer(metadata.get("deletedChars"))?;
    if inserted_chars == 0 && deleted_chars == 0 {
        return None;
    }
    let app_id = bounded_string(metadata.get("appId"), 512)?;
    let mut payload = Map::new();
    payload.insert("appId".to_owned(), Value::String(app_id));
    payload.insert("insertedChars".to_owned(), json!(inserted_chars));
    payload.insert("deletedChars".to_owned(), json!(deleted_chars));
    Some(Mirrored {
        kind: "accessibility.documentChanged",
        source: MIRROR_SOURCE_ACCESSIBILITY,
        sensitivity: DesktopEventSensitivity::Metadata,
        payload,
    })
}

fn window_title(projection: &LegacyMirrorProjection<'_>) -> Option<Mirrored> {
    let title = content_hint(projection, "windowTitle")?;
    let metadata = metadata_object(projection)?;
    let mut payload = Map::new();
    payload.insert(
        "appId".to_owned(),
        Value::String(bounded_string(metadata.get("appId"), 512)?),
    );
    payload.insert(
        "appName".to_owned(),
        Value::String(bounded_string(metadata.get("appName"), 512)?),
    );
    payload.insert("windowTitle".to_owned(), Value::String(title));
    Some(Mirrored {
        kind: "application.foregroundChanged",
        source: MIRROR_SOURCE_WORKSPACE,
        sensitivity: DesktopEventSensitivity::Content,
        payload,
    })
}

fn browser_navigation(projection: &LegacyMirrorProjection<'_>) -> Option<Mirrored> {
    let metadata = metadata_object(projection)?;
    // The same page observed again is not a navigation.
    if metadata.get("changeKind").and_then(Value::as_str) == Some("content_changed") {
        return None;
    }
    let app_id = bounded_string(metadata.get("appId"), 256)?;
    let tab_id = metadata
        .get("opaqueWindowId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.chars().count() <= 256)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("app-{}", short_digest(app_id.as_bytes())));
    // A search results page puts the query, which the user typed, into its title.
    let search_page = content_url(projection).is_some_and(is_search_request);
    let title = if search_page {
        None
    } else {
        content_hint(projection, "title")
    };
    let domain = content_hint(projection, "domain").filter(|value| is_host(value));
    let sensitivity = if title.is_some() || domain.is_some() {
        DesktopEventSensitivity::Content
    } else {
        DesktopEventSensitivity::Metadata
    };
    let mut payload = Map::new();
    payload.insert("browserId".to_owned(), Value::String(app_id));
    payload.insert("tabId".to_owned(), Value::String(tab_id));
    if let Some(domain) = domain {
        payload.insert("url".to_owned(), Value::String(domain));
    }
    if let Some(title) = title {
        payload.insert("title".to_owned(), Value::String(title));
    }
    Some(Mirrored {
        kind: "browser.tabNavigated",
        source: MIRROR_SOURCE_BROWSER,
        sensitivity,
        payload,
    })
}

/// Reads one content hint. It fails closed unless the content was sealed for
/// this observation and no coverage level limits it.
fn content_hint(projection: &LegacyMirrorProjection<'_>, key: &str) -> Option<String> {
    if projection.content_state != SemanticContentStateV2::Available
        || projection.coverage.iter().any(|level| {
            matches!(
                level,
                CoverageLevelV2::Denied | CoverageLevelV2::Unavailable | CoverageLevelV2::Redacted
            )
        })
    {
        return None;
    }
    let content = projection.content?.as_object()?;
    let value = content.get(key)?.as_str()?.trim();
    let is_title = matches!(key, "windowTitle" | "title");
    if value.is_empty()
        || mentions_sensitive_page(value)
        || (is_title && (looks_like_address(value) || is_search_result_title(value)))
    {
        return None;
    }
    Some(
        value
            .chars()
            .take(MAX_TITLE_CHARS)
            .collect::<String>()
            .trim_end()
            .to_owned(),
    )
}

fn content_url<'a>(projection: &LegacyMirrorProjection<'a>) -> Option<&'a str> {
    projection
        .content
        .and_then(Value::as_object)
        .and_then(|content| content.get("url"))
        .and_then(Value::as_str)
}

fn mentions_sensitive_page(value: &str) -> bool {
    let lowercase = value.to_lowercase();
    SENSITIVE_MARKERS
        .iter()
        .any(|marker| lowercase.contains(marker))
}

/// A browser shows the address as the title of a page that has none, so a
/// title that is an address would carry its path and query across the bridge.
fn looks_like_address(value: &str) -> bool {
    let value = value.trim().to_lowercase();
    if value.contains("://") || value.starts_with("www.") {
        return true;
    }
    // The scheme-less form a browser displays: a host, then a path or a query.
    let Some(separator) = value.find(['/', '?']) else {
        return false;
    };
    let mut host = &value[..separator];
    if let Some(port_start) = host.rfind(':') {
        let port = &host[port_start + 1..];
        if !port.is_empty() && port.chars().all(|character| character.is_ascii_digit()) {
            host = &host[..port_start];
        }
    }
    let host = host.trim_end_matches('.');
    host == "localhost"
        || (host.contains('.')
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
            }))
}

/// Search engines and in-site searches echo the query, which the user typed,
/// in a page title that ends with the engine or site name behind a separator.
fn is_search_result_title(value: &str) -> bool {
    let lowercase = value.trim().to_lowercase();
    // DuckDuckGo names its results page "<query> at DuckDuckGo".
    if lowercase.ends_with(" at duckduckgo") {
        return true;
    }
    let Some(separator) = lowercase.rfind(['-', '–', '—', '_', '|']) else {
        return false;
    };
    let tail = lowercase[separator + 1..].trim();
    SEARCH_TITLE_TAILS.contains(&tail)
}

/// Whether a page address is a search request: a search path, or a query that
/// carries one of the usual search parameters.
fn is_search_request(url: &str) -> bool {
    let lowercase = url.to_lowercase();
    let Some(scheme_end) = lowercase.find("://") else {
        return false;
    };
    let after_scheme = &lowercase[scheme_end + 3..];
    let Some(path_start) = after_scheme.find('/') else {
        return false;
    };
    let (path, query) = after_scheme[path_start..]
        .split_once('?')
        .unwrap_or((&after_scheme[path_start..], ""));
    let search_path = ["/search", "/s", "/so", "/webhp", "/results", "/query"]
        .iter()
        .any(|prefix| {
            path == *prefix
                || path
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with(['/', '.', ';']))
        });
    let search_query = query.split('&').any(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        !value.is_empty() && SEARCH_QUERY_KEYS.contains(&key)
    });
    search_path || search_query
}

const SEARCH_QUERY_KEYS: &[&str] = &[
    "q",
    "query",
    "wd",
    "kw",
    "keyword",
    "search",
    "search_query",
];

const SEARCH_TITLE_TAILS: &[&str] = &[
    "google 搜索",
    "google search",
    "百度搜索",
    "必应",
    "bing",
    "duckduckgo",
    "at duckduckgo",
    "yandex",
    "brave search",
    "搜狗搜索",
    "360搜索",
    "搜索",
    "search",
    "搜索结果",
    "search results",
    "站内搜索",
    "results",
];

/// The application of a window or page observation whose content was withheld
/// as sensitive: the journal redacted it, or an available title, host or URL
/// matches a sensitive-page marker. Text changes say nothing about the whole
/// surface, so a redacted password field never marks its application.
fn sensitive_app(projection: &LegacyMirrorProjection<'_>) -> Option<String> {
    let describes_surface = matches!(
        projection.kind,
        semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED
            | semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED
    );
    if !describes_surface {
        return None;
    }
    // Without the Automation permission the observer cannot tell a private
    // window from a normal one and withholds every page. That says nothing
    // about the page itself, so it never marks the browser.
    let privacy_unknown_only = !projection.redactions.is_empty()
        && projection
            .redactions
            .iter()
            .all(|reason| reason == "browser_privacy_state_unavailable");
    let redacted =
        projection.content_state == SemanticContentStateV2::Redacted && !privacy_unknown_only;
    let matches_marker = projection.content_state == SemanticContentStateV2::Available
        && projection
            .content
            .and_then(Value::as_object)
            .is_some_and(|content| {
                ["windowTitle", "title", "domain", "url"].iter().any(|key| {
                    content
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(mentions_sensitive_page)
                })
            });
    if !(redacted || matches_marker) {
        return None;
    }
    bounded_string(metadata_object(projection)?.get("appId"), 512)
}

fn is_host(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 253
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | ':' | '[' | ']')
        })
}

fn metadata_object<'a>(projection: &LegacyMirrorProjection<'a>) -> Option<&'a Map<String, Value>> {
    projection.metadata.as_object()
}

fn safe_integer(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|integer| (0..=MAX_SAFE_INTEGER).contains(integer))
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn bounded_string(value: Option<&Value>, maximum_chars: usize) -> Option<String> {
    let value = value?.as_str()?;
    (!value.is_empty() && value.chars().count() <= maximum_chars).then(|| value.to_owned())
}

fn short_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTED_AT_MS: i64 = 1_700_000_000_000;
    const ENDED_AT_MS: i64 = STARTED_AT_MS + 5_000;
    const OBSERVATION_ID: &str = "ro2_4c1d5e7a9b3f4e6d8a0c2b4e6f8a0b1c";
    const CONTENT_COVERAGE: [CoverageLevelV2; 1] = [CoverageLevelV2::Content];

    fn projection<'a>(
        kind: &'a str,
        metadata: &'a Value,
        content: Option<&'a Value>,
    ) -> LegacyMirrorProjection<'a> {
        LegacyMirrorProjection {
            kind,
            count_class: SemanticCountClassV2::Effective,
            content_state: SemanticContentStateV2::Available,
            coverage: &CONTENT_COVERAGE,
            redactions: &[],
            metadata,
            content,
            occurred_at_ms: STARTED_AT_MS,
            observed_at_ms: ENDED_AT_MS,
            observation_id: OBSERVATION_ID,
        }
    }

    fn bucket(key_count: i64, click_count: i64, scroll_delta: f64) -> Value {
        json!({
            "appId": "com.example.editor",
            "appName": "Editor",
            "opaqueWindowId": "ow1_window",
            "bucketStartedAtMs": STARTED_AT_MS,
            "bucketEndedAtMs": ENDED_AT_MS,
            "keyCount": key_count,
            "clickCount": click_count,
            "scrollDelta": scroll_delta,
            "mouseDistance": 128.5,
        })
    }

    fn text_change(delta_available: bool, inserted: i64, deleted: i64) -> Value {
        json!({
            "appId": "com.example.editor",
            "appName": "Editor",
            "role": "AXTextArea",
            "opaqueControlId": "oc1_area",
            "insertedChars": inserted,
            "deletedChars": deleted,
            "deltaAvailable": delta_available,
            "inputMethod": "unknown",
        })
    }

    fn visible(title: Option<&str>) -> (Value, Option<Value>) {
        (
            json!({
                "appId": "com.example.reader",
                "appName": "Reader",
                "opaqueWindowId": "ow1_reader",
                "contentHash": "deadbeef",
            }),
            title.map(|title| json!({ "windowTitle": title, "visibleText": "private body" })),
        )
    }

    fn payload(draft: &DesktopEventDraft) -> &Map<String, Value> {
        draft
            .payload
            .as_object()
            .expect("mirrored payload is an object")
    }

    #[test]
    fn mirrors_input_bucket_counts_as_metadata() {
        let metadata = bucket(6, 0, 12.5);
        let draft = legacy_mirror_draft(&projection(
            semantic_event_kinds::INPUT_ACTIVITY_BUCKET,
            &metadata,
            None,
        ))
        .expect("typed input mirrors");

        assert_eq!(draft.kind, "input.activityAggregated");
        assert_eq!(draft.source, MIRROR_SOURCE_INPUT);
        assert_eq!(draft.sensitivity, DesktopEventSensitivity::Metadata);
        assert_eq!(
            draft.deduplication_key,
            format!("{MIRROR_DEDUP_PREFIX}{OBSERVATION_ID}")
        );
        assert_eq!(draft.occurred_at_ms, STARTED_AT_MS);
        assert_eq!(draft.observed_at_ms, ENDED_AT_MS);
        assert_eq!(
            payload(&draft),
            json!({
                "bucketStartedAtMs": STARTED_AT_MS,
                "bucketEndedAtMs": ENDED_AT_MS,
                "keyCount": 6,
                "clickCount": 0,
                "scrollDelta": 12.5,
                "mouseDistance": 128.5,
            })
            .as_object()
            .unwrap()
        );
    }

    #[test]
    fn keeps_the_coalesced_bucket_count_only_when_the_duration_matches() {
        let mut metadata = bucket(3, 1, 0.0);
        metadata["bucketEndedAtMs"] = json!(STARTED_AT_MS + 15_000);
        metadata["coalescedBucketCount"] = json!(3);
        let coalesced = legacy_mirror_draft(&projection(
            semantic_event_kinds::INPUT_ACTIVITY_BUCKET,
            &metadata,
            None,
        ))
        .expect("three coalesced buckets mirror");
        assert_eq!(payload(&coalesced)["coalescedBucketCount"], json!(3));

        metadata["coalescedBucketCount"] = json!(2);
        assert!(
            legacy_mirror_draft(&projection(
                semantic_event_kinds::INPUT_ACTIVITY_BUCKET,
                &metadata,
                None
            ))
            .is_none()
        );
    }

    #[test]
    fn drops_mouse_only_input_buckets() {
        let metadata = bucket(0, 0, 0.0);
        assert!(
            legacy_mirror_draft(&projection(
                semantic_event_kinds::INPUT_ACTIVITY_BUCKET,
                &metadata,
                None
            ))
            .is_none()
        );
    }

    #[test]
    fn mirrors_only_real_text_deltas_without_the_control_role() {
        let edited = legacy_mirror_draft(&projection(
            semantic_event_kinds::APPLICATION_TEXT_VALUE_CHANGED,
            &text_change(true, 14, 2),
            None,
        ))
        .expect("a real delta mirrors");
        assert_eq!(edited.kind, "accessibility.documentChanged");
        assert_eq!(edited.sensitivity, DesktopEventSensitivity::Metadata);
        assert_eq!(
            payload(&edited),
            json!({ "appId": "com.example.editor", "insertedChars": 14, "deletedChars": 2 })
                .as_object()
                .unwrap()
        );

        for metadata in [text_change(false, 14, 2), text_change(true, 0, 0)] {
            assert!(
                legacy_mirror_draft(&projection(
                    semantic_event_kinds::APPLICATION_TEXT_VALUE_CHANGED,
                    &metadata,
                    None
                ))
                .is_none()
            );
        }
    }

    #[test]
    fn mirrors_a_window_title_but_never_the_visible_text() {
        let (metadata, content) = visible(Some("  第 2 章 网络层 - 笔记.app  "));
        let draft = legacy_mirror_draft(&projection(
            semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
            &metadata,
            content.as_ref(),
        ))
        .expect("a sealed title mirrors");

        assert_eq!(draft.kind, "application.foregroundChanged");
        assert_eq!(draft.source, MIRROR_SOURCE_WORKSPACE);
        assert_eq!(draft.sensitivity, DesktopEventSensitivity::Content);
        assert_eq!(
            payload(&draft),
            json!({
                "appId": "com.example.reader",
                "appName": "Reader",
                "windowTitle": "第 2 章 网络层 - 笔记.app",
            })
            .as_object()
            .unwrap()
        );
    }

    #[test]
    fn withholds_titles_that_are_limited_unsealed_truncated_or_sensitive() {
        let (metadata, content) = visible(Some("网上银行 - 转账"));
        let mut limited = projection(
            semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
            &metadata,
            content.as_ref(),
        );
        limited.coverage = &[CoverageLevelV2::Content, CoverageLevelV2::Redacted];
        assert!(legacy_mirror_draft(&limited).is_none());

        let mut unsealed = projection(
            semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
            &metadata,
            content.as_ref(),
        );
        unsealed.content_state = SemanticContentStateV2::Unavailable;
        assert!(legacy_mirror_draft(&unsealed).is_none());

        assert!(
            legacy_mirror_draft(&projection(
                semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
                &metadata,
                content.as_ref()
            ))
            .is_none()
        );

        let long_title = "标".repeat(300);
        let (metadata, content) = visible(Some(&long_title));
        let truncated = legacy_mirror_draft(&projection(
            semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
            &metadata,
            content.as_ref(),
        ))
        .expect("a long title still mirrors");
        assert_eq!(
            payload(&truncated)["windowTitle"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            MAX_TITLE_CHARS
        );

        for title in [
            "Welcome, Login",
            "Enter your Password",
            "Sign in - Google",
            "Checkout · Stripe",
            "Incognito",
        ] {
            let (metadata, content) = visible(Some(title));
            assert!(
                legacy_mirror_draft(&projection(
                    semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
                    &metadata,
                    content.as_ref()
                ))
                .is_none(),
                "{title}"
            );
        }
    }

    #[test]
    fn mirrors_a_browser_navigation_with_only_the_host_and_title() {
        let metadata = json!({
            "appId": "com.example.browser",
            "appName": "Browser",
            "opaqueWindowId": "ow1_browser",
            "contentHash": "cafebabe",
            "changeKind": "navigated",
        });
        let content = json!({
            "domain": "developer.mozilla.org",
            "url": "https://developer.mozilla.org/docs?lang=zh#fragment",
            "title": "HTTP 概述 - MDN",
            "visibleText": "private body",
        });
        let draft = legacy_mirror_draft(&projection(
            semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED,
            &metadata,
            Some(&content),
        ))
        .expect("a navigation mirrors");

        assert_eq!(draft.kind, "browser.tabNavigated");
        assert_eq!(draft.sensitivity, DesktopEventSensitivity::Content);
        assert_eq!(
            payload(&draft),
            json!({
                "browserId": "com.example.browser",
                "tabId": "ow1_browser",
                "url": "developer.mozilla.org",
                "title": "HTTP 概述 - MDN",
            })
            .as_object()
            .unwrap()
        );
    }

    #[test]
    fn keeps_a_browser_navigation_without_sealed_content_to_metadata() {
        let mut metadata = json!({
            "appId": "com.example.browser",
            "appName": "Browser",
            "contentHash": "cafebabe",
            "changeKind": "opened",
        });
        metadata.as_object_mut().unwrap().remove("opaqueWindowId");
        let draft = legacy_mirror_draft(&projection(
            semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED,
            &metadata,
            None,
        ))
        .expect("a navigation without content still opens a research segment");
        let payload = payload(&draft);
        assert_eq!(draft.sensitivity, DesktopEventSensitivity::Metadata);
        assert_eq!(payload["browserId"], json!("com.example.browser"));
        assert!(payload["tabId"].as_str().unwrap().starts_with("app-"));
        assert_eq!(payload.len(), 2);

        metadata["changeKind"] = json!("content_changed");
        assert!(
            legacy_mirror_draft(&projection(
                semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED,
                &metadata,
                None
            ))
            .is_none()
        );
    }

    #[test]
    fn withholds_a_browser_host_that_is_sensitive_or_not_a_host() {
        let metadata = json!({
            "appId": "com.example.browser",
            "appName": "Browser",
            "changeKind": "navigated",
        });
        for host in ["bank.example.com", "not a host", "https://example.com/path"] {
            let content = json!({ "domain": host, "title": "Overview" });
            let draft = legacy_mirror_draft(&projection(
                semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED,
                &metadata,
                Some(&content),
            ))
            .expect("the title alone still mirrors");
            assert!(payload(&draft).get("url").is_none(), "{host}");
        }
    }

    #[test]
    fn never_mirrors_boundary_unknown_or_focus_events() {
        let metadata = json!({ "state": "afk_started", "idleForMs": 300_000 });
        let mut boundary = projection(semantic_event_kinds::PRESENCE_CHANGED, &metadata, None);
        boundary.count_class = SemanticCountClassV2::Boundary;
        assert!(legacy_mirror_draft(&boundary).is_none());

        let focus =
            json!({ "appId": "com.example.editor", "appName": "Editor", "role": "AXTextArea" });
        assert!(
            legacy_mirror_draft(&projection(
                semantic_event_kinds::UI_FOCUS_CHANGED,
                &focus,
                None
            ))
            .is_none()
        );
        assert!(legacy_mirror_draft(&projection("coverage.gap", &metadata, None)).is_none());
        // A foreground switch has no content of its own to mirror.
        let (metadata, content) = visible(Some("Chapter 1"));
        assert!(
            legacy_mirror_draft(&projection(
                semantic_event_kinds::APPLICATION_FOREGROUND_CHANGED,
                &metadata,
                content.as_ref(),
            ))
            .is_none()
        );
    }

    #[test]
    fn reports_a_foreground_switch_without_content() {
        let metadata =
            json!({ "appId": "com.example.reader", "appName": "Reader", "processId": 42 });
        let mirror = project_legacy_mirror(&projection(
            semantic_event_kinds::APPLICATION_FOREGROUND_CHANGED,
            &metadata,
            None,
        ))
        .expect("a foreground switch is reported");

        assert!(mirror.draft.is_none());
        assert!(mirror.sensitive_app_id.is_none());
        let switch = mirror
            .foreground
            .expect("the switch is described for the bridge");
        assert_eq!(switch.app_id, "com.example.reader");
        assert_eq!(switch.observation_id, OBSERVATION_ID);

        let draft = legacy_mirror_foreground_draft(&switch, "Chapter 1");
        assert_eq!(draft.kind, "application.foregroundChanged");
        assert_eq!(draft.source, MIRROR_SOURCE_WORKSPACE);
        assert_eq!(draft.sensitivity, DesktopEventSensitivity::Content);
        assert_eq!(
            draft.deduplication_key,
            format!("{MIRROR_DEDUP_PREFIX}{OBSERVATION_ID}")
        );
        assert_eq!(draft.occurred_at_ms, STARTED_AT_MS);
        assert_eq!(draft.observed_at_ms, ENDED_AT_MS);
        assert_eq!(
            payload(&draft),
            json!({
                "appId": "com.example.reader",
                "appName": "Reader",
                "windowTitle": "Chapter 1",
            })
            .as_object()
            .unwrap()
        );
    }

    #[test]
    fn marks_a_sensitive_window_or_page_and_mirrors_nothing_of_it() {
        let (metadata, content) = visible(Some("Stripe Dashboard - Payments"));
        let window = project_legacy_mirror(&projection(
            semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
            &metadata,
            content.as_ref(),
        ))
        .expect("a sensitive window is reported");
        assert_eq!(
            window.sensitive_app_id.as_deref(),
            Some("com.example.reader")
        );
        assert!(window.draft.is_none());

        // A host that matches a marker withholds the title as well.
        let navigation = json!({
            "appId": "com.example.browser",
            "appName": "Browser",
            "changeKind": "navigated",
            "opaqueWindowId": "ow1_tab",
            "contentHash": "deadbeef",
        });
        let page = json!({
            "domain": "bank.example.com",
            "title": "Overview",
            "url": "https://bank.example.com/overview",
            "visibleText": "private body",
        });
        let tab = project_legacy_mirror(&projection(
            semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED,
            &navigation,
            Some(&page),
        ))
        .expect("a sensitive page is reported");
        assert_eq!(tab.sensitive_app_id.as_deref(), Some("com.example.browser"));
        assert!(tab.draft.is_none());

        // Only the URL reveals this one; it is enough to withhold the page.
        let sign_in = json!({
            "domain": "example.com",
            "title": "Welcome",
            "url": "https://example.com/login?next=/dashboard",
            "visibleText": "private body",
        });
        let tab = project_legacy_mirror(&projection(
            semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED,
            &navigation,
            Some(&sign_in),
        ))
        .expect("a sign-in page is reported");
        assert_eq!(tab.sensitive_app_id.as_deref(), Some("com.example.browser"));
        assert!(tab.draft.is_none());
    }

    #[test]
    fn marks_a_redacted_window_but_never_mirrors_a_redacted_text_change() {
        let (metadata, content) = visible(Some("Untitled"));
        let mut redacted_window = projection(
            semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
            &metadata,
            content.as_ref(),
        );
        redacted_window.content_state = SemanticContentStateV2::Redacted;
        let window =
            project_legacy_mirror(&redacted_window).expect("a redacted window is reported");
        assert_eq!(
            window.sensitive_app_id.as_deref(),
            Some("com.example.reader")
        );
        assert!(window.draft.is_none());

        let edit = text_change(true, 3, 0);
        let mut redacted_edit = projection(
            semantic_event_kinds::APPLICATION_TEXT_VALUE_CHANGED,
            &edit,
            None,
        );
        redacted_edit.content_state = SemanticContentStateV2::Redacted;
        assert!(project_legacy_mirror(&redacted_edit).is_none());

        // Without the Automation permission every browser page is redacted,
        // because the observer cannot tell a private window from a normal one.
        // That says nothing about the page and never marks the browser; a
        // redaction for any other reason does.
        let navigation = json!({
            "appId": "com.example.browser",
            "appName": "Browser",
            "changeKind": "navigated",
            "opaqueWindowId": "ow1_tab",
            "contentHash": "deadbeef",
        });
        let coverage = [CoverageLevelV2::Redacted];
        fn withheld<'a>(
            redactions: &'a [String],
            coverage: &'a [CoverageLevelV2],
            navigation: &'a Value,
        ) -> LegacyMirrorProjection<'a> {
            LegacyMirrorProjection {
                kind: semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED,
                count_class: SemanticCountClassV2::Effective,
                content_state: SemanticContentStateV2::Redacted,
                coverage,
                redactions,
                metadata: navigation,
                content: None,
                occurred_at_ms: STARTED_AT_MS,
                observed_at_ms: ENDED_AT_MS,
                observation_id: OBSERVATION_ID,
            }
        }
        let unknown_privacy = ["browser_privacy_state_unavailable".to_owned()];
        let page = project_legacy_mirror(&withheld(&unknown_privacy, &coverage, &navigation))
            .expect("a redacted page is reported");
        assert!(page.sensitive_app_id.is_none());
        // Only the fact that the page changed crosses, never where to.
        let draft = page.draft.expect("the navigation itself mirrors");
        assert_eq!(draft.sensitivity, DesktopEventSensitivity::Metadata);
        assert_eq!(payload(&draft).len(), 2);

        let private_window = ["private_window".to_owned()];
        let page = project_legacy_mirror(&withheld(&private_window, &coverage, &navigation))
            .expect("a private page is reported");
        assert_eq!(
            page.sensitive_app_id.as_deref(),
            Some("com.example.browser")
        );
        assert!(page.draft.is_none());
    }

    #[test]
    fn withholds_a_title_that_is_an_address_or_a_search_query() {
        let mirrored_title = |title: &str| {
            let (metadata, content) = visible(Some(title));
            legacy_mirror_draft(&projection(
                semantic_event_kinds::APPLICATION_VISIBLE_CONTENT_CHANGED,
                &metadata,
                content.as_ref(),
            ))
            .and_then(|draft| {
                payload(&draft)["windowTitle"]
                    .as_str()
                    .map(ToOwned::to_owned)
            })
        };
        for title in [
            "https://example.test/untitled?token=abc",
            "www.example.test/untitled",
            "example.test/untitled",
            "localhost:3000/settings",
            "rust borrow checker - Google 搜索",
            "rust borrow checker - Google Search",
            "rust 借用检查器_百度搜索",
            "rust at DuckDuckGo",
            "rust - 必应",
        ] {
            assert!(mirrored_title(title).is_none(), "{title}");
        }
        // An ordinary document title is untouched.
        assert_eq!(
            mirrored_title("第 2 章 网络层 - 笔记").as_deref(),
            Some("第 2 章 网络层 - 笔记")
        );

        // A search request keeps the host and loses the title.
        let navigation = json!({
            "appId": "com.example.browser",
            "appName": "Browser",
            "changeKind": "navigated",
            "opaqueWindowId": "ow1_tab",
            "contentHash": "deadbeef",
        });
        let results = json!({
            "domain": "www.google.com",
            "title": "rust borrow checker",
            "url": "https://www.google.com/search?q=rust+borrow+checker",
            "visibleText": "private body",
        });
        let draft = legacy_mirror_draft(&projection(
            semantic_event_kinds::BROWSER_VISIBLE_PAGE_CHANGED,
            &navigation,
            Some(&results),
        ))
        .expect("the host of a search mirrors");
        assert_eq!(payload(&draft)["url"], "www.google.com");
        assert!(payload(&draft).get("title").is_none());
    }

    #[test]
    fn contributes_nothing_for_a_counted_boundary() {
        let metadata = json!({ "state": "afk_started", "idleForMs": 300_000 });
        let mut boundary = projection(semantic_event_kinds::PRESENCE_CHANGED, &metadata, None);
        boundary.count_class = SemanticCountClassV2::Boundary;
        assert!(project_legacy_mirror(&boundary).is_none());
    }

    #[derive(serde::Deserialize)]
    struct Contract {
        cases: Vec<ContractCase>,
    }

    #[derive(serde::Deserialize)]
    struct ContractCase {
        name: String,
        projection: ContractProjection,
        expected: Option<ContractExpected>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ContractProjection {
        kind: String,
        count_class: SemanticCountClassV2,
        content_state: SemanticContentStateV2,
        coverage: Vec<CoverageLevelV2>,
        #[serde(default)]
        redactions: Vec<String>,
        metadata: Value,
        content: Option<Value>,
        occurred_at_ms: i64,
        observed_at_ms: i64,
        observation_id: String,
    }

    #[derive(serde::Deserialize, Debug)]
    #[serde(rename_all = "camelCase")]
    struct ContractExpected {
        kind: String,
        source: String,
        sensitivity: DesktopEventSensitivity,
        payload: Value,
        deduplication_key: String,
    }

    #[test]
    fn honours_the_contract_shared_with_the_typescript_validator() {
        let contract: Contract = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/legacy-event-mirror.json"
        ))
        .expect("the mirror contract is valid JSON");
        assert!(contract.cases.len() >= 15);

        for case in &contract.cases {
            let input = &case.projection;
            let projection = LegacyMirrorProjection {
                kind: &input.kind,
                count_class: input.count_class,
                content_state: input.content_state,
                coverage: &input.coverage,
                redactions: &input.redactions,
                metadata: &input.metadata,
                content: input.content.as_ref(),
                occurred_at_ms: input.occurred_at_ms,
                observed_at_ms: input.observed_at_ms,
                observation_id: &input.observation_id,
            };
            match (
                &case.expected,
                project_legacy_mirror(&projection).and_then(|mirror| mirror.draft),
            ) {
                (None, None) => {}
                (Some(expected), Some(draft)) => {
                    assert_eq!(draft.kind, expected.kind, "{}", case.name);
                    assert_eq!(draft.source, expected.source, "{}", case.name);
                    assert_eq!(draft.sensitivity, expected.sensitivity, "{}", case.name);
                    assert_eq!(
                        draft.deduplication_key, expected.deduplication_key,
                        "{}",
                        case.name
                    );
                    assert_eq!(draft.occurred_at_ms, input.occurred_at_ms, "{}", case.name);
                    assert_eq!(draft.observed_at_ms, input.observed_at_ms, "{}", case.name);
                    assert_eq!(draft.payload, expected.payload, "{}", case.name);
                    assert_eq!(draft.goal_version, None, "{}", case.name);
                }
                (expected, draft) => {
                    panic!(
                        "{}: expected {expected:?} but mirrored {draft:?}",
                        case.name
                    )
                }
            }
        }
    }
}
