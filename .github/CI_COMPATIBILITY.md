# CI compatibility contract

WhaleHall validates sensors by capability, not by operating-system name alone. A distribution-only compile does not prove that a screen or foreground-window sensor works in an interactive desktop session.

## Blocking hosted gates

`.github/workflows/ci.yml` runs on every push to `main`, pull request, and manual dispatch. Packaging waits for every gate below:

| Gate | Environments | Contract |
| --- | --- | --- |
| Complete quality suite | Ubuntu 24.04 | TypeScript, formatting, Clippy, all Rust tests, all Bun tests, and native JSONL probes |
| Hosted sensors | Ubuntu 22.04/24.04, Windows Server 2022/2025, macOS 14/15 | Native Rust build and every registered sensor probe, including isolated Chromium history/tab import |
| Linux distributions | Ubuntu 22.04/24.04, Debian 12/13, Fedora 43/44, Arch rolling, Rocky 9, Alma 9, CentOS Stream 9/10, openSUSE Leap 16.0 | Native build, Rust tests, device/environment collection, and explicit headless degradation |
| Virtual desktop | Ubuntu 24.04 with Xvfb, Openbox, and an active xterm | A real X11 display with a 1280x720 screen and a queryable foreground application |
| Packaging | macOS 15, Windows Server 2025, Ubuntu 24.04 | Canary packages and unsigned seven-day artifacts, only after all preceding gates pass |

Linux distribution containers intentionally validate headless behavior. They must report unavailable screens, foreground applications, last-input time, and lock state as degraded sensor capabilities rather than failing the process or inventing desktop state.

## Real desktop runners

`.github/workflows/desktop-compatibility.yml` defines the release-certification matrix that GitHub-hosted runners cannot provide:

- Windows 10 LTSC x64 and Windows 11 x64;
- Ubuntu GNOME Wayland and Fedora GNOME Wayland;
- Arch Linux KDE Plasma Wayland and Debian XFCE X11;
- macOS 14 x64 and macOS 15 ARM64.

These must be ephemeral or resettable self-hosted virtual machines or physical machines. Each runner must:

1. carry both the `self-hosted` and `interactive-desktop` labels plus its exact matrix label;
2. run the Actions runner as a logged-in desktop user, not as a Windows Session 0 service or a display-less Linux daemon;
3. keep one ordinary test window focused while the probe runs;
4. preinstall current OS updates, `rustup`, native build dependencies, and any desktop permissions required by the sensor;
5. expose no production credentials to sensor jobs and reset its workspace after every run.

Set the repository variable `WHALEHALL_ENABLE_DESKTOP_RUNNERS=true` only after all eight labels are online. Until then, the workflow emits an explicit notice and the real-desktop jobs are skipped; skipped jobs are not release-certification evidence.

Do not run untrusted fork pull requests on self-hosted desktop runners. The workflow therefore runs on `main`, a weekly schedule, or explicit manual dispatch, while public pull requests remain on isolated GitHub-hosted machines.

## Platform policy

- Windows 11 is the supported Windows client baseline.
- Windows 10 LTSC is compatibility-tested while the project chooses to support it.
- GitHub-hosted Windows Server verifies Windows APIs and packaging but does not substitute for Windows client testing.
- Windows 7 is not a supported full-client target: Bun requires Windows 10 version 1809 or later, and Rust's dedicated Windows 7 targets are Tier 3.
- Rocky and Alma provide RHEL-compatible coverage without requiring Red Hat subscription credentials.
- CentOS means CentOS Stream; end-of-life CentOS Linux releases are excluded.
- Arch is deliberately a rolling compatibility canary. A failure must be investigated rather than hidden by allowing the job to fail.

## Adding a sensor

Every public `core/src/sensors/*.rs` file must have exactly one entry in `sensorCiProbes` in `tests/native-integration.test.ts`. The probe must declare meaningful behavior for:

- `degraded`: no interactive desktop is available and absence must be explicit;
- `required`: screen resolution and foreground application data must be present;
- presence `idle`: last-input time must be available even if lock state is not;
- presence `complete`: last-input time and lock state must both be available;
- `auto`: the environment may provide either capability, but empty results still require a warning.

Adding a file without a probe fails the automatic discovery test. A sensor is not considered release-certified until its native Tool call passes every blocking environment and all enabled real-desktop environments.

The browser probe creates a synthetic Chromium profile and fresh tab bridge inside the job's temporary data directory. It validates platform-native file paths, SQLite snapshot/import behavior, tab lifecycle, audio flags, URL/search decoding, downloads, and Tool queries without reading a runner account's personal browsing data.

Native Tool responses have a 15-second per-call budget so rolling-distribution
containers can finish cold-start work without introducing timing flakes. Resident
service tests wait for observable persisted state rather than assuming a fixed
scheduler delay; exhausting either bounded wait remains a blocking failure.
The cancellation probe flushes its request and observes the cancellation event,
failed call response, and cancellation acknowledgement before closing stdin.
