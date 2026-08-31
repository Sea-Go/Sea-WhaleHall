# Sea-WhaleHall Agent Guide

This file applies to the entire repository. It is the executable project guide
for Codex and other automated contributors. Human contribution and review
requirements are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Project boundary

WhaleHall is an Electrobun desktop application with two independent WebViews,
a thin TypeScript Agent boundary, and a Rust Local Tool Host. Preserve these
ownership boundaries:

| Area | Location | Owns |
| --- | --- | --- |
| React client | `src/views/client` | Product pages, feature UI, client-only state, and service adapters |
| React pet view | `src/views/pet` | Canvas rendering, pointer interaction, semantic animation, and replaceable pet models |
| Electrobun main | `src/bun` | Native windows, Typed RPC routing, lifecycle, and composition |
| Shared contracts | `src/shared` | Typed RPC and model-independent data shared across WebViews and Bun |
| TypeScript Agent | `src/agent` | Thin orchestration boundary and the Local Tool process client |
| Rust protocol | `native/local-host/protocol` | JSONL request, response, event, and error contracts |
| Rust core | `native/local-host/core` | Local capabilities, permissions, sensors, SQLite, and Tool execution |
| Rust server | `native/local-host/server` | Concurrent stdin/stdout JSONL host and process lifecycle |
| Credential helper | `native/credential-helper` | One-shot OS vault access without exposing secrets to Renderer RPC |
| macOS Observer | `native/observer` | Signed accessibility, input, browser, and screen observation helper |
| macOS Vault Broker | `native/vault-broker` | Signed versioned bridge to protected observation content |

React must not call Rust, native window APIs, or another WebView directly.
WebViews communicate through Typed RPC implemented by the Bun main process.
Rust owns local capability collection and persistence; React owns presentation.
The TypeScript Agent must remain thin and must not duplicate Rust Tool
registration, validation, permissions, cancellation, or sensor state machines.

Generated output is not source. Do not hand-edit `dist/`, `build/`,
`artifacts/`, `.native/`, or `native/**/target/`.

## Read before changing

Always read:

- [README.md](README.md);
- [CONTRIBUTING.md](CONTRIBUTING.md);
- [docs/frontend/FRONTEND_STANDARD.md](docs/frontend/FRONTEND_STANDARD.md);
- [docs/frontend/UI_REFERENCES.md](docs/frontend/UI_REFERENCES.md).

Also read the files for the affected boundary:

- calendar work:
  [docs/frontend/CALENDAR_STANDARD.md](docs/frontend/CALENDAR_STANDARD.md);
- RPC or window work: `src/shared/contracts.ts`, `src/bun/index.ts`, and the
  relevant WebView `rpc.ts`;
- Agent or Local Tool work: `src/agent/local-protocol.ts`,
  `src/agent/agent-runtime.ts`, and the relevant Rust protocol/core code;
- pet work: `src/views/pet/core/types.ts`, `src/shared/pet-actions.ts`,
  `src/bun/pet-state.ts`, and the pet architecture tests;
- sensor work: `native/local-host/SENSORS.md`, the sensor-specific document, and
  `tests/native-integration.test.ts`;
- build or packaging work: `package.json`, `vite.config.ts`,
  `electrobun.config.ts`, `scripts/`, and the workflows under `.github/`.

Use the versions and commands currently present in `package.json`,
`bun.lock`, `rust-toolchain.toml`, and the Cargo manifests. Do not invent a
script in documentation or code review.

## Client feature structure and dependency direction

New client product work is feature-first under
`src/views/client/features/<feature>`. The intended feature names are:

- `auth`
- `planning`
- `calendar`
- `reports`
- `settings`
- `pet-bridge`

Use the following dependency direction:

```text
main.tsx
  -> app composition and cross-feature workflows
    -> feature public APIs
      -> client-shared UI/lib
        -> infrastructure adapters
          -> repository shared Typed RPC contracts
```

Rules:

- Pages compose features; pages do not own domain rules.
- Feature UI may depend on its own domain and service interfaces.
- Domain code must not import React, FullCalendar, chart libraries,
  Electrobun, or browser globals.
- Shared UI must not import feature code or contain business decisions.
- Features must not import another feature's internal files. Cross-feature
  operations belong in app-level workflows and use explicit public contracts.
- Keep `src/shared` reserved for cross-runtime contracts. Client-only shared
  components belong under `src/views/client/shared`.
- Create a feature barrel/public file only when it enforces a real public API.
  Do not add empty or pass-through `index.ts` files for visual symmetry.
- Keep `App.tsx` or its successor limited to composition, bootstrapping, and
  top-level gates.
- Wrap external libraries in adapters. Business code must not expose
  FullCalendar `EventInput`, chart configuration objects, or raw RPC payloads.

## UI rules

- Product copy is clear, natural Chinese. Infrastructure identifiers may
  remain English where they are user-meaningful.
- Do not use emoji as product icons. Use the approved icon component and give
  icon-only controls an accessible name.
- Use WhaleHall design tokens for color, spacing, typography, radius, shadow,
  z-index, motion, and focus rings. Do not add feature-local lookalike tokens.
- The default desktop QA viewport is `1440x900`; the minimum supported viewport
  is `1180x720`.
- Navigation, buttons, menus, inputs, dialogs, events, and settings controls
  require hover, active/pressed, disabled, and `:focus-visible` states as
  applicable.
- Do not encode status only with color. Add text, iconography, pattern, border,
  or another non-color signal.
- Respect `prefers-reduced-motion`; motion must not be required to understand
  state.
- Avoid ornamental gradients, glass effects, and textures in dense content.
  Decoration is limited to the shell/sidebar, authentication, and empty states.
- Every async surface must render an explicit state instead of silently showing
  stale or blank content.
- Do not log tokens, credentials, accessibility values, browser history,
  activity records, or other sensitive user data from the renderer.

## Calendar rules

The rules in
[docs/frontend/CALENDAR_STANDARD.md](docs/frontend/CALENDAR_STANDARD.md) are
mandatory. In particular:

- `CalendarEvent` is the domain contract; FullCalendar objects stay in the
  adapter.
- Event `kind` distinguishes `plan`, `manual-block`, `external`, and `break`.
- Event `state` distinguishes `proposed` and `committed`.
- Timed events, all-day events, recurring series, occurrences, and exceptions
  are distinct domain cases.
- Manual occupied blocks are editable events, not immutable background paint.
- Proposed events must differ from committed events by more than color.
- Drag and resize are optimistic mutations with version checks and a visible,
  tested rollback path.
- Conflicts return an explicit reason. Red is reserved for failure and severe
  conflicts.
- Pointer interactions always have a form or keyboard alternative.
- Timezone and DST behavior is tested with named IANA zones; all-day values
  remain date-only.

## Required page and component states

Implement every state relevant to a surface, using discriminated state models
instead of unrelated booleans:

- booting or loading;
- empty;
- populated;
- partial data;
- authenticating or saving/applying;
- success;
- recoverable error;
- offline or service unavailable;
- disabled or unavailable;
- conflict;
- expired session.

Do not show protected content before the authentication gate resolves. Do not
turn missing report data into zero. Do not silently discard a failed schedule
mutation or preference save.

## Validation

Use the smallest relevant command while iterating, then run the complete
required gate for the change:

```bash
bun run typecheck
bun run test
bun run lint:changed
bun run build:views
bun run check
```

Additional repository commands:

```bash
bun run test:rust
bun run test:sensors:ci
bun run build:native
bun run build:canary
bun run scripts/verify-pet-animations.ts
```

- `bun run check` is the current complete code-quality command. It runs
  TypeScript typecheck, Rust formatting/Clippy/tests, and all Bun tests.
- `bun run lint:changed` reports Biome findings for files changed against
  `main`. It is intentionally informational in CI until the historical
  baseline is retired; do not describe it as a hard merge gate.
- There is currently no repository-wide hard `lint`/format gate or E2E
  script. Do not claim one ran until it exists in `package.json`.
- Run `bun run build:views` for client or pet source changes because
  `bun run check` does not build the Vite entries.
- Run pet animation verification and affected pet tests for pet action,
  animator, renderer, model, interaction, or arbiter changes.
- Run native integration tests for sensor, Tool, protocol, or Local Tool
  lifecycle changes when practical.
- Full canary packaging is required for release/build changes, not for every
  documentation-only edit.

## Visual acceptance workflow

For any UI change:

1. Run the affected type and behavior tests.
2. Build the views with `bun run build:views`.
3. Start `bun run dev:hmr` or the real Electrobun development application.
4. Inspect the actual page at `1440x900` and `1180x720`.
5. Exercise loading, empty, populated/dense, error/offline, disabled, and
   conflict states that apply.
6. Check long Chinese text, keyboard-only operation, focus visibility, reduced
   motion, window resizing, overflow, and dialog/popover/tooltip stacking.
7. Capture before/after screenshots for the pull request.
8. Perform at least one visual correction pass after observing the rendered
   result. Calendar changes require at least two passes.

A passing build is not visual acceptance. Browser-only inspection also does not
replace the required real Electrobun window smoke check for integration work.

## Commits and review

Follow the Conventional Commits policy in
[CONTRIBUTING.md](CONTRIBUTING.md#commit-messages). Keep changes scoped, do not
mix unrelated refactors with feature work, and include verification evidence in
the pull request template.
