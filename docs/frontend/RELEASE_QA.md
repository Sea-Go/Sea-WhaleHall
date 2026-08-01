# WhaleHall release QA

Last audited: 2026-07-29

This checklist is the release gate for the desktop frontend. Deterministic mock
adapters are retained because they exercise product states without external
accounts or network dependencies. The calendar scenario selector is not shown
in the normal application; it is available only when the local client URL
contains `?qa=1`.

## State matrix

| State | Product surface | Deterministic evidence |
| --- | --- | --- |
| Loading | Authentication, calendar, reports, settings, plan generation | Boot/authentication UI tests; calendar, report, and preferences controller tests; browser observation of calendar loading and plan generation |
| Empty | Planning, calendar, reports | Initial planning UI; `empty` calendar fixture; empty report controller/UI tests |
| Populated | Calendar and reports | Normal/dense calendar fixtures; populated and partial report fixtures |
| Partial data | Reports | Weekly and monthly partial-coverage fixtures preserve unknown values instead of reporting zero |
| Saving | Calendar, settings, plan apply, logout | Pending controller states and disabled controls are covered by controller/UI tests |
| Success | Calendar CRUD, settings, plan apply, authentication | Controller success tests plus browser creation, save, apply, and logout flows |
| Error | Authentication, calendar, reports, settings, planning | Retryable and rollback-safe error tests on every controller |
| Offline | Authentication, calendar, reports | Offline service fixtures; authentication offline state also inspected in the browser |
| Disabled | Future navigation, saved/default settings, read-only external events | UI tests assert disabled and read-only semantics; browser verifies disabled future/report and saved-settings controls |
| Conflict | Calendar and planning | Manual/external hard-conflict tests, warning conflicts, optimistic rollback, and the conflict calendar fixture |
| Expired session | Authentication | Session-expiry controller and explicit expired-session UI tests |
| Partial apply | Planning | Idempotent partial-apply failure and retry controller test |

## End-to-end product flow

The local application flow was exercised at 1440×900 and 1180×720:

1. Start from the unauthenticated shell and sign in with the local experience
   account.
2. Create a short-term plan from natural-language Chinese input.
3. Observe generation progress, review the structure, edit and drag a proposed
   item, then explicitly confirm the draft.
4. Apply the plan and verify the success state and committed calendar items.
5. Create a manual occupied block and use the 15-minute movement and duration
   controls.
6. Switch day, week, and month calendar views.
7. Switch daily, weekly, and monthly growth reports.
8. Change density and reduced-motion settings and verify the applied document
   preferences.
9. Inspect user-menu and confirmation-dialog stacking, then confirm logout and
   verify the protected shell is removed.
10. Exercise the deterministic offline sign-in state and recover with the
    experience account.

## Visual and accessibility coverage

- 1440×900: login, calendar, and report layouts.
- 1180×720: settings, empty/dense/conflict calendar fixtures, and offline login.
- High-density desktop: actual Electrobun windows on the host display.
- Long Chinese text: plan goal, manual calendar block, and report activity labels.
- Keyboard focus: visible focus ring on native select and roving navigation tests.
- Reduced motion: saved setting plus animator reduced-motion tests.
- Layering: user popover and modal confirmation inspected above the active page.
- Resize: browser viewport override was changed between both supported sizes.
- Scrolling: only intentional report/page and calendar time-grid scrollbars were
  present; no accidental horizontal page scrollbar was observed.

## Release cleanup policy

- Feature code is consumed through each feature's `public.ts` boundary.
- Frontend code does not call RPC directly from JSX.
- Normal release UI contains no mock scenario/debug selector.
- Renderer logs are limited to sanitized non-blocking bridge/sync diagnostics;
  process startup and native diagnostics remain in the Bun host.
- Deterministic fixtures remain test/demo infrastructure; they are not deleted
  as dead mocks.
- Shared colors, spacing, radius, shadow, motion, and typography values use the
  frontend tokens rather than feature-local raw values.

## Commands

Run from the repository root:

```sh
bun run check
bun run build:views
bun run scripts/verify-pet-animations.ts
bun run build:canary
git diff --check
```

The 2026-07-29 release pass completed all commands above: 281 Bun tests and
60 Rust tests passed, Rust formatting and clippy were clean, all 133 pet
actions passed 1,245 finite-frame checks, the views built, and the Electrobun
canary artifact was produced. The Vite build reports one non-blocking size
warning for the 542.22 kB minified client entry (156.23 kB gzip).

The package currently has no standalone lint or browser-E2E script. TypeScript,
Rust formatting/clippy/tests, and Bun tests are included in `bun run check`;
the interactive browser and Electrobun window passes cover the UI integration
layer.
