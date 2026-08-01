# WhaleHall Frontend Standard

This standard governs the React client under `src/views/client`. Repository
ownership and validation rules are in [AGENTS.md](../../AGENTS.md), human
workflow is in [CONTRIBUTING.md](../../CONTRIBUTING.md), and visual references
are constrained by [UI_REFERENCES.md](UI_REFERENCES.md).

## Architecture

The client uses a feature-first structure:

```text
src/views/client/
├── app/                 # boot, shell, navigation, cross-feature workflows
├── features/
│   ├── auth/
│   ├── planning/
│   ├── calendar/
│   ├── reports/
│   ├── settings/
│   └── pet-bridge/
├── infrastructure/      # Electrobun and test service implementations
└── shared/
    ├── ui/              # business-neutral components
    ├── styles/          # tokens and global foundations
    └── lib/             # small business-neutral utilities
```

Do not reorganize the whole client in one mechanical move. Create each
directory when its first real responsibility is implemented and keep the
existing entry points working throughout migration.

### Dependency direction

Allowed direction:

```text
entry -> app -> feature public API -> feature internals
                                \-> client shared
feature service interface -> infrastructure implementation -> Typed RPC
```

Forbidden:

- domain importing React, Electrobun, FullCalendar, chart libraries, or CSS;
- shared UI importing a feature;
- a feature importing another feature's internal component, hook, store, or
  adapter;
- JSX directly calling `rpc.request`;
- React operating pet DOM or native windows;
- client code importing Rust protocol implementation details;
- cyclic imports between `app`, features, and infrastructure.

An app-level workflow may coordinate two features through their public
contracts, for example confirming a planning draft through the calendar
service. It must not reach into either feature's internal store.

## Feature contents and public API

A feature may contain only the files it needs, commonly:

```text
domain.ts
<feature>-service.ts
<Feature>Page.tsx
components/
hooks/
tests/
```

The domain defines stable product concepts and pure operations. The service
file defines the interface used by the feature. Infrastructure implements that
interface. Components render state and dispatch named actions.

Create `public.ts` only after another layer needs a supported API. Export the
minimum domain types, components, and operations required by that consumer.
Never export internal reducer state, third-party objects, mutable caches, or
test-only fixtures.

## Naming

- React components and component files: `PascalCase`, for example
  `AuthGate.tsx`, `CalendarToolbar.tsx`.
- Hooks: `useCamelCase`, for example `useCalendarView.ts`.
- Domain types: product nouns such as `CalendarEvent`, `GenerationRun`, and
  `ReportPeriod`; avoid `Data`, `Info`, and `Item` when a precise noun exists.
- Service interfaces: `<Feature>Service`; implementations describe the
  boundary, for example `MockAuthService` or `ElectrobunCalendarService`.
- Pure mapping functions: `<source>To<target>`, for example
  `calendarEventToFullCalendarInput`.
- Event handlers passed as props: `on<Action>`; internal handlers:
  `handle<Action>`.
- Tests: `<unit>.test.ts` for domain/service code and `<Component>.test.tsx`
  for DOM behavior. E2E specs use `<flow>.spec.ts` after an E2E runner exists.
- CSS classes use a stable component namespace; do not encode DOM position such
  as `.left-box-2`.

## State layering

Keep four kinds of state separate:

1. Domain state: plans, events, reports, preferences, and their invariants.
2. Remote/persistent state: loading, freshness, version, error, and retry.
3. App workflow state: authentication gate, navigation, dialog or multistep
   orchestration.
4. Ephemeral view state: focus, open popover, hover, draft input, and local
   selection.

Use discriminated unions for meaningful state machines:

```ts
type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "empty" }
  | { status: "offline"; cached: T | null }
  | { status: "error"; message: string; retryable: boolean };
```

Do not represent one state machine with several booleans such as `isLoading`,
`isError`, `isEmpty`, and `isOffline`. Impossible combinations will eventually
render.

Keep form drafts separate from committed domain entities. Proposed schedule
items do not enter the committed calendar until the user confirms.

## TypeScript

- Preserve `strict`, `noUncheckedIndexedAccess`, and
  `noFallthroughCasesInSwitch`.
- Use `unknown` at untrusted boundaries and narrow it. Do not introduce `any`.
- Avoid type assertions. If a library forces one, isolate it in an adapter,
  document the invariant, and test the boundary.
- Prefer discriminated unions and exhaustive `switch` statements for states
  and domain variants.
- Do not use `Date` as an implicit timezone-bearing domain type. Serialize
  timed values explicitly and keep all-day dates separate.
- Validate untrusted RPC, persisted, and form-derived values at the service
  boundary.
- Do not leak third-party types through feature public APIs.
- Await promises or explicitly use `void` with a local error-handling path.
- Do not use non-null assertions to hide an unhandled initialization state.
- Keep IDs opaque strings; do not derive identity from display text or array
  index.

## React

- Components receive data and named actions; they do not contain persistence,
  conflict, recurrence, or authorization rules in JSX.
- Effects synchronize with external systems. They must clean up listeners and
  tolerate React Strict Mode remounting.
- Inject services through app composition so components and browser QA can use
  deterministic adapters without loading Electrobun globals.
- Keep protected pages below `AuthGate`; booting must render a neutral gate,
  not a momentary AppShell.
- Disable repeat submission while authenticating, generating, applying, or
  saving.
- Error boundaries handle unexpected render failures; ordinary service errors
  remain explicit feature states.
- Use semantic HTML before adding ARIA. Do not make a non-interactive `div`
  behave like a button.

## Styling and design tokens

Define shared CSS custom properties for:

- background, surface, elevated surface, border, muted border;
- primary, secondary, muted, and inverse text;
- accent, success, warning, error, and conflict;
- spacing;
- font size, line height, and weight;
- radius;
- shadow;
- z-index layers;
- motion duration/easing;
- focus ring.

Rules:

- New components consume tokens; feature styles do not copy raw palette values.
- Keep global CSS limited to tokens, reset/foundations, typography, and app
  background.
- Component styles own their layout and states.
- Calendar and report content uses stable solid surfaces and explicit grid
  lines; decorative treatments stay outside dense data areas.
- Avoid `!important` except for a documented third-party adapter override.
- Test long Chinese labels and zoom/scale. Do not fix overflow by hiding
  meaningful content.
- One layout region owns scrolling. Avoid nested uncontrolled vertical
  scrollers and accidental body scrolling.
- All animations have reduced-motion behavior and do not block interaction.

## Accessibility

- Every input has a visible label or an explicit accessible label when the
  visible control design cannot contain one.
- Placeholder text is never the only label.
- Every action is keyboard reachable and operable.
- Focus order follows visual and task order.
- Use `:focus-visible` with the shared focus-ring token.
- Dialogs trap focus, identify their title, support Escape where safe, and
  return focus to the trigger.
- Popovers and menus expose correct roles and keyboard behavior.
- Announce async completion and errors without moving focus unexpectedly.
- Charts include a concise summary and data-table/text alternative.
- Status, proposed/committed state, and conflicts are not expressed by color
  alone.
- Pointer drag/resize actions have form or keyboard alternatives.

## Errors, logging, and privacy

Map infrastructure errors to stable product-facing error categories. Do not
display stack traces, transport codes, file paths, tokens, or raw sensitive
payloads.

Diagnostic logging:

- may include operation name, correlation ID, duration, and sanitized error
  category;
- must not include credentials, session contents, full browser URLs, search
  terms, accessibility values/document text, local activity rows, or raw
  calendar titles;
- must never make a pet presentation failure block the primary workflow.

Show data range and confidence for partial reports. Missing data is unknown, not
zero.

## Testing

Every feature requires tests at the layer where behavior lives:

- pure domain tests for validation, transitions, conflict rules, date/time
  handling, and adapters;
- service tests for success, failure, cancellation, stale versions, retry, and
  rollback;
- component tests for accessible labels, keyboard behavior, submission guards,
  and all required page states;
- E2E coverage for the primary user flow after the repository adds an E2E
  runner;
- deterministic fixtures for empty, normal, dense, error, offline, and conflict
  cases;
- visual inspection at `1440x900` and `1180x720`.

Do not write tests that only assert that a component rendered. Test the user
behavior and the state transition.

Calendar tests additionally follow
[CALENDAR_STANDARD.md](CALENDAR_STANDARD.md#required-tests).

## Definition of Done

A client change is done only when:

- the architecture and dependency direction above are preserved;
- relevant loading, empty, populated, partial, saving, success, error, offline,
  disabled, conflict, and expired states are implemented;
- domain and third-party adapter types remain separate;
- keyboard, screen-reader labeling, focus visibility, reduced motion, and
  long-text behavior have been checked;
- no sensitive data appears in renderer logs or screenshots;
- tests cover the behavior and failure paths;
- `bun run typecheck`, affected Bun tests, and `bun run build:views` pass;
- the complete applicable validation from
  [AGENTS.md](../../AGENTS.md#validation) has been run;
- actual rendered UI has been inspected at both required viewports and revised
  after observation;
- UI pull requests include screenshots and the completed PR template;
- known limitations and rollback are documented.
