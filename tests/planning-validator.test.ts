import { describe, expect, test } from "bun:test";
import { validatePlanningDraft } from "../src/bun/planning-validator";
import type { CalendarSnapshot } from "../src/shared/calendar";
import type { TaskPlanningDraft, TaskPlanningInput } from "../src/shared/task-planning";

const input: TaskPlanningInput = {
	goal: "完成发布",
	planType: "short-term",
	deadline: "2026-08-07",
	priority: "high",
	weeklyCapacityHours: 4,
	unavailableDays: ["sunday"],
	preferredSessionMinutes: 60,
	preferredDayPart: "morning",
	timeZone: "Asia/Shanghai",
};

const calendar: CalendarSnapshot = {
	accountId: "account-1",
	revision: 4,
	timeZone: "Asia/Shanghai",
	fromDate: "2026-08-01",
	toDateExclusive: "2026-08-08",
	events: [],
};

function draft(patch: Partial<TaskPlanningDraft> = {}): TaskPlanningDraft {
	return {
		id: "plan-1",
		title: "发布计划",
		assumptions: [],
		calendarRevision: 4,
		phases: [{
			id: "phase-1",
			title: "交付阶段",
			objective: "完成交付",
			order: 1,
		}],
		milestones: [{
			id: "milestone-1",
			phaseId: "phase-1",
			title: "交付",
			description: "完成交付",
			targetDate: "2026-08-07",
			acceptanceCriteria: ["通过验收"],
		}],
		tasks: [{
			id: "task-1",
			milestoneId: "milestone-1",
			title: "实现",
			description: "完成实现",
			estimatedMinutes: 60,
			importance: "high",
			dependencies: [],
			completionCriteria: ["测试通过"],
		}],
		schedule: [{
			id: "proposal-1",
			taskId: "task-1",
			title: "实现",
			start: "2026-08-03T01:00:00Z",
			end: "2026-08-03T02:00:00Z",
			timeZone: "Asia/Shanghai",
		}],
		unscheduledTaskIds: [],
		...patch,
	};
}

describe("planning validator", () => {
	test("accepts exact model schedule against the current calendar revision", () => {
		expect(validatePlanningDraft(draft(), input, calendar)).toEqual({ ok: true, issues: [] });
	});

	test("reports stale revision and authoritative conflicts", () => {
		const busy = {
			...calendar,
			events: [{
				id: "busy-1",
				title: "不可用",
				kind: "manual-block" as const,
				state: "committed" as const,
				schedule: { allDay: false as const, start: "2026-08-03T01:30:00Z", end: "2026-08-03T02:30:00Z", timeZone: "Asia/Shanghai" },
				recurrence: null,
				occurrenceId: null,
				sourcePlanId: null,
				editable: true,
				version: 1,
			}],
		};
		const result = validatePlanningDraft(draft({ calendarRevision: 3 }), input, busy);
		expect(result.ok).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toContain("stale-calendar-revision");
		expect(result.issues.map((issue) => issue.code)).toContain("calendar-conflict");
	});

	test("does not invent a fallback for an unscheduled task", () => {
		const result = validatePlanningDraft(draft({ schedule: [] }), input, calendar);
		expect(result.issues).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: "duration-mismatch" }),
		]));
	});

	test("rejects proposals that overlap each other before calendar commit", () => {
		const result = validatePlanningDraft(draft({
			tasks: [
				...draft().tasks,
				{
					id: "task-2",
					milestoneId: "milestone-1",
					title: "验证",
					description: "完成验证",
					estimatedMinutes: 60,
					importance: "high",
					dependencies: ["task-1"],
					completionCriteria: ["验收通过"],
				},
			],
			schedule: [
				...draft().schedule,
				{
					id: "proposal-2",
					taskId: "task-2",
					title: "验证",
					start: "2026-08-03T01:30:00Z",
					end: "2026-08-03T02:30:00Z",
					timeZone: "Asia/Shanghai",
				},
			],
		}), input, calendar);

		expect(result.ok).toBe(false);
		expect(result.issues).toContainEqual(expect.objectContaining({
			code: "proposal-conflict",
			proposalId: "proposal-2",
			busyEventIds: ["proposal-1"],
		}));
	});
});
