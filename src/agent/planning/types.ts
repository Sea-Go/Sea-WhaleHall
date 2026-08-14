export const PLAN_TYPES = ["short-term", "long-term", "fuzzy"] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

export const PLAN_STATUSES = [
	"draft",
	"awaiting-confirmation",
	"active",
	"paused",
	"completed",
	"archived",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_TASK_STATUSES = ["pending", "completed", "skipped"] as const;
export type PlanTaskStatus = (typeof PLAN_TASK_STATUSES)[number];

export const PLAN_TASK_PURPOSES = [
	"execution",
	"validation",
	"review",
] as const;
export type PlanTaskPurpose = (typeof PLAN_TASK_PURPOSES)[number];

export type PlanAnalysisState = "awaiting-analysis" | "awaiting-user" | "ready";

/** The product create form deliberately has no plan-level date fields. */
export interface PlanCreateInput {
	goal: string;
	startToday: boolean;
}

export interface PlanEstimate {
	id: string;
	estimatedCompletionDate: string;
	confidence: number;
	assessedAt: string;
	evidenceThrough: string;
	basis: string;
	modelVersion: string;
}

export interface PlanConversationMessage {
	id: string;
	planId: string;
	role: "user" | "assistant";
	content: string;
	createdAt: string;
	causedByOperationId: string;
}

export interface PlanTask {
	id: string;
	planId: string;
	sourceKey: string;
	purpose: PlanTaskPurpose;
	title: string;
	description: string;
	estimatedMinutes: number;
	dependencyTaskIds: readonly string[];
	status: PlanTaskStatus;
	statusChangedAt: string | null;
	statusChangedBy: "user" | null;
}

export interface RevisionTask {
	taskId: string;
	sourceKey: string;
	purpose: PlanTaskPurpose;
	title: string;
	description: string;
	estimatedMinutes: number;
	dependencyTaskIds: readonly string[];
}

export interface SchedulingWindowPreference {
	/** ISO weekday where Monday is 1 and Sunday is 7. */
	dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7;
	startTime: string;
	endTime: string;
}

export interface SchedulingPreferences {
	weeklyCapacityMinutes: number;
	sessionMinutes: number;
	availableWindows: readonly SchedulingWindowPreference[];
}

export interface PlanScheduleItem {
	id: string;
	planId: string;
	taskId: string;
	title: string;
	start: string;
	end: string;
	timeZone: string;
}

export interface PlanRevision {
	id: string;
	planId: string;
	number: number;
	parentRevisionId: string | null;
	trigger:
		| "initial-analysis"
		| "conversation"
		| "confirmation"
		| "task-status"
		| "observation"
		| "calendar-change"
		| "daily-summary"
		| "resume";
	goal: string;
	type: PlanType;
	rationaleSummary: string;
	assumptions: readonly string[];
	estimateId: string;
	schedulingPreferences: SchedulingPreferences;
	tasks: readonly RevisionTask[];
	scheduleWindow: {
		startDate: string;
		endDateExclusive: string;
	};
	schedule: readonly PlanScheduleItem[];
	unscheduledTaskIds: readonly string[];
	createdAt: string;
}

export type PlanningCalendarEventKind =
	| "plan"
	| "manual-block"
	| "external"
	| "break";

export interface PlanningCalendarEvent {
	id: string;
	title: string;
	kind: PlanningCalendarEventKind;
	state: "proposed" | "committed";
	start: string;
	end: string;
	timeZone: string;
	planId: string | null;
	sourceTaskId: string | null;
	scheduleOrigin: "model" | "user";
	userLocked: boolean;
	version: number;
}

export interface CalendarEventMutation {
	kind: "create" | "update" | "delete";
	eventId: string;
	expectedVersion: number | null;
	before: PlanningCalendarEvent | null;
	after: PlanningCalendarEvent | null;
}

export interface CalendarChangeSet {
	id: string;
	planId: string;
	operationId: string;
	createdAt: string;
	changes: readonly CalendarEventMutation[];
}

export type PlanAdjustmentStatus = "pending" | "applied" | "failed" | "undone";

export interface PlanAdjustment {
	id: string;
	planId: string;
	operationId: string;
	trigger: PlanRevision["trigger"];
	previousRevisionId: string | null;
	nextRevisionId: string;
	calendarChangeSet: CalendarChangeSet;
	status: PlanAdjustmentStatus;
	createdAt: string;
	finishedAt: string | null;
	failureCode: string | null;
	summary: {
		created: number;
		moved: number;
		cancelled: number;
	};
}

export type ObservationCoverage = "complete" | "partial" | "missing";

export interface ObservationCandidateAttribution {
	planId: string;
	taskId: string;
	confidence: number;
}

/**
 * This is a content-free projection from Timeline v2. Raw activity content is
 * intentionally not part of the planning boundary.
 */
export interface PlanningObservationSummary {
	id: string;
	startedAt: string;
	endedAt: string;
	relevantMinutes: number;
	coverage: ObservationCoverage;
	authorized: boolean;
	candidates: readonly ObservationCandidateAttribution[];
}

export interface PlanObservationEvidence {
	id: string;
	observationId: string;
	planId: string;
	taskId: string;
	startedAt: string;
	endedAt: string;
	relevantMinutes: number;
	confidence: number;
	attribution: "unique-observed" | "user-confirmed";
	recordedAt: string;
}

export interface PendingObservationAttribution {
	observation: PlanningObservationSummary;
	status: "awaiting-user" | "ignored-low-confidence" | "ignored-unavailable";
	recordedAt: string;
}

export interface PlanningAnalysisDiagnostic {
	source: "planning-model";
	code:
		| "model-unavailable"
		| "request-timeout"
		| "invalid-output"
		| "unexpected-failure";
	retryable: boolean;
	recordedAt: string;
}

export interface PendingPlanningAnalysis {
	trigger: Exclude<PlanRevision["trigger"], "confirmation">;
	automatic: boolean;
	useActiveBaseline: boolean;
}

export interface PlanningPlan {
	id: string;
	goal: string;
	requestedStartToday: boolean;
	timeZone: string;
	effectiveStartDate: string | null;
	type: PlanType | null;
	status: PlanStatus;
	analysisState: PlanAnalysisState;
	analysisDiagnostic: PlanningAnalysisDiagnostic | null;
	pendingAnalysis: PendingPlanningAnalysis | null;
	autoAdjustAuthorized: boolean;
	version: number;
	createdAt: string;
	updatedAt: string;
	activeRevisionId: string | null;
	proposedRevisionId: string | null;
	revisions: readonly PlanRevision[];
	estimates: readonly PlanEstimate[];
	tasks: readonly PlanTask[];
	messages: readonly PlanConversationMessage[];
	observationEvidence: readonly PlanObservationEvidence[];
	pendingObservationAttributions: readonly PendingObservationAttribution[];
	adjustments: readonly PlanAdjustment[];
	dailySummaryDates: readonly string[];
}

export interface PlanningMutationContext {
	operationId: string;
	expectedVersion: number;
}

export interface CreatePlanDraftRequest {
	input: PlanCreateInput;
	operationId: string;
}

export interface SendPlanMessageRequest extends PlanningMutationContext {
	planId: string;
	content: string;
}

export interface RetryPlanAnalysisRequest extends PlanningMutationContext {
	planId: string;
}

export interface ConfirmPlanRevisionRequest extends PlanningMutationContext {
	planId: string;
	revisionId: string;
}

export interface SetTaskStatusRequest extends PlanningMutationContext {
	planId: string;
	taskId: string;
	status: PlanTaskStatus;
}

export interface ConfirmObservationAttributionRequest
	extends PlanningMutationContext {
	planId: string;
	observationId: string;
	taskId: string | null;
}

export interface ChangePlanStatusRequest extends PlanningMutationContext {
	planId: string;
}

export interface UndoPlanAdjustmentRequest extends PlanningMutationContext {
	planId: string;
	adjustmentId: string;
	adjustmentVersion: number;
}

export interface ConsumeObservationsRequest extends PlanningMutationContext {
	planId: string;
	from: string;
	to: string;
}

export interface DailyPlanningSummaryRequest extends PlanningMutationContext {
	planId: string;
	localDate: string;
}
