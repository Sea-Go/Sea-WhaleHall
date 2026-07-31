# WhaleHall Observer

`WhaleHall Observer.app` is the macOS 14+ zero-extension capture helper bundled
inside WhaleHall. It does not inject code into browsers or editors and does not
open a network socket. The Rust Local Tool Host owns its lifecycle and durable
storage.

## Privacy boundary

- Accessibility (`AXObserver`) is the primary source for the foreground
  window, focused control, final control value, selection, and bounded visible
  text.
- ScreenCaptureKit captures only the foreground application's on-screen
  window. Vision OCR runs against an in-memory `CGImage`; pixels and screenshots
  are never written to a file or sent through the protocol.
- Apple Events is an optional, per-browser privacy check and metadata
  enrichment. If it was granted independently, Accessibility and OCR provide
  the visible browser content while Apple Events proves the foreground
  Chromium-family window is not incognito and supplies its title and URL.
  WhaleHall never requests Automation itself and never loops over running
  browsers to display separate consent dialogs. If this privacy check is
  unavailable, deep browser capture fails closed. URL credentials, fragments,
  and sensitive query parameters are removed before emission.
- The listen-only `CGEventTap` counts key-downs, clicks, scrolling, and relative
  movement. It never reads key codes, characters, clipboard contents, or
  persistent pointer coordinates.
- Password managers, secure fields, authentication/payment windows, and
  private/incognito browser windows are rejected before content emission.

The helper uses one explicit monitoring-permission action to request the three
macOS capabilities needed by the built-in observer: Accessibility, Screen
Recording, and Input Monitoring. macOS owns those separate TCC decisions, but
WhaleHall asks for them only from that explicit action and never during
startup, status checks, heartbeat checks, or normal refreshes. Once granted to
a stably signed WhaleHall build, they persist across launches.

Browser Automation is optional and is not requested by that action. Without a
per-browser grant, WhaleHall still observes foreground application metadata but
marks deep browser content unavailable because it cannot reliably exclude a
private/incognito window. `refreshPermissions` is always a read-only preflight.
The separate `setupPermissions` command is the only prompt-capable command and
the parent may send it only once per stable installation identity after a direct
user action. A `prompt` field on any command is rejected by the helper.

## JSONL protocol

Every stdin and stdout line is one UTF-8 JSON object and is limited to 512 KiB.
Start capture:

```json
{"type":"command","id":"start-1","command":"start","config":{"captureContent":true,"excludedBundleIds":[]}}
```

Other commands are `pause`, `resume`, `status`, `refreshPermissions`,
`setupPermissions`, and `shutdown`. The parent cumulatively acknowledges
observations only after durable persistence:

```json
{"type":"ack","bootId":"<ready.bootId>","sequence":42}
```

The helper emits `ready`, `permissionStatus`, `heartbeat`, `commandResult`,
`gap`, `error`, and sequenced `observation` frames. Observation payloads use
`raw-observation.v2`. At most 256 frames or 16 MiB remain unacknowledged; when
the parent is behind, new observations are dropped with an explicit `gap`
frame and no plaintext spill file is created.

When stdin closes, the helper stops all sensors and exits. The parent should
restart an unexpected exit after `1s`, `5s`, `15s`, then `60s`; five failures
inside ten minutes should enter a visible degraded state.

## Build and signing

`bun run build:native` compiles the helper with Swift 6 and a macOS 14
deployment target and creates the `.app` bundle under `.native`. Development
and canary builds automatically use the one valid login-Keychain identity
named exactly `WhaleHall Local Development`. Install it once, only through the
explicit setup command:

```bash
# Read-only report.
bun run setup:macos-signing

# The only command allowed to create or explicitly verify the current-user
# identity. Choose "Always Allow" if macOS asks about private-key access.
bun run setup:macos-signing -- --create
```

Ordinary builds never write Keychain state. The fixed certificate keeps the
helper's designated requirement stable across rebuilds, so macOS monitoring
authorization can be granted once. Without it, local builds use an ad-hoc
signature and intentionally remain metadata-only. Electrobun copies the nested
app to:

```text
Resources/app/native/WhaleHall Observer.app
```

For an already valid identity, the mutating setup command performs two
temporary signatures without replacing the certificate. This proves that the
first Keychain choice was persistent; choosing only "Allow" instead of "Always
Allow" would otherwise make later builds prompt again.

Release builds must set `ELECTROBUN_DEVELOPER_ID` to a valid Developer ID
Application identity and `WHALEHALL_APPLE_TEAM_ID` to its exact 10-character
Team ID. A helper-specific override, when present, must be the same identity.
Release automation must also set
`WHALEHALL_RELEASE_SIGNING_REQUIRED=true`; this makes both the helper and outer
build fail instead of falling back to the local or ad-hoc identity. Set
`WHALEHALL_MACOS_NOTARIZE=true` only in the notarization job with Electrobun's
required Apple credentials. The containing WhaleHall app is signed after the
nested helper. Post-package verification compares the staged and packaged
designated requirements and rejects cdhash-only signatures, identifier
rewrites, and any leaf-certificate change.
