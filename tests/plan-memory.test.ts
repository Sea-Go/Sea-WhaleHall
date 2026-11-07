import { describe, expect, test } from "bun:test";
import { planMemoryHints } from "../src/agent/planning/plan-memory";
import type { PlanningPlan } from "../src/agent/planning/types";

function completedPlanFixture(overrides: {
	id: string;
	goal: string;
	tasks?: Array<{
		id: string;
		estimatedMinutes: number;
		status: "completed" | "skipped" | "pending";
		relevanceOverride?: "strong" | "weak" | null;
		relevance?: "strong" | "weak";
	}>;
	observationEvidence?: Array<{ taskId: string; relevantMinutes: number }>;
}): PlanningPlan {
	const tasks = (overrides.tasks ?? []).map((task) => ({
		id: task.id,
		planId: overrides.id,
		sourceKey: task.id,
		purpose: "execution" as const,
		title: `任务 ${task.id}`,
		description: "",
		estimatedMinutes: task.estimatedMinutes,
		dependencyTaskIds: [],
		status: task.status,
		statusChangedAt: null,
		statusChangedBy: null,
		...(task.relevanceOverride !== undefined
			? { relevanceOverride: task.relevanceOverride }
			: {}),
	}));
	const revision = {
		id: `revision-${overrides.id}`,
		planId: overrides.id,
		number: 1,
		parentRevisionId: null,
		trigger: "initial-analysis" as const,
		goal: overrides.goal,
		type: "short-term" as const,
		rationaleSummary: "摘要",
		assumptions: [],
		estimateId: "estimate-1",
		schedulingPreferences: {
			weeklyCapacityMinutes: 240,
			sessionMinutes: 60,
			availableWindows: [
				{ dayOfWeek: 6 as const, startTime: "09:00", endTime: "12:00" },
			],
		},
		tasks: tasks.map((task) => ({
			taskId: task.id,
			sourceKey: task.id,
			purpose: "execution" as const,
			title: `任务 ${task.id}`,
			description: "",
			estimatedMinutes: task.estimatedMinutes,
			dependencyTaskIds: [],
			...(overrides.tasks?.find((item) => item.id === task.id)?.relevance
				? {
						relevance: overrides.tasks.find((item) => item.id === task.id)
							?.relevance,
					}
				: {}),
		})),
		scheduleWindow: { startDate: "2026-08-14", endDateExclusive: "2026-08-21" },
		schedule: [],
		unscheduledTaskIds: [],
		createdAt: "2026-08-13T02:00:00Z",
	};
	return {
		id: overrides.id,
		accountId: "account-1",
		goal: overrides.goal,
		status: "completed",
		type: "short-term",
		version: 3,
		timeZone: "Asia/Shanghai",
		requestedStartToday: false,
		effectiveStartDate: "2026-08-14",
		analysisState: "ready",
		analysisDiagnostic: null,
		authorizedForObservations: false,
		tasks,
		estimates: [
			{
				id: "estimate-1",
				estimatedCompletionDate: "2026-09-30",
				confidence: 0.7,
				assessedAt: "2026-08-13T02:00:00Z",
				evidenceThrough: "2026-08-12",
				basis: "测试",
				modelVersion: "test",
			},
		],
		activeRevisionId: revision.id,
		proposedRevisionId: null,
		revisions: [revision],
		messages: [],
		observationEvidence: (overrides.observationEvidence ?? []).map(
			(item, index) => ({
				id: `obs-${index}`,
				observationId: `observation-${index}`,
				planId: overrides.id,
				taskId: item.taskId,
				startedAt: "2026-08-14T01:00:00Z",
				endedAt: "2026-08-14T02:00:00Z",
				relevantMinutes: item.relevantMinutes,
				confidence: 0.9,
				attribution: "user-confirmed" as const,
				recordedAt: "2026-08-14T02:00:00Z",
			}),
		),
		pendingObservationAttributions: [],
		adjustments: [],
		notifications: [],
		createdAt: "2026-08-13T01:00:00Z",
		updatedAt: "2026-09-30T00:00:00Z",
	} as unknown as PlanningPlan;
}

describe("plan memory", () => {
	test("returns null when no finished plans exist", () => {
		expect(
			planMemoryHints(
				[completedPlanFixture({ id: "p1", goal: "学钢琴" })],
				"p1",
				"学钢琴",
			),
		).toBeNull();
	});

	test("returns null when goals are dissimilar", () => {
		const history = completedPlanFixture({ id: "p1", goal: "跑完全马" });
		expect(planMemoryHints([history], "p2", "学习日语 N2")).toBeNull();
	});

	test("computes calibration ratio, weak skip rate and similar goals", () => {
		const history = completedPlanFixture({
			id: "p1",
			goal: "三个月准备半程马拉松",
			tasks: [
				{ id: "t1", estimatedMinutes: 60, status: "completed" },
				{
					id: "t2",
					estimatedMinutes: 60,
					status: "skipped",
					relevance: "weak",
				},
			],
			observationEvidence: [
				{ taskId: "t1", relevantMinutes: 90 },
				{ taskId: "t2", relevantMinutes: 30 },
			],
		});
		const hints = planMemoryHints([history], "p2", "十二周准备半程马拉松");
		expect(hints).not.toBeNull();
		expect(hints!.similarPlanCount).toBe(1);
		// 中位数 of [90/60, 30/60] = 1.0；样本量 2。
		expect(hints!.estimateCalibrationRatio).toBeCloseTo(1.0);
		expect(hints!.calibrationSamples).toBe(2);
		// 唯一弱任务被舍弃 → 舍弃率 1。
		expect(hints!.weakSkipRate).toBe(1);
		expect(hints!.similarGoals).toEqual(["三个月准备半程马拉松"]);
	});

	test("respects relevanceOverride in weak classification and current plan exclusion", () => {
		const history = completedPlanFixture({
			id: "p1",
			goal: "准备半程马拉松",
			tasks: [
				{
					id: "t1",
					estimatedMinutes: 60,
					status: "completed",
					relevanceOverride: "weak",
				},
			],
		});
		const hints = planMemoryHints([history], history.id, "半程马拉松");
		expect(hints).toBeNull(); // 当前计划自身被排除 → 无历史
		const other = completedPlanFixture({ id: "p2", goal: "完全无关的目标" });
		const hints2 = planMemoryHints([history, other], "p3", "半程马拉松 训练");
		expect(hints2).not.toBeNull();
		expect(hints2!.overrideCount).toBe(1);
		expect(hints2!.weakSkipRate).toBe(0); // 弱任务被完成而非舍弃
	});
});
