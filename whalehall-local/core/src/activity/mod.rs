mod model;
mod provider;
mod store;
mod tracker;

pub use model::{
    ActivityCacheScope, ActivityCleanupResult, ActivityCurrentSession, ActivityMonitorState,
    ActivityQuery, ActivityStatus, ForegroundApp, UsageSession,
};
pub use provider::{ForegroundAppProvider, SystemForegroundAppProvider};
pub use tracker::{ActivityConfig, ActivityService, DEFAULT_ACTIVITY_POLL_INTERVAL_MS};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ActivityError {
    #[error("Activity configuration error: {0}")]
    Configuration(String),
    #[error("Unable to access the foreground application: {0}")]
    Foreground(String),
    #[error("Activity database I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Activity database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
}
