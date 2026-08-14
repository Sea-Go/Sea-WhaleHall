import type {
	GeneratedPlanDraft,
	GenerationStatus,
	Plan,
	PlanCreateInput,
	PlanSummaryView,
	PlanTaskStatus,
	PlanView,
	PlanInput,
	PlanningBusyWindow,
	PlanningConflict,
	ProposedScheduleItem,
} from "./domain";
import type {
	TaskPlanningAnswer,
	TaskPlanningQuestion,
} from "../../../../shared/task-planning";
import type {
	PlanningAuthoritySnapshot,
	PlanningCommitResult,
} from "../../../../shared/planning-authority";

export type PlanningServiceErrorCode =
	| "model-unavailable"
	| "stale-version"
	| "offline"
	| "conflict"
	| "validation"
	| "not-found"
	| "unknown";

export class PlanningServiceError extends Error {
	readonly code: PlanningServiceErrorCode;
	readonly retryable: boolean;

	constructor(
		code: PlanningServiceErrorCode,
		message: string,
		options: { retryable?: boolean; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "PlanningServiceError";
		this.code = code;
		this.retryable = options.retryable ?? code !== "validation";
	}
}

export type PlanningServiceEvent =
	| { kind: "planChanged"; planId: string }
	| { kind: "calendarChanged"; planId: string | null }
	| { kind: "notificationChanged"; planId: string | null };

export interface PlanningWriteContext {
	operationId: string;
	expectedVersion: number;
}

export interface CreatePlanDraftRequest {
	input: PlanCreateInput;
	operationId: string;
}

export interface CreatePlanDraftResult {
	planId: string;
}

export interface SendPlanMessageRequest extends PlanningWriteContext {
	planId: string;
	content: string;
}

export interface ConfirmPlanRevisionRequest extends PlanningWriteContext {
	planId: string;
	revisionId: string;
}

export interface SetPlanTaskStatusRequest extends PlanningWriteContext {
	planId: string;
	taskId: string;
	status: PlanTaskStatus;
}

export interface ConfirmObservationAttributionRequest
	extends PlanningWriteContext {
	planId: string;
	observationId: string;
	taskId: string | null;
}

export interface ChangePlanStatusRequest extends PlanningWriteContext {
	planId: string;
}

export interface UndoPlanAdjustmentRequest extends PlanningWriteContext {
	planId: string;
	adjustmentId: string;
	adjustmentVersion: number;
}

/**
 * Renderer-facing port. Implementations validate transport/persistence DTOs and
 * expose only stable view models to the planning controller.
 */
export interface PlanningService {
	subscribe(listener: (event: PlanningServiceEvent) => void): () => void;
	listPlans(): Promise<readonly PlanSummaryView[]>;
	getPlan(planId: string): Promise<PlanView>;
	createPlanDraft(
		request: CreatePlanDraftRequest,
	): Promise<CreatePlanDraftResult>;
	sendPlanMessage(request: SendPlanMessageRequest): Promise<void>;
	confirmPlanRevision(request: ConfirmPlanRevisionRequest): Promise<void>;
	setTaskStatus(request: SetPlanTaskStatusRequest): Promise<void>;
	confirmObservationAttribution(
		request: ConfirmObservationAttributionRequest,
	): Promise<void>;
	pausePlan(request: ChangePlanStatusRequest): Promise<void>;
	resumePlan(request: ChangePlanStatusRequest): Promise<void>;
	completePlan(request: ChangePlanStatusRequest): Promise<void>;
	archivePlan(request: ChangePlanStatusRequest): Promise<void>;
	undoPlanAdjustment(request: UndoPlanAdjustmentRequest): Promise<void>;
	retryPendingAnalysis(request: ChangePlanStatusRequest): Promise<void>;
}

/* Legacy generation contracts retained until old QA adapters are removed. */
export interface PlanningAvailabilityRequest {
	startDate: string;
	endDateExclusive: string;
	timeZone: string;
}

export interface PlanningGenerationContext {
	today: string;
	timeZone: string;
	revision: number;
	onStatus: (status: GenerationStatus) => void;
	isCancelled: () => boolean;
}

export type PlanningGenerationResult =
	| { kind: "draft"; draft: GeneratedPlanDraft }
	| {
			kind: "clarification";
			sessionId: string;
			questions: readonly TaskPlanningQuestion[];
	  };

export interface RestorablePlanningGeneration {
	runId: string;
	input: PlanInput;
}
export interface PlanningGenerationService {
	findRestorable?(): Promise<RestorablePlanningGeneration | null>;
	restore?(
		run: RestorablePlanningGeneration,
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<PlanningGenerationResult>;
	generate(
		input: PlanInput,
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<PlanningGenerationResult>;
	continueAfterClarification(
		input: PlanInput,
		sessionId: string,
		answers: readonly TaskPlanningAnswer[],
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<PlanningGenerationResult>;
	cancel?(): Promise<void> | void;
}

export type PlanApplyResult =
	| {
			ok: true;
			kind: "success";
			applyId: string;
			committedCount: number;
			warnings: readonly PlanningConflict[];
	  }
	| {
			ok: false;
			kind: "partial";
			applyId: string;
			committedCount: number;
			failedProposalIds: readonly string[];
			message: string;
			calendarState?: "changed" | "unknown";
	  }
	| {
			ok: false;
			kind: "failure";
			applyId: string;
			committedCount: 0;
			failedProposalIds: readonly string[];
			message: string;
			calendarState?: "unchanged" | "unknown";
	  };

export interface PlanningCalendarGateway {
	loadAvailability(
		request: PlanningAvailabilityRequest,
	): Promise<readonly PlanningBusyWindow[]>;
	applyPlan(
		plan: Plan,
		proposals: readonly ProposedScheduleItem[],
		applyId: string,
	): Promise<PlanApplyResult>;
}

/** Bun-owned encrypted authority used by the real desktop planning flow. */
export interface PlanningAuthorityGateway {
	load(): Promise<PlanningAuthoritySnapshot | null>;
	saveDraft(
		input: PlanInput,
		draft: GeneratedPlanDraft,
		expectedRevision: number | null,
	): Promise<PlanningAuthoritySnapshot>;
	commitDraft(
		commitId: string,
		expectedRevision: number,
		expectedCalendarRevision: number,
	): Promise<PlanningCommitResult>;
}
