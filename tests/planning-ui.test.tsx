import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	PlanSummaryView,
	PlanView,
} from "../src/views/client/features/planning/domain";
import { PlanningController } from "../src/views/client/features/planning/PlanningController";
import { PlanningPage } from "../src/views/client/features/planning/PlanningPage";
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
				{
					eventId: "session-2",
					date: "2026-08-16",
					start: "2026-08-16T01:00:00Z",
					end: "2026-08-16T02:30:00Z",
					timeZone: "Asia/Shanghai",
					scheduleOrigin: "user" as const,
					userLocked: true,
					version: 4,
				},
			],
			unplanned: null,
		},
		{
			id: "task-2",
			title: "验证作品集叙事",
			description: null,
			purpose: "validation" as const,
			status: "pending" as const,
			estimatedMinutes: 60,
			dependencyIds: ["task-1"],
			schedules: [],
			unplanned: {
				kind: "capacity" as const,
				message: "未来 7 天剩余容量不足",
			},
		},
		{
			id: "task-3",
			title: "周末复盘验证结果",
			description: "决定下周继续、缩小范围或更换路径。",
			purpose: "review" as const,
			status: "pending" as const,
			estimatedMinutes: 30,
			dependencyIds: ["task-2"],
			schedules: [],
			unplanned: null,
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
		pendingObservations: [
			{
				id: "observation-1",
				occurredAt: "2026-08-14T03:00:00Z",
				durationMinutes: 45,
				summary: "检测到可能相关的 45 分钟投入",
				confidence: "medium",
				candidateTaskIds: ["task-1", "task-2"],
				version: 1,
			},
		],
		adjustments: [
			{
				id: "adjustment-1",
				createdAt: "2026-08-14T04:00:00Z",
				trigger: "daily-rollover",
				summary: "根据昨日进度，后移一次案例整理",
				previousEstimatedCompletionDate: "2027-06-27",
				nextEstimatedCompletionDate: "2027-06-30",
				movedCount: 1,
				addedCount: 0,
				cancelledCount: 0,
				canUndo: true,
				undoUnavailableReason: null,
				undoneAt: null,
				version: 2,
			},
		],
		notifications:
			status === "awaiting-confirmation"
				? [
						{
							id: "notification-analysis",
							kind: "analysis-ready" as const,
							message: "本地分析已完成，有一版新提案等待你确认。",
							createdAt: "2026-08-13T02:00:00Z",
						},
					]
				: [
						{
							id: "notification-adjustment",
							kind: "schedule-adjusted" as const,
							message: "计划已动态调整：移动 1、新增 1、取消 0 项。",
							createdAt: "2026-08-14T04:00:00Z",
						},
					],
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
	messageError: PlanningServiceError | null = null;
	pauseError: PlanningServiceError | null = null;
	undoError: PlanningServiceError | null = null;

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

	async sendPlanMessage(request: SendPlanMessageRequest): Promise<void> {
		if (!this.plan) return;
		this.plan = {
			...this.plan,
			version: this.plan.version + 1,
			messages: [
				...this.plan.messages,
				{
					id: "pending-message",
					role: "user",
					content: request.content,
					createdAt: "2026-08-14T05:00:00Z",
					status: this.messageError ? "pending-analysis" : "complete",
					revisionId: null,
				},
			],
		};
		if (this.messageError) throw this.messageError;
	}

	async confirmPlanRevision(
		_request: ConfirmPlanRevisionRequest,
	): Promise<void> {}
	async setTaskStatus(_request: SetPlanTaskStatusRequest): Promise<void> {}
	async confirmObservationAttribution(
		_request: ConfirmObservationAttributionRequest,
	): Promise<void> {}
	async pausePlan(_request: ChangePlanStatusRequest): Promise<void> {
		if (this.pauseError) throw this.pauseError;
	}
	async resumePlan(_request: ChangePlanStatusRequest): Promise<void> {}
	async completePlan(_request: ChangePlanStatusRequest): Promise<void> {}
	async archivePlan(_request: ChangePlanStatusRequest): Promise<void> {}
	async undoPlanAdjustment(_request: UndoPlanAdjustmentRequest): Promise<void> {
		if (this.undoError) throw this.undoError;
	}
	async retryPendingAnalysis(
		_request: ChangePlanStatusRequest,
	): Promise<void> {}
}

function render(controller: PlanningController) {
	return renderToStaticMarkup(<PlanningPage controller={controller} />);
}

describe("dynamic planning UI", () => {
	test("idle boot renders an announced loading state", () => {
		const controller = new PlanningController(new StaticPlanningService(null));
		const markup = render(controller);
		expect(markup).toContain('role="status"');
		expect(markup).toContain("正在载入本地计划");
	});

	test("empty state asks only for a goal and the default-off today switch", async () => {
		const controller = new PlanningController(new StaticPlanningService(null));
		await controller.initialize();
		const markup = render(controller);
		expect(markup).toContain("你想推进什么？");
		expect(markup).toContain("目标描述");
		expect(markup).toContain("今天开始");
		expect(markup).toContain("默认关闭；确认计划后，从明天开始安排");
		expect(markup).not.toContain('type="date"');
		expect(markup).not.toContain("截止日期");
		expect(markup).not.toContain('checked=""');
	});

	test("shows fuzzy suggestion, low-confidence ETA, exact seven days and every session", async () => {
		const controller = new PlanningController(
			new StaticPlanningService(planFixture("awaiting-confirmation")),
		);
		await controller.initialize();
		const markup = render(controller);
		expect(markup).toContain("模型建议");
		expect(markup).toContain("新提案已就绪");
		expect(markup).toContain("模糊计划");
		expect(markup).toContain("低置信度 · 仍需验证");
		expect(markup).toContain("证据截至 2026年8月12日");
		expect(markup).toContain("2026年8月14日 – 2026年8月20日");
		expect(markup).toContain("第 1 次");
		expect(markup).toContain("第 2 次");
		expect(markup).toContain("用户已锁定");
		expect(markup).toContain("未排程：未来 7 天剩余容量不足");
		expect(markup).toContain("每周 4 小时");
		expect(markup).toContain("周三 19:00–21:30");
		expect(markup).toContain("周六 09:00–12:00");
		expect(markup).toContain("可在下方对话中修改");
		expect(markup).toContain("验证");
		expect(markup).toContain("复盘");
		expect(markup).toContain("确认并开始");
		expect(markup).toContain("计划对话");
		expect(markup).toContain("按 ⌘/Ctrl + Enter 发送");
	});

	test("keeps live tasks visible while an active plan previews a new proposal", async () => {
		const plan = planFixture("active");
		if (!plan.revision) throw new Error("Expected revision fixture");
		const firstRevisionTask = plan.revision.tasks[0];
		if (!firstRevisionTask) throw new Error("Expected revision task fixture");
		const proposalTask = {
			...firstRevisionTask,
			id: "proposal-task",
			title: "下一版验证任务",
			purpose: "validation" as const,
			schedules: [],
		};
		const controller = new PlanningController(
			new StaticPlanningService({
				...plan,
				revision: {
					...plan.revision,
					revisionId: "proposal-revision",
					status: "proposed",
					goal: "先完成一个可以面试演示的完整案例，再扩展作品集",
					tasks: [proposalTask],
				},
			}),
		);
		await controller.initialize();
		const markup = render(controller);

		expect(markup).toContain("执行中");
		expect(markup).toContain("完成第一个案例页面");
		expect(markup).toContain("下一版验证任务");
		expect(markup).toContain("新目标");
		expect(markup).toContain("先完成一个可以面试演示的完整案例，再扩展作品集");
		expect(markup).toContain("当前计划会继续执行");
		expect(markup).toContain("确认并应用");
		expect(markup).not.toContain("只有你确认后才会开始执行");
	});

	test("renders all three model-suggested plan types without auto-confirming one", async () => {
		for (const [type, label] of [
			["short-term", "短期计划"],
			["long-term", "长期计划"],
			["fuzzy", "模糊计划"],
		] as const) {
			const plan = planFixture("awaiting-confirmation");
			const revision = plan.revision;
			if (!revision) throw new Error("Expected revision fixture");
			const controller = new PlanningController(
				new StaticPlanningService({
					...plan,
					revision: { ...revision, planType: type },
				}),
			);
			await controller.initialize();
			const markup = render(controller);
			expect(markup).toContain(label);
			expect(markup).toContain("只有你确认后才会开始执行");
		}
	});

	test("active view keeps task, monitoring, attribution and undo actions explicit", async () => {
		const controller = new PlanningController(
			new StaticPlanningService(planFixture("active")),
		);
		await controller.initialize();
		const markup = render(controller);
		expect(markup).toContain("执行中");
		expect(markup).toContain("完成只由你确认");
		expect(markup).toContain("监测已关闭，仅使用手动进度");
		expect(markup).toContain("观测只提供证据，绝不会自动完成任务");
		expect(markup).toContain("计入“完成第一个案例页面”");
		expect(markup).toContain("不计入计划");
		expect(markup).toContain("动态调整记录");
		expect(markup).toContain("日程与预计完成日已检查");
		expect(markup).toContain("撤销");
		expect(markup).toContain("确认计划已完成");
	});

	test("exposes every runtime-supported completion and archive transition", async () => {
		const paused = new PlanningController(
			new StaticPlanningService(planFixture("paused")),
		);
		await paused.initialize();
		const pausedMarkup = render(paused);
		expect(pausedMarkup).toContain("恢复计划");
		expect(pausedMarkup).toContain("确认计划已完成");

		const draft = new PlanningController(
			new StaticPlanningService(planFixture("draft")),
		);
		await draft.initialize();
		expect(render(draft)).toContain("归档计划");

		const completed = new PlanningController(
			new StaticPlanningService(planFixture("completed")),
		);
		await completed.initialize();
		expect(render(completed)).toContain("归档");
	});

	test("keeps long Chinese content readable instead of truncating plan evidence", async () => {
		const plan = planFixture("active");
		const longGoal =
			"完成一套能够清楚解释复杂项目背景、关键判断、取舍过程与最终影响的个人作品集".repeat(
				5,
			);
		const controller = new PlanningController(
			new StaticPlanningService({ ...plan, goal: longGoal }),
		);
		await controller.initialize();
		const markup = render(controller);
		expect(markup).toContain(longGoal);
		expect(markup).toContain("整理背景、过程与结果");
	});

	test("shows an explicit conflict when an automatic adjustment cannot be undone", async () => {
		const service = new StaticPlanningService(planFixture("active"));
		service.undoError = new PlanningServiceError(
			"conflict",
			"calendar changed",
		);
		const controller = new PlanningController(service);
		await controller.initialize();
		await controller.undoAdjustment("adjustment-1");
		const markup = render(controller);
		expect(markup).toContain("这次调整与已确认安排冲突");
		expect(markup).toContain("原计划没有被覆盖");
		expect(markup).toContain("动态调整记录");
	});

	test("model outage renders persisted pending analysis and a recovery action", async () => {
		const service = new StaticPlanningService(planFixture("draft"));
		service.messageError = new PlanningServiceError(
			"model-unavailable",
			"model unavailable",
		);
		const controller = new PlanningController(service, () => "operation-1");
		await controller.initialize();
		await controller.sendMessage("请重新评估每周投入");
		const markup = render(controller);
		expect(markup).toContain("本地模型暂时不可用");
		expect(markup).toContain("请重新评估每周投入");
		expect(markup).toContain("待分析");
		expect(markup).toContain("重试分析");
	});

	test("offline state never renders a blank page", async () => {
		const service = new StaticPlanningService(null);
		service.listError = new PlanningServiceError("offline", "offline");
		const controller = new PlanningController(service);
		await controller.initialize();
		const markup = render(controller);
		expect(markup).toContain("本地计划服务离线");
		expect(markup).toContain("重新连接");
	});

	test("stale version disables mutations and offers an authoritative reload", async () => {
		const service = new StaticPlanningService(planFixture("active"));
		service.pauseError = new PlanningServiceError("stale-version", "stale");
		const controller = new PlanningController(service);
		await controller.initialize();
		await controller.pausePlan();
		const markup = render(controller);
		expect(markup).toContain("计划已在别处更新");
		expect(markup).toContain("载入最新版本");
		expect(markup).toContain('disabled=""');
	});
});
