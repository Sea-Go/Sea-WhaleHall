import { describe, expect, test } from "bun:test";
import type { PlanningPlanProjection } from "../src/shared/planning";
import { PlanningServiceError } from "../src/views/client/features/planning/planning-service";
import {
	ElectrobunPlanningService,
	type PlanningRpcClient,
} from "../src/views/client/infrastructure/planning/ElectrobunPlanningService";

function planProjection(): PlanningPlanProjection {
	const estimate = {
		estimatedCompletionDate: "2026-10-30",
		confidence: 0.42,
		assessedAt: "2026-08-13T02:00:00Z",
		evidenceThrough: "2026-08-12",
		basis: "先验证一周稳定投入。",
		modelVersion: "qwen3:4b@locked",
	};
	return {
		id: "plan-1",
		goal: "完成一套可用于求职的作品集",
		status: "active",
		version: 12,
		timeZone: "Asia/Shanghai",
		startToday: false,
		effectiveStartDate: "2026-08-14",
		scheduleWindow: {
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-21",
		},
		type: "fuzzy",
		typeReason: "路径尚未稳定，先安排验证任务。",
		estimate,
		activeRevision: {
			revisionId: "revision-4",
			version: 4,
			createdAt: "2026-08-13T02:00:00Z",
			goal: "完成一套可用于求职的作品集",
			reason: "daily-summary",
			type: "fuzzy",
			typeReason: "路径尚未稳定，先安排验证任务。",
			assumptions: ["每周投入四小时"],
			clarifyingQuestions: [],
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
				endDateExclusive: "2026-08-21",
			},
			tasks: [],
		},
		proposedRevision: null,
		messages: [
			{
				id: "message-1",
				role: "user",
				content: "我每周可以投入四小时。",
				createdAt: "2026-08-13T01:00:00Z",
				state: "complete",
			},
		],
		tasks: [
			{
				id: "task-1",
				title: "整理第一个案例",
				description: "整理背景、过程和结果。",
				purpose: "execution",
				status: "pending",
				estimatedMinutes: 120,
				dependsOnTaskIds: [],
				schedules: [
					{
						eventId: "event-1",
						start: "2026-08-13T18:30:00Z",
						end: "2026-08-13T19:30:00Z",
						timeZone: "Asia/Shanghai",
						userLocked: false,
						scheduleOrigin: "model",
						version: 2,
						unplannedReason: null,
					},
					{
						eventId: "event-2",
						start: "2026-08-15T01:00:00Z",
						end: "2026-08-15T02:00:00Z",
						timeZone: "Asia/Shanghai",
						userLocked: true,
						scheduleOrigin: "user",
						version: 5,
						unplannedReason: null,
					},
				],
				unscheduledReason: null,
			},
		],
		monitoring: {
			authorized: true,
			enabled: false,
			mode: "observed",
			coverage: "partial",
			message: "监测已暂停。",
		},
		pendingObservations: [
			{
				id: "observation-1",
				periodStartedAt: "2026-08-13T03:00:00Z",
				periodEndedAt: "2026-08-13T03:45:00Z",
				minutes: 45,
				confidence: 0.66,
				suggestedTaskIds: ["task-1"],
				status: "pending",
			},
		],
		adjustments: [
			{
				id: "adjustment-1",
				createdAt: "2026-08-13T04:00:00Z",
				reason: "daily-summary",
				previousEstimateDate: "2026-10-28",
				nextEstimateDate: "2026-10-30",
				movedCount: 1,
				addedCount: 1,
				cancelledCount: 0,
				canUndo: true,
				undoUnavailableReason: null,
				undoneAt: null,
				version: 3,
			},
		],
		notifications: [
			{
				id: "notification-1",
				planId: "plan-1",
				kind: "schedule-adjusted",
				message: "计划已动态调整。",
				createdAt: "2026-08-13T04:00:00Z",
			},
		],
		createdAt: "2026-08-12T01:00:00Z",
		updatedAt: "2026-08-13T04:00:00Z",
	};
}

function planningRpc(
	overrides: Partial<PlanningRpcClient> = {},
): PlanningRpcClient {
	const plan = planProjection();
	const planResponse = async () => ({ plan });
	return {
		listPlans: async () => ({
			plans: [
				{
					id: plan.id,
					goal: plan.goal,
					status: plan.status,
					type: plan.type,
					estimatedCompletionDate:
						plan.estimate?.estimatedCompletionDate ?? null,
					estimateConfidence: plan.estimate?.confidence ?? null,
					version: plan.version,
					updatedAt: plan.updatedAt,
				},
			],
		}),
		getPlan: async () => ({ plan }),
		createPlanDraft: async () => ({ planId: plan.id }),
		sendPlanMessage: planResponse,
		confirmPlanRevision: planResponse,
		setPlanningTaskStatus: planResponse,
		confirmPlanningObservation: planResponse,
		pausePlan: planResponse,
		resumePlan: planResponse,
		completePlan: planResponse,
		archivePlan: planResponse,
		undoPlanAdjustment: planResponse,
		retryPendingPlanAnalysis: planResponse,
		onPlanChanged: () => () => {},
		onCalendarChanged: () => () => {},
		...overrides,
	};
}

describe("Electrobun planning service", () => {
	test("maps the complete projection, named-zone sessions, monitoring and adjustment version", async () => {
		const service = new ElectrobunPlanningService(async () => planningRpc());
		const plan = await service.getPlan("plan-1");

		expect(plan.startToday).toBe(false);
		expect(plan.revision).toMatchObject({
			revisionId: "revision-4",
			version: 4,
			goal: "完成一套可用于求职的作品集",
			planType: "fuzzy",
			estimate: {
				confidence: "low",
				basis: "先验证一周稳定投入。",
				assessedAt: "2026-08-13T02:00:00Z",
				evidenceThrough: "2026-08-12",
			},
			schedulingPreferences: {
				weeklyCapacityMinutes: 240,
				sessionMinutes: 60,
				availableWindows: [
					{ dayOfWeek: 6, startTime: "09:00", endTime: "12:00" },
				],
			},
		});
		expect(plan.tasks[0]?.schedules).toEqual([
			expect.objectContaining({
				eventId: "event-1",
				date: "2026-08-14",
				userLocked: false,
				version: 2,
			}),
			expect.objectContaining({
				eventId: "event-2",
				date: "2026-08-15",
				userLocked: true,
				scheduleOrigin: "user",
				version: 5,
			}),
		]);
		expect(plan.monitoring).toEqual({
			authorized: true,
			enabled: false,
			mode: "observed",
			coverage: "partial",
			message: "监测已暂停。",
		});
		expect(plan.adjustments[0]).toMatchObject({
			trigger: "daily-rollover",
			summary: "根据每日进度汇总更新预计完成日与安排",
			canUndo: true,
			version: 3,
		});
	});

	test("maps a proposed revision separately from live active tasks", async () => {
		const projection = planProjection();
		if (!projection.activeRevision || !projection.tasks[0]) {
			throw new Error("Expected active projection fixture");
		}
		projection.proposedRevision = {
			...projection.activeRevision,
			revisionId: "revision-proposed",
			version: 5,
			estimate: { ...projection.activeRevision.estimate, confidence: 0.5 },
			tasks: [
				{
					...projection.tasks[0],
					id: "proposal-task",
					title: "下一版验证任务",
					purpose: "validation",
					schedules: [],
				},
			],
		};
		const service = new ElectrobunPlanningService(async () =>
			planningRpc({ getPlan: async () => ({ plan: projection }) }),
		);

		const plan = await service.getPlan("plan-1");

		expect(plan.status).toBe("active");
		expect(plan.revision).toMatchObject({
			revisionId: "revision-proposed",
			status: "proposed",
			estimate: { confidence: "low" },
			tasks: [{ id: "proposal-task", purpose: "validation" }],
		});
		expect(plan.tasks).toEqual([
			expect.objectContaining({ id: "task-1", purpose: "execution" }),
		]);
	});

	test("forwards every write without dropping operation, plan or adjustment versions", async () => {
		const calls: Array<{ method: string; command: unknown }> = [];
		const plan = planProjection();
		const response = { plan };
		const record = (method: string) => async (command: unknown) => {
			calls.push({ method, command });
			return response;
		};
		const api = planningRpc({
			createPlanDraft: async (command) => {
				calls.push({ method: "create", command });
				return { planId: plan.id };
			},
			sendPlanMessage: record("message"),
			confirmPlanRevision: record("confirm"),
			setPlanningTaskStatus: record("task"),
			confirmPlanningObservation: record("observation"),
			pausePlan: record("pause"),
			resumePlan: record("resume"),
			completePlan: record("complete"),
			archivePlan: record("archive"),
			undoPlanAdjustment: record("undo"),
			retryPendingPlanAnalysis: record("retry"),
		});
		const service = new ElectrobunPlanningService(async () => api);
		const write = {
			planId: "plan-1",
			operationId: "operation-12",
			expectedVersion: 12,
		};

		await service.createPlanDraft({
			input: { goal: "完成个人作品集", startToday: false },
			operationId: "operation-create",
		});
		await service.sendPlanMessage({ ...write, content: "每周投入四小时" });
		await service.confirmPlanRevision({ ...write, revisionId: "revision-4" });
		await service.setTaskStatus({
			...write,
			taskId: "task-1",
			status: "completed",
		});
		await service.confirmObservationAttribution({
			...write,
			observationId: "observation-1",
			taskId: "task-1",
		});
		await service.pausePlan(write);
		await service.resumePlan(write);
		await service.completePlan(write);
		await service.archivePlan(write);
		await service.undoPlanAdjustment({
			...write,
			adjustmentId: "adjustment-1",
			adjustmentVersion: 3,
		});
		await service.retryPendingAnalysis(write);

		expect(calls.map((call) => call.method)).toEqual([
			"create",
			"message",
			"confirm",
			"task",
			"observation",
			"pause",
			"resume",
			"complete",
			"archive",
			"undo",
			"retry",
		]);
		expect(calls[0]?.command).toEqual({
			input: { goal: "完成个人作品集", startToday: false },
			operationId: "operation-create",
		});
		for (const call of calls.slice(1)) {
			expect(call.command).toMatchObject(write);
		}
		expect(calls.at(-2)?.command).toEqual({
			...write,
			adjustmentId: "adjustment-1",
			adjustmentVersion: 3,
		});
	});

	test("projects only authoritative plan and calendar invalidations", async () => {
		const planChangedListeners: Array<
			Parameters<PlanningRpcClient["onPlanChanged"]>[0]
		> = [];
		const calendarChangedListeners: Array<
			Parameters<PlanningRpcClient["onCalendarChanged"]>[0]
		> = [];
		const service = new ElectrobunPlanningService(async () =>
			planningRpc({
				onPlanChanged: (listener) => {
					planChangedListeners.push(listener);
					return () => {
						planChangedListeners.splice(
							planChangedListeners.indexOf(listener),
							1,
						);
					};
				},
				onCalendarChanged: (listener) => {
					calendarChangedListeners.push(listener);
					return () => {
						calendarChangedListeners.splice(
							calendarChangedListeners.indexOf(listener),
							1,
						);
					};
				},
			}),
		);
		const events: unknown[] = [];
		const stop = service.subscribe((event) => events.push(event));
		await Promise.resolve();

		planChangedListeners[0]?.({
			planId: "plan-1",
			version: 13,
			kind: "progress",
		});
		calendarChangedListeners[0]?.(9);

		expect(events).toEqual([
			{ kind: "planChanged", planId: "plan-1" },
			{ kind: "calendarChanged", planId: null },
		]);
		stop();
		expect(planChangedListeners).toHaveLength(0);
		expect(calendarChangedListeners).toHaveLength(0);
	});

	test("preserves actionable RPC failures instead of reporting every write as offline", async () => {
		for (const [message, code] of [
			["MODEL_UNAVAILABLE", "model-unavailable"],
			["Planning plan changed concurrently.", "stale-version"],
			["Planning plan was not found.", "not-found"],
			["A stable operation ID is required.", "validation"],
			[
				"Calendar changed after this adjustment and could not be undone.",
				"conflict",
			],
			["PLANNING_OFFLINE", "offline"],
		] as const) {
			const service = new ElectrobunPlanningService(async () =>
				planningRpc({
					listPlans: async () => {
						throw new Error(message);
					},
				}),
			);
			try {
				await service.listPlans();
				expect.unreachable("Expected listPlans to reject");
			} catch (error) {
				expect(error).toBeInstanceOf(PlanningServiceError);
				expect((error as PlanningServiceError).code).toBe(code);
			}
		}
	});
});
