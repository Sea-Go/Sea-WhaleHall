import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	PlanSummaryView,
	PlanView,
} from "../src/views/client/features/planning/domain";
import { PlanningController } from "../src/views/client/features/planning/PlanningController";
import {
	PlanStatusCard,
	SmartScheduleComposer,
} from "../src/views/client/features/planning/PlanningPanels";
import {
	type ChangePlanStatusRequest,
	type ConfirmObservationAttributionRequest,
	type ConfirmPlanRevisionRequest,
	type CreatePlanDraftRequest,
	type PlanningService,
	PlanningServiceError,
	type PlanningServiceEvent,
	type SendPlanMessageRequest,
	type SetPlanTaskStatusRequest,
	type UndoPlanAdjustmentRequest,
} from "../src/views/client/features/planning/planning-service";

function planFixture(status: PlanView["status"]): PlanView {
	const estimate = {
		estimatedCompletionDate: "2027-06-30",
		confidence: "low" as const,
		assessedAt: "2026-08-13T02:00:00Z",
		evidenceThrough: "2026-08-12",
		basis: "先用 7 天验证每周能否稳定完成两个作品页面。",
		modelVersion: "qwen3:4b",
	};
	const tasks = [
		{
			id: "task-1",
			title: "完成第一个案例页面",
			description: "整理背景、过程与结果。",
			purpose: "execution" as const,
			status: "pending" as const,
			estimatedMinutes: 180,
			actualMinutes: 0,
			dependencyIds: [],
			schedules: [
				{
					eventId: "session-1",
					date: "2026-08-14",
					start: "2026-08-14T01:00:00Z",
					end: "2026-08-14T02:30:00Z",
					timeZone: "Asia/Shanghai",
					scheduleOrigin: "model" as const,
					userLocked: false,
					version: 1,
				},
			],
			unplanned: null,
			relevance: null,
			relevanceReason: null,
		},
		{
			id: "task-2",
			title: "验证作品集叙事",
			description: null,
			purpose: "validation" as const,
			status: "pending" as const,
			estimatedMinutes: 60,
			actualMinutes: 0,
			dependencyIds: ["task-1"],
			schedules: [],
			unplanned: {
				kind: "capacity" as const,
				message: "未来 7 天剩余容量不足",
			},
			relevance: null,
			relevanceReason: null,
		},
	];
	return {
		id: "plan-1",
		title: "建立个人作品集",
		goal: "十个月内形成一套可以持续迭代的个人作品集",
		status,
		type: status === "awaiting-confirmation" ? null : "fuzzy",
		version: 9,
		timeZone: "Asia/Shanghai",
		startToday: false,
		effectiveDate: status === "awaiting-confirmation" ? null : "2026-08-14",
		estimate,
		revision: {
			revisionId: "revision-9",
			version: 9,
			status: status === "awaiting-confirmation" ? "proposed" : "confirmed",
			createdAt: "2026-08-13T02:00:00Z",
			goal: "十个月内形成一套可以持续迭代的个人作品集",
			summary: "先用一周验证素材整理和案例撰写速度。",
			reasoningSummary: "长期目标明确，但可靠路径与稳定产能尚未得到验证。",
			planType: "fuzzy",
			estimate,
			schedulingPreferences: {
				weeklyCapacityMinutes: 240,
				sessionMinutes: 60,
				availableWindows: [
					{ dayOfWeek: 3 as const, startTime: "19:00", endTime: "21:30" },
					{ dayOfWeek: 6 as const, startTime: "09:00", endTime: "12:00" },
				],
			},
			scheduleWindow: {
				startDate: "2026-08-14",
				endDateInclusive: "2026-08-20",
				timeZone: "Asia/Shanghai",
			},
			assumptions: ["每周至少可投入 4 小时"],
			questions: ["周末是否可以安排一次 90 分钟专注时段？"],
			tasks,
			evaluations: null,
		},
		messages: [
			{
				id: "message-1",
				role: "user",
				content: "我希望十个月内建立作品集。",
				createdAt: "2026-08-13T01:00:00Z",
				status: "complete",
				revisionId: null,
			},
			{
				id: "message-2",
				role: "assistant",
				content: "现在更适合作为模糊计划，先验证稳定产能。",
				createdAt: "2026-08-13T02:00:00Z",
				status: "complete",
				revisionId: "revision-9",
			},
		],
		tasks,
		monitoring: {
			authorized: false,
			enabled: false,
			mode: "manual-only",
			coverage: "unavailable",
			message: "可以在设置中授权。",
		},
		pendingObservations: [],
		adjustments: [],
		notifications: [],
		updatedAt: "2026-08-14T04:00:00Z",
	};
}

function summary(plan: PlanView): PlanSummaryView {
	return {
		id: plan.id,
		title: plan.title,
		goal: plan.goal,
		status: plan.status,
		type: plan.type,
		version: plan.version,
		estimatedCompletionDate: plan.estimate?.estimatedCompletionDate ?? null,
		confidence: plan.estimate?.confidence ?? null,
		updatedAt: plan.updatedAt,
	};
}

class StaticPlanningService implements PlanningService {
	plan: PlanView | null;
	listError: PlanningServiceError | null = null;

	constructor(plan: PlanView | null) {
		this.plan = plan;
	}

	subscribe(_listener: (event: PlanningServiceEvent) => void): () => void {
		return () => {};
	}

	async listPlans(): Promise<readonly PlanSummaryView[]> {
		if (this.listError) throw this.listError;
		return this.plan ? [summary(this.plan)] : [];
	}

	async getPlan(): Promise<PlanView> {
		if (!this.plan) throw new PlanningServiceError("not-found", "missing");
		return this.plan;
	}

	async createPlanDraft(_request: CreatePlanDraftRequest) {
		return { planId: "plan-1" };
	}

	async sendPlanMessage(_request: SendPlanMessageRequest): Promise<void> {}
	async confirmPlanRevision(
		_request: ConfirmPlanRevisionRequest,
	): Promise<void> {}
	async setTaskStatus(_request: SetPlanTaskStatusRequest): Promise<void> {}
	async confirmObservationAttribution(
		_request: ConfirmObservationAttributionRequest,
	): Promise<void> {}
	async pausePlan(_request: ChangePlanStatusRequest): Promise<void> {}
	async resumePlan(_request: ChangePlanStatusRequest): Promise<void> {}
	async completePlan(_request: ChangePlanStatusRequest): Promise<void> {}
	async archivePlan(_request: ChangePlanStatusRequest): Promise<void> {}
	async undoPlanAdjustment(_request: UndoPlanAdjustmentRequest): Promise<void> {}
	async retryPendingAnalysis(
		_request: ChangePlanStatusRequest,
	): Promise<void> {}
	async setTaskRelevance(_request: unknown): Promise<void> {}
	onPlanningProgress() {
		return () => {};
	}
}

async function composer(service: StaticPlanningService) {
	const controller = new PlanningController(service);
	await controller.initialize();
	return renderToStaticMarkup(
		<SmartScheduleComposer
			controller={controller}
			onOpenManual={() => {}}
			onPlanned={() => {}}
		/>,
	);
}

async function statusCard(service: StaticPlanningService) {
	const controller = new PlanningController(service);
	await controller.initialize();
	return renderToStaticMarkup(<PlanStatusCard controller={controller} />);
}

describe("smart schedule composer", () => {
	test("empty plan state offers one goal input, smart action, and manual escape", async () => {
		const markup = await composer(new StaticPlanningService(null));
		expect(markup).toContain("安排什么？");
		expect(markup).toContain('id="smart-goal"');
		expect(markup).toContain("智能安排");
		expect(markup).toContain("手动设置");
		expect(markup).toContain("今天就开始");
		expect(markup).not.toContain('type="date"');
		expect(markup).not.toContain("保存日程");
	});

	test("proposed revision renders the entry list with times and a confirm action", async () => {
		const markup = await composer(
			new StaticPlanningService(planFixture("awaiting-confirmation")),
		);
		expect(markup).toContain("十个月内形成一套可以持续迭代的个人作品集");
		expect(markup).toContain("完成第一个案例页面");
		expect(markup).toContain("8月14日 09:00–10:30");
		expect(markup).toContain("未排程 · 未来 7 天剩余容量不足");
		expect(markup).toContain("待确认：");
		expect(markup).toContain("周末是否可以安排一次 90 分钟专注时段？");
		expect(markup).toContain("确认安排");
		// 可确认：主按钮不带 disabled（disabled 只出现在空输入的发送钮上）。
		expect(markup).toContain("><span>确认安排</span></button>");
		expect(markup).toContain("输入调整意见");
	});

	test("confirmed draft stays conversational and shows the assistant reply", async () => {
		const draft = planFixture("draft");
		const markup = await composer(new StaticPlanningService(draft));
		expect(markup).toContain("完善中");
		expect(markup).toContain("当前版本已确认，调整会生成新的提案");
		expect(markup).toContain("现在更适合作为模糊计划");
		expect(markup).toContain("输入调整意见");
		expect(markup).not.toContain('<span>确认安排</span>');
	});

	test("plan without any revision yet prompts to keep talking", async () => {
		const draft = { ...planFixture("draft"), revision: null };
		const markup = await composer(new StaticPlanningService(draft));
		// draft 且已有助手答复：明确展示"在等你补充"，而不是含糊的"说句话推进"。
		expect(markup).toContain("需要你补充以下信息");
		expect(markup).toContain("可一次性回答");
	});

});

describe("smart composer confirmed task list", () => {
	test("active plan renders grouped tasks sorted by next schedule with completion markers", async () => {
		const plan = planFixture("active");
		const revision = plan.revision;
		if (!revision) throw new Error("Active fixture must carry a revision");
		const base = {
			description: null,
			purpose: "execution" as const,
			estimatedMinutes: 60,
			actualMinutes: 0,
			dependencyIds: [] as string[],
			unplanned: null,
			relevance: null,
			relevanceReason: null,
		};
		const scheduled = (id: string, start: string) => ({
			eventId: `event-${id}`,
			date: start.slice(0, 10),
			start,
			end: start,
			timeZone: "Asia/Shanghai",
			scheduleOrigin: "model" as const,
			userLocked: false,
			version: 1,
		});
		revision.tasks = [
			{
				...base,
				id: "task-late",
				title: "较晚的排程任务",
				status: "pending" as const,
				actualMinutes: 60,
				schedules: [scheduled("late", "2026-08-16T02:00:00Z")],
			},
			{
				...base,
				id: "task-early",
				title: "较早的排程任务",
				status: "pending" as const,
				actualMinutes: 30,
				schedules: [scheduled("early", "2026-08-14T01:00:00Z")],
			},
			{
				...base,
				id: "task-done",
				title: "已经做完的任务",
				status: "completed" as const,
				actualMinutes: 55,
				schedules: [],
			},
			{
				...base,
				id: "task-skip",
				title: "被跳过的任务",
				status: "skipped" as const,
				actualMinutes: 0,
				schedules: [],
			},
		];
		plan.tasks = revision.tasks;
		const markup = await composer(new StaticPlanningService(plan));
		expect(markup).toContain("任务清单");
		expect(markup).toContain("已完成 1/4");
		// 完成进度降序：投入占比 100% 的较晚任务排在 50% 的较早任务之前。
		expect(markup.indexOf("较晚的排程任务")).toBeLessThan(
			markup.indexOf("较早的排程任务"),
		);
		expect(markup).toContain("已投入 60m（100%）");
		expect(markup).toContain("已投入 30m（50%）");
		// 已完成单独分组，排在活跃任务之后；完成态有独立徽标与样式。
		expect(markup.indexOf("smart-composer__item--completed")).toBeGreaterThan(
			markup.indexOf("较晚的排程任务"),
		);
		expect(markup).toContain("smart-composer__item--completed");
		expect(markup).toContain("已跳过");
		// 活跃计划不走提案确认分支。
		expect(markup).not.toContain("确认安排");
	});
});

describe("plan status card task list", () => {
	test("active plan renders grouped tasks sorted by next schedule with completion markers", async () => {
		const plan = planFixture("active");
		const revision = plan.revision;
		if (!revision) throw new Error("Active fixture must carry a revision");
		const base = {
			description: null,
			purpose: "execution" as const,
			estimatedMinutes: 60,
			dependencyIds: [] as string[],
			unplanned: null,
			relevance: null,
			relevanceReason: null,
		};
		const scheduled = (id: string, start: string) => ({
			eventId: `event-${id}`,
			date: start.slice(0, 10),
			start,
			end: start,
			timeZone: "Asia/Shanghai",
			scheduleOrigin: "model" as const,
			userLocked: false,
			version: 1,
		});
		revision.tasks = [
			{
				...base,
				id: "task-late",
				title: "较晚的排程任务",
				status: "pending" as const,
				actualMinutes: 60,
				schedules: [scheduled("late", "2026-08-16T02:00:00Z")],
			},
			{
				...base,
				id: "task-early",
				title: "较早的排程任务",
				status: "pending" as const,
				actualMinutes: 30,
				schedules: [scheduled("early", "2026-08-14T01:00:00Z")],
			},
			{
				...base,
				id: "task-done",
				title: "已经做完的任务",
				status: "completed" as const,
				actualMinutes: 55,
				schedules: [],
			},
			{
				...base,
				id: "task-skip",
				title: "被跳过的任务",
				status: "skipped" as const,
				actualMinutes: 0,
				schedules: [],
			},
		];
		plan.tasks = revision.tasks;
		const markup = await statusCard(new StaticPlanningService(plan));
		expect(markup).toContain("任务清单");
		expect(markup).toContain("已完成 1/4");
		// 完成进度降序：投入占比 100% 的较晚任务排在 50% 的较早任务之前。
		expect(markup.indexOf("较晚的排程任务")).toBeLessThan(
			markup.indexOf("较早的排程任务"),
		);
		expect(markup).toContain("已投入 60m（100%）");
		expect(markup).toContain("已投入 30m（50%）");
		// 已完成单独分组，排在活跃任务之后；完成态有删除线样式与文字标注。
		expect(markup.indexOf("smart-composer__item--completed")).toBe(-1);
		expect(
			markup.indexOf("plan-status-card__task--completed"),
		).toBeGreaterThan(markup.indexOf("较晚的排程任务"));
		expect(markup).toContain("已跳过");
		// 活跃计划不显示提案确认按钮。
		expect(markup).not.toContain("确认安排");
	});
});

