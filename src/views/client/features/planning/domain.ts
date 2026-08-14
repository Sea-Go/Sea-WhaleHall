import { Temporal } from "temporal-polyfill";

/** Stable product vocabulary shared by the planning page and its service port. */
export type PlanType = "short-term" | "long-term" | "fuzzy";
export type PlanStatus =
	| "draft"
	| "awaiting-confirmation"
	| "active"
	| "paused"
	| "completed"
	| "archived";
export type PlanTaskStatus = "pending" | "completed" | "skipped";
export type PlanTaskPurpose = "execution" | "validation" | "review";
export type PlanEstimateConfidence = "high" | "medium" | "low";

export interface PlanCreateInput {
	goal: string;
	startToday: boolean;
}

export interface PlanEstimate {
	estimatedCompletionDate: string | null;
	confidence: PlanEstimateConfidence;
	assessedAt: string;
	evidenceThrough: string | null;
	basis: string;
	modelVersion: string;
}

export interface PlanningTaskSchedule {
	eventId: string;
	date: string;
	start: string;
	end: string;
	timeZone: string;
	scheduleOrigin: "model" | "user";
	userLocked: boolean;
	version: number;
}

export interface PlanningUnplannedReason {
	kind:
		| "capacity"
		| "conflict"
		| "dependency"
		| "model-pending"
		| "other";
	message: string;
}

export interface PlanningTaskView {
	id: string;
	title: string;
	description: string | null;
	purpose: PlanTaskPurpose;
	status: PlanTaskStatus;
	estimatedMinutes: number;
	dependencyIds: readonly string[];
	schedules: readonly PlanningTaskSchedule[];
	unplanned: PlanningUnplannedReason | null;
}

export interface PlanScheduleWindow {
	startDate: string;
	endDateInclusive: string;
	timeZone: string;
}

export interface PlanningSchedulingPreferencesView {
	weeklyCapacityMinutes: number;
	sessionMinutes: number;
	availableWindows: readonly {
		dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7;
		startTime: string;
		endTime: string;
	}[];
}

export interface PlanRevisionView {
	revisionId: string;
	version: number;
	status: "proposed" | "confirmed" | "superseded";
	createdAt: string;
	goal: string;
	summary: string;
	reasoningSummary: string;
	planType: PlanType;
	estimate: PlanEstimate;
	schedulingPreferences: PlanningSchedulingPreferencesView;
	scheduleWindow: PlanScheduleWindow;
	assumptions: readonly string[];
	questions: readonly string[];
	tasks: readonly PlanningTaskView[];
}

export interface PlanningMessageView {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	createdAt: string;
	status: "complete" | "pending-analysis" | "failed";
	revisionId: string | null;
}

export interface PlanningMonitoringView {
	authorized: boolean;
	enabled: boolean;
	mode: "observed" | "manual-only";
	coverage: "complete" | "partial" | "unavailable";
	message: string;
}

export interface PlanningObservationView {
	id: string;
	occurredAt: string;
	durationMinutes: number;
	summary: string;
	confidence: PlanEstimateConfidence;
	candidateTaskIds: readonly string[];
	version: number;
}

export interface PlanAdjustmentView {
	id: string;
	createdAt: string;
	trigger:
		| "task-status"
		| "observation"
		| "calendar"
		| "daily-rollover"
		| "user-request";
	summary: string;
	previousEstimatedCompletionDate: string | null;
	nextEstimatedCompletionDate: string | null;
	movedCount: number;
	addedCount: number;
	cancelledCount: number;
	canUndo: boolean;
	undoUnavailableReason: string | null;
	undoneAt: string | null;
	version: number;
}

export interface PlanningNotificationView {
	id: string;
	kind: "analysis-ready" | "schedule-adjusted" | "attention-required";
	message: string;
	createdAt: string;
}

export interface PlanSummaryView {
	id: string;
	title: string;
	goal: string;
	status: PlanStatus;
	type: PlanType | null;
	version: number;
	estimatedCompletionDate: string | null;
	confidence: PlanEstimateConfidence | null;
	updatedAt: string;
}

export interface PlanView {
	id: string;
	title: string;
	goal: string;
	status: PlanStatus;
	type: PlanType | null;
	version: number;
	timeZone: string;
	startToday: boolean;
	effectiveDate: string | null;
	estimate: PlanEstimate | null;
	revision: PlanRevisionView | null;
	messages: readonly PlanningMessageView[];
	tasks: readonly PlanningTaskView[];
	monitoring: PlanningMonitoringView;
	pendingObservations: readonly PlanningObservationView[];
	adjustments: readonly PlanAdjustmentView[];
	notifications: readonly PlanningNotificationView[];
	updatedAt: string;
}

export interface PlanCreateIssue {
	field: "goal";
	message: string;
}

export const MAX_PLAN_GOAL_LENGTH = 1_000;

export function emptyPlanCreateInput(): PlanCreateInput {
	return { goal: "", startToday: false };
}

export function validatePlanCreateInput(
	input: PlanCreateInput,
): readonly PlanCreateIssue[] {
	const goal = input.goal.trim();
	if (Array.from(goal).length < 4) {
		return [{ field: "goal", message: "请用至少 4 个字描述想完成的目标。" }];
	}
	if (Array.from(goal).length > MAX_PLAN_GOAL_LENGTH) {
		return [
			{
				field: "goal",
				message: `目标描述不能超过 ${MAX_PLAN_GOAL_LENGTH} 个字符。`,
			},
		];
	}
	return [];
}

export function planTaskProgress(tasks: readonly PlanningTaskView[]): {
	completed: number;
	total: number;
} {
	return {
		completed: tasks.filter((task) => task.status === "completed").length,
		total: tasks.length,
	};
}

export function isPlanRevisionConfirmable(plan: PlanView): boolean {
	return (
		(plan.status === "awaiting-confirmation" ||
			plan.status === "active" ||
			plan.status === "paused") &&
		plan.revision !== null &&
		plan.revision.status === "proposed" &&
		isSevenDayScheduleWindow(plan.revision.scheduleWindow) &&
		plan.messages.every((message) => message.status === "complete")
	);
}

export function isSevenDayScheduleWindow(window: PlanScheduleWindow): boolean {
	try {
		return (
			Temporal.PlainDate.from(window.startDate).until(
				Temporal.PlainDate.from(window.endDateInclusive),
				{ largestUnit: "day" },
			).days === 6
		);
	} catch {
		return false;
	}
}

/*
 * Compatibility schedule types remain feature-internal while the calendar
 * preview adapter is removed from app composition. New planning UI and service
 * implementations must use PlanView/PlanningTaskView above.
 */
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
	/** Authoritative local calendar revision used by the generated schedule. */
	calendarRevision?: number;
	totalEstimatedMinutes: number;
	phases: readonly PlanPhase[];
	milestones: readonly Milestone[];
	tasks: readonly PlanTask[];
	scheduleWindow: { startDate: string; endDateExclusive: string };
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
	| "invalid-duration"
	| "agent-validation";

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
	const createIssues = validatePlanCreateInput({
		goal: input.goal,
		startToday: false,
	});
	issues.push(...createIssues);
	if (!input.type) {
		issues.push({ field: "type", message: "请选择计划类型。" });
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
