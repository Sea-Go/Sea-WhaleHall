import { describe, expect, test } from "bun:test";
import type { LocalPlanningCalendarEvent } from "../src/agent/local-protocol";
import type {
	PlanningPlan,
	PlanRevision,
	PlanStatus,
	PlanTask,
	PlanTaskStatus,
} from "../src/agent/planning";
import {
	type CurrentPlanningGoal,
	composePendingTasksGoalText,
	PlanningGoalReconciler,
	resolvePlanningGoal,
} from "../src/bun/planning-goal-reconciler";
import { MAX_ACTIVE_GOAL_TEXT_LENGTH } from "../src/shared/goal-context";

const NOW_MS = Date.parse("2026-11-26T10:30:00+08:00");
const at = (hour: number, minute = 0): string =>
	`2026-11-26T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`;

function task(
	id: string,
	title: string,
	status: PlanTaskStatus = "pending",
): PlanTask {
	return {
		id,
		planId: "plan-1",
		sourceKey: id,
		purpose: "execution",
		title,
		description: "",
		estimatedMinutes: 45,
		dependencyTaskIds: [],
		status,
		statusChangedAt: null,
		statusChangedBy: "user",
	};
}

function plan(input: {
	id?: string;
	status?: PlanStatus;
	tasks?: PlanTask[];
	scheduledTaskIds?: readonly string[];
}): PlanningPlan {
	const id = input.id ?? "plan-1";
	const tasks = input.tasks ?? [];
	const scheduledTaskIds = input.scheduledTaskIds ?? [];
	const revision: PlanRevision = {
		id: `${id}-revision-1`,
		planId: id,
		number: 1,
		parentRevisionId: null,
		trigger: "confirmation",
		goal: "学会计算机网络",
		type: "long-term",
		rationaleSummary: "",
		assumptions: [],
		estimateId: `${id}-estimate-1`,
		schedulingPreferences: {
			weeklyCapacityMinutes: 300,
			sessionMinutes: 90,
			availableWindows: [],
		},
		tasks: [],
		scheduleWindow: { startDate: "2026-11-26", endDateExclusive: "2026-12-31" },
		schedule: scheduledTaskIds.map((taskId, index) => ({
			id: `${id}-event-${index}`,
			planId: id,
			taskId,
			title: "计划任务",
			start: at(20 + index),
			end: at(21, 30),
			timeZone: "Asia/Shanghai",
		})),
		unscheduledTaskIds: tasks
			.map((item) => item.id)
			.filter((taskId) => !scheduledTaskIds.includes(taskId)),
		createdAt: "2026-11-26T09:00:00+08:00",
	};
	return {
		id,
		goal: "学会计算机网络",
		requestedStartToday: false,
		timeZone: "Asia/Shanghai",
		effectiveStartDate: "2026-11-26",
		type: "long-term",
		status: input.status ?? "active",
		analysisState: "ready",
		analysisDiagnostic: null,
		pendingAnalysis: null,
		autoAdjustAuthorized: true,
		version: 1,
		createdAt: "2026-11-26T09:00:00+08:00",
		updatedAt: "2026-11-26T09:00:00+08:00",
		activeRevisionId: revision.id,
		proposedRevisionId: null,
		revisions: [revision],
		estimates: [],
		tasks: tasks.map((item) => ({ ...item, planId: id })),
		messages: [],
		observationEvidence: [],
		pendingObservationAttributions: [],
		adjustments: [],
		dailySummaryDates: [],
	};
}

function block(
	input: {
		planId?: string;
		taskId?: string;
		state?: LocalPlanningCalendarEvent["state"];
		start?: string;
		end?: string;
	} = {},
): LocalPlanningCalendarEvent {
	return {
		schemaVersion: "calendar.v1",
		eventId: `event-${input.taskId ?? "task"}`,
		title: "计划任务",
		sealedContentRef: null,
		redactedContent: false,
		kind: "plan",
		state: input.state ?? "committed",
		schedule: {
			allDay: false,
			start: input.start ?? at(10),
			end: input.end ?? at(11, 30),
			timeZone: "Asia/Shanghai",
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: input.planId ?? "plan-1",
		sourceTaskId: input.taskId ?? "task-1",
		scheduleOrigin: "model",
		userLocked: false,
		editable: true,
		version: 1,
	};
}

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
		const second = resolvePlanningGoal({ nowMs: NOW_MS, calendar: [], plans });

		expect(first.tier).toBe("pending-tasks");
		expect(first.goal?.planId).toBeNull();
		expect(first.goal?.text).toBe("待办任务：1. 乙；2. 甲");
		expect(first.goal?.goalId).toMatch(/^pending-tasks:[0-9a-f]{32}$/u);
		expect(second.goal?.goalId).toBe(first.goal?.goalId);
		expect(
			resolvePlanningGoal({
				nowMs: NOW_MS,
				calendar: [],
				plans: [plan({ id: "plan-c", tasks: [task("task-c1", "丙")] })],
			}).goal?.goalId,
		).not.toBe(first.goal?.goalId);
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
});

function harness(input: { current?: CurrentPlanningGoal | null } = {}) {
	let current: CurrentPlanningGoal | null = input.current ?? null;
	let nowMs = NOW_MS;
	let planLoads = 0;
	const applied: Array<Record<string, unknown> | null> = [];
	let changes = 0;
	const diag: string[] = [];
	const reconciler = new PlanningGoalReconciler({
		loadCalendar: async () => [],
		loadPlans: async () => {
			planLoads += 1;
			return [plan({ tasks: [task("task-1", "应用层第一遍")] })];
		},
		currentGoal: () => current && { ...current },
		applyGoal: async (goal) => {
			applied.push(goal && { ...goal });
			current =
				goal === null
					? null
					: {
							goalId: goal.goalId,
							planId: goal.planId,
							text: goal.text,
							activatedAtMs: goal.activatedAtMs,
						};
			return current && { ...current };
		},
		afterChange: () => {
			changes += 1;
		},
		diag: (line) => diag.push(line),
		nowMs: () => nowMs,
		planCacheTtlMs: 60_000,
	});
	return {
		reconciler,
		applied,
		diag,
		advance: (ms: number) => {
			nowMs += ms;
		},
		current: () => current,
		changes: () => changes,
		planLoads: () => planLoads,
	};
}

describe("PlanningGoalReconciler", () => {
	test("applies the resolved goal and reports each state only once", async () => {
		const state = harness();

		expect(await state.reconciler.reconcile()).toMatchObject({
			tier: "pending-tasks",
		});
		await state.reconciler.reconcile();

		expect(state.applied).toHaveLength(2);
		expect(state.applied[0]).toEqual(state.applied[1]);
		expect(state.changes()).toBe(1);
		expect(state.diag).toEqual([
			"[planning-goal] tier=pending-tasks plans=1 tasks=1",
		]);
	});

	test("does not touch the runtime when there is no goal to clear", async () => {
		const resolution = await new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: async () => [],
			currentGoal: () => null,
			applyGoal: async () => {
				throw new Error("must not be called");
			},
		}).reconcile();

		expect(resolution).toEqual({
			tier: "none",
			goal: null,
			reason: "no-active-plan",
		});
	});

	test("clears the goal once no plan is active any more", async () => {
		const applied: Array<Record<string, unknown> | null> = [];
		let changes = 0;
		const resolution = await new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: async () => [],
			currentGoal: () => ({
				goalId: "pending-tasks:plan-1",
				planId: "plan-1",
				text: "待办任务：1. 应用层第一遍",
				activatedAtMs: NOW_MS - 60_000,
			}),
			applyGoal: async (goal) => {
				applied.push(goal && { ...goal });
				return null;
			},
			afterChange: () => {
				changes += 1;
			},
			nowMs: () => NOW_MS,
		}).reconcile();

		expect(resolution).toEqual({
			tier: "none",
			goal: null,
			reason: "no-active-plan",
		});
		expect(applied).toEqual([null]);
		expect(changes).toBe(1);
	});

	test("keeps the current goal and reports unavailable when plans cannot load", async () => {
		let fail = false;
		const diag: string[] = [];
		const applied: Array<Record<string, unknown> | null> = [];
		const current: CurrentPlanningGoal = {
			goalId: "pending-tasks:plan-1",
			planId: "plan-1",
			text: "待办任务：1. 应用层第一遍",
			activatedAtMs: NOW_MS - 60_000,
		};
		const reconciler = new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: async () => {
				if (fail) throw new Error("vault key unavailable");
				return [plan({ tasks: [task("task-1", "应用层第一遍")] })];
			},
			currentGoal: () => ({ ...current }),
			applyGoal: async (goal) => {
				applied.push(goal && { ...goal });
				return current;
			},
			diag: (line) => diag.push(line),
			nowMs: () => NOW_MS,
		});

		await reconciler.reconcile();
		reconciler.invalidate();
		fail = true;
		reconciler.invalidate();
		expect(await reconciler.reconcile()).toEqual({
			tier: "unavailable",
			goal: null,
		});
		await reconciler.reconcile();

		expect(applied).toHaveLength(1);
		expect(diag).toEqual([
			"[planning-goal] tier=pending-tasks plans=1 tasks=1",
			"[planning-goal] tier=unavailable error=Error",
		]);
	});

	test("reuses the cached plan list until it is invalidated or expires", async () => {
		const state = harness();

		await state.reconciler.reconcile();
		await state.reconciler.reconcile();
		expect(state.planLoads()).toBe(1);

		state.advance(30_000);
		await state.reconciler.reconcile();
		expect(state.planLoads()).toBe(1);

		state.reconciler.invalidate();
		await state.reconciler.reconcile();
		expect(state.planLoads()).toBe(2);

		state.advance(61_000);
		await state.reconciler.reconcile();
		expect(state.planLoads()).toBe(3);
	});

	test("never moves the goal activation time backwards", async () => {
		const current: CurrentPlanningGoal = {
			goalId: "pending-tasks:plan-1",
			planId: "plan-1",
			text: "待办任务：1. 应用层第一遍",
			activatedAtMs: NOW_MS,
		};
		const applied: Array<Record<string, unknown> | null> = [];
		const reconciler = new PlanningGoalReconciler({
			loadCalendar: async () => [block()],
			loadPlans: async () => [
				plan({ tasks: [task("task-1", "应用层第一遍")] }),
			],
			currentGoal: () => ({ ...current }),
			applyGoal: async (goal) => {
				applied.push(goal && { ...goal });
				return current;
			},
			nowMs: () => NOW_MS,
		});

		await reconciler.reconcile();

		expect(applied[0]?.activatedAtMs).toBe(NOW_MS);
	});
});
