/**
 * Renderer-safe projections for the local planning runtime.
 *
 * Goal and conversation text are content-sensitive. They may cross the local
 * Typed RPC boundary for presentation, but must never be written to renderer
 * diagnostics or generic telemetry.
 */
export type PlanningPlanType = "short-term" | "long-term" | "fuzzy";
export type PlanningPlanStatus =
	| "draft"
	| "awaiting-confirmation"
	| "active"
	| "paused"
	| "completed"
	| "archived";
export type PlanningTaskStatus = "pending" | "completed" | "skipped";
export type PlanningTaskPurpose = "execution" | "validation" | "review";
export type PlanningMessageRole = "user" | "assistant" | "system";
export type PlanningMessageState = "complete" | "pending-analysis" | "failed";

export type PlanningScheduleProjection = {
	eventId: string | null;
	start: string | null;
	end: string | null;
	timeZone: string;
	userLocked: boolean;
	scheduleOrigin: "model" | "user";
	version: number;
	unplannedReason: string | null;
};

export type PlanningTaskProjection = {
	id: string;
	title: string;
	description: string;
	purpose: PlanningTaskPurpose;
	status: PlanningTaskStatus;
	estimatedMinutes: number;
	dependsOnTaskIds: string[];
	schedules: PlanningScheduleProjection[];
	unscheduledReason: string | null;
};

export type PlanningEstimateProjection = {
	estimatedCompletionDate: string;
	confidence: number;
	assessedAt: string;
	evidenceThrough: string;
	basis: string;
	modelVersion: string;
};

export type PlanningSchedulingPreferencesProjection = {
	weeklyCapacityMinutes: number;
	sessionMinutes: number;
	availableWindows: Array<{
		dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7;
		startTime: string;
		endTime: string;
	}>;
};

export type PlanningMessageProjection = {
	id: string;
	role: PlanningMessageRole;
	content: string;
	createdAt: string;
	state: PlanningMessageState;
};

export type PlanningRevisionProjection = {
	revisionId: string;
	version: number;
	createdAt: string;
	goal: string;
	reason:
		| "initial-analysis"
		| "conversation"
		| "user-progress"
		| "observation"
		| "calendar-change"
		| "daily-summary"
		| "undo";
	type: PlanningPlanType;
	typeReason: string;
	assumptions: string[];
	clarifyingQuestions: string[];
	estimate: PlanningEstimateProjection;
	schedulingPreferences: PlanningSchedulingPreferencesProjection;
	scheduleWindow: { startDate: string; endDateExclusive: string };
	tasks: PlanningTaskProjection[];
};

export type PlanningObservationProjection = {
	id: string;
	periodStartedAt: string;
	periodEndedAt: string;
	minutes: number;
	confidence: number;
	suggestedTaskIds: string[];
	status: "pending" | "confirmed" | "dismissed";
};

export type PlanningAdjustmentProjection = {
	id: string;
	createdAt: string;
	reason: string;
	previousEstimateDate: string;
	nextEstimateDate: string;
	movedCount: number;
	addedCount: number;
	cancelledCount: number;
	canUndo: boolean;
	undoUnavailableReason: string | null;
	undoneAt: string | null;
	version: number;
};

export type PlanningMonitoringProjection = {
	authorized: boolean;
	enabled: boolean;
	mode: "observed" | "manual-only";
	coverage: "complete" | "partial" | "unavailable";
	message: string;
};

export type PlanningPlanSummaryProjection = {
	id: string;
	goal: string;
	status: PlanningPlanStatus;
	type: PlanningPlanType | null;
	estimatedCompletionDate: string | null;
	estimateConfidence: number | null;
	version: number;
	updatedAt: string;
};

export type PlanningPlanProjection = {
	id: string;
	goal: string;
	status: PlanningPlanStatus;
	version: number;
	timeZone: string;
	startToday: boolean;
	effectiveStartDate: string | null;
	scheduleWindow: { startDate: string; endDateExclusive: string };
	type: PlanningPlanType | null;
	typeReason: string | null;
	estimate: PlanningEstimateProjection | null;
	/** Confirmed execution baseline. Never points at an unconfirmed proposal. */
	activeRevision: PlanningRevisionProjection | null;
	/** Latest conversation proposal. May coexist with an active or paused plan. */
	proposedRevision: PlanningRevisionProjection | null;
	messages: PlanningMessageProjection[];
	tasks: PlanningTaskProjection[];
	monitoring: PlanningMonitoringProjection;
	pendingObservations: PlanningObservationProjection[];
	adjustments: PlanningAdjustmentProjection[];
	notifications: PlanningNotificationProjection[];
	createdAt: string;
	updatedAt: string;
};

export type PlanningWriteCommand = {
	planId: string;
	operationId: string;
	expectedVersion: number;
};

export type UndoPlanningAdjustmentCommand = PlanningWriteCommand & {
	adjustmentId: string;
	adjustmentVersion: number;
};

export type CreatePlanDraftCommand = {
	input: { goal: string; startToday: boolean };
	operationId: string;
};

export type SendPlanMessageCommand = PlanningWriteCommand & {
	content: string;
};

export type ConfirmPlanRevisionCommand = PlanningWriteCommand & {
	revisionId: string;
};

export type SetPlanningTaskStatusCommand = PlanningWriteCommand & {
	taskId: string;
	status: PlanningTaskStatus;
};

export type ConfirmPlanningObservationCommand = PlanningWriteCommand & {
	observationId: string;
	taskId: string | null;
};

export type PlanningChangeProjection = {
	planId: string;
	version: number;
	kind:
		| "created"
		| "analysis"
		| "activated"
		| "progress"
		| "adjusted"
		| "status";
};

export type PlanningNotificationProjection = {
	id: string;
	planId: string;
	kind: "analysis-ready" | "schedule-adjusted" | "attention-required";
	message: string;
	createdAt: string;
};

export type PlanningCalendarSchedule =
	| {
			allDay: false;
			start: string;
			end: string;
			timeZone: string;
	  }
	| { allDay: true; startDate: string; endDateExclusive: string };

export type PlanningCalendarEventProjection = {
	id: string;
	title: string;
	kind: "plan" | "manual-block" | "external" | "break";
	state: "proposed" | "committed";
	schedule: PlanningCalendarSchedule;
	recurrence: {
		seriesId: string;
		rrule: string;
		timeZone: string;
		exceptionDates: string[];
	} | null;
	occurrenceId: string | null;
	sourcePlanId: string | null;
	sourceTaskId: string | null;
	scheduleOrigin: "model" | "user" | null;
	userLocked: boolean;
	editable: boolean;
	version: number;
};

export type PlanningCalendarMutationProjection = {
	mutationId: string;
	kind: "create" | "update" | "delete" | "restore";
	eventId: string;
	expectedVersion: number | null;
	before: PlanningCalendarEventProjection | null;
	after: PlanningCalendarEventProjection | null;
	recurrenceScope: "occurrence" | "following" | "series" | null;
};

export type PlanningCalendarConflictProjection = {
	reason:
		| "overlaps-manual-block"
		| "overlaps-external-event"
		| "overlaps-committed-plan"
		| "outside-available-hours"
		| "insufficient-duration"
		| "stale-version"
		| "recurrence-restriction"
		| "read-only-event"
		| "service-unavailable";
	severity: "warning" | "error";
	affectedEventIds: string[];
	message: string;
	nextAction: "edit" | "retry" | "inspect" | "keep-proposed";
};

export type PlanningCalendarMutationResultProjection =
	| {
			ok: true;
			mutationId: string;
			event: PlanningCalendarEventProjection | null;
			warning: PlanningCalendarConflictProjection | null;
	  }
	| {
			ok: false;
			mutationId: string;
			conflict: PlanningCalendarConflictProjection;
	  };

export type PlanningCalendarBatchResultProjection =
	| {
			ok: true;
			batchId: string;
			events: PlanningCalendarEventProjection[];
			warnings: PlanningCalendarConflictProjection[];
	  }
	| {
			ok: false;
			batchId: string;
			conflicts: PlanningCalendarConflictProjection[];
	  };
