import { describe, expect, test } from "bun:test";
import {
	addMinutes,
	instantToLocalParts,
	resolveLocalDateTime,
} from "../src/views/client/features/calendar/date-time";
import {
	assertValidCalendarEvent,
	canUserUnlockPlanEvent,
	CalendarDomainError,
	createOccurrenceOverride,
	detectCalendarConflict,
	eventsOverlap,
	type CalendarEvent,
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
import {
	isExplicitRendererPlanUnlock,
	shouldForceRendererPlanLock,
} from "../src/bun/calendar-mutation-policy";

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
		expect(canUserUnlockPlanEvent({ ...locked, userLocked: false })).toBe(false);
		expect(canUserUnlockPlanEvent({ ...locked, scheduleOrigin: "user" })).toBe(false);
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
			after: { ...before, userLocked: false },
			recurrenceScope: null,
		};
		expect(isExplicitRendererPlanUnlock(unlock)).toBe(true);
		expect(shouldForceRendererPlanLock(unlock)).toBe(false);
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

	test("rejects reversed ranges and editable external events", () => {
		expect(() =>
			assertValidCalendarEvent(
				timedEvent({
					schedule: {
						allDay: false,
						start: "2026-07-29T02:00:00Z",
						end: "2026-07-29T01:00:00Z",
						timeZone: CALENDAR_TIME_ZONE,
					},
				}),
			),
		).toThrow(CalendarDomainError);
		expect(() =>
			assertValidCalendarEvent(
				timedEvent({ kind: "external", editable: true }),
			),
		).toThrow("外部日历默认必须保持只读");
	});

	test("validates task ownership and automation lock metadata", () => {
		expect(() =>
			assertValidCalendarEvent(
				timedEvent({ sourcePlanId: null, sourceTaskId: "orphan-task" }),
			),
		).toThrow("来源");
		expect(() =>
			assertValidCalendarEvent(
				timedEvent({
					kind: "manual-block",
					sourcePlanId: null,
					sourceTaskId: null,
					scheduleOrigin: null,
					userLocked: true,
				}),
			),
		).toThrow("锁定");
	});

	test("detects manual and external hard conflicts and plan warnings", () => {
		const candidate = timedEvent();
		const manual = timedEvent({
			id: "manual",
			title: "家庭时间",
			kind: "manual-block",
		});
		const manualConflict = detectCalendarConflict(candidate, [manual]);
		expect(manualConflict?.reason).toBe("overlaps-manual-block");
		expect(manualConflict?.affectedEventIds).toEqual(["manual"]);
		expect(manualConflict?.severity).toBe("error");

		const external = timedEvent({
			id: "external",
			kind: "external",
			editable: false,
		});
		expect(detectCalendarConflict(candidate, [external])?.reason).toBe(
			"overlaps-external-event",
		);

		const plan = timedEvent({ id: "plan-b" });
		const planConflict = detectCalendarConflict(candidate, [plan]);
		expect(planConflict?.reason).toBe("overlaps-committed-plan");
		expect(planConflict?.severity).toBe("warning");
	});

	test("uses half-open ranges so adjacent events do not conflict", () => {
		const first = timedEvent();
		const adjacent = timedEvent({
			id: "event-b",
			schedule: {
				allDay: false,
				start: "2026-07-29T02:00:00Z",
				end: "2026-07-29T03:00:00Z",
				timeZone: CALENDAR_TIME_ZONE,
			},
		});
		expect(eventsOverlap(first, adjacent)).toBe(false);
	});

	test("records a single recurrence exception without changing unrelated occurrences", () => {
		const series = calendarScenarioEvents("recurrence")[0];
		if (!series) throw new Error("Missing recurrence fixture");
		const exceptionStart = "2026-07-29T12:00:00Z";
		const updated = withOccurrenceException(series, exceptionStart);
		expect(updated.recurrence?.exceptionDates).toContain(exceptionStart);
		expect(series.recurrence?.exceptionDates).not.toBe(
			updated.recurrence?.exceptionDates,
		);

		const override = createOccurrenceOverride(
			series,
			exceptionStart,
			{
				allDay: false,
				start: "2026-07-29T13:00:00Z",
				end: "2026-07-29T13:30:00Z",
				timeZone: CALENDAR_TIME_ZONE,
			},
		);
		expect(override.occurrence.occurrenceId).toContain(
			series.recurrence?.seriesId ?? "",
		);
		expect(override.occurrence.id).not.toBe(series.id);
		expect(override.series.schedule).toEqual(series.schedule);
	});
});

describe("calendar time abstraction", () => {
	test("formats a named timezone rather than a cached machine offset", () => {
		expect(
			instantToLocalParts("2026-07-29T01:00:00Z", "Asia/Shanghai"),
		).toEqual({ date: "2026-07-29", time: "09:00" });
		expect(
			instantToLocalParts("2026-07-29T01:00:00Z", "America/New_York"),
		).toEqual({ date: "2026-07-28", time: "21:00" });
	});

	test("distinguishes a DST gap from a repeated local hour", () => {
		const gap = resolveLocalDateTime(
			"2026-03-08",
			"02:30",
			"America/New_York",
		);
		const repeated = resolveLocalDateTime(
			"2026-11-01",
			"01:30",
			"America/New_York",
		);
		expect(gap.status).toBe("nonexistent");
		expect(repeated.status).toBe("ambiguous");
		if (repeated.status === "ambiguous") {
			expect(repeated.earlier).not.toBe(repeated.later);
		}
	});
});

describe("FullCalendar adapter boundary", () => {
	test("maps domain events without leaking FullCalendar data into fixtures", () => {
		const event = timedEvent({ state: "proposed" });
		const input = calendarEventToFullCalendarInput(event, true);
		expect(input.id).toBe(event.id);
		expect(input.start).toBe(event.schedule.allDay ? undefined : event.schedule.start);
		expect(input.className).toContain("whale-event--proposed");
		expect(input.className).toContain("whale-event--pending");
		expect(input.editable).toBe(false);
		expect(JSON.stringify(event)).not.toContain("className");
	});

	test("maps all-day exclusive end and recurrence exceptions", () => {
		const allDay = calendarScenarioEvents("all-day")[0];
		const recurring = calendarScenarioEvents("recurrence")[0];
		if (!allDay || !recurring) throw new Error("Missing fixture");
		const allDayInput = calendarEventToFullCalendarInput(allDay);
		const recurringInput = calendarEventToFullCalendarInput(recurring);
		expect(allDayInput.start).toBe("2026-07-30");
		expect(allDayInput.end).toBe("2026-08-01");
		expect(recurringInput.rrule).toBeTruthy();
		expect(recurringInput.exdate).toEqual(
			recurring.recurrence
				? [...recurring.recurrence.exceptionDates]
				: undefined,
		);
	});

	test("maps a drag/resize callback snapshot to an immutable domain update", () => {
		const before = timedEvent();
		const after = calendarChangeSnapshotToDomainEvent(
			{
				allDay: false,
				startStr: addMinutes(
					before.schedule.allDay ? "" : before.schedule.start,
					15,
				),
				endStr: addMinutes(
					before.schedule.allDay ? "" : before.schedule.end,
					30,
				),
				oldStartStr: before.schedule.allDay ? "" : before.schedule.start,
				displayTimeZone: CALENDAR_TIME_ZONE,
			},
			before,
		);
		expect(after?.schedule).not.toBe(before.schedule);
		expect(after?.schedule.allDay).toBe(false);
		if (after?.schedule.allDay === false) {
			expect(after.schedule.start).toBe("2026-07-29T01:15:00Z");
			expect(after.schedule.end).toBe("2026-07-29T02:30:00Z");
		}
		expect(before.schedule).toEqual(timedEvent().schedule);
	});

	test("rejects implicit all-day/timed conversion at the adapter boundary", () => {
		expect(
			calendarChangeSnapshotToDomainEvent(
				{
					allDay: true,
					startStr: "2026-07-29",
					endStr: "2026-07-30",
					oldStartStr: "2026-07-29T01:00:00Z",
					displayTimeZone: CALENDAR_TIME_ZONE,
				},
				timedEvent(),
			),
		).toBeNull();
	});
});
