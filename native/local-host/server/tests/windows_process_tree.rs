#![cfg(windows)]

use std::fs;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use whalehall_local_server::install_current_process_tree_job;
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
    WaitForSingleObject,
};

const TERMINATE_TEST_NAME: &str =
    "current_process_job_kills_registered_descendants_after_terminate_process";
const NORMAL_EXIT_TEST_NAME: &str =
    "current_process_job_kills_registered_descendants_after_normal_exit";
const TEST_ROLE_ENV: &str = "WHALEHALL_WINDOWS_PROCESS_TREE_TEST_ROLE";
const READY_GATE_ENV: &str = "WHALEHALL_WINDOWS_PROCESS_TREE_TEST_READY_GATE";
const EXIT_GATE_ENV: &str = "WHALEHALL_WINDOWS_PROCESS_TREE_TEST_EXIT_GATE";
const PID_FILE_ENV: &str = "WHALEHALL_WINDOWS_PROCESS_TREE_TEST_PIDS";
const TERMINATED_OWNER_ROLE: &str = "terminated-job-owner";
const NORMAL_EXIT_OWNER_ROLE: &str = "normal-exit-job-owner";
const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

struct OwnerProcess {
    child: Child,
}

impl OwnerProcess {
    fn spawn(
        test_name: &str,
        role: &str,
        ready_gate: &Path,
        exit_gate: &Path,
        pid_file: &Path,
    ) -> io::Result<Self> {
        let child = Command::new(std::env::current_exe()?)
            .args([test_name, "--exact", "--nocapture", "--test-threads=1"])
            .env(TEST_ROLE_ENV, role)
            .env(READY_GATE_ENV, ready_gate)
            .env(EXIT_GATE_ENV, exit_gate)
            .env(PID_FILE_ENV, pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()?;
        Ok(Self { child })
    }

    fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    fn terminate_and_wait(&mut self) -> io::Result<std::process::ExitStatus> {
        // Call the Windows ABI directly: the owner cannot run Rust destructors
        // or any graceful descendant cleanup after this succeeds.
        let terminated = unsafe { TerminateProcess(self.child.as_raw_handle(), 23) };
        if terminated == 0 {
            return Err(io::Error::last_os_error());
        }
        self.child.wait()
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> io::Result<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Job owner did not exit",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for OwnerProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct ProcessHandle {
    handle: OwnedHandle,
    pid: u32,
}

impl ProcessHandle {
    fn open(pid: u32) -> io::Result<Self> {
        let raw_handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE_ACCESS,
                0,
                pid,
            )
        };
        if raw_handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            handle: unsafe { OwnedHandle::from_raw_handle(raw_handle) },
            pid,
        })
    }

    fn wait_for_exit(&self, timeout: Duration) -> io::Result<bool> {
        let timeout_ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        match unsafe { WaitForSingleObject(self.handle.as_raw_handle(), timeout_ms) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        if self.wait_for_exit(Duration::ZERO).ok() == Some(false) {
            unsafe {
                TerminateProcess(self.handle.as_raw_handle(), 1);
            }
            let _ = self.wait_for_exit(Duration::from_secs(1));
        }
    }
}

fn powershell_path() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").expect("Windows SystemRoot is available"))
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

#[allow(clippy::zombie_processes)]
fn run_owner_process(role: &str) {
    install_current_process_tree_job().expect("install whalehall-local process-tree Job");

    let ready_gate = PathBuf::from(
        std::env::var_os(READY_GATE_ENV).expect("Windows process-tree test ready-gate path"),
    );
    let pid_file = PathBuf::from(
        std::env::var_os(PID_FILE_ENV).expect("Windows process-tree test PID-file path"),
    );
    let exit_gate = PathBuf::from(
        std::env::var_os(EXIT_GATE_ENV).expect("Windows process-tree test exit-gate path"),
    );
    let powershell = powershell_path();
    assert!(powershell.is_file(), "Windows PowerShell must exist");

    let script = r#"
$ErrorActionPreference = 'Stop'
while (-not [IO.File]::Exists($env:WHALEHALL_WINDOWS_PROCESS_TREE_TEST_READY_GATE)) {
    Start-Sleep -Milliseconds 10
}
$ping = Join-Path $env:SystemRoot 'System32\PING.EXE'
$grandchild = Start-Process -FilePath $ping -ArgumentList @('-t', '127.0.0.1') -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText(
    $env:WHALEHALL_WINDOWS_PROCESS_TREE_TEST_PIDS,
    "$PID`n$($grandchild.Id)`n"
)
while ($true) {
    Start-Sleep -Seconds 60
}
"#;

    // This uses an ordinary process spawn after the production Job is
    // installed. It proves that descendants inherit membership without an
    // Observer-specific wrapper or taskkill ancestry lookup.
    let _helper = Command::new(&powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script,
        ])
        .env(READY_GATE_ENV, &ready_gate)
        .env(PID_FILE_ENV, &pid_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn process-tree helper");
    fs::write(&ready_gate, b"job-installed").expect("release Job-owned helper");

    if role == NORMAL_EXIT_OWNER_ROLE {
        while !exit_gate.is_file() {
            thread::sleep(Duration::from_millis(10));
        }
        return;
    }
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn read_registered_pids(owner: &mut OwnerProcess, pid_file: &Path) -> io::Result<(u32, u32)> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(contents) = fs::read_to_string(pid_file) {
            let values = contents
                .lines()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::parse::<u32>)
                .collect::<Result<Vec<_>, _>>();
            if let Ok(values) = values
                && let [helper_pid, grandchild_pid] = values.as_slice()
            {
                return Ok((*helper_pid, *grandchild_pid));
            }
        }
        if let Some(status) = owner.try_wait()? {
            return Err(io::Error::other(format!(
                "Job owner exited before publishing descendant PIDs: {status}"
            )));
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Job-owned descendants did not publish their PIDs",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn prove_current_process_job_kills_registered_descendants(
    test_name: &str,
    role: &str,
    terminate_owner: bool,
) {
    let directory = tempfile::tempdir().expect("create Windows process-tree test directory");
    let ready_gate = directory.path().join("ready.gate");
    let exit_gate = directory.path().join("exit.gate");
    let pid_file = directory.path().join("process-tree.pids");
    let mut owner = OwnerProcess::spawn(test_name, role, &ready_gate, &exit_gate, &pid_file)
        .expect("spawn Job-owning test process");
    let (helper_pid, grandchild_pid) =
        read_registered_pids(&mut owner, &pid_file).expect("observe registered process tree");
    let helper = ProcessHandle::open(helper_pid).expect("retain helper process handle");
    let grandchild =
        ProcessHandle::open(grandchild_pid).expect("retain helper grandchild process handle");
    assert!(
        !helper
            .wait_for_exit(Duration::ZERO)
            .expect("query helper state"),
        "registered helper PID {helper_pid} must be running"
    );
    assert!(
        !grandchild
            .wait_for_exit(Duration::ZERO)
            .expect("query grandchild state"),
        "registered grandchild PID {grandchild_pid} must be running"
    );

    let owner_status = if terminate_owner {
        owner
            .terminate_and_wait()
            .expect("TerminateProcess and reap Job owner")
    } else {
        fs::write(&exit_gate, b"exit").expect("request normal Job-owner exit");
        owner
            .wait_for_exit(Duration::from_secs(10))
            .expect("wait for normal Job-owner exit")
    };
    assert_eq!(
        owner_status.success(),
        !terminate_owner,
        "Job owner exit mode must match the test contract: {owner_status}"
    );
    assert!(
        helper
            .wait_for_exit(Duration::from_secs(10))
            .expect("wait for Job-owned helper"),
        "OS Job teardown did not terminate helper PID {}",
        helper.pid
    );
    assert!(
        grandchild
            .wait_for_exit(Duration::from_secs(10))
            .expect("wait for Job-owned grandchild"),
        "OS Job teardown did not terminate grandchild PID {}",
        grandchild.pid
    );
}

#[test]
fn current_process_job_kills_registered_descendants_after_terminate_process() {
    if std::env::var(TEST_ROLE_ENV).as_deref() == Ok(TERMINATED_OWNER_ROLE) {
        run_owner_process(TERMINATED_OWNER_ROLE);
        return;
    }
    prove_current_process_job_kills_registered_descendants(
        TERMINATE_TEST_NAME,
        TERMINATED_OWNER_ROLE,
        true,
    );
}

#[test]
fn current_process_job_kills_registered_descendants_after_normal_exit() {
    if std::env::var(TEST_ROLE_ENV).as_deref() == Ok(NORMAL_EXIT_OWNER_ROLE) {
        run_owner_process(NORMAL_EXIT_OWNER_ROLE);
        return;
    }
    prove_current_process_job_kills_registered_descendants(
        NORMAL_EXIT_TEST_NAME,
        NORMAL_EXIT_OWNER_ROLE,
        false,
    );
}
