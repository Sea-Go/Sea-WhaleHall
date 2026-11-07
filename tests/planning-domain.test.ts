import { describe, expect, test } from "bun:test";
import {
	emptyPlanCreateInput,
	isPlanRevisionConfirmable,
	isSevenDayScheduleWindow,
	type PlanningTaskView,
	type PlanView,
	planTaskProgress,
	validatePlanCreateInput,
} from "../src/views/client/features/planning/domain";

function task(
	id: string,
	status: PlanningTaskView["status"],
): PlanningTaskView {
	return {
		id,
		title: `任务 ${id}`,
		description: null,
		purpose: "execution",
		status,
		estimatedMinutes: 60,
		actualMinutes: 0,
		dependencyIds: [],
		schedules: [],
		unplanned: null,
		relevance: null,
		relevanceReason: null,
	};
}

function confirmablePlan(): PlanView {
	const tasks = [task("task-1", "pending")];
	return {
		id: "plan-1",
		title: "建立稳定作品集",
		goal: "完成一套可以用于求职的作品集",
		status: "awaiting-confirmation",
		type: null,
		version: 3,
		timeZone: "Asia/Shanghai",
		startToday: false,
		effectiveDate: null,
		estimate: {
			estimatedCompletionDate: "2026-10-30",
			confidence: "low",
			assessedAt: "2026-08-13T02:00:00Z",
			evidenceThrough: null,
			basis: "先用一周验证稳定产出速度。",
			modelVersion: "qwen3:4b",
		},
		revision: {
			revisionId: "revision-3",
			version: 3,
			status: "proposed",
			createdAt: "2026-08-13T02:00:00Z",
			goal: "完成一套可以用于求职的作品集",
			summary: "先验证作品生产节奏。",
			reasoningSummary: "路径还不稳定。",
			planType: "fuzzy",
			estimate: {
				estimatedCompletionDate: "2026-10-30",
				confidence: "low",
				assessedAt: "2026-08-13T02:00:00Z",
				evidenceThrough: null,
				basis: "先用一周验证稳定产出速度。",
				modelVersion: "qwen3:4b",
			},
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
			assumptions: [],
			questions: [],
			tasks,
			evaluations: null,
		},
		messages: [],
		tasks,
		monitoring: {
			authorized: false,
			enabled: false,
			mode: "manual-only",
			coverage: "unavailable",
			message: "未授权活动监测。",
		},
		pendingObservations: [],
		adjustments: [],
		notifications: [],
		updatedAt: "2026-08-13T02:00:00Z",
	};
}

describe("planning domain", () => {
	test("creation only requires a goal and starts tomorrow by default", () => {
		expect(emptyPlanCreateInput()).toEqual({ goal: "", startToday: false });
		expect(validatePlanCreateInput(emptyPlanCreateInput())).toEqual([
			expect.objectContaining({ field: "goal" }),
		]);
		expect(
			validatePlanCreateInput({
				goal: "完成个人作品集",
				startToday: false,
			}),
		).toEqual([]);
	});

	test("bounds sensitive goal content before persistence", () => {
		expect(
			validatePlanCreateInput({ goal: "鲸".repeat(1_001), startToday: true }),
		).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("1000") }),
		);
	});
});
