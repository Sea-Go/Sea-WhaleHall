use super::{ActivityError, ForegroundApp};

pub trait ForegroundAppProvider: Send + Sync + 'static {
    fn foreground_app(&self) -> Result<Option<ForegroundApp>, ActivityError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemForegroundAppProvider;

#[cfg(target_os = "macos")]
impl ForegroundAppProvider for SystemForegroundAppProvider {
    fn foreground_app(&self) -> Result<Option<ForegroundApp>, ActivityError> {
        use objc2_app_kit::NSWorkspace;

        let Some(application) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
            return Err(ActivityError::Foreground(
                "macOS did not expose a frontmost application".to_owned(),
            ));
        };
        let process_id = application.processIdentifier();
        let app_name = application
            .localizedName()
            .map(|name| name.to_string())
            .unwrap_or_default();
        let executable_path = application
            .executableURL()
            .and_then(|url| url.path())
            .map(|path| path.to_string())
            .unwrap_or_default();
        let bundle_id = application
            .bundleIdentifier()
            .map(|identifier| identifier.to_string())
            .unwrap_or_default();
        if app_name.is_empty() && executable_path.is_empty() {
            return Err(ActivityError::Foreground(
                "macOS returned a foreground application without an identity.".to_owned(),
            ));
        }
        let app_id = if bundle_id.is_empty() {
            if executable_path.is_empty() {
                app_name.clone()
            } else {
                executable_path.clone()
            }
        } else {
            bundle_id
        };

        Ok(Some(ForegroundApp {
            app_id,
            app_name,
            executable_path,
            process_id: u64::try_from(process_id).unwrap_or_default(),
            window_title: String::new(),
        }))
    }
}

#[cfg(not(target_os = "macos"))]
impl ForegroundAppProvider for SystemForegroundAppProvider {
    fn foreground_app(&self) -> Result<Option<ForegroundApp>, ActivityError> {
        let window = active_win_pos_rs::get_active_window().map_err(|()| {
            ActivityError::Foreground(
                "the desktop session did not expose an active window".to_owned(),
            )
        })?;
        let executable_path = window.process_path.to_string_lossy().into_owned();
        let app_name = if window.app_name.is_empty() {
            window
                .process_path
                .file_stem()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            window.app_name
        };
        if app_name.is_empty() && executable_path.is_empty() {
            return Err(ActivityError::Foreground(
                "the active window did not expose an application identity".to_owned(),
            ));
        }
        let app_id = if executable_path.is_empty() {
            app_name.clone()
        } else {
            executable_path.clone()
        };
        #[cfg(target_os = "windows")]
        let app_id = app_id.to_ascii_lowercase();

        Ok(Some(ForegroundApp {
            app_id,
            app_name,
            executable_path,
            process_id: window.process_id,
            window_title: window.title,
        }))
    }
}
