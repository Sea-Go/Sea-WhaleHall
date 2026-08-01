import { describe, expect, test } from "bun:test";
import {
	CalendarPolicyError,
	detectAuthoritativeConflict,
	eventOccursInDateRange,
	eventsOverlap,
	validateCalendarEvent,
	validateCalendarMutation,
} from "../src/bun/calendar-policy";
import type { CalendarEvent } from "../src/shared/calendar";

function event(
	id: string,
	start: string,
	end: string,
	patch: Partial<CalendarEvent> = {},
): CalendarEvent {
	return {
		id,
		title: id,
		kind: "plan",
		state: "committed",
		schedule: { allDay: false, start, end, timeZone: "Asia/Shanghai" },
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: "plan-1",
		editable: true,
		version: 1,
		...patch,
	};
}

describe("authoritative calendar policy", () => {
	test("validates named zones and minimum duration", () => {
		const valid = event("event-1", "2026-08-01T01:00:00Z", "2026-08-01T01:30:00Z");
		expect(() => validateCalendarEvent(valid)).not.toThrow();
		expect(() => validateCalendarEvent({
			...valid,
			schedule: {
				allDay: false,
				start: "2026-08-01T01:00:00Z",
				end: "2026-08-01T01:30:00Z",
				timeZone: "not/a-zone",
			},
		})).toThrow(CalendarPolicyError);
		expect(() => validateCalendarEvent(event(
			"short",
			"2026-08-01T01:00:00Z",
			"2026-08-01T01:05:00Z",
		))).toThrow("至少需要 15 分钟");
	});

	test("detects timed events inside an all-day block", () => {
		const timed = event("timed", "2026-08-01T01:00:00Z", "2026-08-01T02:00:00Z");
		const allDay: CalendarEvent = {
			...timed,
			id: "all-day",
			title: "整天不可用",
			kind: "manual-block",
			schedule: { allDay: true, startDate: "2026-08-01", endDateExclusive: "2026-08-02" },
		};
		expect(eventsOverlap(timed, allDay)).toBe(true);
		expect(detectAuthoritativeConflict(timed, [allDay])).toEqual(
			expect.objectContaining({ reason: "overlaps-manual-block", severity: "error" }),
		);
	});

	test("requires exact event version before mutation", () => {
		const current = event("versioned", "2026-08-01T01:00:00Z", "2026-08-01T02:00:00Z");
		const conflict = validateCalendarMutation({
			mutationId: "mutation-1",
			kind: "update",
			eventId: current.id,
			expectedVersion: 0,
			before: current,
			after: { ...current, title: "updated" },
			recurrenceScope: null,
		}, current);
		expect(conflict?.reason).toBe("stale-version");
	});

	test("expands old recurring series into a later planning window", () => {
		const daily = event(
			"daily-focus",
			"2026-01-01T01:00:00Z",
			"2026-01-01T02:00:00Z",
			{
				recurrence: {
					seriesId: "series-daily-focus",
					rrule: "FREQ=DAILY",
					timeZone: "Asia/Shanghai",
					exceptionDates: [],
				},
			},
		);
		const candidate = event(
			"candidate",
			"2026-08-03T01:30:00Z",
			"2026-08-03T02:30:00Z",
		);

		expect(eventsOverlap(daily, candidate)).toBe(true);
		expect(eventOccursInDateRange(daily, "2026-08-03", "2026-08-04", "UTC")).toBe(true);
	});

	test("honors instant and date-only recurrence exceptions", () => {
		const base = event(
			"daily-with-exceptions",
			"2026-08-01T01:00:00Z",
			"2026-08-01T02:00:00Z",
			{
				recurrence: {
					seriesId: "series-exceptions",
					rrule: "FREQ=DAILY;COUNT=4",
					timeZone: "Asia/Shanghai",
					exceptionDates: ["2026-08-02T01:00:00Z", "2026-08-03"],
				},
			},
		);

		expect(eventsOverlap(base, event(
			"instant-exception",
			"2026-08-02T01:15:00Z",
			"2026-08-02T01:45:00Z",
		))).toBe(false);
		expect(eventsOverlap(base, event(
			"date-exception",
			"2026-08-03T01:15:00Z",
			"2026-08-03T01:45:00Z",
		))).toBe(false);
		expect(eventsOverlap(base, event(
			"remaining-occurrence",
			"2026-08-04T01:15:00Z",
			"2026-08-04T01:45:00Z",
		))).toBe(true);
	});

	test("keeps local wall time through a DST gap and repeated hour", () => {
		const spring = event(
			"spring-series",
			"2026-03-07T07:30:00Z",
			"2026-03-07T08:30:00Z",
			{
				schedule: {
					allDay: false,
					start: "2026-03-07T07:30:00Z",
					end: "2026-03-07T08:30:00Z",
					timeZone: "America/New_York",
				},
				recurrence: {
					seriesId: "spring-series",
					rrule: "FREQ=DAILY;COUNT=2",
					timeZone: "America/New_York",
					exceptionDates: [],
				},
			},
		);
		// 02:30 does not exist on 2026-03-08. Temporal's compatible
		// disambiguation moves it to 03:30 EDT (07:30Z).
		expect(eventsOverlap(spring, event(
			"spring-candidate",
			"2026-03-08T07:45:00Z",
			"2026-03-08T08:15:00Z",
		))).toBe(true);

		const autumn = event(
			"autumn-series",
			"2026-10-31T05:30:00Z",
			"2026-10-31T06:30:00Z",
			{
				schedule: {
					allDay: false,
					start: "2026-10-31T05:30:00Z",
					end: "2026-10-31T06:30:00Z",
					timeZone: "America/New_York",
				},
				recurrence: {
					seriesId: "autumn-series",
					rrule: "FREQ=DAILY;COUNT=2",
					timeZone: "America/New_York",
					exceptionDates: [],
				},
			},
		);
		// The repeated 01:30 chooses the earlier offset under compatible
		// disambiguation, so the occurrence begins at 05:30Z.
		expect(eventsOverlap(autumn, event(
			"autumn-candidate",
			"2026-11-01T05:45:00Z",
			"2026-11-01T06:15:00Z",
		))).toBe(true);
	});

	test("expands recurring all-day events by local date", () => {
		const allDay: CalendarEvent = {
			...event("weekly-all-day", "2026-08-03T00:00:00Z", "2026-08-04T00:00:00Z"),
			schedule: { allDay: true, startDate: "2026-08-03", endDateExclusive: "2026-08-04" },
			recurrence: {
				seriesId: "weekly-all-day",
				rrule: "FREQ=WEEKLY",
				timeZone: "Asia/Shanghai",
				exceptionDates: [],
			},
		};
		const laterMonday = event(
			"later-monday",
			"2026-08-10T01:00:00Z",
			"2026-08-10T02:00:00Z",
		);

		expect(eventsOverlap(allDay, laterMonday)).toBe(true);
		expect(eventOccursInDateRange(allDay, "2026-08-10", "2026-08-11", "UTC")).toBe(true);
	});

	test("allows occurrence exceptions but rejects series rewrites under occurrence scope", () => {
		const series = event(
			"series-1",
			"2026-08-03T01:00:00Z",
			"2026-08-03T02:00:00Z",
			{
				recurrence: {
					seriesId: "series-1",
					rrule: "FREQ=WEEKLY",
					timeZone: "Asia/Shanghai",
					exceptionDates: [],
				},
			},
		);
		const validException = {
			...series,
			recurrence: {
				...series.recurrence!,
				exceptionDates: ["2026-08-10T01:00:00Z"],
			},
		};
		expect(validateCalendarMutation({
			mutationId: "exception-only",
			kind: "update",
			eventId: series.id,
			expectedVersion: series.version,
			before: series,
			after: validException,
			recurrenceScope: "occurrence",
		}, series)).toBeNull();
		expect(validateCalendarMutation({
			mutationId: "rewrite-one",
			kind: "update",
			eventId: series.id,
			expectedVersion: series.version,
			before: series,
				after: {
					...validException,
					schedule: {
						allDay: false,
						start: "2026-08-03T03:00:00Z",
						end: "2026-08-03T04:00:00Z",
						timeZone: "Asia/Shanghai",
					},
				} as CalendarEvent,
			recurrenceScope: "occurrence",
		}, series)?.reason).toBe("recurrence-restriction");
		expect(validateCalendarMutation({
			mutationId: "following-unsupported",
			kind: "delete",
			eventId: series.id,
			expectedVersion: series.version,
			before: series,
			after: null,
			recurrenceScope: "following",
		}, series)?.reason).toBe("recurrence-restriction");
	});
});
