# Application Inventory Sensor

## Purpose and ownership

The application inventory sensor is implemented in `core/src/sensors/application_inventory.rs`. It is a resident Rust service that can run with the local client and can also be queried through Agent Tools. It owns `applications.sqlite3`; it does not reuse the foreground-activity database because process inventory has a separate schema, cadence, lifecycle, and privacy boundary.

The sensor records two related datasets:

- installed applications: application name, executable or bundle path, discovery source, first discovery time, and latest discovery time;
- process runs: application/process name, executable path, PID, operating-system start time, first and latest observation time, detected exit time, latest CPU usage percentage, and latest resident-memory usage in bytes.

## Resident lifecycle

`ApplicationInventoryService::start` opens and migrates SQLite, recovers rows left open by an interrupted monitor, and starts a Tokio task. The task performs an immediate process and installed-application scan, then:

- refreshes processes every `WHALEHALL_APPLICATION_POLL_MS` milliseconds (default `2000`, accepted range `50..=60000`);
- refreshes installed applications every `WHALEHALL_INSTALLED_APPLICATION_REFRESH_MS` milliseconds (default six hours, accepted range one second through seven days);
- writes each successful scan in one immediate SQLite transaction;
- marks a previously open process as exited when its `(PID, start time)` pair disappears from a successful snapshot;
- stops without inventing process exits when the sensor itself shuts down.

CPU usage is the latest `sysinfo` sampling value and may exceed 100 percent for a multithreaded process using more than one logical CPU. Memory is resident physical memory in bytes. Exit time is the first successful observation where the process is absent, so it normally lags by at most one polling interval but can lag longer when a scan is delayed. After an unclean sensor stop, unresolved rows are bounded at their last successful observation and can be reopened if the same PID/start-time identity is seen again.

## Installed application discovery

Collection is platform-specific but lives in the single public sensor file:

- Linux reads freedesktop `.desktop` entries from system and user application directories and resolves the `Exec`/`TryExec` command when possible.
- macOS walks `/Applications`, `/System/Applications`, and the user's `Applications` directory for `.app` bundles.
- Windows walks `Program Files`, `Program Files (x86)`, and `LOCALAPPDATA\\Programs` for `.exe` application files with a bounded depth and entry count.

Missing roots and inaccessible subdirectories are skipped. Paths are de-duplicated before persistence. Minimal server/container systems may therefore have zero installed desktop applications without the process sensor being degraded.

## SQLite schema

The database uses WAL mode, normal synchronization, a five-second busy timeout, and schema version `1`.

`installed_applications` uses the executable/bundle path as its stable unique key. A repeated discovery updates the name, source, and latest discovery time without losing the first discovery time. Each successful scan uses a temporary key table to delete paths absent from the new snapshot, so `applications.installed` represents the current discoverable inventory rather than an append-only history.

`process_runs` uses `(process_id, started_at_ms)` as its unique key. This prevents PID reuse from joining unrelated runs. Each successful refresh updates the latest name/path/resource fields and clears `exited_at_ms` while that exact process identity is still present. Queries are indexed by observation time, running state, and name.

Both SQLite timestamps and JSON `*AtMs` values are Unix epoch milliseconds. JSON also exposes RFC 3339 UTC strings for every timestamp.

## Rust and Agent APIs

Rust callers use `ApplicationInventoryService` with either `SystemApplicationInventoryProvider` or a custom `ApplicationInventoryProvider`. The provider trait makes process and installed-application observations deterministic in unit tests.

Agent Tools are read-only and require `applications.read`:

- `applications.status` returns lifecycle state, database path, intervals, counts, last successful scan times, and the latest error;
- `applications.installed` accepts `limit` and optional `nameContains`;
- `applications.processes` accepts `limit`, `processId`, `nameContains`, `fromMs`, `toMs`, and `runningOnly`.

Example calls:

```json
{"id":"apps-1","method":"tool.call","params":{"name":"applications.installed","arguments":{"limit":100}}}
{"id":"processes-1","method":"tool.call","params":{"name":"applications.processes","arguments":{"runningOnly":true,"limit":500}}}
```

## CI/CD contract

`tests/native-integration.test.ts` discovers every public sensor file and requires exactly one native probe. The application inventory probe waits for both initial scans, checks that the resident service reports a non-empty process set, queries installed applications, and verifies that the local JSONL server itself is persisted with a PID, path, start time, CPU value, memory value, and `exitedAt: null`.

The existing blocking Actions matrix executes this probe on hosted macOS, Windows Server and Ubuntu, distribution containers, and the virtual X11 desktop before packaging. A sensor change is not considered compatible until those platform jobs and the three packaging jobs pass.

## Privacy and limitations

Application names, executable paths, process IDs, resource usage, and timestamps can reveal sensitive user behavior. The data stays in the local application-data directory and is not sent to a remote service by this implementation. Agent access must enforce `applications.read`.

The sensor records the latest CPU and memory sample per process run, not a high-frequency resource time series. Some protected operating-system processes can expose a name and PID while withholding their executable path. Installed-application discovery is an application-oriented inventory, not a complete package-manager database.
