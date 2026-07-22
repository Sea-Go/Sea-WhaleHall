# WhaleHall Activity Sensor

This document defines the Rust-owned client sensor for foreground application usage. The design follows the useful separation in [Planshit/Tai](https://github.com/Planshit/Tai): operating-system observation and duration accounting are independent from UI presentation. WhaleHall keeps raw sessions in local SQLite and exposes capabilities through Rust APIs and Agent Tools.

## Scope and ownership

The sensor belongs entirely to the `whalehall-local` Rust workspace:

- `core/src/sensors/activity.rs` is the single public sensor entry file.
- `core/src/activity/provider.rs` reads the current foreground application from the OS.
- `core/src/activity/tracker.rs` owns the resident sampling loop, session state machine, shutdown, query API, and serialized cleanup commands.
- `core/src/activity/store.rs` owns SQLite schema, transactions, filtering, retention, and crash recovery.
- `core/src/activity/model.rs` contains public query/result types.
- `core/src/tools/activity_*.rs` adapt the service API to Agent-callable Local Tools.
- `server/src/lib.rs` starts one sensor with the Local Tool Host and shuts it down cleanly when the host exits.

The sensor starts automatically with `whalehall-local`, runs for the lifetime of that native process, and does not need an Agent call to collect data. The same `ActivityService` instance is injected into Tools, so Agent calls query or clean the resident sensor rather than starting competing collectors.

## Runtime lifecycle

1. Resolve `usage.sqlite3`, create its parent directory, initialize the schema, and recover any stale open session at its last heartbeat.
2. Sample the foreground application every 100 ms by default.
3. Insert an open session on the first observation.
4. On an application/process switch, atomically close the old row and insert the new row at the same timestamp.
5. Touch the open row every five seconds to bound crash-related data loss.
6. Close the current row on foreground failure, a suspended-loop observation gap, or clean process shutdown.

Set `WHALEHALL_DATA_DIR` to override the database directory and `WHALEHALL_ACTIVITY_POLL_MS` (50–5000) to tune sampling. `activity.status` returns the effective database path and interval.

## Local SQLite contract

`usage_sessions` stores application ID/name, executable path, process ID, optional window title, start/last-seen/end timestamps, duration, and end reason. Timestamps are UTC Unix milliseconds; API results also include RFC 3339 strings. WAL mode allows queries while the monitor writes. A partial unique index ensures only one row can remain open.

The sensor records application/window metadata, not screenshots, keyboard input, clipboard content, document bodies, or network traffic. The database is never exposed through a network listener.

## Rust service APIs

```rust
let status = activity.status();
let sessions = activity.sessions(&ActivityQuery::default())?;
let result = activity.cleanup(ActivityCacheScope::ShortTerm).await?;
activity.shutdown().await;
```

- `status()` reports monitor health and the current session.
- `sessions(query)` filters by time range, application ID, open/closed state, and limit (1–500).
- `cleanup(scope)` serializes deletion through the running monitor.
- `shutdown()` stops sampling and closes the current row before process exit.

## Agent Tool APIs

All calls use the existing `tool.call` JSONL protocol.

```json
{"id":"status-1","method":"tool.call","params":{"name":"activity.status","arguments":{}}}
{"id":"query-1","method":"tool.call","params":{"name":"activity.sessions","arguments":{"limit":50,"fromMs":0,"includeOpen":true}}}
{"id":"clean-1","method":"tool.call","params":{"name":"activity.cleanup","arguments":{"scope":"shortTerm"}}}
```

| Tool | Risk | Permission | Purpose |
| --- | --- | --- | --- |
| `activity.status` | read | none | Monitor health and current session |
| `activity.sessions` | read | `activity.read` | Raw local usage history |
| `activity.cleanup` | write | `activity.delete` | Retention or complete deletion |

Cleanup scopes have exact meanings:

| Scope | Result |
| --- | --- |
| `longTerm` | Delete closed sessions ending more than 30 days ago; retain the latest 30 days |
| `shortTerm` | Delete closed sessions ending more than 7 days ago; retain the latest 7 days |
| `all` | Delete every session; reset in-memory tracking and start a fresh row on the next sample |

The cleanup result includes `deletedSessions`, `retentionDays`, and cutoff time. Deletion uses a strict `ended_at_ms < cutoff` boundary, so a session ending exactly at the cutoff is retained.

## Verification

From this directory run:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Tests cover exact switch boundaries, zero-duration switches, heartbeat recovery, observation gaps, queries, 30-day/7-day/all cleanup, protection of an open session during retention cleanup, Tool registration, and JSONL access.

## GitHub Actions CI/CD

`.github/workflows/ci.yml` performs validation and packaging entirely on GitHub-hosted virtual machines, so developers do not need to spend local CPU time on the full cross-platform matrix.

The matrix currently runs on:

- `macos-15` for macOS ARM64;
- `windows-latest` for Windows x64;
- `ubuntu-22.04` for Linux x64.

Each runner checks out a clean copy, installs the pinned Bun `1.3.14` and Rust `1.97.1` toolchains, restores a platform-specific Cargo cache, installs locked dependencies, then runs:

1. TypeScript type checking;
2. Rust formatting, Clippy with warnings denied, and all Rust tests;
3. all Bun tests, including the integration test that builds and starts the real `whalehall-local` process in an isolated temporary data directory;
4. Electrobun canary packaging after every preceding check passes;
5. upload of unsigned platform artifacts with seven-day retention.

Pushes to `main`, pull requests, and manual `workflow_dispatch` runs trigger the pipeline. A newer commit on the same branch cancels an obsolete in-progress run, and each platform has a 45-minute timeout.

GitHub-hosted runners do not expose a normal interactive desktop session. Therefore CI verifies the platform code compiles and that a missing foreground window produces a safe degraded state, while deterministic fake providers verify recording behavior. It does not prove that every desktop shell reports its real foreground window. Release qualification should still include one short manual foreground-switch check on each supported OS.
