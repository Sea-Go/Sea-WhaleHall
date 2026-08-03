import type {
	GeneratedPlanDraft,
	GenerationStatus,
	Plan,
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
