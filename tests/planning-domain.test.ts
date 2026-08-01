import { describe, expect, test } from "bun:test";
import {
	detectPlanningConflicts,
	emptyPlanInput,
	planHasBlockingConflicts,
	validatePlanInput,
	type PlanningBusyWindow,
	type ProposedScheduleItem,
} from "../src/views/client/features/planning/domain";

function proposal(
	overrides: Partial<ProposedScheduleItem> = {},
): ProposedScheduleItem {
	return {
		id: "proposal-1",
		sourcePlanId: "plan-1",
		taskId: "task-1",
		title: "完成核心任务",
		state: "proposed",
		start: "2026-07-30T01:00:00Z",
		end: "2026-07-30T02:00:00Z",
		timeZone: "Asia/Shanghai",
		version: 0,
		...overrides,
	};
}

describe("planning domain", () => {
	test("validates progressive minimum input without requiring a long form", () => {
		expect(validatePlanInput(emptyPlanInput(), "2026-07-29")).toEqual([
			expect.objectContaining({ field: "goal" }),
			expect.objectContaining({ field: "type" }),
			expect.objectContaining({ field: "deadline" }),
		]);
		const valid = {
			...emptyPlanInput(),
			goal: "完成个人作品集",
			type: "long-term" as const,
			deadline: "2026-09-01",
		};
		expect(validatePlanInput(valid, "2026-07-29")).toEqual([]);
	});

	test("bounds goal text before it enters the local reflection context", () => {
		const oversized = {
			...emptyPlanInput(),
			goal: "鲸".repeat(1_001),
			type: "long-term" as const,
			deadline: "2026-09-01",
		};
		expect(validatePlanInput(oversized, "2026-07-29")).toContainEqual(
			expect.objectContaining({
				field: "goal",
				message: expect.stringContaining("1000"),
			}),
		);
	});

	test("distinguishes blocking unavailable time from a committed-plan warning", () => {
		const windows: PlanningBusyWindow[] = [
			{
				id: "manual",
				title: "家庭时间",
				kind: "manual-block",
				start: "2026-07-30T01:30:00Z",
				end: "2026-07-30T02:30:00Z",
				timeZone: "Asia/Shanghai",
			},
			{
				id: "committed",
				title: "已有学习计划",
				kind: "committed-plan",
				start: "2026-07-31T01:30:00Z",
				end: "2026-07-31T02:30:00Z",
				timeZone: "Asia/Shanghai",
			},
		];
		const conflicts = detectPlanningConflicts(
			[
				proposal(),
				proposal({
					id: "proposal-2",
					start: "2026-07-31T01:00:00Z",
					end: "2026-07-31T02:00:00Z",
				}),
			],
			windows,
		);
		expect(conflicts.map((item) => item.severity)).toEqual([
			"error",
			"warning",
		]);
		expect(planHasBlockingConflicts(conflicts)).toBe(true);
	});

	test("rejects schedule items shorter than 15 minutes", () => {
		const conflicts = detectPlanningConflicts(
			[
				proposal({
					end: "2026-07-30T01:10:00Z",
				}),
			],
			[],
		);
		expect(conflicts[0]).toMatchObject({
			reason: "invalid-duration",
			severity: "error",
		});
	});
});
