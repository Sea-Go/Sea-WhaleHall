import type {
	CalendarChangeSet,
	PlanningCalendarEvent,
	PlanningObservationSummary,
	PlanningPlan,
} from "./types";

export interface PlanningWriteResult {
	plan: PlanningPlan;
	replayed: boolean;
}

export interface PlanningRepository {
	listPlans(): Promise<readonly PlanningPlan[]>;
	getPlan(planId: string): Promise<PlanningPlan | null>;
	getOperationResult(operationId: string): Promise<PlanningPlan | null>;
	createPlan(plan: PlanningPlan, operationId: string): Promise<PlanningWriteResult>;
	savePlan(
		plan: PlanningPlan,
		options: { operationId: string; expectedVersion: number },
	): Promise<PlanningWriteResult>;
}

export interface PlanningCalendarQuery {
	startDate: string;
	endDateExclusive: string;
	timeZone: string;
}

export type PlanningCalendarConflictCode =
	| "overlap"
	| "stale-version"
	| "read-only"
	| "invalid-event"
	| "service-unavailable";

export interface PlanningCalendarConflict {
	code: PlanningCalendarConflictCode;
	affectedEventIds: readonly string[];
}

export type CalendarApplyResult =
	| {
			ok: true;
			changeSetId: string;
			events: readonly PlanningCalendarEvent[];
			replayed: boolean;
	  }
	| {
			ok: false;
			changeSetId: string;
			conflicts: readonly PlanningCalendarConflict[];
	  };

/**
 * Production implementations apply a change set atomically and make its
 * operationId idempotent. No partial event list may be committed on failure.
 */
export interface PlanningCalendarPort {
	listEvents(
		query: PlanningCalendarQuery,
	): Promise<readonly PlanningCalendarEvent[]>;
	applyChangeSet(changeSet: CalendarChangeSet): Promise<CalendarApplyResult>;
}

export interface PlanningObservationQuery {
	from: string;
	to: string;
}

export interface PlanningObservationPort {
	listSummaries(
		query: PlanningObservationQuery,
	): Promise<readonly PlanningObservationSummary[]>;
}

export class PlanNotFoundError extends Error {
	constructor(public readonly planId: string) {
		super("Planning plan was not found.");
		this.name = "PlanNotFoundError";
	}
}

export class PlanVersionConflictError extends Error {
	constructor(
		public readonly expectedVersion: number,
		public readonly actualVersion: number | null,
	) {
		super("Planning plan changed concurrently.");
		this.name = "PlanVersionConflictError";
	}
}

export class PlanOperationConflictError extends Error {
	constructor(public readonly operationId: string) {
		super("Planning operation ID was reused for a different mutation.");
		this.name = "PlanOperationConflictError";
	}
}

export class PlanStateError extends Error {
	constructor(
		public readonly code:
			| "invalid-input"
			| "invalid-state"
			| "revision-not-found"
			| "task-not-found"
			| "observation-not-found"
			| "adjustment-not-found"
			| "calendar-conflict",
		message: string,
	) {
		super(message);
		this.name = "PlanStateError";
	}
}
