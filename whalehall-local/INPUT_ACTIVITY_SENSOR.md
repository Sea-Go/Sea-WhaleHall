# Input Activity Sensor

## Purpose and privacy boundary

The input activity sensor is implemented in
`core/src/sensors/input_activity.rs`. It is a resident, macOS-first Rust
service that converts global keyboard and pointer activity into fixed
five-second aggregate events for the local `EventJournal`.

This is an activity-volume sensor, not a keylogger. The platform callback may
only update these in-memory values:

- number of key-down events;
- number of mouse-button clicks;
- net relative scroll delta;
- distance derived from relative pointer movement.

It never reads or stores key codes, characters, typed text, clipboard data,
screen contents, or absolute pointer coordinates. Raw callbacks are never
written to SQLite and are discarded after they update the current counters.

## Explicit enablement and macOS permission

Collection is fail-closed. It starts only when
`WHALEHALL_INPUT_MONITORING_ENABLED=true` (also accepting `1` or `yes`) and
macOS Input Monitoring permission is already granted. The default is
disabled.

The two conditions remain visible separately in `input.status`:

- `enabled` is the explicit WhaleHall product switch;
- `authorized` and `permissionGranted` report the current operating-system
  permission;
- `captureAvailable` is true only while a listen-only event tap is operating.

The sensor calls the read-only `CGPreflightListenEventAccess()` check. It does
not call the API that displays a permission prompt. Therefore an existing
macOS permission never enables collection by itself, and enabling WhaleHall
without granting the operating-system permission produces a `degraded` status
and an actionable warning rather than a crash.

On non-macOS platforms the same status Tool is available, but the sensor
reports `supported: false`, `authorized: false`, and
`captureAvailable: false`. Windows and Linux implementations can later reuse
the same aggregate event contract.

## Collection and event contract

The macOS provider creates a session-level, listen-only `CGEventTap` for key
down, mouse button down, mouse move/drag, and scroll events. The callback
returns every event unchanged. It reads relative `MouseEventDeltaX` and
`MouseEventDeltaY` values for distance and relative scroll delta fields for
scrolling; it never reads the keyboard key-code or event location fields.

The resident service uses deterministic epoch-aligned buckets:
`[floor(timestamp / 5000) * 5000, +5000)`. On startup it waits only until the
end of the current bucket; the capture counters begin empty, so the first
possibly short bucket cannot include pre-start activity. At each boundary the
service atomically drains the counters. Non-empty buckets are appended to
`events.sqlite3` as `input.activityAggregated`:

```json
{
  "keyCount": 12,
  "clickCount": 3,
  "scrollDelta": -8,
  "mouseDistance": 481.264,
  "bucketStartedAtMs": 1700000000000,
  "bucketEndedAtMs": 1700000005000
}
```

These six fields are the complete payload contract. Each non-empty aggregate
is one semantic event for downstream reflection-window counting, regardless
of the raw counts inside it. Empty buckets are not published, so an idle
computer cannot create behavior events or empty reflection work.

After sleep, suspend, or a long scheduler pause, the next tick realigns
directly to the latest completed epoch bucket. It never emits or walks through
the intervening empty buckets, and newly drained activity is not timestamped
against a stale pre-sleep bucket.

The event uses metadata sensitivity and a deterministic key based on its
bucket boundaries. `EventJournal` deduplication therefore prevents a repeated
append of the same bucket. The event stream is available through the existing
`event.query`, `event.commit`, and live `desktop.event` protocol.
On POSIX systems the EventJournal database and present WAL/SHM sidecars are
forced to owner-only mode `0600`; a newly created journal parent directory is
forced to `0700`.

## Lifecycle and degraded behavior

The service states are `starting`, `disabled`, `running`, `degraded`, and
`stopped`.

- A disabled product switch never creates the event tap.
- Missing Input Monitoring permission or event-tap failure is degraded, not a
  server startup failure.
- If macOS revokes permission or disables the tap at runtime, capture stops
  and the status becomes degraded with a warning. A transition from granted to
  revoked also emits one non-counting `authorization.revoked` boundary with
  `permissions: ["input.monitoring"]`.
- Authorization state is durable in the EventJournal. If permission was
  revoked while WhaleHall was stopped, enabled startup observes the missing
  permission and immediately emits one `authorization.revoked` boundary unless
  that revoke is already durable.
- When permission is restored, including after a process restart, the sensor
  emits one non-counting `authorization.granted` boundary with the same
  permission payload before publishing resumed aggregates. Startup with
  permission already present and no prior revoke does not invent a grant event.
- Event publication failure also degrades the status. The current in-memory
  bucket is not exposed through another channel.
- Shutdown cancels the bucket loop, stops the run loop, and joins the capture
  thread.

## Rust and Agent APIs

Rust callers construct `InputActivityService` with
`SystemInputActivityProvider` or a custom `InputActivityProvider`. Tests use a
custom provider and the deterministic bucket accumulator, so no synthetic
keystrokes or changes to workstation permission are required.

The read-only `input.status` Tool requires `input.aggregate` and accepts no
arguments:

```json
{"id":"input-1","method":"tool.call","params":{"name":"input.status","arguments":{}}}
```

It returns the enablement, authorization and capture capability fields, the
five-second duration, latest bucket and publication timestamps, number of
published buckets, latest safe aggregate, warnings, and last error. It never
returns raw input.

## CI/CD contract

`tests/native-integration.test.ts` must contain exactly one native probe for
`input_activity.rs`. Hosted CI must force
`WHALEHALL_INPUT_MONITORING_ENABLED=false` and assert the fail-closed contract:
`state: "disabled"`, `enabled: false`, and `captureAvailable: false`. On macOS,
`authorized` may be true or false because the read-only preflight reflects the
runner's real privacy database; it must not change `enabled`.

Unit tests inject aggregate deltas to verify that 1,000 raw actions remain one
five-second semantic event, empty buckets are omitted, payload serialization
contains only the six allowed fields, and product enablement remains
independent from operating-system authorization. They also verify direct epoch
realignment after a long pause, revoke detection while WhaleHall was stopped,
and revoke/grant closure across process restarts.
