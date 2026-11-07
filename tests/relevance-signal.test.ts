import { describe, expect, test } from "bun:test";
import {
	deriveRelevanceHints,
	type RelevanceSignalTaskInput,
} from "../src/agent/planning/relevance-signal";
import type { PlanMemoryHints } from "../src/agent/planning/plan-memory";

function taskInput(
	overrides: Partial<RelevanceSignalTaskInput> & { taskId: string },
): RelevanceSignalTaskInput {
	return {
		sourceKey: `key-${overrides.taskId}`,
		estimatedMinutes: 60,
		dependencyTaskIds: [],
		status: "pending",
		baseRelevance: "strong",
		...overrides,
	};
}

const hints: PlanMemoryHints = {
	similarPlanCount: 3,
	estimateCalibrationRatio: null,
	calibrationSamples: 10,
	weakSkipRate: null,
	overrideCount: 0,
	similarGoals: [],
};

function emptyMap(): Map<string, number> {
	return new Map();
}

describe("deriveRelevanceHints", () => {
	test("tasks depended on by two or more pending tasks are suggested strong", () => {
		const tasks = [
			taskInput({ taskId: "a", baseRelevance: "weak" }),
			taskInput({ taskId: "b", dependencyTaskIds: ["a"] }),
			taskInput({ taskId: "c", dependencyTaskIds: ["a"] }),
		];
		const result = deriveRelevanceHints(tasks, {
			memoryHints: null,
			sessionMinutes: null,
		});
		const a = result.find((hint) => hint.taskKey === "key-a")!;
		expect(a.suggested).toBe("strong");
		expect(a.reason).toContain("被 2 个未完成任务依赖");
		// 只被 1 个任务依赖不触发升级规则（阈值 2），基线分级保持不变。
		const b = result.find((hint) => hint.taskKey === "key-b")!;
		expect(b.suggested).toBe("strong");
		expect(b.reason).toBe("无确定性信号，沿用基线分级");
	});

	test("high weak-skip rate with enough calibration samples demotes to weak", () => {
		const result = deriveRelevanceHints(
			[taskInput({ taskId: "a" })],
			{
				memoryHints: { ...hints, weakSkipRate: 0.6, calibrationSamples: 10 },
				sessionMinutes: null,
			},
		);
		expect(result[0]!.suggested).toBe("weak");
		expect(result[0]!.reason).toContain("舍弃率 60%");
	});

	test("weak-skip demotion requires a minimum calibration sample size", () => {
		const result = deriveRelevanceHints(
			[taskInput({ taskId: "a" })],
			{
				memoryHints: { ...hints, weakSkipRate: 0.9, calibrationSamples: 3 },
				sessionMinutes: null,
			},
		);
		expect(result[0]!.suggested).toBe("strong");
		expect(result[0]!.reason).toBe("无确定性信号，沿用基线分级");
	});

	test("dependency upgrade wins over the skip-rate demotion tendency", () => {
		const result = deriveRelevanceHints(
			[
				taskInput({ taskId: "a", baseRelevance: "weak" }),
				taskInput({ taskId: "b", dependencyTaskIds: ["a"], status: "pending" }),
				taskInput({ taskId: "c", dependencyTaskIds: ["a"], status: "pending" }),
			],
			{
				memoryHints: { ...hints, weakSkipRate: 0.8, calibrationSamples: 20 },
				sessionMinutes: null,
			},
		);
		const a = result.find((hint) => hint.taskKey === "key-a")!;
		expect(a.suggested).toBe("strong");
		expect(a.reason).toContain("被 2 个未完成任务依赖");
	});

	test("non-pending dependents do not produce an upgrade signal", () => {
		const result = deriveRelevanceHints(
			[
				taskInput({ taskId: "a", baseRelevance: "weak" }),
				taskInput({ taskId: "b", dependencyTaskIds: ["a"], status: "completed" }),
			],
			{ memoryHints: null, sessionMinutes: null },
		);
		const a = result.find((hint) => hint.taskKey === "key-a")!;
		expect(a.suggested).toBe("weak");
		expect(a.reason).toBe("无确定性信号，沿用基线分级");
	});

	test("oversized tasks get a split suggestion without changing the grade", () => {
		const result = deriveRelevanceHints(
			[taskInput({ taskId: "a", estimatedMinutes: 240 })],
			{ memoryHints: null, sessionMinutes: 90 },
		);
		expect(result[0]!.suggested).toBe("strong");
		expect(result[0]!.reason).toContain("建议拆分");
	});

	test("hints map registry task ids to source keys", () => {
		const result = deriveRelevanceHints(
			[taskInput({ taskId: "task-7", sourceKey: "ch01-exercises" })],
			{ memoryHints: null, sessionMinutes: null },
		);
		expect(result[0]!.taskKey).toBe("ch01-exercises");
	});

	test("empty task list yields no hints", () => {
		expect(
			deriveRelevanceHints([], { memoryHints: hints, sessionMinutes: 60 }),
		).toEqual([]);
		expect(emptyMap().size).toBe(0);
	});
});
