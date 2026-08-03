/** Runtime-neutral calendar contracts shared by Bun and the client WebView. */
export type CalendarEventKind = "plan" | "manual-block" | "external" | "break";
export type CalendarEventState = "proposed" | "committed";

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
	| "stale-revision"
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
	| { ok: true; mutationId: string; event: CalendarEvent | null; warning: CalendarConflict | null }
	| { ok: false; mutationId: string; conflict: CalendarConflict };

export type CalendarBatchMutationResult =
	| {
			ok: true;
			batchId: string;
			events: readonly CalendarEvent[];
			warnings: readonly CalendarConflict[];
			calendarRevision?: number;
	  }
	| { ok: false; batchId: string; conflicts: readonly CalendarConflict[] };

export interface CalendarSnapshot {
	accountId: string;
	revision: number;
	timeZone: string;
	fromDate: string;
	toDateExclusive: string;
	events: readonly CalendarEvent[];
}

export interface CalendarLoadResponse {
	revision: number;
	timeZone: string;
	events: readonly CalendarEvent[];
}
