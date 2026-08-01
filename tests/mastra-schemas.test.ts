import { describe, expect, test } from "bun:test";
import {
	planningWorkflowResumeSchema,
} from "../src/agent/mastra-host/planning-workflow";
import {
	taskPlanningInputSchema,
	taskPlanningResultSchema,
} from "../src/agent/mastra-host/schemas";

const validInput = {
	goal: "完成本地 Agent 重构",
	planType: "short-term" as const,
	deadline: "2026-08-31",
	priority: "high" as const,
	weeklyCapacityHours: 8,
	unavailableDays: ["sunday"] as Array<"sunday">,
	preferredSessionMinutes: 60 as const,
	preferredDayPart: "evening" as const,
	timeZone: "Asia/Shanghai",
};

describe("Mastra planning schemas", () => {
	test("accepts the bounded exact planning input", () => {
		expect(taskPlanningInputSchema.parse(validInput)).toEqual(validInput);
	});

	test("rejects unknown fields and out-of-bounds input", () => {
		expect(taskPlanningInputSchema.safeParse({
			...validInput,
			providerKey: "must-not-cross-boundary",
		}).success).toBe(false);
		expect(taskPlanningInputSchema.safeParse({
			...validInput,
			goal: "x".repeat(1_001),
		}).success).toBe(false);
		expect(taskPlanningInputSchema.safeParse({
			...validInput,
			weeklyCapacityHours: 41,
		}).success).toBe(false);
		expect(taskPlanningInputSchema.safeParse({
			...validInput,
			unavailableDays: ["holiday"],
		}).success).toBe(false);
	});

	test("rejects extra structured-output and resume fields", () => {
		expect(taskPlanningResultSchema.safeParse({
			status: "clarifying",
			questions: [{
				key: "scope",
				text: "范围是什么？",
				required: true,
				trace: "must-stay-local",
			}],
		}).success).toBe(false);
		expect(planningWorkflowResumeSchema.safeParse({
			sessionId: "planning-1",
			answers: [{ questionKey: "scope", answerText: "完整范围" }],
			extra: true,
		}).success).toBe(false);
		expect(planningWorkflowResumeSchema.safeParse({
			sessionId: "planning-1",
			answers: [{ questionKey: "scope", answerText: "x".repeat(4_001) }],
		}).success).toBe(false);
	});
});
