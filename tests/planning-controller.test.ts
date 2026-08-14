import { describe, expect, test } from "bun:test";
import { PlanningController } from "../src/views/client/features/planning/PlanningController";
import type {
	PlanSummaryView,
	PlanView,
	PlanningTaskView,
} from "../src/views/client/features/planning/domain";
import {
	PlanningServiceError,
	type ChangePlanStatusRequest,
	type ConfirmObservationAttributionRequest,
	type ConfirmPlanRevisionRequest,
	type CreatePlanDraftRequest,
	type PlanningService,
	type PlanningServiceEvent,
	type SendPlanMessageRequest,
	type SetPlanTaskStatusRequest,
	type UndoPlanAdjustmentRequest,
} from "../src/views/client/features/planning/planning-service";

function schedule(eventId: string, start: string, userLocked = false) {
	return {
		eventId,
		date: start.slice(0, 10),
		start,
		end: start.replace("01:00:00", "02:00:00"),
		timeZone: "Asia/Shanghai",
		scheduleOrigin: "model" as const,
		userLocked,
		version: 2,
	};
}

function planningTask(
	id: string,
	overrides: Partial<PlanningTaskView> = {},
): PlanningTaskView {
	return {
		id,
		title: `任务 ${id}`,
		description: null,
		purpose: "execution",
		status: "pending",
		estimatedMinutes: 90,
		dependencyIds: [],
		schedules: [schedule(`${id}-session-1`, "2026-08-14T01:00:00Z")],
		unplanned: null,
		...overrides,
	};
}

function basePlan(
	status: PlanView["status"] = "awaiting-confirmation",
): PlanView {
	const tasks = [
		planningTask("task-1", {
			schedules: [
				schedule("session-1", "2026-08-14T01:00:00Z"),
				schedule("session-2", "2026-08-16T01:00:00Z", true),
			],
		}),
		planningTask("task-2", {
			schedules: [],
			unplanned: { kind: "capacity", message: "本周剩余容量不足" },
		}),
	];
	const estimate = {
		estimatedCompletionDate: "2026-10-30",
		confidence: "low" as const,
		assessedAt: "2026-08-13T02:00:00Z",
		evidenceThrough: "2026-08-12T23:59:59Z",
		basis: "先验证一周的稳定投入，再缩小日期范围。",
		modelVersion: "qwen3:4b",
	};
	return {
		id: "plan-1",
		title: "建立个人作品集",
		goal: "完成一套可以用于求职的作品集",
		status,
		type: status === "awaiting-confirmation" ? null : "fuzzy",
		version: 7,
		timeZone: "Asia/Shanghai",
		startToday: false,
		effectiveDate: status === "awaiting-confirmation" ? null : "2026-08-14",
		estimate,
		revision: {
			revisionId: "revision-7",
			version: 7,
			status: status === "awaiting-confirmation" ? "proposed" : "confirmed",
			createdAt: "2026-08-13T02:00:00Z",
			goal: "完成一套可以用于求职的作品集",
			summary: "先验证作品生产节奏，再动态收敛长期日期。",
			reasoningSummary: "当前目标路径仍有不确定性，建议作为模糊计划推进。",
			planType: "fuzzy",
			estimate,
			schedulingPreferences: {
				weeklyCapacityMinutes: 240,
				sessionMinutes: 60,
				availableWindows: [
					{ dayOfWeek: 6, startTime: "09:00", endTime: "12:00" },
				],
			},
			scheduleWindow: {
				startDate: "2026-08-14",
				endDateInclusive: "2026-08-20",
				timeZone: "Asia/Shanghai",
			},
			assumptions: ["每周至少投入 3 小时"],
			questions: [],
			tasks,
		},
		messages: [
			{
				id: "message-1",
				role: "user",
				content: "我想完成作品集",
				createdAt: "2026-08-13T01:58:00Z",
				status: "complete",
				revisionId: null,
			},
			{
				id: "message-2",
				role: "assistant",
				content: "建议先作为模糊计划，用一周验证稳定产出速度。",
				createdAt: "2026-08-13T02:00:00Z",
				status: "complete",
				revisionId: "revision-7",
			},
		],
		tasks,
		monitoring: {
			authorized: false,
			enabled: false,
			mode: "manual-only",
			coverage: "unavailable",
			message: "未授权活动监测。",
		},
		pendingObservations: [
			{
				id: "observation-1",
				occurredAt: "2026-08-14T02:00:00Z",
				durationMinutes: 45,
				summary: "检测到一段可能与计划相关的投入",
				confidence: "medium",
				candidateTaskIds: ["task-1", "task-2"],
				version: 3,
			},
		],
		adjustments: [
			{
				id: "adjustment-1",
				createdAt: "2026-08-14T03:00:00Z",
				trigger: "task-status",
				summary: "根据任务进度后移一次安排",
				previousEstimatedCompletionDate: "2026-10-28",
				nextEstimatedCompletionDate: "2026-10-30",
				movedCount: 1,
				addedCount: 0,
				cancelledCount: 0,
				canUndo: true,
				undoUnavailableReason: null,
				undoneAt: null,
				version: 2,
			},
		],
		notifications: [],
		updatedAt: "2026-08-13T02:00:00Z",
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

class FakePlanningService implements PlanningService {
	plan: PlanView | null;
	readonly listeners = new Set<(event: PlanningServiceEvent) => void>();
	readonly createRequests: CreatePlanDraftRequest[] = [];
	readonly messageRequests: SendPlanMessageRequest[] = [];
	readonly confirmationRequests: ConfirmPlanRevisionRequest[] = [];
	readonly taskRequests: SetPlanTaskStatusRequest[] = [];
	readonly observationRequests: ConfirmObservationAttributionRequest[] = [];
	readonly undoRequests: UndoPlanAdjustmentRequest[] = [];
	readonly statusRequests: Array<{ action: string; request: ChangePlanStatusRequest }> = [];
	sendErrorAfterPersist: PlanningServiceError | null = null;
	pauseError: PlanningServiceError | null = null;
	listError: PlanningServiceError | null = null;
	createErrorOnce: PlanningServiceError | null = null;

	constructor(plan: PlanView | null = basePlan()) {
		this.plan = plan;
	}

	subscribe(listener: (event: PlanningServiceEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async listPlans(): Promise<readonly PlanSummaryView[]> {
		if (this.listError) throw this.listError;
		return this.plan ? [summary(this.plan)] : [];
	}

	async getPlan(planId: string): Promise<PlanView> {
		if (!this.plan || this.plan.id !== planId) {
			throw new PlanningServiceError("not-found", "not found", { retryable: false });
		}
		return this.plan;
	}

	async createPlanDraft(request: CreatePlanDraftRequest) {
		this.createRequests.push(request);
		if (this.createErrorOnce) {
			const error = this.createErrorOnce;
			this.createErrorOnce = null;
			throw error;
		}
		this.plan = {
			...basePlan("draft"),
			id: "created-plan",
			title: request.input.goal,
			goal: request.input.goal,
			startToday: request.input.startToday,
			type: null,
			effectiveDate: null,
			revision: null,
			estimate: null,
			tasks: [],
			messages: [
				{
					id: "created-message",
					role: "user",
					content: request.input.goal,
					createdAt: "2026-08-13T04:00:00Z",
					status: "pending-analysis",
					revisionId: null,
				},
			],
		};
		return { planId: "created-plan" };
	}

	async sendPlanMessage(request: SendPlanMessageRequest): Promise<void> {
		this.messageRequests.push(request);
		const plan = this.requirePlan();
		this.plan = {
			...plan,
			version: plan.version + 1,
			messages: [
				...plan.messages,
				{
					id: `message-${plan.messages.length + 1}`,
					role: "user",
					content: request.content,
					createdAt: "2026-08-13T05:00:00Z",
					status: this.sendErrorAfterPersist ? "pending-analysis" : "complete",
					revisionId: null,
				},
			],
		};
		if (this.sendErrorAfterPersist) throw this.sendErrorAfterPersist;
	}

	async confirmPlanRevision(request: ConfirmPlanRevisionRequest): Promise<void> {
		this.confirmationRequests.push(request);
		const plan = this.requirePlan();
		this.plan = {
			...plan,
			status: plan.status === "paused" ? "paused" : "active",
			type: plan.revision?.planType ?? null,
			version: plan.version + 1,
			effectiveDate: plan.startToday ? "2026-08-13" : "2026-08-14",
			revision: plan.revision ? { ...plan.revision, status: "confirmed" } : null,
		};
	}

	async setTaskStatus(request: SetPlanTaskStatusRequest): Promise<void> {
		this.taskRequests.push(request);
		const plan = this.requirePlan();
		this.plan = {
			...plan,
			version: plan.version + 1,
			tasks: plan.tasks.map((task) =>
				task.id === request.taskId ? { ...task, status: request.status } : task,
			),
		};
	}

	async confirmObservationAttribution(
		request: ConfirmObservationAttributionRequest,
	): Promise<void> {
		this.observationRequests.push(request);
		const plan = this.requirePlan();
		this.plan = {
			...plan,
			version: plan.version + 1,
			pendingObservations: plan.pendingObservations.filter(
				(item) => item.id !== request.observationId,
			),
		};
	}

	async pausePlan(request: ChangePlanStatusRequest): Promise<void> {
		this.statusRequests.push({ action: "pause", request });
		if (this.pauseError) throw this.pauseError;
		this.changeStatus("paused");
	}

	async resumePlan(request: ChangePlanStatusRequest): Promise<void> {
		this.statusRequests.push({ action: "resume", request });
		this.changeStatus("active");
	}

	async completePlan(request: ChangePlanStatusRequest): Promise<void> {
		this.statusRequests.push({ action: "complete", request });
		this.changeStatus("completed");
	}

	async archivePlan(request: ChangePlanStatusRequest): Promise<void> {
		this.statusRequests.push({ action: "archive", request });
		this.changeStatus("archived");
	}

	async undoPlanAdjustment(request: UndoPlanAdjustmentRequest): Promise<void> {
		this.undoRequests.push(request);
		const plan = this.requirePlan();
		this.plan = {
			...plan,
			version: plan.version + 1,
			adjustments: plan.adjustments.map((item) =>
				item.id === request.adjustmentId
					? {
							...item,
							canUndo: false,
							undoneAt: "2026-08-14T04:00:00Z",
					  }
					: item,
			),
		};
	}

	async retryPendingAnalysis(request: ChangePlanStatusRequest): Promise<void> {
		this.statusRequests.push({ action: "retry-analysis", request });
		const plan = this.requirePlan();
		this.sendErrorAfterPersist = null;
		this.plan = {
			...plan,
			status: "awaiting-confirmation",
			version: plan.version + 1,
			messages: plan.messages.map((message) =>
				message.status === "pending-analysis"
					? { ...message, status: "complete" }
					: message,
			),
		};
	}

	emit(event: PlanningServiceEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private requirePlan(): PlanView {
		if (!this.plan) throw new Error("Expected a plan");
		return this.plan;
	}

	private changeStatus(status: PlanView["status"]): void {
		const plan = this.requirePlan();
		this.plan = { ...plan, status, version: plan.version + 1 };
	}
}

function ids() {
	let value = 0;
	return () => `operation-${++value}`;
}

function currentPlan(controller: PlanningController): PlanView {
	const state = controller.getSnapshot();
	if (!("content" in state) || !state.content) {
		throw new Error(`Expected loaded content, got ${state.status}`);
	}
	return state.content.plan;
}

describe("PlanningController creation and conversation", () => {
	test("loads an honest empty state and creates with tomorrow as the default", async () => {
		const service = new FakePlanningService(null);
		const controller = new PlanningController(service, ids());
		await controller.initialize();
		expect(controller.getSnapshot()).toMatchObject({
			status: "empty",
			input: { goal: "", startToday: false },
		});

		controller.updateCreateInput({ goal: "完成一套个人作品集" });
		await controller.createPlanDraft();
		expect(service.createRequests).toEqual([
			{
				input: { goal: "完成一套个人作品集", startToday: false },
				operationId: "operation-1",
			},
		]);
		expect(controller.getSnapshot().status).toBe("draft");
		expect(currentPlan(controller).effectiveDate).toBeNull();
		expect(currentPlan(controller).messages[0]?.status).toBe("pending-analysis");
	});

	test("passes today-start only when the user explicitly checks it", async () => {
		const service = new FakePlanningService(null);
		const controller = new PlanningController(service, ids());
		await controller.initialize();
		controller.updateCreateInput({
			goal: "建立长期写作与发布节奏",
			startToday: true,
		});
		await controller.createPlanDraft();
		expect(service.createRequests[0]?.input.startToday).toBe(true);
	});

	test("reuses the stable creation operation id after a lost local acknowledgement", async () => {
		const service = new FakePlanningService(null);
		service.createErrorOnce = new PlanningServiceError("offline", "offline");
		const controller = new PlanningController(service, ids());
		await controller.initialize();
		controller.updateCreateInput({ goal: "完成一套个人作品集" });
		await controller.createPlanDraft();
		expect(controller.getSnapshot().status).toBe("offline");

		await controller.retry();
		expect(service.createRequests.map((request) => request.operationId)).toEqual([
			"operation-1",
			"operation-1",
		]);
		expect(controller.getSnapshot().status).toBe("draft");
	});

	test("sends repeated messages through the port and confirms only the latest revision", async () => {
		const service = new FakePlanningService();
		const controller = new PlanningController(service, ids());
		await controller.initialize();

		await controller.sendMessage(" 我每周可投入三小时 ");
		expect(service.messageRequests[0]).toMatchObject({
			planId: "plan-1",
			content: "我每周可投入三小时",
			expectedVersion: 7,
			operationId: "operation-1",
		});
		expect(currentPlan(controller).messages.at(-1)?.content).toBe(
			"我每周可投入三小时",
		);

		await controller.confirmLatestRevision();
		expect(service.confirmationRequests[0]).toMatchObject({
			planId: "plan-1",
			revisionId: "revision-7",
			expectedVersion: 8,
			operationId: "operation-2",
		});
		expect(controller.getSnapshot().status).toBe("active");
		expect(currentPlan(controller).effectiveDate).toBe("2026-08-14");
	});

	test("applies a proposal without stopping an active or paused execution baseline", async () => {
		for (const status of ["active", "paused"] as const) {
			const plan = basePlan(status);
			if (!plan.revision) throw new Error("Expected revision fixture");
			const liveTaskIds = plan.tasks.map((task) => task.id);
			const service = new FakePlanningService({
				...plan,
				revision: { ...plan.revision, status: "proposed" },
			});
			const controller = new PlanningController(service, ids());
			await controller.initialize();

			await controller.confirmLatestRevision();

			expect(service.confirmationRequests).toHaveLength(1);
			expect(currentPlan(controller).status).toBe(status);
			expect(currentPlan(controller).tasks.map((task) => task.id)).toEqual(liveTaskIds);
			expect(currentPlan(controller).revision?.status).toBe("confirmed");
		}
	});

	test("keeps a persisted pending message when the model is unavailable", async () => {
		const service = new FakePlanningService(basePlan("draft"));
		service.sendErrorAfterPersist = new PlanningServiceError(
			"model-unavailable",
			"model down",
		);
		const controller = new PlanningController(service, ids());
		await controller.initialize();
		await controller.sendMessage("请按每周三个晚上重新分析");

		expect(controller.getSnapshot().status).toBe("model-unavailable");
		expect(currentPlan(controller).messages.at(-1)).toMatchObject({
			content: "请按每周三个晚上重新分析",
			status: "pending-analysis",
		});

		await controller.retry();
		expect(service.statusRequests.at(-1)).toMatchObject({
			action: "retry-analysis",
			request: {
				planId: "plan-1",
				operationId: "operation-2",
				expectedVersion: 8,
			},
		});
		expect(controller.getSnapshot().status).toBe("awaiting-confirmation");
		expect(currentPlan(controller).messages.at(-1)?.status).toBe("complete");
	});
});

describe("PlanningController execution and recovery", () => {
	test("carries stable operation and current plan versions through every lifecycle write", async () => {
		const service = new FakePlanningService(basePlan("active"));
		const controller = new PlanningController(service, ids());
		await controller.initialize();

		await controller.pausePlan();
		await controller.resumePlan();
		await controller.completePlan();
		await controller.archivePlan();

		expect(service.statusRequests).toEqual([
			{
				action: "pause",
				request: {
					planId: "plan-1",
					operationId: "operation-1",
					expectedVersion: 7,
				},
			},
			{
				action: "resume",
				request: {
					planId: "plan-1",
					operationId: "operation-2",
					expectedVersion: 8,
				},
			},
			{
				action: "complete",
				request: {
					planId: "plan-1",
					operationId: "operation-3",
					expectedVersion: 9,
				},
			},
			{
				action: "archive",
				request: {
					planId: "plan-1",
					operationId: "operation-4",
					expectedVersion: 10,
				},
			},
		]);
		expect(controller.getSnapshot().status).toBe("archived");
	});

	test("only explicit user task actions change completed/skipped state", async () => {
		const service = new FakePlanningService(basePlan("active"));
		const controller = new PlanningController(service, ids());
		await controller.initialize();

		await controller.setTaskStatus("task-1", "completed");
		expect(service.taskRequests[0]).toMatchObject({
			taskId: "task-1",
			status: "completed",
			expectedVersion: 7,
		});
		expect(currentPlan(controller).tasks[0]?.status).toBe("completed");

		await controller.setTaskStatus("task-1", "pending");
		expect(currentPlan(controller).tasks[0]?.status).toBe("pending");
	});

	test("confirms ambiguous observation attribution without completing a task", async () => {
		const service = new FakePlanningService(basePlan("active"));
		const controller = new PlanningController(service, ids());
		await controller.initialize();
		await controller.confirmObservationAttribution("observation-1", "task-1");

		expect(service.observationRequests[0]).toMatchObject({
			observationId: "observation-1",
			taskId: "task-1",
			expectedVersion: 7,
		});
		expect(currentPlan(controller).pendingObservations).toHaveLength(0);
		expect(currentPlan(controller).tasks[0]?.status).toBe("pending");
	});

	test("undo uses both plan and adjustment versions", async () => {
		const service = new FakePlanningService(basePlan("active"));
		const controller = new PlanningController(service, ids());
		await controller.initialize();
		await controller.undoAdjustment("adjustment-1");
		expect(service.undoRequests[0]).toMatchObject({
			planId: "plan-1",
			adjustmentId: "adjustment-1",
			adjustmentVersion: 2,
			expectedVersion: 7,
		});
		expect(currentPlan(controller).adjustments[0]?.canUndo).toBe(false);
	});

	test("surfaces stale writes and reloads the authoritative version", async () => {
		const service = new FakePlanningService(basePlan("active"));
		service.pauseError = new PlanningServiceError("stale-version", "stale");
		const controller = new PlanningController(service, ids());
		await controller.initialize();
		await controller.pausePlan();
		expect(controller.getSnapshot().status).toBe("stale");

		service.pauseError = null;
		service.plan = { ...basePlan("active"), version: 12 };
		await controller.retry();
		expect(controller.getSnapshot().status).toBe("active");
		expect(currentPlan(controller).version).toBe(12);
	});

	test("keeps cached content visible when the local service goes offline", async () => {
		const service = new FakePlanningService(basePlan("active"));
		const controller = new PlanningController(service, ids());
		await controller.initialize();
		service.listError = new PlanningServiceError("offline", "offline");
		await controller.load();
		const state = controller.getSnapshot();
		expect(state.status).toBe("offline");
		if (state.status !== "offline") throw new Error("Expected offline state");
		expect(state.cached?.plan.id).toBe("plan-1");
	});
});
