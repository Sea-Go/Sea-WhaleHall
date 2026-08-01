# WhaleHall Local Edit Bridge for VS Code

This extension is a local, explicit-consent source of editor change events for
WhaleHall. It uses VS Code's `onDidChangeTextDocument` API instead of guessing
editor contents through Accessibility APIs. It does not open sockets, make
network requests, read the clipboard, inspect key values, or collect deleted
text.

The extension is intentionally independent from WhaleHall's root TypeScript and
Rust builds. Its package, types, tests, schema, and build output live entirely
in this directory.

## Consent and privacy defaults

Collection starts only when all of the following are true:

1. `whalehall.monitoring.enabled` is explicitly set to `true`;
2. `whalehall.monitoring.bridgeDirectory` is an explicit absolute local path;
3. a trusted, local VS Code workspace is open.

`whalehall.monitoring.includeText` is a second consent gate and defaults to
`false`. In the default metadata-only mode, each change contains only:

- workspace-relative document path, language, and document version;
- range offset;
- inserted UTF-16 code-unit count;
- deleted UTF-16 code-unit count.

Deleted text is never read or written. When `includeText=true`, only inserted
text is included. It is capped at 1,024 Unicode code points per change and
16 KiB of UTF-8 text per event, with a second JSON-escaped-size budget. An
event contains at most 128 deltas and one JSONL record is at most 64 KiB.

The extension only accepts authority-free `file:` documents inside an open
workspace. It rejects untitled, output, debug, Git, virtual, UNC, and remote
schemes/paths. It also
rejects common credential locations and files such as `.env*`, `.ssh`,
`.aws`, `.npmrc`, private-key extensions, and `dotenv` documents. This is a
defense-in-depth denylist, not a secret scanner; users should still keep
`includeText` off unless content is truly required.

VS Code document-change notifications can originate from typing, paste,
formatters, refactors, or another extension. The event therefore means
“document changed,” not “a particular key was pressed.”

## Build, test, and install

Requirements are Node.js 20+ and Bun 1.3.14.

```bash
cd integrations/vscode-whalehall
bun install --frozen-lockfile
bun run test
```

For an Extension Development Host:

```bash
bun run build
code --extensionDevelopmentPath="$PWD"
```

To build and install a local VSIX without adding a packaging dependency to the
runtime:

```bash
bun run build
bunx @vscode/vsce@3.9.2 package --no-dependencies \
  --allow-missing-repository --no-rewrite-relative-links --skip-license \
  --out whalehall-vscode-bridge.vsix
code --install-extension whalehall-vscode-bridge.vsix
```

The extension has no runtime dependencies. `@types/node`, `@types/vscode`, and
TypeScript are development-only dependencies.

## Configuration

Configure the bridge in workspace or user settings. The directory is created
locally if necessary; relative paths, filesystem roots, NUL bytes, and `..`
traversal are rejected. UNC/network and device paths are also rejected.

```json
{
  "whalehall.monitoring.enabled": true,
  "whalehall.monitoring.includeText": false,
  "whalehall.monitoring.bridgeDirectory": "/absolute/path/chosen/by/the/user"
}
```

The status-bar item always makes the state visible:

- `WhaleHall: off` — explicit monitoring switch is disabled;
- `WhaleHall: metadata` — safe counts and document metadata only;
- `WhaleHall: content` — bounded inserted text is also enabled;
- `WhaleHall: inactive` — workspace trust, configuration, or spool error.

Commands available from the Command Palette:

- `WhaleHall: Show Edit Monitoring Status`;
- `WhaleHall: Flush Pending Edit Events`.

Changing any WhaleHall monitoring setting closes and flushes the old writer
before applying the new configuration.

## Versioned event schema

Every record conforms to
[`schemas/vscode-edit-event.v1.schema.json`](schemas/vscode-edit-event.v1.schema.json).
The source schema is `whalehall-vscode-edit.v1`; its event ID is a deterministic
SHA-256-derived `vse1_…` identifier. The workspace ID is salted by a random
installation identifier kept in VS Code extension global state, so the
absolute workspace URI is neither written nor recoverable from the record.

Metadata-only example:

```json
{
  "schemaVersion": "whalehall-vscode-edit.v1",
  "eventId": "vse1_0123456789abcdef0123456789abcdef",
  "kind": "editor.documentChanged",
  "source": "vscode.extension",
  "occurredAtMs": 1724000000000,
  "observedAtMs": 1724000000001,
  "sensitivity": "metadata",
  "payload": {
    "workspaceId": "wsp1_0123456789abcdef0123456789abcdef",
    "document": {
      "relativePath": "src/example.ts",
      "languageId": "typescript",
      "version": 7
    },
    "changeCount": 1,
    "emittedChangeCount": 1,
    "changesTruncated": false,
    "changes": [
      {
        "rangeOffset": 12,
        "deletedChars": 4,
        "insertedChars": 5
      }
    ]
  }
}
```

## Atomic spool protocol

Records are queued for at most 500 ms, then written as UTF-8 JSONL segments
under:

```text
<bridgeDirectory>/.whalehall-vscode-spool-v1/
```

The checked-in protocol manifest is
[`schemas/spool-manifest.v1.json`](schemas/spool-manifest.v1.json). A producer:

1. creates the owned spool directory with mode `0700` where supported;
2. writes a same-directory `.tmp-<uuid>` file exclusively with mode `0600`;
3. flushes and `fsync`s the file;
4. atomically renames it to
   `segment-<13-digit-time>-<sha256-prefix>.jsonl`;
5. best-effort `fsync`s the containing directory;
6. never appends to a published segment.

A segment contains at most 128 records or 256 KiB. The spool retains at most
4,096 segments or 64 MiB and removes the oldest sealed segments under pressure.
At most eight sealed batches may wait in memory; saturation stops collection
and changes the visible status to an error instead of growing without bound.
The consumer is expected to drain continuously; rotation is a bounded-storage
last resort and can discard an unconsumed oldest segment. Temporary files older
than one hour are treated as abandoned and removed during initialization; the
grace period prevents one VS Code window from deleting another active window's
write. Unknown files are never touched.

## WhaleHall Rust consumer contract

The Rust bridge should be a separate, explicitly enabled Local Tool Host input.
It must:

1. canonicalize the configured bridge root and reject traversal or a symlinked
   spool directory;
2. read only sealed filenames matching the manifest's segment pattern, never
   `.tmp-*`;
3. reject a segment over 256 KiB, a line over 64 KiB, invalid UTF-8, invalid
   JSON, or a record that fails the v1 schema;
4. claim a segment with a same-directory atomic rename, and recover claimed
   files after a crash;
5. validate and sort a complete segment by `(occurredAtMs, eventId)`, then use
   the extension `eventId` as a durable source idempotency key in the private
   editor SQLite database;
6. accept normal cross-segment overlap and duplicates, but quarantine a truly
   late event that predates its document's already sealed boundary without
   blocking later segments;
7. atomically materialize each accepted delta into a deterministic,
   crash-recoverable per-document burst and remove the raw source row in that
   same transaction;
8. seal a burst after two seconds of edit silence or force-seal it after ten
   seconds of continuous editing;
9. publish only the completed, bounded burst to `EventJournal` with a
   deterministic outbox/deduplication key; raw extension records must never
   enter `EventJournal`;
10. commit the private SQLite transaction before deleting the claimed segment.

The Rust consumer owns the two-second edit-silence boundary and ten-second
forced edit-burst boundary. The downstream deterministic window builder
receives only completed semantic bursts. WhaleHall may attach its current
`goalVersion` during final EventJournal publication. The mapping is:

```text
kind           = editor.documentChanged
source         = vscode.extension
sensitivity    = metadata | content
payload        = editorId/documentId/path/language/counts/optional bounded text
                 plus burstStartedAtMs/burstEndedAtMs
goalVersion    = current WhaleHall goal version at ingestion
```

The implemented persistence, quarantine, permissions, recovery, payload, and
status contracts are documented in
[`../../whalehall-local/VSCODE_EDIT_BRIDGE_SENSOR.md`](../../whalehall-local/VSCODE_EDIT_BRIDGE_SENSOR.md).

If the Rust bridge is unavailable, the extension remains local and bounded; it
does not fall back to a network transport.
