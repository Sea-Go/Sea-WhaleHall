import { describe, expect, test } from "bun:test";
import { sumObservationMinutesByTask } from "../src/agent/planning/observation-consumer";
import type { PlanObservationEvidence } from "../src/agent/planning/types";

function evidence(
	id: string,
	taskId: string,
	minutes: number,
): PlanObservationEvidence {
	return {
		id,
		observationId: `obs-${id}`,
		planId: "plan-1",
		taskId,
		startedAt: "2026-11-05T01:00:00Z",
		endedAt: "2026-11-05T02:00:00Z",
		relevantMinutes: minutes,
		confidence: 0.9,
		attribution: "unique-observed",
		recordedAt: "2026-11-05T02:00:00Z",
	};
}

describe("sumObservationMinutesByTask", () => {
	test("accumulates relevant minutes per task across multiple evidence rows", () => {
		const minutes = sumObservationMinutesByTask([
			evidence("e1", "task-a", 25),
			evidence("e2", "task-a", 15.5),
			evidence("e3", "task-b", 40),
		]);
		expect(minutes.get("task-a")).toBe(40.5);
		expect(minutes.get("task-b")).toBe(40);
	});

	test("tasks without evidence are absent from the result", () => {
		const minutes = sumObservationMinutesByTask([evidence("e1", "task-a", 10)]);
		expect(minutes.has("task-b")).toBe(false);
		expect(minutes.get("task-a")).toBe(10);
	});

	test("empty evidence yields an empty map", () => {
		expect(sumObservationMinutesByTask([]).size).toBe(0);
	});
});
