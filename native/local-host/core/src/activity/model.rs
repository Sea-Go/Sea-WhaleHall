use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use super::ActivityError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForegroundApp {
    pub app_id: String,
    pub app_name: String,
    pub executable_path: String,
    pub process_id: u64,
    pub window_title: String,
}

impl ForegroundApp {
    pub(crate) fn same_usage_target(&self, other: &Self) -> bool {
        self.app_id == other.app_id && self.process_id == other.process_id
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActivityMonitorState {
    Starting,
    Running,
    Degraded,
    Stopped,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCurrentSession {
    pub id: i64,
    pub app_id: String,
    pub app_name: String,
    pub executable_path: String,
    pub process_id: u64,
    pub window_title: String,
    pub started_at_ms: i64,
    pub started_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStatus {
    pub state: ActivityMonitorState,
    pub database_path: String,
    pub poll_interval_ms: u64,
    pub current_session: Option<ActivityCurrentSession>,
    pub last_observed_at_ms: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSession {
    pub id: i64,
    pub app_id: String,
    pub app_name: String,
    pub executable_path: String,
    pub process_id: u64,
    pub window_title: String,
    pub started_at_ms: i64,
    pub started_at: String,
    pub last_seen_at_ms: i64,
    pub last_seen_at: String,
    pub ended_at_ms: Option<i64>,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub end_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActivityCacheScope {
    LongTerm,
    ShortTerm,
    All,
}

impl ActivityCacheScope {
    pub(crate) const fn retention_days(self) -> Option<i64> {
        match self {
            Self::LongTerm => Some(30),
            Self::ShortTerm => Some(7),
            Self::All => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCleanupResult {
    pub scope: ActivityCacheScope,
    pub deleted_sessions: usize,
    pub retention_days: Option<i64>,
    pub cutoff_at_ms: Option<i64>,
    pub cutoff_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityQuery {
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
    #[serde(default)]
    pub app_id: Option<String>,
    #[serde(default = "default_true")]
    pub include_open: bool,
}

impl Default for ActivityQuery {
    fn default() -> Self {
        Self {
            limit: default_limit(),
            from_ms: None,
            to_ms: None,
            app_id: None,
            include_open: true,
        }
    }
}

impl ActivityQuery {
    pub fn validate(&self) -> Result<(), ActivityError> {
        if !(1..=500).contains(&self.limit) {
            return Err(ActivityError::Configuration(
                "activity.sessions limit must be between 1 and 500.".to_owned(),
            ));
        }
        if matches!((self.from_ms, self.to_ms), (Some(from), Some(to)) if from > to) {
            return Err(ActivityError::Configuration(
                "activity.sessions fromMs cannot be greater than toMs.".to_owned(),
            ));
        }
        if self.app_id.as_ref().is_some_and(|value| value.is_empty()) {
            return Err(ActivityError::Configuration(
                "activity.sessions appId cannot be empty.".to_owned(),
            ));
        }
        Ok(())
    }
}

pub(crate) fn format_timestamp(timestamp_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms)
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| "invalid-timestamp".to_owned())
}

fn default_limit() -> usize {
    100
}

fn default_true() -> bool {
    true
}
