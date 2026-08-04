<!--
For documentation, dependency, or CI-only changes, complete the applicable
sections and write N/A with a short reason for the rest. Do not delete the
headings: reviewers need to see which contract boundaries were considered.
-->

## Pull request type

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor or performance work
- [ ] Tests or documentation
- [ ] Dependency or build update
- [ ] CI, workflow, or security configuration

## Tracking

- Closes / relates to:
- No linked issue because:

## Summary

<!-- What user or engineering outcome does this pull request deliver? -->

## Change contract

<!-- State the behavior change and mark every non-applicable boundary explicitly. -->

- What changed and why:
- Typed RPC, Local Tool protocol, public API, or remote-model request impact:
- Persistence, schema, migration, or recovery impact:
- Activity data, credentials, privacy, or telemetry impact:
- Lifecycle, concurrency, cancellation, timeout, or retry impact:
- Dependency, Action, or supply-chain impact:
- Design/issue reference required for cross-cutting contract or data changes:

## Scope

<!-- List the included areas and explicitly note important out-of-scope work. -->

- Included:
- Out of scope:
- Architecture boundaries affected:

## Before / After

<!-- UI changes require screenshots. Do not include real sensitive user data. -->

| Viewport/state | Before | After |
| --- | --- | --- |
| 1440×900 | <!-- image or N/A --> | <!-- image --> |
| 1180×720 | <!-- image or N/A --> | <!-- image --> |
| Dense/error/conflict, if applicable | <!-- image or N/A --> | <!-- image or N/A --> |

## State checks

- [ ] Loading/booting
- [ ] Empty
- [ ] Populated/dense
- [ ] Partial data
- [ ] Saving/applying
- [ ] Success
- [ ] Error and retry
- [ ] Offline/service unavailable
- [ ] Disabled
- [ ] Conflict
- [ ] Expired session
- [ ] Not applicable states are explained below

State notes:

## Accessibility and visual checks

- [ ] Keyboard-only flow
- [ ] Visible focus
- [ ] Accessible names and labels
- [ ] Status is not conveyed by color alone
- [ ] Reduced motion
- [ ] Long Chinese text
- [ ] No accidental overflow or double scrollbar
- [ ] Tooltip/popover/dialog stacking
- [ ] Actual Electrobun window checked when applicable
- [ ] Visual correction pass completed

## Validation

<!-- Record only commands that actually ran and include the result. -->

| Command | Result |
| --- | --- |
| `git diff --check` | Not run |
| `bun run lint:changed` (informational) | Not run |
| `bun run typecheck` | Not run |
| `bun run test` | Not run |
| `bun run build:views` | Not run |
| `bun run check` | Not run |
| Other | Not run |

Skipped or blocked validation:

## Risk and rollback

- Main risks:
- Data/privacy impact:
- Compatibility impact:
- Concurrency/lifecycle impact:
- Breaking change, migration, or release-note impact:
- Rollback plan:

## Reviewer focus

<!-- Name the decision, boundary, risk, or file that deserves the closest review. -->

- Please focus on:

## Related work

<!-- Issues, design references, specifications, or follow-up work. -->
