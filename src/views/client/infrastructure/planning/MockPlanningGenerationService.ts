import { Temporal } from "temporal-polyfill";
import {
	detectPlanningConflicts,
	type GenerationStatus,
	type Milestone,
	type Plan,
	type PlanInput,
	type PlanPhase,
	type PlanTask,
	type PlanningBusyWindow,
	type ProposedScheduleItem,
	type Weekday,
} from "../../features/planning/domain";
import type {
	PlanningGenerationContext,
	PlanningGenerationResult,
	PlanningGenerationService,
} from "../../features/planning/planning-service";
import type { TaskPlanningAnswer } from "../../../../shared/task-planning";

export interface MockPlanningGenerationServiceOptions {
	latencyMs?: number;
}

class GenerationCancelledError extends Error {
	constructor() {
		super("generation cancelled");
	}
}

const statuses: readonly GenerationStatus[] = [
	"understood",
	"split-phases",
	"checking-calendar",
	"arranging",
	"ready",
];

const weekdayByNumber: Record<number, Weekday> = {
	1: "monday",
	2: "tuesday",
	3: "wednesday",
	4: "thursday",
	5: "friday",
	6: "saturday",
	7: "sunday",
};

function localInstant(date: string, hour: number, timeZone: string): string {
	return Temporal.PlainDate.from(date)
		.toZonedDateTime({
			timeZone,
			plainTime: Temporal.PlainTime.from({ hour }),
		})
		.toInstant()
		.toString();
}

function shortGoal(goal: string): string {
	const normalized = goal.trim().replace(/[。！？!?]+$/u, "");
	return normalized.length > 22 ? `${normalized.slice(0, 22)}…` : normalized;
}

export class MockPlanningGenerationService
	implements PlanningGenerationService
{
	private readonly latencyMs: number;
	private nextFailure: string | null = null;
	private nextEmpty = false;

	constructor(options: MockPlanningGenerationServiceOptions = {}) {
		this.latencyMs = options.latencyMs ?? 150;
	}

	failNextGeneration(message = "计划生成服务暂时不可用，请重试。"): void {
		this.nextFailure = message;
	}

	returnEmptyNextGeneration(): void {
		this.nextEmpty = true;
	}

	async generate(
		input: PlanInput,
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<PlanningGenerationResult> {
		for (const status of statuses) {
			this.assertActive(context);
			context.onStatus(status);
			await this.wait();
		}
		this.assertActive(context);
		if (this.nextFailure) {
			const message = this.nextFailure;
			this.nextFailure = null;
			throw new Error(message);
		}

		const plan = this.buildPlan(input, context);
		if (this.nextEmpty || input.unavailableDays.length === 7) {
			this.nextEmpty = false;
			return {
				kind: "draft",
				draft: {
					plan,
					proposals: [],
					busyWindows: availability,
					conflicts: [],
					suggestions: [
						"延后截止日期，留出更多可安排日期",
						"缩小本轮目标范围",
						"增加每周可投入时间",
					],
				},
			};
		}

		const proposals = this.buildProposals(input, plan, context);
		const conflicts = detectPlanningConflicts(proposals, availability);
		return {
			kind: "draft",
			draft: {
				plan,
				proposals,
				busyWindows: availability,
				conflicts,
				suggestions:
					conflicts.length > 0
						? ["拖动冲突安排到空闲时段，或删除本轮不做的任务"]
						: [],
			},
		};
	}

	continueAfterClarification(
		input: PlanInput,
		_sessionId: string,
		_answers: readonly TaskPlanningAnswer[],
		availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<PlanningGenerationResult> {
		return this.generate(input, availability, context);
	}

	private buildPlan(input: PlanInput, context: PlanningGenerationContext): Plan {
		if (input.type === null) {
			throw new Error("生成计划前必须选择计划类型。");
		}
		const id = `plan-${context.revision}`;
		const goal = shortGoal(input.goal);
		const long = input.type === "long-term";
		const phases: PlanPhase[] = long
			? [
					{
						id: `${id}-phase-foundation`,
						title: "建立基础",
						objective: "明确完成标准并补齐关键准备。",
						order: 1,
					},
					{
						id: `${id}-phase-execution`,
						title: "集中推进",
						objective: "围绕核心成果持续产出与校正。",
						order: 2,
					},
					{
						id: `${id}-phase-finish`,
						title: "收尾验收",
						objective: "完成验证、整理与交付。",
						order: 3,
					},
				]
			: [
					{
						id: `${id}-phase-sprint`,
						title: "本轮推进",
						objective: "把目标拆成可以在近期完成的动作。",
						order: 1,
					},
				];
		const milestoneDates = long
			? [
					this.interpolateDate(context.today, input.deadline, 0.3),
					this.interpolateDate(context.today, input.deadline, 0.72),
					input.deadline,
				]
			: [input.deadline];
		const milestones: Milestone[] = phases.map((phase, index) => ({
			id: `${id}-milestone-${index + 1}`,
			phaseId: phase.id,
			title: long
				? ["基础方案确认", "核心成果成形", "目标完成"][index] ?? "目标完成"
				: `${goal}完成`,
			targetDate: milestoneDates[index] ?? input.deadline,
		}));
		const taskTitles = long
			? [
					"明确成果标准与边界",
					"整理资料与必要准备",
					"完成第一轮核心产出",
					"复盘反馈并集中迭代",
					"完成最终验证与整理",
					"交付成果并记录下一步",
				]
			: ["明确完成标准", "完成核心任务", "检查并收尾"];
		const tasks: PlanTask[] = taskTitles.map((title, index) => {
			const phase = phases[Math.min(
				phases.length - 1,
				Math.floor(index / Math.max(1, taskTitles.length / phases.length)),
			)]!;
			const milestone = milestones.find((item) => item.phaseId === phase.id) ?? null;
			return {
				id: `${id}-task-${index + 1}`,
				phaseId: phase.id,
				milestoneId: milestone?.id ?? null,
				title,
				estimatedMinutes: input.preferredSessionMinutes,
			};
		});
		const windowDays = long ? 10 : 7;
		const windowEnd = Temporal.PlainDate.from(context.today)
			.add({ days: windowDays })
			.toString();
		return {
			id,
			type: input.type,
			title: goal,
			goal: input.goal.trim(),
			deadline: input.deadline,
			priority: input.priority,
			weeklyCapacityHours: input.weeklyCapacityHours,
			totalEstimatedMinutes: long
				? Math.max(1_200, input.weeklyCapacityHours * 60 * 4)
				: tasks.reduce((total, task) => total + task.estimatedMinutes, 0),
			phases,
			milestones,
			tasks,
			scheduleWindow: {
				startDate: context.today,
				endDateExclusive:
					windowEnd < input.deadline ? windowEnd : this.addDay(input.deadline),
			},
			generationRun: {
				id: `generation-${context.revision}`,
				startedAt: `${context.today}T00:00:00Z`,
				completedAt: `${context.today}T00:00:01Z`,
				statuses,
				revision: context.revision,
			},
		};
	}

	private buildProposals(
		input: PlanInput,
		plan: Plan,
		context: PlanningGenerationContext,
	): ProposedScheduleItem[] {
		const preferredHour =
			input.preferredDayPart === "morning"
				? 9
				: input.preferredDayPart === "afternoon"
					? 14
					: input.preferredDayPart === "evening"
						? 19
						: 14;
		const dates: string[] = [];
		let cursor = Temporal.PlainDate.from(context.today);
		const end = Temporal.PlainDate.from(plan.scheduleWindow.endDateExclusive);
		while (
			Temporal.PlainDate.compare(cursor, end) < 0 &&
			dates.length < plan.tasks.length
		) {
			const weekday = weekdayByNumber[cursor.dayOfWeek];
			if (weekday && !input.unavailableDays.includes(weekday)) {
				dates.push(cursor.toString());
			}
			cursor = cursor.add({ days: 1 });
		}
		const maxSessions = Math.min(
			plan.tasks.length,
			Math.max(
				1,
				Math.floor(
					(input.weeklyCapacityHours * 60) / input.preferredSessionMinutes,
				),
			),
		);
		return dates.slice(0, maxSessions).map((date, index) => {
			const task = plan.tasks[index]!;
			const start = localInstant(date, preferredHour, context.timeZone);
			const endInstant = Temporal.Instant.from(start)
				.add({ minutes: task.estimatedMinutes })
				.toString();
			return {
				id: `${plan.id}-proposal-${index + 1}`,
				sourcePlanId: plan.id,
				taskId: task.id,
				title: task.title,
				state: "proposed",
				start,
				end: endInstant,
				timeZone: context.timeZone,
				version: 0,
			};
		});
	}

	private interpolateDate(start: string, end: string, ratio: number): string {
		const startDate = Temporal.PlainDate.from(start);
		const days = Number(
			startDate
				.until(Temporal.PlainDate.from(end), { largestUnit: "day" })
				.total({ unit: "day" }),
		);
		return startDate.add({ days: Math.max(1, Math.round(days * ratio)) }).toString();
	}

	private addDay(date: string): string {
		return Temporal.PlainDate.from(date).add({ days: 1 }).toString();
	}

	private assertActive(context: PlanningGenerationContext): void {
		if (context.isCancelled()) throw new GenerationCancelledError();
	}

	private async wait(): Promise<void> {
		if (this.latencyMs <= 0) return;
		await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
	}
}
