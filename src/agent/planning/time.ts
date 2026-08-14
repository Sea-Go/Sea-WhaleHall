import { Temporal } from "temporal-polyfill";
import type { PlanningCalendarEvent } from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_MINUTE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface PlanningClock {
	nowMs(): number;
}

export class SystemPlanningClock implements PlanningClock {
	nowMs(): number {
		return Date.now();
	}
}

export function assertIanaTimeZone(timeZone: string): void {
	if (!timeZone.trim()) throw new Error("Planning time zone is required.");
	try {
		Temporal.Now.instant().toZonedDateTimeISO(timeZone);
	} catch {
		throw new Error("Planning time zone must be a valid IANA identifier.");
	}
}

export function assertIsoDate(date: string, field = "date"): void {
	if (!ISO_DATE.test(date)) throw new Error(`${field} must be an ISO date.`);
	try {
		if (Temporal.PlainDate.from(date).toString() !== date) {
			throw new Error("non-canonical date");
		}
	} catch {
		throw new Error(`${field} must be an ISO date.`);
	}
}

export function assertLocalMinute(time: string, field = "time"): void {
	if (!LOCAL_MINUTE.test(time)) {
		throw new Error(`${field} must use HH:mm local time.`);
	}
}

export function instantForEpochMs(nowMs: number): string {
	if (!Number.isFinite(nowMs)) throw new Error("Planning clock returned invalid time.");
	return Temporal.Instant.fromEpochMilliseconds(Math.trunc(nowMs)).toString();
}

export function localDateAt(nowMs: number, timeZone: string): string {
	assertIanaTimeZone(timeZone);
	return Temporal.Instant.fromEpochMilliseconds(Math.trunc(nowMs))
		.toZonedDateTimeISO(timeZone)
		.toPlainDate()
		.toString();
}

/** The start date is intentionally evaluated at confirmation time. */
export function effectivePlanStartDate(
	nowMs: number,
	timeZone: string,
	startToday: boolean,
): string {
	const today = Temporal.PlainDate.from(localDateAt(nowMs, timeZone));
	return (startToday ? today : today.add({ days: 1 })).toString();
}

export function rollingSevenDayWindow(startDate: string): {
	startDate: string;
	endDateExclusive: string;
} {
	assertIsoDate(startDate, "startDate");
	return {
		startDate,
		endDateExclusive: Temporal.PlainDate.from(startDate)
			.add({ days: 7 })
			.toString(),
	};
}

export function addDays(date: string, days: number): string {
	assertIsoDate(date);
	if (!Number.isSafeInteger(days)) throw new Error("days must be an integer.");
	return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function compareDates(left: string, right: string): number {
	assertIsoDate(left, "left date");
	assertIsoDate(right, "right date");
	return Temporal.PlainDate.compare(
		Temporal.PlainDate.from(left),
		Temporal.PlainDate.from(right),
	);
}

export function instantToDate(instant: string, timeZone: string): string {
	return Temporal.Instant.from(instant)
		.toZonedDateTimeISO(timeZone)
		.toPlainDate()
		.toString();
}

export function localDateTimeToInstant(
	date: string,
	time: string,
	timeZone: string,
): string {
	assertIsoDate(date);
	assertLocalMinute(time);
	assertIanaTimeZone(timeZone);
	return Temporal.PlainDateTime.from(`${date}T${time}`)
		.toZonedDateTime(timeZone, { disambiguation: "reject" })
		.toInstant()
		.toString();
}

export function addInstantMinutes(instant: string, minutes: number): string {
	return Temporal.Instant.from(instant).add({ minutes }).toString();
}

export function durationMinutes(start: string, end: string): number {
	return Number(
		Temporal.Instant.from(start)
			.until(Temporal.Instant.from(end), { largestUnit: "minute" })
			.total({ unit: "minute" }),
	);
}

export function compareInstants(left: string, right: string): number {
	return Temporal.Instant.compare(
		Temporal.Instant.from(left),
		Temporal.Instant.from(right),
	);
}

export function intervalsOverlap(
	leftStart: string,
	leftEnd: string,
	rightStart: string,
	rightEnd: string,
): boolean {
	return (
		compareInstants(leftStart, rightEnd) < 0 &&
		compareInstants(rightStart, leftEnd) < 0
	);
}

export type AutomaticCalendarMutationDecision =
	| { allowed: true }
	| {
			allowed: false;
			reason:
				| "not-plan-event"
				| "different-plan"
				| "not-model-generated"
				| "user-locked"
				| "today-frozen"
				| "already-started"
				| "completed-task";
	  };

/**
 * Automatic adjustments are intentionally stricter than initial confirmation.
 * The entire current local date is frozen, including events that have not yet
 * started. Initial confirmation is a direct user-approved change and does not
 * call this predicate.
 */
export function canAutomaticallyMutateCalendarEvent(
	event: PlanningCalendarEvent,
	options: {
		planId: string;
		nowMs: number;
		planTimeZone: string;
		completedTaskIds?: ReadonlySet<string>;
	},
): AutomaticCalendarMutationDecision {
	if (event.kind !== "plan") {
		return { allowed: false, reason: "not-plan-event" };
	}
	if (event.planId !== options.planId) {
		return { allowed: false, reason: "different-plan" };
	}
	if (event.scheduleOrigin !== "model") {
		return { allowed: false, reason: "not-model-generated" };
	}
	if (event.userLocked) return { allowed: false, reason: "user-locked" };
	const today = localDateAt(options.nowMs, options.planTimeZone);
	if (instantToDate(event.start, options.planTimeZone) <= today) {
		return { allowed: false, reason: "today-frozen" };
	}
	if (compareInstants(event.start, instantForEpochMs(options.nowMs)) <= 0) {
		return { allowed: false, reason: "already-started" };
	}
	if (
		event.sourceTaskId !== null &&
		options.completedTaskIds?.has(event.sourceTaskId)
	) {
		return { allowed: false, reason: "completed-task" };
	}
	return { allowed: true };
}
