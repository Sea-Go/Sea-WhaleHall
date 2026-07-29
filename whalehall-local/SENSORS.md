# Rust Sensors

Every client sensor has exactly one public entry file under `core/src/sensors/`:

| Sensor file | Collection model | Agent Tools |
| --- | --- | --- |
| `accessibility_tree.rs` | Resident foreground accessibility-tree monitor | `accessibility.status`, `accessibility.tree` |
| `activity.rs` | Resident foreground-application monitor | `activity.status`, `activity.sessions`, `activity.cleanup` |
| `application_inventory.rs` | Resident installed-application and process monitor | `applications.status`, `applications.installed`, `applications.processes` |
| `browser_activity.rs` | Resident tab, history, search, and download monitor | `browser.status`, `browser.tabs`, `browser.history`, `browser.searches`, `browser.downloads` |
| `device_environment.rs` | On-demand device snapshot | `device.environment` |
| `input_activity.rs` | Resident privacy-safe keyboard/pointer aggregate monitor | `input.status` |
| `presence.rs` | Resident idle, AFK, lock, and sleep/wake monitor | `presence.status`, `presence.events` |
| `vscode_edit_bridge.rs` | Explicit-consent VS Code spool consumer and durable edit-burst monitor | `editor.status` |

`sensors/mod.rs` is only the registry. A new sensor is added as one sibling `.rs` file and exported there. Tool protocol adaptation stays under `core/src/tools/`, so sensor APIs remain usable directly from Rust without JSON.

The activity entry file delegates to a private multi-file SQLite engine because it owns a long-running state machine, schema, crash recovery, and retention. Those files are implementation support rather than separately registered sensors.

## Accessibility tree

`accessibility_tree.rs` owns the resident foreground UI accessibility monitor
and `accessibility.sqlite3`. It stores bounded changed snapshots containing
roles, control names, focus, selection, optional values, and optional document
excerpts. Protected/password values are always removed, while ordinary values
and document text remain opt-in in Agent responses.

The system provider supports Windows UI Automation, macOS System Events with
Accessibility permission, and Linux AT-SPI. A fresh atomic bridge can supply
the same platform-neutral tree contract. Full schema, limits, permissions,
privacy, Tool, and CI details are in
[`ACCESSIBILITY_TREE_SENSOR.md`](ACCESSIBILITY_TREE_SENSOR.md).

## Application inventory

`application_inventory.rs` owns a resident cross-platform monitor and the `applications.sqlite3` database. It refreshes running processes at a configurable interval and installed applications on a slower cadence. A process identity is the pair `(processId, startedAtMs)`, so an operating system reusing a PID does not merge two different process lifecycles.

Persisted installed-application fields include name, executable or bundle path, discovery source, first discovery time, and last discovery time. Each successful installed scan replaces paths that are no longer discoverable. Persisted process fields include name, executable path, PID, operating-system start time, first and last observation time, detected exit time, latest CPU percentage, and latest resident-memory bytes. `exitedAt: null` means the process was present in the most recent snapshot. Exit time is detection time and can lag the actual exit until the next successful process scan.

Installed application discovery uses Linux desktop entries, macOS application bundles, and Windows executable installation roots. A headless or minimal image can legitimately return an empty installed list, but running-process collection must still return the local server process. Full ownership, schema, query, privacy, and lifecycle details are in [`APPLICATION_INVENTORY_SENSOR.md`](APPLICATION_INVENTORY_SENSOR.md).

## Presence and idle state

`presence.rs` owns the resident cross-platform presence monitor and `presence.sqlite3`. It records the latest input time and derives `afkStarted`, `afkEnded`, `screenLocked`, `screenUnlocked`, `sleepStarted`, and `wokeUp` transitions. Unknown desktop capability is represented explicitly rather than being confused with an active or unlocked user.

Windows uses native input-desktop APIs, macOS reads IOHID and session properties, and Linux supports X11 idle time plus systemd-logind session hints. Full state-machine, schema, query, platform, privacy, and CI details are in [`PRESENCE_SENSOR.md`](PRESENCE_SENSOR.md).

## Browser activity

`browser_activity.rs` owns `browser.sqlite3` and two resident collection paths. Current tab observations create sessions with title, URL, domain, nullable audio state, and start/end boundaries. Browser profile snapshots import history URLs/titles/visit times/counts, derived search terms, and download URLs/paths/times/bytes/state.

Chromium-family, Firefox, and Safari history profiles are supported with documented platform differences. Exact current tab audio uses the cross-platform bridge contract; macOS also has a title/URL Apple Events fallback. Full schema, bridge, privacy, query, limitation, and CI details are in [`BROWSER_ACTIVITY_SENSOR.md`](BROWSER_ACTIVITY_SENSOR.md).

Current-tab DesktopEvents are separately fail-closed:
`WHALEHALL_BROWSER_EVENT_MONITORING_ENABLED` defaults off, and the independent
`WHALEHALL_BROWSER_CONTENT_MONITORING_ENABLED` gate is required before an
event may contain a title or URL. The macOS single-tab fallback never drives
semantic open/navigation/close transitions.

## Device and environment snapshot

Rust callers use:

```rust
use whalehall_local_core::sensors::device_environment::DeviceEnvironmentSensor;

let snapshot = DeviceEnvironmentSensor.collect();
```

Agent callers use:

```json
{"id":"device-1","method":"tool.call","params":{"name":"device.environment","arguments":{}}}
```

The snapshot includes:

- operating-system name/version, kernel version, and architecture;
- device name and local username;
- preferred languages and IANA timezone with current UTC offset;
- display count, position, pixel resolution, scale, refresh rate, and primary/builtin flags;
- CPU brand/vendor, architecture, logical/physical core counts, and frequency;
- total, available, and used memory in bytes;
- battery charge, health, state, cycle count, and remaining-time estimates when available;
- network-interface name/index, loopback state, MAC address, IP addresses, and netmasks.

Collection is best-effort. Missing batteries are represented by an empty list. Components that cannot be queried add an item to `warnings` while all other fields remain available. The Tool requires `device.environment.read` because device name, username, MAC, and IP addresses are sensitive local information.

## Input activity aggregation

`input_activity.rs` owns the macOS-first global input-volume monitor. It keeps
raw callbacks in memory and emits one `input.activityAggregated` DesktopEvent
per non-empty five-second bucket. The complete payload is key count, click
count, relative scroll delta, relative mouse distance, and the bucket start/end
timestamps. It never reads key values, text, clipboard data, screenshots, or
absolute coordinates.

Collection is fail-closed and starts only when
`WHALEHALL_INPUT_MONITORING_ENABLED=true` and macOS Input Monitoring
permission is already present. `input.status` exposes the explicit `enabled`
switch separately from operating-system `authorized` permission and
`captureAvailable` state. The sensor performs no permission prompt; missing
permission is an explicit degraded state, while non-macOS platforms report
unsupported. Empty buckets are omitted and each emitted bucket counts as one
downstream semantic event. The full lifecycle, payload, privacy, Tool, and CI
contract is documented in
[`INPUT_ACTIVITY_SENSOR.md`](INPUT_ACTIVITY_SENSOR.md).

Sleep or a long scheduler pause realigns the next aggregate directly to the
latest completed epoch bucket; skipped empty buckets are never replayed.

Runtime permission loss emits one non-counting `authorization.revoked`
boundary. The latest authorization state is read from the durable EventJournal,
so permission recovery restarts the listen-only tap and emits
`authorization.granted` before resumed aggregates even when WhaleHall restarted
between revoke and grant. Initial authorization without a preceding durable
revocation does not emit a synthetic grant. Conversely, if enabled startup
finds permission already missing after an offline revoke, it immediately
persists one revoke boundary unless the EventJournal already records it.

## VS Code edit bridge

`vscode_edit_bridge.rs` is disabled unless
`WHALEHALL_VSCODE_BRIDGE_DIRECTORY` explicitly names a local absolute bridge
root. It claims only sealed v1 JSONL segments, validates the complete segment,
and durably coalesces per-document edit deltas. Two seconds of silence or ten
seconds of continuous editing seals one `editor.documentChanged` event.

Raw deltas never enter the Desktop EventJournal. Active raw source rows live
only in private `0700`/`0600` editor storage and are deleted atomically when
the immutable burst outbox is created. Filename digest validation,
event-ID tombstones, claimed-file recovery, cross-segment ordering, and
EventJournal deduplication make restart replay idempotent. Full enablement,
schema, atomicity, privacy, status, and CI details are in
[`VSCODE_EDIT_BRIDGE_SENSOR.md`](VSCODE_EDIT_BRIDGE_SENSOR.md).

## Mandatory CI/CD gate

Every public sensor file must have one native CI probe in `tests/native-integration.test.ts`. The test discovers all sibling `.rs` files under `core/src/sensors/` (excluding the registry `mod.rs`) and compares them with the probe table. Adding, renaming, or removing a sensor without updating its probe fails CI.

Each probe must call the sensor through the real packaged JSONL server and assert meaningful output, not only confirm that the Rust code compiles. Probe Tool names and call IDs must be unique. The blocking GitHub Actions matrix runs this gate on multiple hosted macOS, Windows Server, Ubuntu, distribution-container, and virtual-X11 environments before packaging or artifact upload.

The probe also consumes `WHALEHALL_CI_DISPLAY_MODE`, `WHALEHALL_CI_FOREGROUND_MODE`, and `WHALEHALL_CI_PRESENCE_MODE` capability contracts. Display and foreground `required` demand a real desktop capability, `degraded` demands an explicit unavailable state, and `auto` accepts either. Presence additionally supports `complete` for last-input plus lock-state collection and `idle` when only last-input collection is required.

To add a sensor:

1. add its single public entry file under `core/src/sensors/` and export it from `sensors/mod.rs`;
2. expose an Agent-callable Tool suitable for a non-destructive CI probe;
3. add exactly one entry to `sensorCiProbes` with platform-safe output assertions;
4. run `bun run test:sensors:ci` locally when practical, then require every blocking GitHub Actions sensor job to pass before merging or releasing.

Hosted runners can lack an interactive display, battery, or foreground window. A probe must validate successful collection and the component's degraded-state contract on such machines; hardware-dependent values may be empty only when the sensor returns an explicit warning or documented empty representation.

The complete hosted, distribution-container, virtual-X11, and self-hosted real-desktop matrices are documented in [`.github/CI_COMPATIBILITY.md`](../.github/CI_COMPATIBILITY.md). A skipped self-hosted job is not compatibility evidence.
