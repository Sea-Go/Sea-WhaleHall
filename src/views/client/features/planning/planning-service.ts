import type {
	GeneratedPlanDraft,
	GenerationStatus,
	Plan,
	PlanInput,
	PlanningBusyWindow,
	PlanningConflict,
	ProposedScheduleItem,
} from "./domain";

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

export interface PlanningGenerationService {
	generate(
		input: PlanInput,
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<GeneratedPlanDraft>;
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
	  }
	| {
			ok: false;
			kind: "failure";
			applyId: string;
			committedCount: 0;
			failedProposalIds: readonly string[];
			message: string;
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
