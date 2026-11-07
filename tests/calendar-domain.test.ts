import { describe, expect, test } from "bun:test";
import {
	isExplicitRendererPlanUnlock,
	shouldForceRendererPlanLock,
} from "../src/bun/calendar-mutation-policy";
import {
	addMinutes,
	instantToLocalParts,
	resolveLocalDateTime,
} from "../src/views/client/features/calendar/date-time";
import {
	assertValidCalendarEvent,
	CalendarDomainError,
	type CalendarEvent,
	canUserUnlockPlanEvent,
	createOccurrenceOverride,
	detectCalendarConflict,
	eventsOverlap,
	withOccurrenceException,
} from "../src/views/client/features/calendar/domain";
import {
	CALENDAR_TIME_ZONE,
	calendarScenarioEvents,
} from "../src/views/client/features/calendar/fixtures";
import {
	calendarChangeSnapshotToDomainEvent,
	calendarEventToFullCalendarInput,
} from "../src/views/client/features/calendar/fullcalendar-adapter";

function timedEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		id: "event-a",
		title: "测试日程",
		kind: "plan",
		state: "committed",
		schedule: {
			allDay: false,
			start: "2026-07-29T01:00:00Z",
			end: "2026-07-29T02:00:00Z",
			timeZone: CALENDAR_TIME_ZONE,
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: "plan-a",
		sourceTaskId: "task-a",
		scheduleOrigin: "model",
		userLocked: false,
		editable: true,
		version: 1,
		...overrides,
	};
}

describe("calendar domain invariants", () => {
	test("only a user-locked model plan event can opt back into rescheduling", () => {
		const locked = timedEvent({ userLocked: true });
		expect(canUserUnlockPlanEvent(locked)).toBe(true);
		expect(canUserUnlockPlanEvent({ ...locked, userLocked: false })).toBe(
			false,
		);
		expect(canUserUnlockPlanEvent({ ...locked, scheduleOrigin: "user" })).toBe(
			false,
		);
		expect(canUserUnlockPlanEvent({ ...locked, editable: false })).toBe(false);
	});

	test("Bun accepts only an unlock-only renderer mutation without re-locking", () => {
		const before = {
			...timedEvent({ userLocked: true, version: 4 }),
			recurrence: null,
		};
		const unlock = {
			mutationId: "unlock-1",
			kind: "update" as const,
			eventId: before.id,
			expectedVersion: 4,
			before,
			after: { ...before, userLocked: false, version: 5 },
			recurrenceScope: null,
		};
		expect(isExplicitRendererPlanUnlock(unlock)).toBe(true);
		expect(shouldForceRendererPlanLock(unlock)).toBe(false);
		expect(
			isExplicitRendererPlanUnlock({
				...unlock,
				after: { ...unlock.after, version: 4 },
			}),
		).toBe(false);
		expect(
			isExplicitRendererPlanUnlock({
				...unlock,
				after: { ...unlock.after, title: "同时偷偷修改" },
			}),
		).toBe(false);
		expect(
			shouldForceRendererPlanLock({
				...unlock,
				after: { ...unlock.after, title: "用户编辑" },
			}),
		).toBe(true);
	});
	test("accepts valid timed and all-day schedules with exclusive end", () => {
		expect(() => assertValidCalendarEvent(timedEvent())).not.toThrow();
		expect(() =>
			assertValidCalendarEvent({
				...timedEvent(),
				schedule: {
					allDay: true,
					startDate: "2026-07-29",
					endDateExclusive: "2026-07-30",
				},
			}),
		).not.toThrow();
	});
});

describe("calendar time abstraction", () => {});

describe("FullCalendar adapter boundary", () => {});
