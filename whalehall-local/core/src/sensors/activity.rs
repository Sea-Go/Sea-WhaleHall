//! Public entry point for the foreground-activity sensor.
//!
//! Sensor entry points live one-per-file under `sensors/`. The activity engine
//! keeps its SQLite state machine in the private `activity` support module.

pub use crate::activity::{
    ActivityCacheScope, ActivityCleanupResult, ActivityConfig, ActivityCurrentSession,
    ActivityError, ActivityMonitorState, ActivityQuery, ActivityService, ActivityStatus,
    DEFAULT_ACTIVITY_POLL_INTERVAL_MS, ForegroundApp, ForegroundAppProvider,
    SystemForegroundAppProvider, UsageSession,
};
