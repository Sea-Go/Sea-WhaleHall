# WhaleHall Calendar Standard

This standard is mandatory for calendar domain, UI, service, persistence, and
planning-to-calendar work. General client rules are in
[FRONTEND_STANDARD.md](FRONTEND_STANDARD.md), and visual reference limits are
in [UI_REFERENCES.md](UI_REFERENCES.md).

## Principles

- Calendar correctness is a domain responsibility, not a rendering-library
  side effect.
- FullCalendar is a replaceable view/interaction adapter.
- The user's committed schedule is never changed by AI generation without
  explicit confirmation.
- Failed mutations are visible and reversible.
- All-day, timezone, recurrence, and exception semantics are explicit.
- Pointer convenience never removes keyboard and form alternatives.

## Domain model

The production type may refine names, but it must preserve the following
semantics:

```ts
type CalendarEventKind = "plan" | "manual-block" | "external" | "break";
type CalendarEventState = "proposed" | "committed";

type TimedSchedule = {
  allDay: false;
  start: string; // ISO instant with offset or Z
  end: string;   // ISO instant with offset or Z
  timeZone: string; // IANA zone
};

type AllDaySchedule = {
  allDay: true;
  startDate: string; // ISO calendar date YYYY-MM-DD
  endDateExclusive: string;
};

type Recurrence = {
  seriesId: string;
  rrule: string;
  timeZone: string;
  exceptionDates: readonly string[];
};

type CalendarEvent = {
  id: string;
  title: string;
  kind: CalendarEventKind;
  state: CalendarEventState;
  schedule: TimedSchedule | AllDaySchedule;
  recurrence: Recurrence | null;
  occurrenceId: string | null;
  sourcePlanId: string | null;
  editable: boolean;
  version: number;
};
```

Additional metadata must remain serializable and domain-oriented. Do not add
DOM nodes, CSS classes, FullCalendar `EventInput`, native `Date`, chart
configuration, or RPC transport envelopes to `CalendarEvent`.

Invariants:

- `start < end` for timed events;
- `startDate < endDateExclusive` for all-day events;
- `version` increases after a successful committed mutation;
- external events are read-only unless a future source explicitly grants
  write capability;
- proposed events do not appear committed merely because they are visible in
  the same grid;
- occurrence identity is stable and distinct from the recurrence series ID;
- a recurrence exception does not mutate unrelated occurrences.

## Kind and state behavior

| Kind | Purpose | Default editability |
| --- | --- | --- |
| `plan` | Time scheduled from a user plan | Editable unless locked by an applying operation |
| `manual-block` | User-declared occupied time | Editable and deletable |
| `external` | Imported calendar source | Read-only by default |
| `break` | Rest or recovery interval | Editable according to its source |

| State | Meaning | Required visual signal |
| --- | --- | --- |
| `proposed` | Draft awaiting user approval | Dashed/patterned border or fill plus draft label/icon |
| `committed` | Part of the accepted schedule | Solid treatment and no draft label |

Color may reinforce these signals but cannot be their only difference.

## FullCalendar adapter boundary

Only the calendar adapter may import FullCalendar types. It owns:

- `CalendarEvent` to FullCalendar event input mapping;
- FullCalendar callback payload to domain command mapping;
- per-event editability;
- content rendering metadata;
- snap duration, visible ranges, scroll time, and view selection;
- calling FullCalendar `revert` after a rejected mutation;
- synchronizing authoritative domain state back into the calendar.

Domain, service, planning, and test fixtures must not import FullCalendar
`EventInput`, `EventApi`, `DateSelectArg`, `EventDropArg`, or equivalent types.

Do not persist FullCalendar objects. Do not mutate domain entities inside
`eventContent`. Do not use FullCalendar background events for editable manual
blocks.

All FullCalendar packages must use one exact compatible version. Premium
resource/timeline plugins require a separate approved product and licensing
decision.

## Creating and editing

The calendar supports:

- dragging an empty range to create;
- a “创建日程” form;
- event click/edit;
- drag to move;
- resize to change duration;
- creating an explicit occupied block;
- delete with undo;
- day, week, and month views;
- a keyboard/form alternative for every pointer operation.

Use 15-minute snapping for ordinary interaction. The form may allow exact
values where product requirements permit. Short events remain selectable and
readable without falsifying their duration.

Prevent duplicate submissions while a create/update/delete is pending. A
dialog or form draft must not mutate the calendar until its action is
confirmed.

## Conflict policy

Conflict detection is a domain/service operation. Return a structured reason,
for example:

```ts
type CalendarConflictReason =
  | "overlaps-manual-block"
  | "overlaps-external-event"
  | "outside-available-hours"
  | "insufficient-duration"
  | "stale-version"
  | "recurrence-restriction";
```

The product must define which overlaps are warnings and which are rejected.
Until that policy is explicitly expanded:

- overlapping a manual occupied block is rejected;
- attempting to edit an external read-only event is rejected;
- overlapping two committed plan events requires a visible warning and user
  resolution;
- proposed events may be displayed in conflict, but cannot be committed
  silently;
- breaks are not automatically deleted to make room.

Conflict UI includes the affected events, reason, and available next action.
Red is used only for failed or severe conflict states.

## Optimistic mutation and rollback

Every mutation carries:

- event ID;
- expected version;
- unique mutation ID;
- before value;
- proposed after value.

Flow:

1. Render the optimistic value and mark it saving.
2. Send the domain mutation through the service.
3. On success, replace it with the authoritative event/version.
4. On conflict or failure, call the view adapter's revert behavior and restore
   the authoritative value.
5. Show a localized reason and provide retry or edit where applicable.
6. Ignore stale responses whose mutation ID no longer owns the displayed
   optimistic state.

Drag, resize, delete, undo, and proposed-to-committed batch application all
need deterministic rollback tests. Batch confirmation must report atomic
success or an explicit partial result; silent loss is forbidden.

## Recurrence and exceptions

- Store the recurrence rule and named timezone on the series.
- Store exclusions/exceptions explicitly.
- Distinguish “edit this occurrence,” “this and following,” and “entire
  series” before applying a recurring edit. Do not infer scope from a drag.
- Moving one occurrence creates or updates an exception; it does not rewrite
  the full series.
- Deleting one occurrence records an exception.
- Preserve recurrence identity through adapter round trips.
- An external recurrence remains read-only unless its source adapter supports
  writes.
- Test recurrences across DST changes, month boundaries, and an exception.

The RRule connector is an adapter dependency, not the domain model.

## All-day events

- Represent all-day values as calendar dates.
- `endDateExclusive` follows the calendar adapter's exclusive-end convention.
- Do not create all-day events by converting local midnight to UTC.
- Moving between all-day and timed areas requires explicit domain conversion
  and user-visible times; do not rely on an implicit library conversion.
- Test one-day, multi-day, timezone-change, and recurrence cases.

## Timezone and DST

- The default display timezone is the user's system IANA timezone unless a
  user preference overrides it.
- Timed domain values store an unambiguous instant plus the intended IANA
  timezone.
- UI formatting uses the display timezone, not the machine offset cached at
  application startup.
- Date-only values never pass through instant conversion.
- DST tests cover a nonexistent local time during spring-forward and an
  ambiguous repeated time during fall-back.
- Recurrence evaluates in its declared timezone before occurrences become
  instants.
- RPC and persisted adapters serialize values explicitly; native `Date`
  objects do not cross boundaries.

Keep date/time operations behind a small tested client abstraction. Do not mix
multiple date libraries across features.

## Keyboard and accessibility

The user must be able to:

- create an event from a button and form;
- select an event and open its editor;
- change date, start/end time, all-day state, and recurrence without dragging;
- move an event by a defined increment;
- change duration by a defined increment;
- delete and undo;
- inspect and resolve conflicts;
- distinguish proposed, committed, read-only, and occupied events without
  color.

The calendar has a visible label, predictable focus entry, clear focus
indicators, and a way to exit the grid. Toolbar controls expose pressed/current
state. After dialogs close or rollback occurs, focus returns to a meaningful
control or event.

## Visual acceptance matrix

Check every relevant cell at `1440x900` and `1180x720`:

| Scenario | Week | Day | Month |
| --- | --- | --- | --- |
| Empty | Required | Required | Required |
| Ordinary data | Required | Required | Required |
| Dense data | Required | Required | Required |
| Overlapping events | Required | Required | Inspect |
| 15-minute event | Required | Required | Not applicable |
| Multi-hour event | Required | Required | Inspect |
| All-day event | Required | Required | Required |
| Proposed schedule | Required | Required | Required |
| Manual occupied block | Required | Required | Required |
| External read-only event | Required | Required | Required |
| Conflict | Required | Required | Inspect |
| Recurring exception | Required | Required | Required |
| Loading/error/offline | Required | Required | Required |

Also inspect:

- current-time line;
- mini calendar and toolbar alignment;
- workday/weekend distinction;
- long Chinese titles;
- disabled and focus-visible states;
- drag and resize previews;
- popover/dialog stacking;
- resizing the Electrobun window;
- absence of column drift, row drift, horizontal overflow, and uncontrolled
  double scrollbars.

Calendar work requires at least two visual observation and correction passes.

## Required tests

- domain invariant validation;
- domain-to-FullCalendar and callback-to-command adapters;
- create, update, delete, and undo;
- drag rollback and stale drag response;
- resize rollback;
- structured conflict reason;
- manual occupied-block editability;
- external read-only enforcement;
- proposed/committed batch confirmation;
- all-day exclusive end;
- recurrence series, occurrence exception, and single-occurrence deletion;
- named timezone display;
- DST gap and repeated-hour behavior;
- keyboard creation, editing, movement, resizing, and deletion;
- empty, dense, loading, error, and offline component states.

Rendering success alone is not sufficient coverage.
