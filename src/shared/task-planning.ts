/** Renderer-safe contract for the short-lived task-planning Agent session. */
export type TaskPlanningQuestionKey =
	| "task_type"
	| "brief_extraction_confirmation"
	| "expected_outcome"
	| "deadline"
	| "current_progress"
	| "scope"
	| "capacity"
	| "constraints"
	| "skill_context"
	| "risks";

export interface TaskPlanningInput {
	goal: string;
	planType: "short-term" | "long-term";
	deadline: string;
	priority: "low" | "medium" | "high";
	weeklyCapacityHours: number;
	unavailableDays: readonly string[];
	preferredSessionMinutes: 30 | 45 | 60 | 90;
	preferredDayPart: "morning" | "afternoon" | "evening" | "flexible";
	timeZone: string;
}

export interface TaskPlanningAnswer {
	questionKey: TaskPlanningQuestionKey;
	answerText: string;
}

export interface TaskPlanningQuestion {
	key: TaskPlanningQuestionKey;
	text: string;
	required: boolean;
}

export interface TaskPlanningDraft {
	id: string;
	title: string;
	assumptions: readonly string[];
	milestones: readonly {
		id: string;
		title: string;
		description: string;
		targetDate?: string;
		acceptanceCriteria: readonly string[];
	}[];
	tasks: readonly {
		id: string;
		milestoneId: string;
		title: string;
		description: string;
		estimatedMinutes: number;
		importance: "low" | "medium" | "high";
		dependencies: readonly string[];
		completionCriteria: readonly string[];
	}[];
}

export type TaskPlanningSession =
	| {
			id: string;
			status: "clarifying";
			questions: readonly TaskPlanningQuestion[];
	  }
	| { id: string; status: "draft"; draft: TaskPlanningDraft };

export type TaskPlanningRpcResult<T> =
	| { kind: "success"; data: T }
	| { kind: "unavailable" | "offline" | "error"; message: string };
