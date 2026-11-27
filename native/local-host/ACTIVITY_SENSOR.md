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

Each real transition to a known foreground application also appends one
`application.foregroundChanged` DesktopEvent. Its metadata payload is limited
to `appId` and `appName`; `windowTitle`, process ID, and executable path are
not copied into EventJournal. Repeated heartbeats and transitions to an
unknown/no-foreground state do not publish semantic events.

The session transition and a private `activity_event_outbox` row are committed
in the same `usage.sqlite3` transaction. Publication then appends to
EventJournal and deletes the outbox row. A transient append failure or a crash
therefore replays by stable deduplication key without losing or duplicating the
foreground boundary. On restart, the last open session is recovered as a
one-observation baseline: seeing the same app, process, and window starts the
new usage session without inventing another foreground event, while a real
change still publishes normally.

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

## Observer bridge into the EventJournal

The local host mirrors a bounded subset of Observer semantic projections into
the legacy EventJournal so the activity reflection can score real evidence.
`core/src/legacy_event_mirror.rs` owns the mapping; `server/src/legacy_mirror.rs`
appends each mirrored event only after the Observer frame that produced it has
been acknowledged, so a slow EventJournal write can never make the helper drop
frames.

| Observer semantic event | Legacy desktop event | Mirrors when |
| --- | --- | --- |
| `input.activityBucket` | `input.activityAggregated` | keys, clicks or scrolling are non-zero |
| `application.textValueChanged` | `accessibility.documentChanged` | a real delta against the prior value exists and the change was not redacted |
| `application.visibleContentChanged` | `application.foregroundChanged` with `windowTitle` | a sealed window title exists and differs from the last title event |
| `application.foregroundChanged` | `application.foregroundChanged` with `windowTitle` | the application switched to has a title the bridge has already seen, and it differs from the last title event |
| `browser.visiblePageChanged` | `browser.tabNavigated` with host and `title` | the host and title of that tab differ from the last navigation mirrored for it |

A foreground switch carries no content of its own. The bridge remembers the
newest title it has seen for each application and pairs a later switch to that
application with it, so returning to a document whose title did not change is
still described. Window titles are reported against the single last title
event, whichever application it described.

Visible text, typed text, control labels and full URLs never cross the bridge.
The bridge reads the URL only to recognise a sensitive page. When a window or
page observation is withheld as sensitive (the journal redacted it, or an
available title, host or URL matches a marker for sign-in, payment,
verification codes or private browsing), nothing of that observation is
mirrored and the application stays sensitive for the bridge: its text changes
are withheld too, until a title of it is mirrored again. Input buckets carry no
application and cannot be tied to a page, so they are not withheld.

Each event uses the deduplication key `observer-mirror:<observation id>`, so a
replayed frame appends nothing twice. A failed append sets
`observer_legacy_mirror_failed` in the monitoring status only when no more
specific observer error is already reported, and leaves the observation itself
untouched; the next Observer heartbeat resets the status line, so the marker
shows a failure only briefly. `tests/fixtures/legacy-event-mirror.json` is the
contract both the Rust mapping and the TypeScript desktop-event validator are
tested against.

Mirrored titles are stored in plaintext in `events.sqlite3`, which is readable
by the operating-system account only. The journal's retention deletes events
older than 30 days only up to the sequence every named consumer has committed,
so a consumer that stops advancing also keeps later titles.

## Verification

From this directory run:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Tests cover exact switch boundaries, zero-duration switches, heartbeat recovery, observation gaps, queries, 30-day/7-day/all cleanup, protection of an open session during retention cleanup, Tool registration, and JSONL access.

## GitHub Actions CI/CD

`.github/workflows/ci.yml` performs blocking validation and packaging on GitHub-hosted virtual machines and Linux containers, so developers do not need to spend local CPU time on the full cross-platform matrix.

The blocking matrix covers:

- hosted macOS 14/15 and Windows Server 2022/2025 with a deterministic foreground application;
- hosted Ubuntu 22.04/24.04 in its expected headless mode;
- Ubuntu, Debian, Fedora, Arch, Rocky, Alma, CentOS Stream, and openSUSE containers;
- Ubuntu 24.04 with Xvfb, Openbox, and an active xterm to exercise a deterministic X11 desktop.

Across these jobs, the pipeline checks out a clean copy, installs the pinned Bun `1.3.14` and Rust `1.97.1` toolchains, restores platform-specific Cargo caches where useful, installs locked dependencies, then runs:

1. TypeScript type checking;
2. Rust formatting, Clippy with warnings denied, and all Rust tests;
3. all Bun tests, including the integration test that builds and starts the real `whalehall-local` process in an isolated temporary data directory and probes every registered sensor;
4. Electrobun canary packaging after every preceding check passes;
5. upload of unsigned platform artifacts with seven-day retention.

Pushes to `main`, pull requests, and manual `workflow_dispatch` runs trigger the pipeline. A newer commit on the same branch cancels an obsolete in-progress run, and every job has a bounded timeout.

Hosted and container jobs verify both explicit headless degradation and deterministic foreground collection on the three platform families. `.github/workflows/desktop-compatibility.yml` separately defines real Windows client, Wayland/X11 Linux desktop, and macOS release-certification runners. See [`.github/CI_COMPATIBILITY.md`](../../.github/CI_COMPATIBILITY.md) for the exact environments, capability contracts, and self-hosted runner requirements.
