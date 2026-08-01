# VS Code Edit Bridge Sensor

`core/src/sensors/vscode_edit_bridge.rs` consumes the explicit-consent spool
written by `integrations/vscode-whalehall`. It never observes global key values
and never publishes raw VS Code document deltas. Only completed semantic edit
bursts enter the Desktop EventJournal.

## Enablement and path policy

The consumer is disabled unless `WHALEHALL_VSCODE_BRIDGE_DIRECTORY` names an
explicit absolute local directory. Disabled startup does not guess a bridge
path, create a spool, open the editor database, or start a polling task.

When enabled, the consumer canonicalizes the configured root and its direct
`.whalehall-vscode-spool-v1` child. A symlinked root, spool, matching segment,
database, or private state directory fails closed. It ignores unknown files
and `.tmp-*`; it reads only the manifest's sealed
`segment-<13-digit-time>-<32-lowercase-hex>.jsonl` files and its own
`.claimed-…` recovery names.

## Atomic ingestion and recovery

The consumer atomically renames each sealed file to its claimed name, verifies
the filename timestamp and SHA-256 prefix, and validates the whole segment
before importing any record. Limits are 256 KiB per segment, 64 KiB per JSONL
record, and 128 records per segment. UTF-8, strict v1 fields, identifier/path
shapes, safe integers, `observedAtMs >= occurredAtMs`, count consistency, and
the metadata/content text gate are all checked. On Unix the claimed file is
opened with `O_NOFOLLOW` and validated through the opened file descriptor.

Records are sorted by `(occurredAtMs, eventId)` both inside segments and inside
each durable open burst. Normal cross-segment overlap and exact event-ID
duplicates are accepted. A genuinely late record is quarantined only when its
document timestamp is earlier than that document's persisted sealed boundary
and would therefore rewrite an immutable burst. The invalid claimed file and
one bounded error remain available for manual inspection, but it does not
block later independent segments and is not reparsed or repeatedly logged.
Moving the claimed file away clears its quarantine record on the next scan;
an operator can then repair and republish it under a new content-derived
filename.

One `BEGIN IMMEDIATE` transaction:

1. inserts immutable source-event dedup tombstones and short-lived source JSON;
2. updates deterministic, crash-recoverable per-document open bursts;
3. seals any event-time-mature bursts into an immutable outbox;
4. records the segment as imported and advances the timestamp watermark.

The claimed file is deleted only after commit. A crash before commit rolls the
whole import back; a crash after commit replays through segment and event-ID
deduplication. As soon as each source record is materialized into its durable
bounded open burst, its raw `source_events` row is deleted in the same
transaction. Sealing later replaces that open burst with the immutable outbox;
hash-only idempotency tombstones remain. Tombstones expire after seven days and
are capped at one million rows once the live-burst safety horizon has passed.
Schema creation and upgrades run in one reentrant transaction, including
recovery from the former partially-created version-zero layout.

## Burst and EventJournal contract

Each document has an independent durable burst. Two seconds without another
change seals it; continuous changes force a seal exactly ten seconds after its
first event. A change at that ten-second boundary starts the next burst.
Background ticks seal silence deadlines even when no new spool segment arrives.

The final `editor.documentChanged` payload is:

```json
{
  "editorId": "edt1_<opaque>",
  "documentId": "doc1_<opaque>",
  "relativePath": "src/example.ts",
  "language": "typescript",
  "insertedChars": 12,
  "deletedChars": 3,
  "text": "optional bounded inserted text",
  "burstStartedAtMs": 1724000000000,
  "burstEndedAtMs": 1724000002000
}
```

`text` is absent for metadata input and bounded to 4,096 characters for
content input. Deleted text is never collected. `editorId`, `documentId`, the
outbox burst ID, and the EventJournal deduplication key are deterministic
opaque hashes. Appending the outbox precedes its local deletion, so a crash
after EventJournal commit is an idempotent replay rather than a duplicate
DesktopEvent.

## Private storage and status

The durable state is `editor-bridge/editor.sqlite3` under WhaleHall's data
directory. The owned directory is mode `0700`; the database and existing WAL
and SHM sidecars are mode `0600` on Unix.

The read-only `editor.status` Tool requires `editor.metadata` and accepts no
arguments. It reports explicit enablement, canonical paths, polling interval,
sealed/claimed backlog, rejected segments, open bursts, outbox backlog,
import/publication timestamps, warnings, and the last error. It never returns
document paths, text, event IDs, or burst payloads.

Native CI creates an explicitly enabled bridge fixture, waits for its burst to
seal, verifies `editor.status`, and observes the proactive
`desktop.event` push. Rust unit tests cover silence and forced boundaries,
independent documents, content gating, claimed-file recovery, EventJournal
replay, deterministic cross-segment overlap, true-late quarantine without
head-of-line blocking, migration recovery, bounded deduplication, strict
validation, raw-source cleanup, and Unix path permissions.
