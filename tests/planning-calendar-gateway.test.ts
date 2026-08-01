import { describe, expect, test } from "bun:test";
import { CalendarPlanningGateway } from "../src/views/client/infrastructure/planning/CalendarPlanningGateway";
import { MockCalendarService } from "../src/views/client/infrastructure/calendar/MockCalendarService";
import type {
	Plan,
	ProposedScheduleItem,
} from "../src/views/client/features/planning/domain";

const plan: Plan = {
	id: "plan-gateway",
	type: "short-term",
	title: "完成提案",
	goal: "完成提案",
	deadline: "2026-08-05",
	priority: "high",
	weeklyCapacityHours: 5,
	totalEstimatedMinutes: 60,
	phases: [{ id: "phase", title: "推进", objective: "完成", order: 1 }],
	milestones: [],
	tasks: [
		{
			id: "task",
			phaseId: "phase",
			milestoneId: null,
			title: "撰写提案",
			estimatedMinutes: 60,
		},
	],
	scheduleWindow: {
		startDate: "2026-07-29",
		endDateExclusive: "2026-08-05",
	},
	generationRun: {
		id: "run",
		startedAt: "2026-07-29T00:00:00Z",
		completedAt: "2026-07-29T00:00:01Z",
		statuses: ["ready"],
		revision: 1,
	},
};

const proposal: ProposedScheduleItem = {
	id: "proposal-gateway",
	sourcePlanId: plan.id,
	taskId: "task",
	title: "撰写提案",
	state: "proposed",
	start: "2026-08-01T11:00:00Z",
	end: "2026-08-01T12:00:00Z",
	timeZone: "Asia/Shanghai",
	version: 0,
};

describe("CalendarPlanningGateway", () => {
	test("reads committed calendar events as availability without writing proposals", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const gateway = new CalendarPlanningGateway(service, () => "mutation");
		const before = await service.load();
		const availability = await gateway.loadAvailability({
			startDate: "2026-07-29",
			endDateExclusive: "2026-08-05",
			timeZone: "Asia/Shanghai",
		});
		const after = await service.load();
		expect(availability.some((item) => item.kind === "manual-block")).toBe(true);
		expect(availability.some((item) => item.kind === "external")).toBe(true);
		expect(after.events).toEqual(before.events);
		expect(after.events.some((event) => event.id === proposal.id)).toBe(false);
	});

	test("converts proposed items to committed calendar events only on apply", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const gateway = new CalendarPlanningGateway(service, () => "mutation");
		const result = await gateway.applyPlan(plan, [proposal], "apply-1");
		expect(result.ok).toBe(true);
		const calendar = await service.load();
		expect(
			calendar.events.find((event) => event.id === proposal.id),
		).toMatchObject({
			state: "committed",
			sourcePlanId: plan.id,
			title: proposal.title,
		});
	});
});
