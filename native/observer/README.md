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
- Apple Events reads only a foreground Chromium-family tab title and URL after
  proving the window is not incognito. URL credentials, fragments, and
  sensitive query parameters are removed before emission. Safari is
  metadata-only in v2 because its public scripting API cannot prove that the
  front window is not private; the helper fails closed instead of guessing.
- The listen-only `CGEventTap` counts key-downs, clicks, scrolling, and relative
  movement. It never reads key codes, characters, clipboard contents, or
  persistent pointer coordinates.
- Password managers, secure fields, authentication/payment windows, and
  private/incognito browser windows are rejected before content emission.

The helper needs user-granted Accessibility, Screen Recording, Input
Monitoring, and browser Automation permissions. A `refreshPermissions`
command with `"prompt":true` may request them; normal startup only checks
existing authorization.

## JSONL protocol

Every stdin and stdout line is one UTF-8 JSON object and is limited to 512 KiB.
Start capture:

```json
{"type":"command","id":"start-1","command":"start","config":{"captureContent":true,"excludedBundleIds":[]}}
```

Other commands are `pause`, `resume`, `status`, `refreshPermissions`, and
`shutdown`. The parent cumulatively acknowledges observations only after
durable persistence:

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
deployment target, creates the `.app` bundle under `.native`, and applies an
ad-hoc signature for local development. Electrobun copies the nested app to:

```text
Resources/app/native/WhaleHall Observer.app
```

Set `ELECTROBUN_DEVELOPER_ID` (or the helper-specific
`WHALEHALL_OBSERVER_SIGNING_IDENTITY`) to a Developer ID Application identity
to apply a hardened-runtime signature. Release automation must also set
`WHALEHALL_RELEASE_SIGNING_REQUIRED=true`; this makes both the helper and outer
build fail instead of falling back to ad-hoc signing. Set
`WHALEHALL_MACOS_NOTARIZE=true` only in the notarization job with Electrobun's
required Apple credentials. The containing WhaleHall app is signed after the
nested helper.
