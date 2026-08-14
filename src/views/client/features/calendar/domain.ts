import {
	compareInstants,
	durationMinutes,
	instantToDateInZone,
	rangesOverlap,
} from "./date-time";

export type CalendarEventKind = "plan" | "manual-block" | "external" | "break";
export type CalendarEventState = "proposed" | "committed";
export type CalendarScheduleOrigin = "model" | "user";

export interface TimedSchedule {
	allDay: false;
	start: string;
	end: string;
	timeZone: string;
}

export interface AllDaySchedule {
	allDay: true;
	startDate: string;
	endDateExclusive: string;
}

export interface Recurrence {
	seriesId: string;
	rrule: string;
	timeZone: string;
	exceptionDates: readonly string[];
}

export interface CalendarEvent {
	id: string;
	title: string;
	kind: CalendarEventKind;
	state: CalendarEventState;
	schedule: TimedSchedule | AllDaySchedule;
	recurrence: Recurrence | null;
	occurrenceId: string | null;
	sourcePlanId: string | null;
	/** Stable task ownership for planned work; null for non-task calendar entries. */
	sourceTaskId: string | null;
	/** Identifies whether planning automation or the user created this schedule. */
	scheduleOrigin: CalendarScheduleOrigin | null;
	/** User-edited planned work is protected from future automatic rescheduling. */
	userLocked: boolean;
	editable: boolean;
	version: number;
}

export type CalendarConflictReason =
	| "overlaps-manual-block"
	| "overlaps-external-event"
	| "overlaps-committed-plan"
	| "outside-available-hours"
	| "insufficient-duration"
	| "stale-version"
	| "recurrence-restriction"
	| "read-only-event"
	| "service-unavailable";

export interface CalendarConflict {
	reason: CalendarConflictReason;
	severity: "warning" | "error";
	affectedEventIds: readonly string[];
	message: string;
	nextAction: "edit" | "retry" | "inspect" | "keep-proposed";
}

export type RecurrenceScope = "occurrence" | "following" | "series";
export type CalendarMutationKind = "create" | "update" | "delete" | "restore";

export interface CalendarMutation {
	mutationId: string;
	kind: CalendarMutationKind;
	eventId: string;
	expectedVersion: number | null;
	before: CalendarEvent | null;
	after: CalendarEvent | null;
	recurrenceScope: RecurrenceScope | null;
}

export type CalendarMutationResult =
	| {
			ok: true;
			mutationId: string;
			event: CalendarEvent | null;
			warning: CalendarConflict | null;
	  }
	| {
			ok: false;
			mutationId: string;
			conflict: CalendarConflict;
	  };

export type CalendarBatchMutationResult =
	| {
			ok: true;
			batchId: string;
			events: readonly CalendarEvent[];
			warnings: readonly CalendarConflict[];
	  }
	| {
			ok: false;
			batchId: string;
			conflicts: readonly CalendarConflict[];
	  };

export class CalendarDomainError extends Error {
	constructor(
		public readonly code:
			| "empty-id"
			| "empty-title"
			| "invalid-timed-range"
			| "invalid-all-day-range"
			| "invalid-time-zone"
			| "invalid-version"
			| "external-editable"
			| "invalid-recurrence"
			| "invalid-occurrence"
			| "invalid-planning-metadata",
		message: string,
	) {
		super(message);
		this.name = "CalendarDomainError";
	}
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function assertValidCalendarEvent(event: CalendarEvent): void {
	if (!event.id.trim()) {
		throw new CalendarDomainError("empty-id", "日程缺少稳定 ID。");
	}
	if (!event.title.trim()) {
		throw new CalendarDomainError("empty-title", "日程标题不能为空。");
	}
	if (!Number.isInteger(event.version) || event.version < 0) {
		throw new CalendarDomainError(
			"invalid-version",
			"日程版本必须是非负整数。",
		);
	}
	if (event.kind === "external" && event.editable) {
		throw new CalendarDomainError(
			"external-editable",
			"外部日历默认必须保持只读。",
		);
	}
	const hasCompletePlanOwnership =
		event.sourcePlanId !== null &&
		event.sourcePlanId.trim().length > 0 &&
		event.sourceTaskId !== null &&
		event.sourceTaskId.trim().length > 0 &&
		(event.scheduleOrigin === "model" || event.scheduleOrigin === "user");
	const hasNoPlanOwnership =
		event.sourcePlanId === null &&
		event.sourceTaskId === null &&
		event.scheduleOrigin === null &&
		!event.userLocked;
	if (
		typeof event.userLocked !== "boolean" ||
		(event.kind === "plan" ? !hasCompletePlanOwnership : !hasNoPlanOwnership)
	) {
		throw new CalendarDomainError(
			"invalid-planning-metadata",
			"计划日程的计划来源、任务来源与锁定状态不一致。",
		);
	}

	if (event.schedule.allDay) {
		if (
			!isoDatePattern.test(event.schedule.startDate) ||
			!isoDatePattern.test(event.schedule.endDateExclusive) ||
			event.schedule.startDate >= event.schedule.endDateExclusive
		) {
			throw new CalendarDomainError(
				"invalid-all-day-range",
				"全天日程必须使用有效的独占结束日期。",
			);
		}
	} else {
		if (!event.schedule.timeZone.includes("/")) {
			throw new CalendarDomainError(
				"invalid-time-zone",
				"定时日程必须声明 IANA 时区。",
			);
		}
		if (compareInstants(event.schedule.start, event.schedule.end) >= 0) {
			throw new CalendarDomainError(
				"invalid-timed-range",
				"日程结束时间必须晚于开始时间。",
			);
		}
	}

	if (event.recurrence) {
		if (
			!event.recurrence.seriesId.trim() ||
			!event.recurrence.rrule.trim() ||
			!event.recurrence.timeZone.includes("/")
		) {
			throw new CalendarDomainError(
				"invalid-recurrence",
				"重复日程必须包含系列 ID、规则和命名时区。",
			);
		}
	}
	if (event.occurrenceId && !event.recurrence) {
		throw new CalendarDomainError(
			"invalid-occurrence",
			"单次发生项必须归属于重复系列。",
		);
	}
}

export function cloneCalendarEvent(event: CalendarEvent): CalendarEvent {
	return {
		...event,
		schedule: { ...event.schedule },
		recurrence: event.recurrence
			? {
					...event.recurrence,
					exceptionDates: [...event.recurrence.exceptionDates],
				}
			: null,
	};
}

export function canUserUnlockPlanEvent(event: CalendarEvent): boolean {
	return (
		event.editable &&
		event.kind === "plan" &&
		event.scheduleOrigin === "model" &&
		event.userLocked
	);
}

function eventDates(event: CalendarEvent): {
	startDate: string;
	endDateExclusive: string;
} {
	if (event.schedule.allDay) return event.schedule;
	return {
		startDate: instantToDateInZone(
			event.schedule.start,
			event.schedule.timeZone,
		),
		endDateExclusive: instantToDateInZone(
			event.schedule.end,
			event.schedule.timeZone,
		),
	};
}

export function eventsOverlap(
	left: CalendarEvent,
	right: CalendarEvent,
): boolean {
	if (!left.schedule.allDay && !right.schedule.allDay) {
		return rangesOverlap(
			left.schedule.start,
			left.schedule.end,
			right.schedule.start,
			right.schedule.end,
		);
	}
	const leftDates = eventDates(left);
	const rightDates = eventDates(right);
	return (
		leftDates.startDate < rightDates.endDateExclusive &&
		rightDates.startDate < leftDates.endDateExclusive
	);
}

export function detectCalendarConflict(
	candidate: CalendarEvent,
	existing: readonly CalendarEvent[],
): CalendarConflict | null {
	if (!candidate.schedule.allDay) {
		const minutes = durationMinutes(
			candidate.schedule.start,
			candidate.schedule.end,
		);
		if (minutes < 15) {
			return {
				reason: "insufficient-duration",
				severity: "error",
				affectedEventIds: [candidate.id],
				message: "日程至少需要 15 分钟，请延长结束时间。",
				nextAction: "edit",
			};
		}
	}

	const overlaps = existing.filter(
		(event) =>
			event.id !== candidate.id &&
			event.schedule.allDay === candidate.schedule.allDay &&
			eventsOverlap(candidate, event),
	);
	const manual = overlaps.filter((event) => event.kind === "manual-block");
	if (manual.length > 0) {
		return {
			reason: "overlaps-manual-block",
			severity: "error",
			affectedEventIds: manual.map((event) => event.id),
			message: `与 ${manual.map((event) => `“${event.title}”`).join("、")} 的手动占用冲突。`,
			nextAction: "edit",
		};
	}

	const external = overlaps.filter((event) => event.kind === "external");
	if (external.length > 0) {
		return {
			reason: "overlaps-external-event",
			severity: "error",
			affectedEventIds: external.map((event) => event.id),
			message: `与只读外部日程 ${external.map((event) => `“${event.title}”`).join("、")} 冲突。`,
			nextAction: "inspect",
		};
	}

	const committedPlans = overlaps.filter(
		(event) => event.kind === "plan" && event.state === "committed",
	);
	if (committedPlans.length > 0) {
		return {
			reason: "overlaps-committed-plan",
			severity: "warning",
			affectedEventIds: committedPlans.map((event) => event.id),
			message: `与已确认计划 ${committedPlans.map((event) => `“${event.title}”`).join("、")} 重叠。`,
			nextAction: candidate.state === "proposed" ? "keep-proposed" : "inspect",
		};
	}
	return null;
}

export function withOccurrenceException(
	event: CalendarEvent,
	exceptionDate: string,
): CalendarEvent {
	if (!event.recurrence) {
		throw new CalendarDomainError(
			"invalid-recurrence",
			"只有重复日程可以记录单次例外。",
		);
	}
	return {
		...cloneCalendarEvent(event),
		recurrence: {
			...event.recurrence,
			exceptionDates: Array.from(
				new Set([...event.recurrence.exceptionDates, exceptionDate]),
			).sort(),
		},
	};
}

export function createOccurrenceOverride(
	series: CalendarEvent,
	occurrenceStart: string,
	schedule: CalendarEvent["schedule"],
	title = series.title,
): { series: CalendarEvent; occurrence: CalendarEvent } {
	if (!series.recurrence) {
		throw new CalendarDomainError(
			"invalid-recurrence",
			"只有重复系列可以创建单次例外。",
		);
	}
	const occurrenceId = `${series.recurrence.seriesId}:${occurrenceStart}`;
	return {
		series: withOccurrenceException(series, occurrenceStart),
		occurrence: {
			...cloneCalendarEvent(series),
			id: `${series.id}::${occurrenceStart}`,
			title,
			schedule: { ...schedule },
			occurrenceId,
			version: 0,
		},
	};
}
