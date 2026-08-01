# Presence Sensor

## Purpose and ownership

The presence sensor is implemented in `core/src/sensors/presence.rs`. It is a resident Rust service that collects the latest input time, derives AFK boundaries, observes screen lock/unlock transitions, detects suspend-sized observation gaps, and stores the resulting state and events in `presence.sqlite3`.

It deliberately owns a separate database from foreground usage and process inventory. Presence data has a different permission boundary, sampling cadence, state machine, and retention policy.

## Resident lifecycle

`PresenceService::start` opens and migrates SQLite, restores the latest persisted state, and starts an immediate Tokio polling loop. Configuration is controlled by:

- `WHALEHALL_PRESENCE_POLL_MS`: polling interval, default 1 second, accepted range 50 milliseconds through 60 seconds;
- `WHALEHALL_AFK_THRESHOLD_MS`: idle duration that begins AFK, default 5 minutes, accepted range 1 second through 24 hours;
- `WHALEHALL_SUSPEND_GAP_THRESHOLD_MS`: extra scheduling gap treated as sleep, default 15 seconds, accepted range 1 second through 10 minutes.

The AFK start timestamp is the last input timestamp plus the configured threshold, not the later polling timestamp. AFK ends at the newly observed input timestamp. Lock and unlock events are created only when a known lock state changes; an unavailable lock capability never invents an unlocked state.

Sleep and wake are recorded as a pair when the wall-clock interval between two runtime samples exceeds the expected poll interval plus the suspend threshold. The sleep timestamp is bounded at the previous sample plus one expected interval and wake is the first post-gap observation. This detects ordinary system suspend without requiring the process to be awake during the transition. Extreme scheduler starvation or debugger pauses can produce the same observable gap and are therefore a documented source of false positives.

## Platform collection

- Windows calls `GetLastInputInfo` and compares it with the system tick counter. It checks whether the interactive input desktop is switchable to distinguish the ordinary desktop from the secure lock desktop.
- macOS reads `HIDIdleTime` from `IOHIDSystem` and `CGSSessionScreenIsLocked` from the root I/O Registry session properties.
- Linux uses `xprintidle` when an X11 display is present. It otherwise uses systemd-logind `IdleHint`, `IdleSinceHintMonotonic`, and `LockedHint` for X11 or Wayland sessions.

Headless Linux containers and service sessions commonly expose neither input idle time nor a lock state. In that case the sensor remains alive, reports `degraded`, sets the corresponding capability fields to `false`, and returns explicit warnings. Unknown capability and a known `false` state are never represented by the same value.

## SQLite schema

The database uses WAL mode, normal synchronization, a five-second busy timeout, and schema version `1`.

`presence_state` contains one upserted row with:

- latest observation and calculated last-input timestamps;
- current idle duration, AFK flag, and AFK start timestamp;
- nullable lock state;
- latest detected sleep and wake timestamps.

`presence_events` is append-only and stores `event_type`, the calculated occurrence timestamp, and the later observation timestamp. Supported event types are:

- `afkStarted` and `afkEnded`;
- `screenLocked` and `screenUnlocked`;
- `sleepStarted` and `wokeUp`.

SQLite stores event names in snake case and timestamps as Unix epoch milliseconds. Tool output serializes event names in camel case and includes both Unix milliseconds and RFC 3339 UTC strings.

## Rust and Agent APIs

Rust callers construct `PresenceService` with `SystemPresenceProvider` or a custom `PresenceProvider`. The provider abstraction and deterministic transition function allow AFK, lock, and sleep behavior to be tested without changing the real workstation state.

The read-only Agent Tools require `presence.read`:

- `presence.status` returns current last input, idle duration, AFK and lock state, latest sleep/wake timestamps, capability flags, warnings, configuration, and database path;
- `presence.events` accepts `limit`, `eventTypes`, `fromMs`, and `toMs`.

Example calls:

```json
{"id":"presence-1","method":"tool.call","params":{"name":"presence.status","arguments":{}}}
{"id":"presence-2","method":"tool.call","params":{"name":"presence.events","arguments":{"eventTypes":["afkStarted","afkEnded"],"limit":100}}}
```

## CI/CD contract

The native integration suite requires exactly one probe for `presence.rs`. It starts the real JSONL server, waits for an observation, validates the reported capability contract, calls `presence.events`, and confirms that `presence.sqlite3` exists.

`WHALEHALL_CI_PRESENCE_MODE` declares the environment contract:

- `complete`: both last-input and lock-state collection must work;
- `idle`: last-input collection must work while lock-state collection may be unavailable;
- `degraded`: both desktop capabilities must be explicitly unavailable;
- `auto`: accept any explicit capability combination.

Hosted Windows and macOS jobs use `complete`; the virtual X11 job installs `xprintidle` and uses `idle`; headless Linux jobs use `degraded`; enabled real-desktop runners use `complete`. Unit tests inject observations to verify every AFK, lock/unlock, sleep, and wake transition regardless of CI desktop state.

## Privacy and limitations

Presence timestamps reveal when a person interacted with or left a device. Data remains in the local application-data directory and this implementation does not send it over a network. Agent access must enforce `presence.read`.

The sensor records state transitions, not key names, pointer coordinates, typed text, screenshots, or input contents. Platform security policy can withhold the lock state or last-input time; the status capability flags and warnings expose that limitation.
