import type { ActiveGoalContextV1 } from "./goal-context";

export const PLANNING_AUTHORITY_SCHEMA_VERSION = "planning-authority.v1" as const;

export type PlanningAuthorityWeekday =
	| "monday"
	| "tuesday"
	| "wednesday"
	| "thursday"
	| "friday"
	| "saturday"
	| "sunday";

export interface PlanningAuthorityInput {
	goal: string;
	type: "short-term" | "long-term";
	deadline: string;
	priority: "low" | "medium" | "high";
	weeklyCapacityHours: number;
	unavailableDays: readonly PlanningAuthorityWeekday[];
	preferredSessionMinutes: 30 | 45 | 60 | 90;
	preferredDayPart: "morning" | "afternoon" | "evening" | "flexible";
}

export interface PlanningAuthorityBusyWindow {
	id: string;
	title: string;
	kind: "manual-block" | "external" | "committed-plan";
	start: string;
	end: string;
	timeZone: string;
}

export interface PlanningAuthorityConflict {
	proposalId: string | null;
	busyWindowId: string | null;
	reason:
		| "manual-block"
		| "external-event"
		| "committed-plan"
		| "insufficient-capacity"
		| "invalid-duration"
		| "agent-validation";
	severity: "warning" | "error";
	message: string;
	suggestions: readonly (
		| "adjust-deadline"
		| "reduce-scope"
		| "increase-capacity"
		| "move-session"
	)[];
}

export interface PlanningAuthorityPlan {
	id: string;
	type: "short-term" | "long-term";
	title: string;
	goal: string;
	deadline: string;
	priority: "low" | "medium" | "high";
	weeklyCapacityHours: number;
	calendarRevision?: number;
	totalEstimatedMinutes: number;
	phases: readonly {
		id: string;
		title: string;
		objective: string;
		order: number;
	}[];
	milestones: readonly {
		id: string;
		phaseId: string;
		title: string;
		targetDate: string;
	}[];
	tasks: readonly {
		id: string;
		phaseId: string;
		milestoneId: string | null;
		title: string;
		estimatedMinutes: number;
	}[];
	scheduleWindow: {
		startDate: string;
		endDateExclusive: string;
	};
	generationRun: {
		id: string;
		startedAt: string;
		completedAt: string;
		statuses: readonly (
			| "understood"
			| "split-phases"
			| "checking-calendar"
			| "arranging"
			| "ready"
		)[];
		revision: number;
	};
}

export interface PlanningAuthorityProposal {
	id: string;
	sourcePlanId: string;
	taskId: string;
	title: string;
	state: "proposed";
	start: string;
	end: string;
	timeZone: string;
	version: number;
}

export interface PlanningAuthorityDraft {
	plan: PlanningAuthorityPlan;
	proposals: readonly PlanningAuthorityProposal[];
	busyWindows: readonly PlanningAuthorityBusyWindow[];
	conflicts: readonly PlanningAuthorityConflict[];
	suggestions: readonly string[];
}

export interface PlanningAuthorityCommit {
	commitId: string;
	/** Revision of the draft that this durable commit/outbox record consumed. */
	draftRevision: number;
	/** SHA-256 over the exact saved input and draft consumed by this commit. */
	draftDigest: string;
	calendarRevision: number;
	committedAtMs: number;
	committedCount: number;
	warnings: readonly PlanningAuthorityConflict[];
	effect: {
		status: "pending" | "applied";
		attempts: number;
		lastAttemptAtMs: number | null;
		lastError: string | null;
	};
}

/**
 * Renderer-safe projection of the encrypted Bun-owned planning aggregate.
 * The complete object is encrypted at rest; only revision/status/timestamps and
 * opaque commit IDs are duplicated as SQLite coordination columns.
 */
export interface PlanningAuthoritySnapshot {
	schemaVersion: typeof PLANNING_AUTHORITY_SCHEMA_VERSION;
	revision: number;
	status: "draft" | "committed";
	input: PlanningAuthorityInput;
	draft: PlanningAuthorityDraft;
	confirmedPlan: PlanningAuthorityPlan | null;
	activeGoal: ActiveGoalContextV1 | null;
	commit: PlanningAuthorityCommit | null;
	updatedAtMs: number;
}

export interface SavePlanningDraftRequest {
	requestId: string;
	expectedRevision: number | null;
	input: PlanningAuthorityInput;
	draft: PlanningAuthorityDraft;
}

export interface CommitPlanningDraftRequest {
	requestId: string;
	commitId: string;
	expectedRevision: number;
	expectedCalendarRevision: number;
}

export type PlanningAuthorityRpcResult<T> =
	| { kind: "success"; data: T }
	| { kind: "conflict"; message: string; currentRevision: number }
	| { kind: "not-found"; message: string }
	| { kind: "unavailable" | "error"; message: string; retryable: boolean };

export interface PlanningCommitResult {
	snapshot: PlanningAuthoritySnapshot;
	calendarCommitted: true;
	idempotent: boolean;
	effectsApplied: boolean;
}
