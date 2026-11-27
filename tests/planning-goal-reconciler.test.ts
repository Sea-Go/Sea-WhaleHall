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
	MAX_SUPERSEDED_PLAN_LOADS,
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
	createdAt?: string;
}): PlanningPlan {
	const id = input.id ?? "plan-1";
	const tasks = input.tasks ?? [];
	const scheduledTaskIds = input.scheduledTaskIds ?? [];
	const createdAt = input.createdAt ?? "2026-11-26T09:00:00+08:00";
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
		createdAt,
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
		expect(resolve("网络\u0007层\u001f\t\r\n基础").goal?.text).toBe("网络层 基础");

		// A title that leaves nothing printable cannot name the block's task.
		const blank = resolve("\u0007\u001f \t");
		expect(blank.tier).toBe("pending-tasks");
		expect(blank.goal?.text).toBe("待办任务：1. 网络层");
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
			stage: "lookup",
		});
		await reconciler.reconcile();

		expect(applied).toHaveLength(1);
		expect(diag).toEqual([
			"[planning-goal] tier=pending-tasks plans=1 tasks=1",
			'[planning-goal] tier=unavailable stage=lookup error=Error message="vault key unavailable"',
		]);
	});

	test("keeps the current goal and reports a failed goal write", async () => {
		let fail = true;
		const diag: string[] = [];
		const applied: Array<Record<string, unknown> | null> = [];
		const current: CurrentPlanningGoal = {
			goalId: "task-old",
			planId: "plan-1",
			text: "上一个任务",
			activatedAtMs: NOW_MS - 60_000,
		};
		const reconciler = new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: async () => [
				plan({ tasks: [task("task-1", "应用层第一遍")] }),
			],
			currentGoal: () => ({ ...current }),
			applyGoal: async (goal) => {
				if (fail)
					throw new Error("goal text must contain printable characters");
				applied.push(goal && { ...goal });
				return current;
			},
			diag: (line) => diag.push(line),
			nowMs: () => NOW_MS,
		});

		expect(await reconciler.reconcile()).toEqual({
			tier: "unavailable",
			goal: null,
			stage: "apply",
		});
		expect(applied).toHaveLength(0);
		// The same failure is reported once; a recovery is reported again.
		expect(await reconciler.reconcile()).toMatchObject({ tier: "unavailable" });
		fail = false;
		expect(await reconciler.reconcile()).toMatchObject({
			tier: "pending-tasks",
		});

		expect(applied).toHaveLength(1);
		expect(diag).toEqual([
			'[planning-goal] tier=unavailable stage=apply error=Error message="goal text must contain printable characters"',
			"[planning-goal] tier=pending-tasks plans=1 tasks=1",
		]);
	});

	test("keeps the resolution when the timeline pull fails", async () => {
		const diag: string[] = [];
		const reconciler = new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: async () => [
				plan({ tasks: [task("task-1", "应用层第一遍")] }),
			],
			currentGoal: () => null,
			applyGoal: async (goal) => {
				return goal && { ...goal, activatedAtMs: goal.activatedAtMs };
			},
			afterChange: () => {
				throw new Error("DesktopReflectionService is shutting down.");
			},
			diag: (line) => diag.push(line),
			nowMs: () => NOW_MS,
		});

		expect(await reconciler.reconcile()).toMatchObject({
			tier: "pending-tasks",
		});
		expect(diag).toEqual([
			'[planning-goal] pull-failed error=Error message="DesktopReflectionService is shutting down."',
			"[planning-goal] tier=pending-tasks plans=1 tasks=1",
		]);
	});

	test("reloads plans when a write lands during a load", async () => {
		function deferred<T>() {
			let resolve!: (value: T) => void;
			const promise = new Promise<T>((done) => {
				resolve = done;
			});
			return { promise, resolve };
		}
		let planLoads = 0;
		let title = "旧标题";
		const started = deferred<void>();
		const vault = deferred<void>();
		const applied: string[] = [];
		// The reflection service appends nothing for an unchanged goal.
		const record = (text: string) => {
			if (text !== applied.at(-1)) applied.push(text);
		};
		const reconciler = new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: () => {
				planLoads += 1;
				// The rows are read before the write; the vault RPCs settle later.
				const rows = [plan({ tasks: [task("task-1", title)] })];
				started.resolve();
				return vault.promise.then(() => rows);
			},
			currentGoal: () => null,
			applyGoal: async (goal) => {
				if (goal) record(goal.text);
				return goal && { ...goal, activatedAtMs: goal.activatedAtMs };
			},
			nowMs: () => NOW_MS,
			planCacheTtlMs: 60_000,
		});

		const inFlight = reconciler.reconcile();
		await started.promise;
		title = "新标题";
		reconciler.invalidate();
		vault.resolve();
		const superseded = await inFlight;
		const next = await reconciler.reconcile();

		// Rows read before the write are never applied: that would put the
		// goal back for a minute and cost two goal changes.
		expect(planLoads).toBe(2);
		expect(applied).toEqual(["待办任务：1. 新标题"]);
		expect(superseded.goal?.text).toBe("待办任务：1. 新标题");
		expect(next.goal?.text).toBe("待办任务：1. 新标题");
	});

	test("applies the last rows it read when writes outlast its repeated loads", async () => {
		function deferred() {
			let resolve!: () => void;
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			return { promise, resolve };
		}
		let planLoads = 0;
		const started: Array<{ promise: Promise<void>; resolve: () => void }> = [];
		const applied: string[] = [];
		const reconciler = new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: () => {
				planLoads += 1;
				// Every load is read before the next write lands.
				const rows = [
					plan({ tasks: [task("task-1", `第 ${planLoads} 次读到的标题`)] }),
				];
				const gate = deferred();
				started.push(gate);
				return gate.promise.then(() => rows);
			},
			currentGoal: () => null,
			applyGoal: async (goal) => {
				if (goal) applied.push(goal.text);
				return goal && { ...goal, activatedAtMs: goal.activatedAtMs };
			},
			nowMs: () => NOW_MS,
			planCacheTtlMs: 60_000,
		});

		const inFlight = reconciler.reconcile();
		for (let write = 0; write <= MAX_SUPERSEDED_PLAN_LOADS; write += 1) {
			// The load released by the previous iteration reaches its own gate.
			while (started.length <= write) {
				await new Promise<void>((done) => setTimeout(done, 0));
			}
			reconciler.invalidate();
			started[write]?.resolve();
		}
		const result = await inFlight;

		expect(planLoads).toBe(MAX_SUPERSEDED_PLAN_LOADS + 1);
		expect(applied).toEqual([
			`待办任务：1. 第 ${MAX_SUPERSEDED_PLAN_LOADS + 1} 次读到的标题`,
		]);
		expect(result.tier).toBe("pending-tasks");
	});

	test("reconciles once for the plan changes notified in one turn", async () => {
		let planLoads = 0;
		const applied: string[] = [];
		const reconciler = new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: async () => {
				planLoads += 1;
				return [plan({ tasks: [task("task-1", "写周报")] })];
			},
			currentGoal: () => null,
			applyGoal: async (goal) => {
				if (goal) applied.push(goal.text);
				return goal && { ...goal, activatedAtMs: goal.activatedAtMs };
			},
			nowMs: () => NOW_MS,
		});

		// One outbox turn reports three changes.
		for (let change = 0; change < 3; change += 1) {
			reconciler.invalidate();
			reconciler.schedule();
		}
		expect(planLoads).toBe(0);
		await new Promise<void>((done) => setTimeout(done, 0));

		expect(planLoads).toBe(1);
		expect(applied).toEqual(["待办任务：1. 写周报"]);
	});

	test("sets no goal and clears a leftover one while signed out", async () => {
		let signedIn = true;
		let planLoads = 0;
		const applied: Array<Record<string, unknown> | null> = [];
		let current: CurrentPlanningGoal | null = {
			goalId: "pending-tasks:plan-1",
			planId: "plan-1",
			text: "待办任务：1. 应用层第一遍",
			activatedAtMs: NOW_MS - 60_000,
		};
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
				current = goal && { ...goal, activatedAtMs: goal.activatedAtMs };
				return current && { ...current };
			},
			sessionToken: () => (signedIn ? 1 : null),
			diag: (line) => diag.push(line),
			nowMs: () => NOW_MS,
		});

		signedIn = false;
		expect(await reconciler.reconcile()).toEqual({
			tier: "signed-out",
			goal: null,
		});
		expect(await reconciler.reconcile()).toEqual({
			tier: "signed-out",
			goal: null,
		});
		expect(applied).toEqual([null]);
		expect(planLoads).toBe(0);

		signedIn = true;
		expect(await reconciler.reconcile()).toMatchObject({
			tier: "pending-tasks",
		});
		expect(current?.text).toBe("待办任务：1. 应用层第一遍");
		expect(diag).toEqual([
			"[planning-goal] tier=signed-out",
			"[planning-goal] tier=pending-tasks plans=1 tasks=1",
		]);
	});

	test("sets no goal when the session ends while the plans load", async () => {
		function deferred() {
			let resolve!: () => void;
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			return { promise, resolve };
		}
		let session: number | null = 1;
		const started = deferred();
		const vault = deferred();
		const applied: Array<Record<string, unknown> | null> = [];
		let current: CurrentPlanningGoal | null = null;
		const reconciler = new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: () => {
				started.resolve();
				return vault.promise.then(() => [
					plan({ tasks: [task("task-1", "已退出账号的任务")] }),
				]);
			},
			sessionToken: () => session,
			currentGoal: () => current,
			applyGoal: async (goal) => {
				applied.push(goal && { ...goal });
				current = goal && { ...goal, activatedAtMs: goal.activatedAtMs };
				return current && { ...current };
			},
			nowMs: () => NOW_MS,
		});

		const inFlight = reconciler.reconcile();
		await started.promise;
		// The logout barrier ends the session while the plans are still read.
		session = null;
		vault.resolve();

		expect(await inFlight).toEqual({ tier: "superseded", goal: null });
		expect(applied).toEqual([]);
	});

	test("never uses plans that were read for another session", async () => {
		let session: number | null = 1;
		let title = "账号一的任务";
		let planLoads = 0;
		const applied: string[] = [];
		let current: CurrentPlanningGoal | null = null;
		const reconciler = new PlanningGoalReconciler({
			loadCalendar: async () => [],
			loadPlans: async () => {
				planLoads += 1;
				return [plan({ tasks: [task("task-1", title)] })];
			},
			sessionToken: () => session,
			currentGoal: () => current && { ...current },
			applyGoal: async (goal) => {
				if (goal) applied.push(goal.text);
				current = goal && { ...goal, activatedAtMs: goal.activatedAtMs };
				return current && { ...current };
			},
			nowMs: () => NOW_MS,
			planCacheTtlMs: 60_000,
		});

		await reconciler.reconcile();
		// The user switches accounts inside the cache's lifetime.
		title = "账号二的任务";
		session = 2;
		current = null;
		await reconciler.reconcile();

		expect(planLoads).toBe(2);
		expect(applied).toEqual(["待办任务：1. 账号一的任务", "待办任务：1. 账号二的任务"]);
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
