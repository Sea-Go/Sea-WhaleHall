import { Temporal } from "temporal-polyfill";
import { MAX_ACTIVE_GOAL_TEXT_LENGTH } from "../../../../shared/goal-context";

export type PlanType = "short-term" | "long-term";
export type PlanPriority = "low" | "medium" | "high";
export type PreferredDayPart =
	| "morning"
	| "afternoon"
	| "evening"
	| "flexible";
export type Weekday =
	| "monday"
	| "tuesday"
	| "wednesday"
	| "thursday"
	| "friday"
	| "saturday"
	| "sunday";

export interface PlanInput {
	goal: string;
	type: PlanType | null;
	deadline: string;
	priority: PlanPriority;
	weeklyCapacityHours: number;
	unavailableDays: readonly Weekday[];
	preferredSessionMinutes: 30 | 45 | 60 | 90;
	preferredDayPart: PreferredDayPart;
}

export type PlanInputField =
	| "goal"
	| "type"
	| "deadline"
	| "weeklyCapacityHours";

export interface PlanInputIssue {
	field: PlanInputField;
	message: string;
}

export interface PlanPhase {
	id: string;
	title: string;
	objective: string;
	order: number;
}

export interface Milestone {
	id: string;
	phaseId: string;
	title: string;
	targetDate: string;
}

export interface PlanTask {
	id: string;
	phaseId: string;
	milestoneId: string | null;
	title: string;
	estimatedMinutes: number;
}

export type GenerationStatus =
	| "understood"
	| "split-phases"
	| "checking-calendar"
	| "arranging"
	| "ready";

export interface GenerationRun {
	id: string;
	startedAt: string;
	completedAt: string;
	statuses: readonly GenerationStatus[];
	revision: number;
}

export interface ProposedScheduleItem {
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

export interface Plan {
	id: string;
	type: PlanType;
	title: string;
	goal: string;
	deadline: string;
	priority: PlanPriority;
	weeklyCapacityHours: number;
	totalEstimatedMinutes: number;
	phases: readonly PlanPhase[];
	milestones: readonly Milestone[];
	tasks: readonly PlanTask[];
	scheduleWindow: {
		startDate: string;
		endDateExclusive: string;
	};
	generationRun: GenerationRun;
}

export type PlanningBusyKind =
	| "manual-block"
	| "external"
	| "committed-plan";

export interface PlanningBusyWindow {
	id: string;
	title: string;
	kind: PlanningBusyKind;
	start: string;
	end: string;
	timeZone: string;
}

export type PlanningConflictReason =
	| "manual-block"
	| "external-event"
	| "committed-plan"
	| "insufficient-capacity"
	| "invalid-duration";

export interface PlanningConflict {
	proposalId: string | null;
	busyWindowId: string | null;
	reason: PlanningConflictReason;
	severity: "warning" | "error";
	message: string;
	suggestions: readonly (
		| "adjust-deadline"
		| "reduce-scope"
		| "increase-capacity"
		| "move-session"
	)[];
}

export interface GeneratedPlanDraft {
	plan: Plan;
	proposals: readonly ProposedScheduleItem[];
	busyWindows: readonly PlanningBusyWindow[];
	conflicts: readonly PlanningConflict[];
	suggestions: readonly string[];
}

export function emptyPlanInput(): PlanInput {
	return {
		goal: "",
		type: null,
		deadline: "",
		priority: "medium",
		weeklyCapacityHours: 5,
		unavailableDays: [],
		preferredSessionMinutes: 60,
		preferredDayPart: "evening",
	};
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function validatePlanInput(
	input: PlanInput,
	today: string,
): readonly PlanInputIssue[] {
	const issues: PlanInputIssue[] = [];
	if (input.goal.trim().length < 4) {
		issues.push({
			field: "goal",
			message: "再具体一点：请用至少 4 个字描述想完成的目标。",
		});
	} else if (Array.from(input.goal.trim()).length > MAX_ACTIVE_GOAL_TEXT_LENGTH) {
		issues.push({
			field: "goal",
			message: `目标描述不能超过 ${MAX_ACTIVE_GOAL_TEXT_LENGTH} 个字符。`,
		});
	}
	if (!input.type) {
		issues.push({ field: "type", message: "请选择长期计划或短期计划。" });
	}
	if (!isoDatePattern.test(input.deadline)) {
		issues.push({ field: "deadline", message: "请选择有效的截止日期。" });
	} else if (input.deadline < today) {
		issues.push({ field: "deadline", message: "截止日期不能早于今天。" });
	}
	if (
		!Number.isFinite(input.weeklyCapacityHours) ||
		input.weeklyCapacityHours < 1 ||
		input.weeklyCapacityHours > 40
	) {
		issues.push({
			field: "weeklyCapacityHours",
			message: "每周可投入时间应在 1–40 小时之间。",
		});
	}
	return issues;
}

export function assertValidProposal(item: ProposedScheduleItem): void {
	if (!item.id.trim() || !item.sourcePlanId.trim() || !item.taskId.trim()) {
		throw new Error("计划草案缺少稳定标识。");
	}
	if (!item.title.trim()) throw new Error("计划草案标题不能为空。");
	if (!item.timeZone.includes("/")) throw new Error("计划草案必须声明命名时区。");
	if (
		Temporal.Instant.compare(
			Temporal.Instant.from(item.start),
			Temporal.Instant.from(item.end),
		) >= 0
	) {
		throw new Error("计划草案结束时间必须晚于开始时间。");
	}
}

export function proposalsOverlap(
	left: Pick<ProposedScheduleItem, "start" | "end">,
	right: Pick<PlanningBusyWindow, "start" | "end">,
): boolean {
	return (
		Temporal.Instant.compare(
			Temporal.Instant.from(left.start),
			Temporal.Instant.from(right.end),
		) < 0 &&
		Temporal.Instant.compare(
			Temporal.Instant.from(right.start),
			Temporal.Instant.from(left.end),
		) < 0
	);
}

export function detectPlanningConflicts(
	proposals: readonly ProposedScheduleItem[],
	busyWindows: readonly PlanningBusyWindow[],
): readonly PlanningConflict[] {
	const conflicts: PlanningConflict[] = [];
	for (const proposal of proposals) {
		assertValidProposal(proposal);
		const minutes = Number(
			Temporal.Instant.from(proposal.start)
				.until(Temporal.Instant.from(proposal.end), {
					largestUnit: "minute",
				})
				.total({ unit: "minute" }),
		);
		if (minutes < 15) {
			conflicts.push({
				proposalId: proposal.id,
				busyWindowId: null,
				reason: "invalid-duration",
				severity: "error",
				message: `“${proposal.title}”至少需要 15 分钟。`,
				suggestions: ["move-session"],
			});
		}
		for (const busy of busyWindows.filter((item) =>
			proposalsOverlap(proposal, item),
		)) {
			const severity =
				busy.kind === "committed-plan" ? ("warning" as const) : ("error" as const);
			conflicts.push({
				proposalId: proposal.id,
				busyWindowId: busy.id,
				reason:
					busy.kind === "manual-block"
						? "manual-block"
						: busy.kind === "external"
							? "external-event"
							: "committed-plan",
				severity,
				message:
					severity === "warning"
						? `“${proposal.title}”与已确认计划“${busy.title}”重叠。`
						: `“${proposal.title}”与不可用时间“${busy.title}”冲突。`,
				suggestions: ["move-session"],
			});
		}
	}
	return conflicts;
}

export function planHasBlockingConflicts(
	conflicts: readonly PlanningConflict[],
): boolean {
	return conflicts.some((conflict) => conflict.severity === "error");
}

export function cloneGeneratedDraft(draft: GeneratedPlanDraft): GeneratedPlanDraft {
	return {
		plan: {
			...draft.plan,
			phases: draft.plan.phases.map((item) => ({ ...item })),
			milestones: draft.plan.milestones.map((item) => ({ ...item })),
			tasks: draft.plan.tasks.map((item) => ({ ...item })),
			scheduleWindow: { ...draft.plan.scheduleWindow },
			generationRun: {
				...draft.plan.generationRun,
				statuses: [...draft.plan.generationRun.statuses],
			},
		},
		proposals: draft.proposals.map((item) => ({ ...item })),
		busyWindows: draft.busyWindows.map((item) => ({ ...item })),
		conflicts: draft.conflicts.map((item) => ({
			...item,
			suggestions: [...item.suggestions],
		})),
		suggestions: [...draft.suggestions],
	};
}
