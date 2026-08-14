use std::ffi::c_void;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::Mutex;

use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

// Rust does not run destructors for statics at process exit. Keeping the Job
// handle here is intentional: a normal return from main must not close a
// KILL_ON_JOB_CLOSE Job while whalehall-local is still alive. Windows closes
// the handle during process teardown, including TerminateProcess and crashes.
static CURRENT_PROCESS_TREE_JOB: Mutex<Option<OwnedHandle>> = Mutex::new(None);

/// Installs the fail-closed Windows lifetime boundary for whalehall-local and
/// every process it creates, directly or transitively.
///
/// This must run before the first business child process is spawned. Windows
/// automatically associates future descendants with this Job because no
/// breakaway flag is requested. A host environment that rejects nested Job
/// assignment is an initialization error; silently running without ownership
/// would violate the native process-tree shutdown contract.
pub fn install_current_process_tree_job() -> io::Result<()> {
    let mut installed = CURRENT_PROCESS_TREE_JOB
        .lock()
        .map_err(|_| io::Error::other("Windows process-tree Job lock was poisoned"))?;
    if installed.is_some() {
        return Ok(());
    }

    // Null security attributes make the Job handle non-inheritable. Children
    // inherit Job membership, never the handle that keeps the Job alive.
    let raw_handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw_handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw_handle) };

    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            handle.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(io::Error::last_os_error());
    }

    let assigned = unsafe { AssignProcessToJobObject(handle.as_raw_handle(), GetCurrentProcess()) };
    if assigned == 0 {
        return Err(io::Error::last_os_error());
    }

    *installed = Some(handle);
    Ok(())
}
