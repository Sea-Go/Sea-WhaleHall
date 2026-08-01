import { Temporal } from "temporal-polyfill";
import {
	detectPlanningConflicts,
	type GeneratedPlanDraft,
	type Plan,
	type PlanInput,
	type PlanningBusyWindow,
	type Weekday,
} from "../../features/planning/domain";
import type {
	PlanningGenerationContext,
	PlanningGenerationResult,
	PlanningGenerationService,
} from "../../features/planning/planning-service";
import type {
	TaskPlanningAnswer,
	TaskPlanningInput,
	TaskPlanningRpcResult,
	TaskPlanningSession,
} from "../../../../shared/task-planning";

const weekdayByNumber: Record<number, Weekday> = {
	1: "monday", 2: "tuesday", 3: "wednesday", 4: "thursday",
	5: "friday", 6: "saturday", 7: "sunday",
};

/** Maps Agent output into the existing plan review and calendar-confirmation flow. */
export class AgentPlanningGenerationService implements PlanningGenerationService {
	constructor(private readonly userId: string) {}

	async generate(input: PlanInput, availability: readonly PlanningBusyWindow[], context: PlanningGenerationContext): Promise<PlanningGenerationResult> {
		this.notifyStart(context);
		const { clientApi } = await import("../../rpc");
		const result = await clientApi.createTaskPlanningSession(this.userId, toAgentInput(input, context.timeZone));
		return this.resolve(result, input, availability, context);
	}

	async continueAfterClarification(input: PlanInput, sessionId: string, answers: readonly TaskPlanningAnswer[], availability: readonly PlanningBusyWindow[], context: PlanningGenerationContext): Promise<PlanningGenerationResult> {
		this.notifyStart(context);
		const { clientApi } = await import("../../rpc");
		const result = await clientApi.submitTaskPlanningAnswers(this.userId, sessionId, answers);
		return this.resolve(result, input, availability, context);
	}

	private notifyStart(context: PlanningGenerationContext): void {
		context.onStatus("understood");
		if (context.isCancelled()) throw new Error("已取消计划生成。");
	}

	private resolve(
		result: TaskPlanningRpcResult<TaskPlanningSession>,
		input: PlanInput,
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): PlanningGenerationResult {
		if (result.kind !== "success") throw new Error(result.message);
		if (context.isCancelled()) throw new Error("已取消计划生成。");
		if (result.data.status === "clarifying") return { kind: "clarification", sessionId: result.data.id, questions: result.data.questions };
		context.onStatus("split-phases");
		context.onStatus("checking-calendar");
		const draft = toGeneratedDraft(result.data, input, availability, context);
		context.onStatus("arranging");
		context.onStatus("ready");
		return { kind: "draft", draft };
	}
}

function toAgentInput(input: PlanInput, timeZone: string): TaskPlanningInput {
	if (!input.type) throw new Error("生成计划前必须选择计划类型。");
	return { goal: input.goal, planType: input.type, deadline: input.deadline, priority: input.priority, weeklyCapacityHours: input.weeklyCapacityHours, unavailableDays: input.unavailableDays, preferredSessionMinutes: input.preferredSessionMinutes, preferredDayPart: input.preferredDayPart, timeZone };
}

function toGeneratedDraft(session: Extract<TaskPlanningSession, { status: "draft" }>, input: PlanInput, busyWindows: readonly PlanningBusyWindow[], context: PlanningGenerationContext): GeneratedPlanDraft {
	const agentDraft = session.draft;
	if (!input.type) throw new Error("生成计划前必须选择计划类型。");
	const planId = agentDraft.id;
	const phases = agentDraft.milestones.map((milestone, index) => ({ id: `${planId}-phase-${index + 1}`, title: milestone.title, objective: milestone.description, order: index + 1 }));
	const phaseByMilestone = new Map(agentDraft.milestones.map((milestone, index) => [milestone.id, phases[index]!.id]));
	const plan: Plan = {
		id: planId, type: input.type, title: agentDraft.title, goal: input.goal.trim(), deadline: input.deadline, priority: input.priority,
		weeklyCapacityHours: input.weeklyCapacityHours,
		totalEstimatedMinutes: agentDraft.tasks.reduce((total, task) => total + task.estimatedMinutes, 0),
		phases,
		milestones: agentDraft.milestones.map((milestone, index) => ({ id: milestone.id, phaseId: phases[index]!.id, title: milestone.title, targetDate: validDate(milestone.targetDate) ? milestone.targetDate : input.deadline })),
		tasks: agentDraft.tasks.map((task) => ({ id: task.id, phaseId: phaseByMilestone.get(task.milestoneId) ?? phases[0]?.id ?? `${planId}-phase-unassigned`, milestoneId: task.milestoneId, title: task.title, estimatedMinutes: Math.max(15, task.estimatedMinutes) })),
		scheduleWindow: { startDate: context.today, endDateExclusive: Temporal.PlainDate.from(input.deadline).add({ days: 1 }).toString() },
		generationRun: { id: `agent-${session.id}`, startedAt: Temporal.Now.instant().toString(), completedAt: Temporal.Now.instant().toString(), statuses: ["understood", "split-phases", "checking-calendar", "arranging", "ready"], revision: context.revision },
	};
	const proposals = buildProposals(plan, input, context);
	const conflicts = detectPlanningConflicts(proposals, busyWindows);
	return { plan, proposals, busyWindows, conflicts, suggestions: conflicts.length > 0 ? ["可在下一步调整与日历冲突的时段。"] : [] };
}

function buildProposals(plan: Plan, input: PlanInput, context: PlanningGenerationContext): GeneratedPlanDraft["proposals"] {
	const hour = input.preferredDayPart === "morning" ? 9 : input.preferredDayPart === "afternoon" ? 14 : input.preferredDayPart === "evening" ? 19 : 14;
	const dates: string[] = [];
	let cursor = Temporal.PlainDate.from(context.today);
	const end = Temporal.PlainDate.from(plan.scheduleWindow.endDateExclusive);
	while (Temporal.PlainDate.compare(cursor, end) < 0 && dates.length < plan.tasks.length) {
		const weekday = weekdayByNumber[cursor.dayOfWeek];
		if (weekday && !input.unavailableDays.includes(weekday)) dates.push(cursor.toString());
		cursor = cursor.add({ days: 1 });
	}
	const limit = Math.min(plan.tasks.length, Math.max(1, Math.floor(input.weeklyCapacityHours * 60 / input.preferredSessionMinutes)));
	return dates.slice(0, limit).map((date, index) => {
		const task = plan.tasks[index]!;
		const start = Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: context.timeZone, plainTime: Temporal.PlainTime.from({ hour }) }).toInstant().toString();
		return { id: `${plan.id}-proposal-${index + 1}`, sourcePlanId: plan.id, taskId: task.id, title: task.title, state: "proposed" as const, start, end: Temporal.Instant.from(start).add({ minutes: task.estimatedMinutes }).toString(), timeZone: context.timeZone, version: 0 };
	});
}

function validDate(value: string | undefined): value is string {
	if (!value) return false;
	try { Temporal.PlainDate.from(value); return true; } catch { return false; }
}
