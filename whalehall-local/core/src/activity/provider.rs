use super::{ActivityError, ForegroundApp};

pub trait ForegroundAppProvider: Send + Sync + 'static {
    fn foreground_app(&self) -> Result<Option<ForegroundApp>, ActivityError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemForegroundAppProvider;

#[cfg(target_os = "macos")]
impl ForegroundAppProvider for SystemForegroundAppProvider {
    fn foreground_app(&self) -> Result<Option<ForegroundApp>, ActivityError> {
        use objc2_app_kit::NSRunningApplication;

        let process_id = frontmost_process_id()?;
        let Some(application) =
            NSRunningApplication::runningApplicationWithProcessIdentifier(process_id)
        else {
            return Ok(None);
        };
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

#[cfg(target_os = "macos")]
#[repr(C)]
struct ProcessSerialNumber {
    high_long_of_psn: u32,
    low_long_of_psn: u32,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn GetFrontProcess(process: *mut ProcessSerialNumber) -> i16;
    fn GetProcessPID(process: *const ProcessSerialNumber, process_id: *mut i32) -> i16;
}

#[cfg(target_os = "macos")]
fn frontmost_process_id() -> Result<i32, ActivityError> {
    let mut process = ProcessSerialNumber {
        high_long_of_psn: 0,
        low_long_of_psn: 0,
    };
    let front_status = unsafe { GetFrontProcess(&mut process) };
    if front_status != 0 {
        return Err(ActivityError::Foreground(format!(
            "GetFrontProcess failed with OSStatus {front_status}"
        )));
    }
    let mut process_id = 0;
    let pid_status = unsafe { GetProcessPID(&process, &mut process_id) };
    if pid_status != 0 || process_id <= 0 {
        return Err(ActivityError::Foreground(format!(
            "GetProcessPID failed with OSStatus {pid_status}"
        )));
    }
    Ok(process_id)
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
        let mut app_id = if executable_path.is_empty() {
            app_name.clone()
        } else {
            executable_path.clone()
        };
        #[cfg(target_os = "windows")]
        app_id.make_ascii_lowercase();

        Ok(Some(ForegroundApp {
            app_id,
            app_name,
            executable_path,
            process_id: window.process_id,
            window_title: window.title,
        }))
    }
}
