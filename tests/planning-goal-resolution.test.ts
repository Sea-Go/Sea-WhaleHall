import { describe, expect, test } from "bun:test";
import {
	composePendingTasksGoalText,
	resolvePlanningGoal,
} from "../src/bun/planning-goal-reconciler";
import { MAX_ACTIVE_GOAL_TEXT_LENGTH } from "../src/shared/goal-context";
import { at, block, NOW_MS, plan, task } from "./planning-goal-fixtures";

describe("resolvePlanningGoal", () => {
	test("uses the executing block's task while a committed block covers now", () => {
		const resolution = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [block()],
			plans: [
				plan({
					tasks: [task("task-1", "应用层第一遍"), task("task-2", "网络层")],
				}),
			],
		});

		expect(resolution).toEqual({
			tier: "executing-task",
			goal: {
				goalId: "task-1",
				planId: "plan-1",
				text: "应用层第一遍",
				activatedAtMs: Date.parse(at(10)),
			},
			planId: "plan-1",
			taskId: "task-1",
		});
	});

	test("prefers the earliest-starting block and ignores blocks outside now", () => {
		const tasks = [
			task("task-1", "最早"),
			task("task-2", "较晚"),
			task("task-3", "未开始"),
		];
		const resolution = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [
				block({ taskId: "task-2", start: at(10, 15) }),
				block({ taskId: "task-3", start: at(11), end: at(12) }),
				block({ taskId: "task-1", start: at(9, 45) }),
			],
			plans: [plan({ tasks })],
		});

		expect(resolution.tier).toBe("executing-task");
		expect(resolution.tier === "executing-task" && resolution.taskId).toBe(
			"task-1",
		);
	});

	test("falls back to the other pending tasks when the block's task is done", () => {
		const resolution = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [block()],
			plans: [
				plan({
					tasks: [
						task("task-1", "已完成的任务", "completed"),
						task("task-2", "网络层"),
					],
				}),
			],
		});

		expect(resolution.tier).toBe("pending-tasks");
		expect(resolution.goal?.text).toBe("待办任务：1. 网络层");
	});

	test("resolves no goal when the only plan is paused", () => {
		const resolution = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [block()],
			plans: [
				plan({ status: "paused", tasks: [task("task-1", "暂停中的任务")] }),
			],
		});

		expect(resolution).toEqual({
			tier: "none",
			goal: null,
			reason: "no-active-plan",
		});
	});

	test("skips a paused plan's block and uses the other active plan's tasks", () => {
		const resolution = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [block({ planId: "plan-paused", taskId: "task-p" })],
			plans: [
				plan({
					id: "plan-paused",
					status: "paused",
					tasks: [task("task-p", "暂停")],
				}),
				plan({ id: "plan-live", tasks: [task("task-l", "进行中的计划任务")] }),
			],
		});

		expect(resolution.tier).toBe("pending-tasks");
		expect(resolution.goal?.planId).toBe("plan-live");
		expect(resolution.goal?.text).toBe("待办任务：1. 进行中的计划任务");
	});

	test("lists pending tasks in schedule order followed by unscheduled ones", () => {
		const resolution = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [],
			plans: [
				plan({
					tasks: [
						task("task-a", "未排期"),
						task("task-b", "第二个排期"),
						task("task-c", "第一个排期"),
						task("task-d", "已跳过", "skipped"),
					],
					scheduledTaskIds: ["task-c", "task-b"],
				}),
			],
		});

		expect(resolution.goal?.text).toBe(
			"待办任务：1. 第一个排期；2. 第二个排期；3. 未排期",
		);
		expect(resolution.goal?.goalId).toBe("pending-tasks:plan-1");
		expect(resolution.goal?.activatedAtMs).toBe(NOW_MS);
	});

	test("combines several active plans under a deterministic identity", () => {
		const plans = [
			plan({ id: "plan-b", tasks: [task("task-b1", "乙")] }),
			plan({ id: "plan-a", tasks: [task("task-a1", "甲")] }),
		];
		const first = resolvePlanningGoal({ nowMs: NOW_MS, calendar: [], plans });
		const second = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [],
			plans: [...plans].reverse(),
		});

		expect(first.tier).toBe("pending-tasks");
		expect(first.goal?.planId).toBeNull();
		// Plans created at the same time keep the order of their ids.
		expect(first.goal?.text).toBe("待办任务：1. 甲；2. 乙");
		expect(first.goal?.goalId).toMatch(/^pending-tasks:[0-9a-f]{32}$/u);
		expect(second.goal).toEqual(first.goal);
		expect(
			resolvePlanningGoal({
				nowMs: NOW_MS,
				calendar: [],
				plans: [plan({ id: "plan-c", tasks: [task("task-c1", "丙")] })],
			}).goal?.goalId,
		).not.toBe(first.goal?.goalId);
	});

	test("orders several active plans by creation time, not by the store's list order", () => {
		const older = plan({
			id: "plan-newer-id",
			createdAt: "2026-11-20T09:00:00+08:00",
			tasks: [task("task-old", "较早创建的计划任务")],
		});
		const newer = plan({
			id: "plan-aaaa",
			createdAt: "2026-11-25T09:00:00+08:00",
			tasks: [task("task-new", "较晚创建的计划任务")],
		});
		const touched = { ...newer, updatedAt: "2026-11-26T10:29:00+08:00" };

		// The native store lists the most recently written plan first.
		const before = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [],
			plans: [newer, older],
		});
		const after = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [],
			plans: [touched, older],
		});

		expect(before.goal?.text).toBe(
			"待办任务：1. 较早创建的计划任务；2. 较晚创建的计划任务",
		);
		expect(after.goal).toEqual(before.goal);
	});

	test("strips control characters a task title may carry", () => {
		const resolution = resolvePlanningGoal({
			nowMs: NOW_MS,
			calendar: [],
			plans: [
				plan({ tasks: [task("task-1", "网络\u0007层\u001f\t\r\n基础")] }),
			],
		});

		expect(resolution.goal?.text).toBe("待办任务：1. 网络层 基础");
	});

	test("resolves no goal when nothing is active or nothing is pending", () => {
		expect(
			resolvePlanningGoal({ nowMs: NOW_MS, calendar: [], plans: [] }).tier,
		).toBe("none");
		expect(
			resolvePlanningGoal({
				nowMs: NOW_MS,
				calendar: [],
				plans: [
					plan({ status: "completed", tasks: [task("task-1", "已完成")] }),
				],
			}),
		).toEqual({ tier: "none", goal: null, reason: "no-active-plan" });
		expect(
			resolvePlanningGoal({
				nowMs: NOW_MS,
				calendar: [],
				plans: [plan({ tasks: [task("task-1", "已完成", "completed")] })],
			}),
		).toEqual({ tier: "none", goal: null, reason: "no-pending-tasks" });
	});

	test("caps the pending-task goal text at the goal length limit", () => {
		const longTitle = "很".repeat(600);
		const text = composePendingTasksGoalText([longTitle, longTitle, longTitle]);

		expect(Array.from(text).length).toBe(MAX_ACTIVE_GOAL_TEXT_LENGTH);
		expect(text.startsWith("待办任务：1. 很")).toBeTrue();
		expect(text.endsWith("…")).toBeTrue();
	});

	test("normalizes and caps the executing task's title like the pending ones", () => {
		const resolve = (title: string) =>
			resolvePlanningGoal({
				nowMs: NOW_MS,
				calendar: [block()],
				plans: [
					plan({ tasks: [task("task-1", title), task("task-2", "网络层")] }),
				],
			});

		const long = resolve("很".repeat(1_200));
		expect(long.tier).toBe("executing-task");
		expect(Array.from(long.goal?.text ?? "")).toHaveLength(
			MAX_ACTIVE_GOAL_TEXT_LENGTH,
		);
		expect(resolve("网络\u0007层\u001f\t\r\n基础").goal?.text).toBe(
			"网络层 基础",
		);

		// A title that leaves nothing printable cannot name the block's task.
		const blank = resolve("\u0007\u001f \t");
		expect(blank.tier).toBe("pending-tasks");
		expect(blank.goal?.text).toBe("待办任务：1. 网络层");
	});
});
