# Accessibility Tree Sensor

## Purpose and ownership

The accessibility-tree sensor is implemented in
`core/src/sensors/accessibility_tree.rs`. It is an explicitly enabled resident Rust service that
samples the foreground application's bounded accessibility tree and stores
changed snapshots in `accessibility.sqlite3`. It is fail-closed by default.

The sensor covers:

- the foreground application and window;
- the currently focused control;
- buttons, menus, text boxes, documents, and other accessibility roles;
- control names and optional values;
- selected controls and items;
- bounded text excerpts exposed by document or text accessibility interfaces.

It does not perform clicks, edits, focus changes, or other UI automation
actions. Both Agent Tools are read-only and require `accessibility.read`.

## Collection paths

The system provider first checks the atomic JSON bridge reported by
`accessibility.status`, normally `accessibility-current-tree.json` beside the
database. A fresh bridge snapshot has this shape:

```json
{
  "observedAtMs": 1700000000000,
  "available": true,
  "applicationName": "Editor",
  "processId": 42,
  "windowTitle": "Document",
  "capabilities": {
    "tree": true,
    "focusedControl": true,
    "selection": true,
    "documentText": true
  },
  "nodes": [
    {
      "nodeId": "body",
      "parentId": "window",
      "depth": 1,
      "role": "textBox",
      "name": "Document body",
      "value": "bounded value",
      "selected": false,
      "focused": true,
      "enabled": true,
      "documentText": "bounded document excerpt",
      "protected": false
    }
  ],
  "warnings": []
}
```

Bridge writers must replace the file atomically and refresh `observedAtMs`.
Snapshots older than `WHALEHALL_ACCESSIBILITY_BRIDGE_MAX_AGE_MS` are rejected.
The bridge is useful for an embedded desktop accessibility adapter and for
deterministic tests.

Without a bridge, the provider uses the operating system:

- Windows calls UI Automation through PowerShell and
  `UIAutomationClient`/`UIAutomationTypes`;
- macOS queries the frontmost process through System Events/JXA and therefore
  requires the packaged application to have Accessibility and Automation
  permission;
- Linux queries the active AT-SPI application through Python `pyatspi`; the
  desktop session must expose an accessibility bus and have the distribution's
  Python AT-SPI package installed.

Unavailable permissions, a service/headless session, or a missing Linux AT-SPI
runtime produce an explicit `degraded` state with warnings. They do not invent
an empty accessibility tree.

## Bounds and privacy

Accessibility data can contain private messages, document contents, form
values, filenames, and account information. The implementation applies these
limits before writing SQLite:

- resident collection requires
  `WHALEHALL_ACCESSIBILITY_MONITORING_ENABLED=true`;
- values and document excerpts require the separate
  `WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED=true` switch;
- metadata-only collection does not ask the native platform adapters for
  values/document text and clears those fields again at the normalization
  boundary, including bridge-supplied fields;
- at most 300 nodes per snapshot by default, configurable up to 1,000;
- control names are limited to 1,024 characters;
- ordinary values are limited to 4,096 characters;
- document excerpts are limited to 4,096 characters by default and at most
  16,384;
- roles marked password or secure, or nodes with `protected: true`, always have
  both `value` and `documentText` removed;
- only changed trees create a new SQLite snapshot;
- snapshots older than seven days are deleted when a changed snapshot is
  stored; retention is configurable from 1 through 30 days.

`accessibility.status` never returns control values or document text.
`accessibility.tree` also redacts both fields unless callers explicitly set
`includeValues` or `includeDocumentText`.

Data stays in the local application-data directory and is not transmitted by
this implementation. Deployments should treat `accessibility.read` as a
high-impact permission and show an explicit consent surface.

## Configuration

- `WHALEHALL_ACCESSIBILITY_MONITORING_ENABLED`: fail-closed resident
  collection switch, default `false`;
- `WHALEHALL_ACCESSIBILITY_CONTENT_MONITORING_ENABLED`: independent value and
  document-content switch, default `false`; it is ineffective unless
  monitoring is enabled;
- `WHALEHALL_ACCESSIBILITY_POLL_MS`: polling interval, default 2 seconds,
  range 50 milliseconds through 60 seconds;
- `WHALEHALL_ACCESSIBILITY_SNAPSHOT_PATH`: optional bridge path;
- `WHALEHALL_ACCESSIBILITY_BRIDGE_MAX_AGE_MS`: bridge freshness, default
  15 seconds, range 1 second through 10 minutes;
- `WHALEHALL_ACCESSIBILITY_MAX_NODES`: default 300, range 1 through 1,000;
- `WHALEHALL_ACCESSIBILITY_DOCUMENT_TEXT_LIMIT`: default 4,096, range 0
  through 16,384; zero disables stored document excerpts;
- `WHALEHALL_ACCESSIBILITY_RETENTION_DAYS`: default 7, range 1 through 30.

## SQLite schema and lifecycle

The database uses WAL mode and foreign keys:

- `accessibility_snapshots` stores observation time, application name, optional
  process ID, window title, and node count;
- `accessibility_nodes` stores ordered parent/child identity, depth, role, name,
  optional value, nullable selection state, focus, enabled state, optional
  document excerpt, and the protected-input marker.

The service opens SQLite with `whalehall-local` so Tools can query previously
authorized snapshots. With monitoring disabled it reports `disabled` and does
not invoke the bridge or platform provider. When explicitly enabled it remains
resident independently of Agent calls and shuts down before the other desktop
sensors. A content-only configuration remains fail-closed and reports a
warning. Callers can provide a custom `AccessibilityProvider` for deterministic
embedding or tests.

## Agent Tools

- `accessibility.status` returns lifecycle state, paths, limits, current
  application/window, focused-control summary, capability flags, warnings, and
  counts.
- `accessibility.tree` accepts `snapshotId`, `limit`, `roles`, `focusedOnly`,
  `selectedOnly`, `includeValues`, and `includeDocumentText`.

Examples:

```json
{"id":"a11y-1","method":"tool.call","params":{"name":"accessibility.status","arguments":{}}}
{"id":"a11y-2","method":"tool.call","params":{"name":"accessibility.tree","arguments":{"focusedOnly":true}}}
{"id":"a11y-3","method":"tool.call","params":{"name":"accessibility.tree","arguments":{"roles":["button","menu","textBox"],"includeValues":true,"limit":100}}}
{"id":"a11y-4","method":"tool.call","params":{"name":"accessibility.tree","arguments":{"roles":["document"],"includeDocumentText":true,"limit":10}}}
```

## CI/CD contract

`tests/native-integration.test.ts` discovers
`accessibility_tree.rs` automatically and requires exactly one probe. The probe
explicitly enables both accessibility switches and writes a fresh isolated
bridge containing a window, button, menu, text box,
selected item, document excerpt, and protected password control. Through the
real JSONL server it verifies:

- resident readiness, capabilities, focused-control summary, and SQLite
  creation;
- registration and execution of both Tools;
- role/name/value, selection, focus, and document-text persistence;
- unconditional redaction of protected input values;
- platform-native temporary paths on every blocking operating-system job.

The fixture avoids reading the CI account's actual UI contents. Native Windows
UI Automation, macOS permission grants, and Linux AT-SPI session integration
remain real interactive-desktop certification checks; a skipped self-hosted
desktop matrix is not evidence for those permissions.
