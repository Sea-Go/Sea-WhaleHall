import { Temporal } from "temporal-polyfill";
import { RRule } from "rrule";
import type {
	CalendarConflict,
	CalendarEvent,
	CalendarMutation,
} from "../shared/calendar";

export class CalendarPolicyError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "CalendarPolicyError";
	}
}

export function validateCalendarEvent(event: CalendarEvent): void {
	boundedText(event.id, "event.id", 256);
	boundedText(event.title, "event.title", 512);
	if (!Number.isSafeInteger(event.version) || event.version < 0) {
		throw new CalendarPolicyError("invalid-version", "日程版本无效。");
	}
	if (event.kind === "external" && event.editable) {
		throw new CalendarPolicyError("external-editable", "外部日程必须保持只读。");
	}
	if (event.schedule.allDay) {
		const start = parseDate(event.schedule.startDate, "startDate");
		const end = parseDate(event.schedule.endDateExclusive, "endDateExclusive");
		if (Temporal.PlainDate.compare(start, end) >= 0) {
			throw new CalendarPolicyError("invalid-all-day-range", "全天日程结束日期必须晚于开始日期。");
		}
	} else {
		assertTimeZone(event.schedule.timeZone);
		const start = parseInstant(event.schedule.start, "start");
		const end = parseInstant(event.schedule.end, "end");
		if (Temporal.Instant.compare(start, end) >= 0) {
			throw new CalendarPolicyError("invalid-timed-range", "日程结束时间必须晚于开始时间。");
		}
		if (start.until(end).total("minutes") < 15) {
			throw new CalendarPolicyError("insufficient-duration", "日程至少需要 15 分钟。");
		}
	}
	if (event.recurrence) {
		boundedText(event.recurrence.seriesId, "recurrence.seriesId", 256);
		boundedText(event.recurrence.rrule, "recurrence.rrule", 4096);
		assertTimeZone(event.recurrence.timeZone);
		if (!/(^|;)FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;|$)/i.test(event.recurrence.rrule.replace(/^RRULE:/i, ""))) {
			throw new CalendarPolicyError("invalid-recurrence", "重复规则缺少受支持的 FREQ。");
		}
		if (event.recurrence.exceptionDates.length > 2_000) {
			throw new CalendarPolicyError("invalid-recurrence", "重复日程例外数量超限。");
		}
		for (const date of event.recurrence.exceptionDates) {
			if (event.schedule.allDay) parseDate(date, "exceptionDate");
			else parseRecurrenceException(date);
		}
	} else if (event.occurrenceId) {
		throw new CalendarPolicyError("invalid-occurrence", "单次发生项必须归属于重复系列。");
	}
}

export function validateCalendarMutation(
	mutation: CalendarMutation,
	current: CalendarEvent | null,
): CalendarConflict | null {
	boundedText(mutation.mutationId, "mutationId", 256);
	boundedText(mutation.eventId, "eventId", 256);
	if (mutation.after) {
		validateCalendarEvent(mutation.after);
		if (mutation.after.id !== mutation.eventId) {
			throw new CalendarPolicyError("event-id-mismatch", "日程 ID 与 mutation 不一致。");
		}
	}
	if (mutation.kind === "create") {
		if (current || mutation.expectedVersion !== null || !mutation.after) {
			return staleConflict(mutation.eventId);
		}
		return null;
	}
	if (!current || mutation.expectedVersion !== current.version) {
		return staleConflict(mutation.eventId);
	}
	if (current.kind === "external" || !current.editable) {
		return {
			reason: "read-only-event",
			severity: "error",
			affectedEventIds: [current.id],
			message: "只读日程不能修改或删除。",
			nextAction: "inspect",
		};
	}
	if (current.recurrence && !mutation.recurrenceScope) {
		return recurrenceConflict(current.id, "修改重复日程前必须选择作用范围。");
	}
	if (current.recurrence && mutation.recurrenceScope === "following") {
		return recurrenceConflict(
			current.id,
			"当前版本尚不能安全拆分“这次及以后”的重复系列，请改为编辑单次或整个系列。",
		);
	}
	if (current.recurrence && current.occurrenceId === null) {
		if (mutation.recurrenceScope === "occurrence") {
			if (
				mutation.kind !== "update" ||
				!mutation.after ||
				!isOccurrenceExceptionUpdate(current, mutation.after)
			) {
				return recurrenceConflict(
					current.id,
					"单次修改必须只在系列上记录例外，并以独立 occurrence 保存改动。",
				);
			}
		}
		if (
			mutation.recurrenceScope === "series" &&
			mutation.after?.recurrence &&
			(mutation.after.occurrenceId !== null ||
				mutation.after.recurrence.seriesId !== current.recurrence.seriesId)
		) {
			return recurrenceConflict(current.id, "整个系列的身份不能在更新时改变。");
		}
	} else if (current.recurrence && mutation.recurrenceScope === "series") {
		return recurrenceConflict(current.id, "单次 occurrence 不能直接改写整个重复系列。");
	}
	if (mutation.kind === "update" && !mutation.after) {
		throw new CalendarPolicyError("missing-after", "更新日程缺少 after。");
	}
	if (mutation.kind === "delete" && mutation.after) {
		throw new CalendarPolicyError("unexpected-after", "删除日程不能包含 after。");
	}
	return null;
}

export function validateOccurrenceOverride(
	candidate: CalendarEvent,
	existing: readonly CalendarEvent[],
): CalendarConflict | null {
	if (!candidate.occurrenceId) return null;
	const recurrence = candidate.recurrence;
	if (!recurrence) return recurrenceConflict(candidate.id, "单次 occurrence 缺少重复系列信息。");
	const prefix = `${recurrence.seriesId}:`;
	if (!candidate.occurrenceId.startsWith(prefix)) {
		return recurrenceConflict(candidate.id, "单次 occurrence 身份与重复系列不一致。");
	}
	const anchor = candidate.occurrenceId.slice(prefix.length);
	try {
		parseRecurrenceException(anchor);
	} catch {
		return recurrenceConflict(candidate.id, "单次 occurrence 的原始发生时间无效。");
	}
	const series = existing.filter(
		(event) =>
			event.id !== candidate.id &&
			event.recurrence?.seriesId === recurrence.seriesId &&
			event.occurrenceId === null,
	);
	if (series.length !== 1 || !series[0]!.recurrence!.exceptionDates.includes(anchor)) {
		return recurrenceConflict(
			candidate.id,
			"单次 occurrence 必须对应一个已记录例外的重复系列。",
		);
	}
	return null;
}

export function detectAuthoritativeConflict(
	candidate: CalendarEvent,
	existing: readonly CalendarEvent[],
): CalendarConflict | null {
	const overlaps = existing.filter((event) => event.id !== candidate.id && eventsOverlap(candidate, event));
	const manual = overlaps.filter((event) => event.kind === "manual-block");
	if (manual.length) return overlapConflict("overlaps-manual-block", manual, "手动占用", "error");
	const external = overlaps.filter((event) => event.kind === "external");
	if (external.length) return overlapConflict("overlaps-external-event", external, "外部日程", "error");
	const committed = overlaps.filter((event) => event.kind === "plan" && event.state === "committed");
	if (committed.length) {
		return overlapConflict(
			"overlaps-committed-plan",
			committed,
			"已确认计划",
			candidate.state === "committed" ? "error" : "warning",
		);
	}
	return null;
}

export function eventsOverlap(left: CalendarEvent, right: CalendarEvent): boolean {
	if (left.recurrence && !right.recurrence) return recurringEventOverlaps(left, right);
	if (!left.recurrence && right.recurrence) return recurringEventOverlaps(right, left);
	if (left.recurrence && right.recurrence) return recurringSeriesOverlap(left, right);
	if (!left.schedule.allDay && !right.schedule.allDay) {
		return (
			Temporal.Instant.compare(parseInstant(left.schedule.start, "start"), parseInstant(right.schedule.end, "end")) < 0 &&
			Temporal.Instant.compare(parseInstant(right.schedule.start, "start"), parseInstant(left.schedule.end, "end")) < 0
		);
	}
	const zone = eventTimeZone(left) ?? eventTimeZone(right) ?? "UTC";
	const leftRange = eventDateRange(left, zone);
	const rightRange = eventDateRange(right, zone);
	return leftRange.start < rightRange.end && rightRange.start < leftRange.end;
}

/** Date-window predicate used after decrypting calendar rows. Recurring series
 * are evaluated in their declared IANA zone, so an old series is not lost just
 * because its base occurrence predates the coarse SQLite range index. */
export function eventOccursInDateRange(
	event: CalendarEvent,
	fromDate: string,
	toDateExclusive: string,
	defaultTimeZone: string,
): boolean {
	const from = parseDate(fromDate, "fromDate");
	const to = parseDate(toDateExclusive, "toDateExclusive");
	if (Temporal.PlainDate.compare(from, to) >= 0) {
		throw new CalendarPolicyError("invalid-date-range", "日历查询范围无效。");
	}
	if (!event.recurrence) {
		const range = eventDateRange(event, defaultTimeZone);
		return range.start < toDateExclusive && fromDate < range.end;
	}
	const zone = event.recurrence.timeZone;
	const queryStart = from.toZonedDateTime({ timeZone: zone, plainTime: "00:00" }).toInstant();
	const queryEnd = to.toZonedDateTime({ timeZone: zone, plainTime: "00:00" }).toInstant();
	return recurrenceIntervals(event, queryStart, queryEnd).some(
		(interval) => instantRangesOverlap(interval, { start: queryStart, end: queryEnd }),
	);
}

export function cloneCalendarEvent(event: CalendarEvent): CalendarEvent {
	return {
		...event,
		schedule: { ...event.schedule },
		recurrence: event.recurrence
			? { ...event.recurrence, exceptionDates: [...event.recurrence.exceptionDates] }
			: null,
	};
}

function eventDateRange(event: CalendarEvent, zone: string): { start: string; end: string } {
	if (event.schedule.allDay) {
		return { start: event.schedule.startDate, end: event.schedule.endDateExclusive };
	}
	return {
		start: parseInstant(event.schedule.start, "start").toZonedDateTimeISO(zone).toPlainDate().toString(),
		end: parseInstant(event.schedule.end, "end").subtract({ nanoseconds: 1 }).toZonedDateTimeISO(zone).toPlainDate().add({ days: 1 }).toString(),
	};
}

function eventTimeZone(event: CalendarEvent): string | null {
	if (!event.schedule.allDay) return event.schedule.timeZone;
	return event.recurrence?.timeZone ?? null;
}

interface InstantRange {
	start: Temporal.Instant;
	end: Temporal.Instant;
}

function recurringEventOverlaps(series: CalendarEvent, candidate: CalendarEvent): boolean {
	const zone = series.recurrence!.timeZone;
	const candidateRange = eventInstantRange(candidate, zone);
	return recurrenceIntervals(series, candidateRange.start, candidateRange.end).some(
		(interval) => instantRangesOverlap(interval, candidateRange),
	);
}

function recurringSeriesOverlap(left: CalendarEvent, right: CalendarEvent): boolean {
	const leftBase = eventInstantRange(left, left.recurrence!.timeZone);
	const rightBase = eventInstantRange(right, right.recurrence!.timeZone);
	const start = Temporal.Instant.compare(leftBase.start, rightBase.start) <= 0
		? leftBase.start
		: rightBase.start;
	// Recurring-series writes are conservatively checked over the next year.
	// Planning proposals are non-recurring and use the exact requested window.
	const end = start.add({ hours: 24 * 366 });
	const leftIntervals = recurrenceIntervals(left, start, end);
	const rightIntervals = recurrenceIntervals(right, start, end);
	return leftIntervals.some((leftInterval) =>
		rightIntervals.some((rightInterval) => instantRangesOverlap(leftInterval, rightInterval)),
	);
}

function recurrenceIntervals(
	event: CalendarEvent,
	queryStart: Temporal.Instant,
	queryEnd: Temporal.Instant,
): readonly InstantRange[] {
	const recurrence = event.recurrence;
	if (!recurrence) return [eventInstantRange(event, eventTimeZone(event) ?? "UTC")];
	const zone = recurrence.timeZone;
	const base = eventLocalStart(event, zone);
	const duration = recurrenceDuration(event);
	const parsed = RRule.parseString(recurrence.rrule.replace(/^RRULE:/i, ""));
	const rule = new RRule({ ...parsed, dtstart: floatingDate(base) });
	const queryStartLocal = queryStart.toZonedDateTimeISO(zone).toPlainDateTime();
	const queryEndLocal = queryEnd.toZonedDateTimeISO(zone).toPlainDateTime();
	// During a fall-back transition, increasing instants can map to decreasing
	// local wall times (01:45 EDT -> 01:15 EST). Build a conservative local
	// envelope, then let callers perform the exact instant overlap check.
	const lowerLocal = Temporal.PlainDateTime.compare(queryStartLocal, queryEndLocal) <= 0
		? queryStartLocal
		: queryEndLocal;
	const upperLocal = Temporal.PlainDateTime.compare(queryStartLocal, queryEndLocal) <= 0
		? queryEndLocal
		: queryStartLocal;
	const recurrenceQueryStart = lowerLocal
		.subtract(event.schedule.allDay
			? { days: duration.days + 1 }
			: { milliseconds: duration.milliseconds, days: 1 });
	const recurrenceQueryEnd = upperLocal.add({ days: 1 });
	const occurrences = rule.between(
		floatingDate(recurrenceQueryStart),
		floatingDate(recurrenceQueryEnd),
		true,
	);
	if (occurrences.length > 4_096) {
		throw new CalendarPolicyError("recurrence-too-dense", "重复日程在查询窗口内的发生次数超限。");
	}
	const output: InstantRange[] = [];
	for (const occurrence of occurrences) {
		const local = floatingPlainDateTime(occurrence);
		const zoned = local.toZonedDateTime(zone, { disambiguation: "compatible" });
		const start = zoned.toInstant();
		if (isException(recurrence.exceptionDates, local.toPlainDate(), start)) continue;
		const end = event.schedule.allDay
			? local.toPlainDate().add({ days: duration.days })
				.toZonedDateTime({ timeZone: zone, plainTime: "00:00" })
				.toInstant()
			: start.add({ milliseconds: duration.milliseconds });
		output.push({ start, end });
	}
	return output;
}

function eventInstantRange(event: CalendarEvent, allDayTimeZone: string): InstantRange {
	if (!event.schedule.allDay) {
		return {
			start: parseInstant(event.schedule.start, "start"),
			end: parseInstant(event.schedule.end, "end"),
		};
	}
	return {
		start: parseDate(event.schedule.startDate, "startDate")
			.toZonedDateTime({ timeZone: allDayTimeZone, plainTime: "00:00" })
			.toInstant(),
		end: parseDate(event.schedule.endDateExclusive, "endDateExclusive")
			.toZonedDateTime({ timeZone: allDayTimeZone, plainTime: "00:00" })
			.toInstant(),
	};
}

function eventLocalStart(event: CalendarEvent, zone: string): Temporal.PlainDateTime {
	if (event.schedule.allDay) return parseDate(event.schedule.startDate, "startDate").toPlainDateTime("00:00");
	return parseInstant(event.schedule.start, "start").toZonedDateTimeISO(zone).toPlainDateTime();
}

function recurrenceDuration(event: CalendarEvent): { days: number; milliseconds: number } {
	if (event.schedule.allDay) {
		return {
			days: parseDate(event.schedule.startDate, "startDate")
				.until(parseDate(event.schedule.endDateExclusive, "endDateExclusive"), { largestUnit: "day" })
				.days,
			milliseconds: 0,
		};
	}
	return {
		days: 0,
		milliseconds:
			parseInstant(event.schedule.end, "end").epochMilliseconds -
			parseInstant(event.schedule.start, "start").epochMilliseconds,
	};
}

function floatingDate(value: Temporal.PlainDateTime): Date {
	return new Date(Date.UTC(
		value.year,
		value.month - 1,
		value.day,
		value.hour,
		value.minute,
		value.second,
		value.millisecond,
	));
}

function floatingPlainDateTime(value: Date): Temporal.PlainDateTime {
	return Temporal.PlainDateTime.from({
		year: value.getUTCFullYear(),
		month: value.getUTCMonth() + 1,
		day: value.getUTCDate(),
		hour: value.getUTCHours(),
		minute: value.getUTCMinutes(),
		second: value.getUTCSeconds(),
		millisecond: value.getUTCMilliseconds(),
	});
}

function isException(
	exceptions: readonly string[],
	localDate: Temporal.PlainDate,
	start: Temporal.Instant,
): boolean {
	return exceptions.some((exception) => {
		if (/^\d{4}-\d{2}-\d{2}$/.test(exception)) return exception === localDate.toString();
		try {
			return Temporal.Instant.compare(Temporal.Instant.from(exception), start) === 0;
		} catch {
			return false;
		}
	});
}

function instantRangesOverlap(left: InstantRange, right: InstantRange): boolean {
	return Temporal.Instant.compare(left.start, right.end) < 0 &&
		Temporal.Instant.compare(right.start, left.end) < 0;
}

function overlapConflict(
	reason: Extract<CalendarConflict["reason"], "overlaps-manual-block" | "overlaps-external-event" | "overlaps-committed-plan">,
	events: readonly CalendarEvent[],
	label: string,
	severity: CalendarConflict["severity"],
): CalendarConflict {
	return {
		reason,
		severity,
		affectedEventIds: events.map((event) => event.id),
		message: `与${label} ${events.map((event) => `“${event.title}”`).join("、")} 冲突。`,
		nextAction: severity === "warning" ? "keep-proposed" : "inspect",
	};
}

function staleConflict(eventId: string): CalendarConflict {
	return {
		reason: "stale-version",
		severity: "error",
		affectedEventIds: [eventId],
		message: "日程已被其他操作更新，请刷新后重试。",
		nextAction: "retry",
	};
}

function recurrenceConflict(eventId: string, message: string): CalendarConflict {
	return {
		reason: "recurrence-restriction",
		severity: "error",
		affectedEventIds: [eventId],
		message,
		nextAction: "edit",
	};
}

function isOccurrenceExceptionUpdate(
	current: CalendarEvent,
	after: CalendarEvent,
): boolean {
	if (!current.recurrence || !after.recurrence) return false;
	if (
		after.id !== current.id ||
		after.title !== current.title ||
		after.kind !== current.kind ||
		after.state !== current.state ||
		after.occurrenceId !== current.occurrenceId ||
		after.sourcePlanId !== current.sourcePlanId ||
		after.editable !== current.editable ||
		after.version !== current.version ||
		JSON.stringify(after.schedule) !== JSON.stringify(current.schedule) ||
		after.recurrence.seriesId !== current.recurrence.seriesId ||
		after.recurrence.rrule !== current.recurrence.rrule ||
		after.recurrence.timeZone !== current.recurrence.timeZone
	) return false;
	const before = new Set(current.recurrence.exceptionDates);
	const next = new Set(after.recurrence.exceptionDates);
	if (next.size <= before.size) return false;
	return [...before].every((exception) => next.has(exception));
}

function parseInstant(value: string, field: string): Temporal.Instant {
	try {
		return Temporal.Instant.from(value);
	} catch {
		throw new CalendarPolicyError("invalid-instant", `${field} 不是有效的 ISO instant。`);
	}
}

function parseDate(value: string, field: string): Temporal.PlainDate {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new CalendarPolicyError("invalid-date", `${field} 必须是 ISO date-only。`);
	}
	try {
		return Temporal.PlainDate.from(value);
	} catch {
		throw new CalendarPolicyError("invalid-date", `${field} 不是有效日期。`);
	}
}

function parseRecurrenceException(value: string): void {
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		parseDate(value, "exceptionDate");
		return;
	}
	parseInstant(value, "exceptionDate");
}

function assertTimeZone(value: string): void {
	boundedText(value, "timeZone", 128);
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
	} catch {
		throw new CalendarPolicyError("invalid-time-zone", "日程必须使用有效 IANA 时区。");
	}
}

function boundedText(value: string, field: string, maxLength: number): void {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
		throw new CalendarPolicyError("invalid-text", `${field} 长度无效。`);
	}
}
