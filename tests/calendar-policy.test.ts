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






});
