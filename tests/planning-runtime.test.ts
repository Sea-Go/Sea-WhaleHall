import { describe, expect, test } from "bun:test";
import {
	InMemoryPlanningCalendar,
	InMemoryPlanningObservations,
	InMemoryPlanningRepository,
	isPlanningPlan,
	type PlanningClock,
	type PlanningModelAnalysisRequest,
	PlanningModelInvocationError,
	type PlanningModelOutput,
	type PlanningModelPort,
	type PlanningModelProposal,
	PlanningRuntime,
	type PlanType,
	PlanVersionConflictError,
	parsePlanningPlan,
} from "../src/agent/planning";

class FakeClock implements PlanningClock {
	constructor(private value: number) {}
	nowMs(): number {
		return this.value;
	}
	set(instant: string): void {
		this.value = Date.parse(instant);
	}
}

class QueuePlanningModel implements PlanningModelPort {
	readonly modelVersion = "qwen3:4b-test";
	readonly requests: PlanningModelAnalysisRequest[] = [];
	constructor(readonly outputs: Array<PlanningModelOutput | Error>) {}
	async analyze(
		request: PlanningModelAnalysisRequest,
	): Promise<PlanningModelOutput> {
		this.requests.push(structuredClone(request));
		const output = this.outputs.shift();
		if (!output) throw new Error("Fake model output queue is empty.");
		if (output instanceof Error) throw output;
		if (
			output.outcome === "proposal" &&
			request.analysisMode === "automatic-adjustment" &&
			request.currentSchedulingPreferences
		) {
			return structuredClone({
				...output,
				schedulingPreferenceSource: "confirmed-reuse" as const,
				schedulingPreferences: request.currentSchedulingPreferences,
			});
		}
		return structuredClone(output);
	}
}

function idGenerator(): () => string {
	let next = 0;
	return () => String(++next);
}

const everyDay = ([1, 2, 3, 4, 5, 6, 7] as const).map((dayOfWeek) => ({
	dayOfWeek,
	startTime: "09:00",
	endTime: "10:00",
}));

function proposal(
	type: PlanType,
	options: {
		confidence?: number;
		eta?: string;
		taskCount?: number;
		assistantMessage?: string;
	} = {},
): PlanningModelProposal {
	const taskCount = Math.max(options.taskCount ?? 1, type === "fuzzy" ? 2 : 1);
	return {
		outcome: "proposal",
		recommendedType: type,
		rationaleSummary: `${type} recommendation`,
		assumptions: [],
		clarificationQuestions: [],
		assistantMessage: options.assistantMessage ?? "我已生成可确认的七天安排。",
		goal: "完成本地动态计划闭环",
		estimatedCompletionDate: options.eta ?? "2026-09-30",
		confidence: options.confidence ?? (type === "fuzzy" ? 0.4 : 0.85),
		estimateBasis: "根据用户确认的容量、任务工作量和当前日历估算。",
		schedulingPreferenceSource: "user-provided",
		schedulingPreferences: {
			weeklyCapacityMinutes: taskCount * 60,
			sessionMinutes: 60,
			availableWindows: everyDay,
		},
		tasks: Array.from({ length: taskCount }, (_, index) => ({
			taskKey: `task-${index + 1}`,
			purpose:
				type !== "fuzzy"
					? ("execution" as const)
					: index === 0
						? ("validation" as const)
						: index === 1
							? ("review" as const)
							: ("execution" as const),
			title: `任务 ${index + 1}`,
			description: "明确的执行任务",
			estimatedMinutes: 60,
			dependencyKeys: index === 0 ? [] : [`task-${index}`],
		})),
	};
}

function harness(
	outputs: Array<PlanningModelOutput | Error>,
	clock?: FakeClock,
) {
	const repository = new InMemoryPlanningRepository();
	const calendar = new InMemoryPlanningCalendar();
	const observations = new InMemoryPlanningObservations();
	const model = new QueuePlanningModel(outputs);
	const runtimeClock =
		clock ?? new FakeClock(Date.parse("2026-08-13T02:00:00Z"));
	const runtime = new PlanningRuntime({
		repository,
		calendar,
		observations,
		model,
		timeZone: "Asia/Shanghai",
		clock: runtimeClock,
		createId: idGenerator(),
	});
	return {
		runtime,
		repository,
		calendar,
		observations,
		model,
		clock: runtimeClock,
	};
}

async function createAndConfirm(
	type: PlanType,
	options: {
		outputs?: Array<PlanningModelOutput | Error>;
		startToday?: boolean;
		clock?: FakeClock;
	} = {},
) {
	const app = harness(options.outputs ?? [proposal(type)], options.clock);
	const draft = await app.runtime.createPlanDraft({
		input: {
			goal: "完成本地动态计划闭环",
			startToday: options.startToday ?? false,
		},
		operationId: "create-1",
	});
	const active = await app.runtime.confirmPlanRevision({
		planId: draft.id,
		revisionId: draft.proposedRevisionId ?? "missing",
		expectedVersion: draft.version,
		operationId: "confirm-1",
	});
	return { ...app, draft, active };
}

describe("PlanningRuntime creation and confirmation", () => {
	for (const type of ["short-term", "long-term", "fuzzy"] as const) {
		test(`supports ${type} with one ETA and exactly seven scheduled dates`, async () => {
			const { draft, active, calendar } = await createAndConfirm(type);

			expect(draft.status).toBe("awaiting-confirmation");
			expect(draft.type).toBeNull();
			expect(draft.effectiveStartDate).toBeNull();
			expect(draft.estimates).toHaveLength(1);
			expect(draft.estimates[0]?.estimatedCompletionDate).toBe(
				type === "short-term" ? "2026-08-14" : "2026-09-30",
			);
			expect(draft.estimates[0]?.modelVersion).toBe(
				type === "short-term" ? "deterministic-short-term.v1" : "qwen3:4b-test",
			);
			expect(draft.revisions[0]?.scheduleWindow).toEqual({
				startDate: "2026-08-14",
				endDateExclusive: "2026-08-21",
			});
			expect(active.status).toBe("active");
			expect(active.type).toBe(type);
			expect(active.effectiveStartDate).toBe("2026-08-14");
			expect(active.autoAdjustAuthorized).toBeTrue();
			expect(isPlanningPlan(active)).toBeTrue();
			const restored = parsePlanningPlan(JSON.parse(JSON.stringify(active)));
			expect(restored).toEqual(active);
			expect(restored).not.toBe(active);

			const events = await calendar.listEvents({
				startDate: "2026-08-14",
				endDateExclusive: "2026-08-21",
				timeZone: "Asia/Shanghai",
			});
			expect(events).toHaveLength(type === "fuzzy" ? 2 : 1);
			expect(events[0]).toMatchObject({
				planId: active.id,
				sourceTaskId: active.tasks[0]?.id,
				scheduleOrigin: "model",
				userLocked: false,
			});
		});
	}

	test("evaluates today/tomorrow at confirmation time across local midnight", async () => {
		const clock = new FakeClock(Date.parse("2026-08-13T15:59:00Z"));
		const app = harness([proposal("short-term")], clock);
		const draft = await app.runtime.createPlanDraft({
			input: { goal: "完成动态计划", startToday: false },
			operationId: "create-midnight",
		});
		expect(draft.revisions[0]?.scheduleWindow.startDate).toBe("2026-08-14");

		clock.set("2026-08-13T16:01:00Z");
		const active = await app.runtime.confirmPlanRevision({
			planId: draft.id,
			revisionId: draft.proposedRevisionId ?? "missing",
			expectedVersion: draft.version,
			operationId: "confirm-midnight",
		});
		expect(active.effectiveStartDate).toBe("2026-08-15");
		expect(active.revisions.at(-1)?.scheduleWindow).toEqual({
			startDate: "2026-08-15",
			endDateExclusive: "2026-08-22",
		});
	});

	test("resolves the current named timezone again when the first revision is confirmed", async () => {
		let timeZone = "Asia/Shanghai";
		const repository = new InMemoryPlanningRepository();
		const calendar = new InMemoryPlanningCalendar();
		const model = new QueuePlanningModel([proposal("short-term")]);
		const runtime = new PlanningRuntime({
			repository,
			calendar,
			model,
			timeZone: () => timeZone,
			clock: new FakeClock(Date.parse("2026-08-13T02:00:00Z")),
			createId: idGenerator(),
		});
		const draft = await runtime.createPlanDraft({
			input: { goal: "跨时区确认计划", startToday: false },
			operationId: "timezone-draft",
		});
		expect(draft.timeZone).toBe("Asia/Shanghai");
		timeZone = "America/Los_Angeles";
		const active = await runtime.confirmPlanRevision({
			planId: draft.id,
			revisionId: draft.proposedRevisionId ?? "missing",
			expectedVersion: draft.version,
			operationId: "timezone-confirm",
		});
		expect(active.timeZone).toBe("America/Los_Angeles");
		expect(active.effectiveStartDate).toBe("2026-08-13");
	});

	test("persists the user message and remains awaiting analysis when the model is unavailable", async () => {
		const { runtime } = harness([
			new PlanningModelInvocationError("model-unavailable", true),
		]);
		const plan = await runtime.createPlanDraft({
			input: { goal: "构建可靠计划运行时", startToday: false },
			operationId: "create-offline",
		});
		expect(plan.status).toBe("draft");
		expect(plan.analysisState).toBe("awaiting-analysis");
		expect(plan.analysisDiagnostic).toMatchObject({
			code: "model-unavailable",
			retryable: true,
		});
		expect(plan.messages).toHaveLength(1);
		expect(plan.messages[0]?.role).toBe("user");
		expect(plan.revisions).toEqual([]);
		expect(plan.estimates).toEqual([]);
	});

	test("asks for missing capacity instead of inventing scheduling defaults", async () => {
		const { runtime } = harness([
			{
				outcome: "needs-clarification",
				recommendedType: "long-term",
				rationaleSummary: "目标路径较长。",
				assumptions: [],
				clarificationQuestions: ["你每周可以投入多少分钟？"],
				assistantMessage: "请先告诉我每周容量与可用时段。",
			},
		]);
		const plan = await runtime.createPlanDraft({
			input: { goal: "长期学习一门语言", startToday: false },
			operationId: "create-clarify",
		});
		expect(plan.status).toBe("draft");
		expect(plan.analysisState).toBe("awaiting-user");
		expect(plan.revisions).toEqual([]);
		expect(plan.messages.at(-1)?.content).toContain("每周容量");
		expect(plan.messages.at(-1)?.content).toContain(
			"1. 你每周可以投入多少分钟？",
		);
	});

	test("replays a stable operation without a second model call and rejects stale versions", async () => {
		const app = harness([proposal("short-term")]);
		const request = {
			input: { goal: "构建幂等计划运行时", startToday: false },
			operationId: "create-idempotent",
		};
		const first = await app.runtime.createPlanDraft(request);
		const replay = await app.runtime.createPlanDraft(request);
		expect(replay).toEqual(first);
		expect(app.model.requests).toHaveLength(1);
		await expect(
			app.runtime.sendPlanMessage({
				planId: first.id,
				content: "继续分析",
				expectedVersion: first.version - 1,
				operationId: "stale-message",
			}),
		).rejects.toBeInstanceOf(PlanVersionConflictError);
	});
});

describe("PlanningRuntime adjustment rules", () => {
	test("keeps active execution live while a manual proposal awaits confirmation", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term"),
				proposal("short-term", { taskCount: 2 }),
			],
		});
		const activeRevisionId = app.active.activeRevisionId;
		const beforeEvents = await app.calendar.listEvents({
			startDate: "2026-08-13",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		});

		const proposed = await app.runtime.sendPlanMessage({
			planId: app.active.id,
			content: "请把范围扩展为两个任务",
			expectedVersion: app.active.version,
			operationId: "active-manual-proposal",
		});

		expect(proposed.status).toBe("active");
		expect(proposed.activeRevisionId).toBe(activeRevisionId);
		expect(proposed.proposedRevisionId).not.toBeNull();
		expect(proposed.tasks).toEqual(app.active.tasks);
		expect(
			proposed.revisions.find(
				(revision) => revision.id === proposed.proposedRevisionId,
			)?.tasks,
		).toHaveLength(2);
		expect(
			await app.calendar.listEvents({
				startDate: "2026-08-13",
				endDateExclusive: "2026-08-21",
				timeZone: "Asia/Shanghai",
			}),
		).toEqual(beforeEvents);
	});

	test("preserves paused status when a running plan confirms a proposal", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [proposal("short-term"), proposal("short-term")],
		});
		const paused = await app.runtime.pausePlan({
			planId: app.active.id,
			expectedVersion: app.active.version,
			operationId: "pause-before-proposal",
		});
		const proposed = await app.runtime.sendPlanMessage({
			planId: paused.id,
			content: "调整说明但继续保持暂停",
			expectedVersion: paused.version,
			operationId: "paused-proposal",
		});
		const confirmed = await app.runtime.confirmPlanRevision({
			planId: proposed.id,
			revisionId: proposed.proposedRevisionId ?? "missing",
			expectedVersion: proposed.version,
			operationId: "paused-confirm",
		});

		expect(proposed.status).toBe("paused");
		expect(confirmed.status).toBe("paused");
		expect(confirmed.proposedRevisionId).toBeNull();
	});

	test("supersedes an unconfirmed manual task without polluting the task registry", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term"),
				proposal("short-term", { taskCount: 2 }),
				proposal("short-term", { taskCount: 1 }),
			],
		});
		const first = await app.runtime.sendPlanMessage({
			planId: app.active.id,
			content: "先增加一个候选任务",
			expectedVersion: app.active.version,
			operationId: "proposal-first",
		});
		const firstProposal = first.revisions.find(
			(revision) => revision.id === first.proposedRevisionId,
		);
		expect(firstProposal?.tasks).toHaveLength(2);

		const second = await app.runtime.sendPlanMessage({
			planId: first.id,
			content: "放弃刚才新增的候选任务",
			expectedVersion: first.version,
			operationId: "proposal-second",
		});
		const secondProposal = second.revisions.find(
			(revision) => revision.id === second.proposedRevisionId,
		);
		expect(secondProposal?.tasks).toHaveLength(1);
		expect(secondProposal?.tasks.map((task) => task.sourceKey)).not.toContain(
			"task-2",
		);
		expect(second.tasks).toHaveLength(1);
	});

	test("manual scope reduction removes pending work from execution but retains history", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term", { taskCount: 2 }),
				proposal("short-term", { taskCount: 1 }),
			],
		});
		const removedTask = app.active.tasks[1];
		if (!removedTask) throw new Error("Expected a removable task.");
		const proposed = await app.runtime.sendPlanMessage({
			planId: app.active.id,
			content: "明确缩小范围，只保留第一个任务",
			expectedVersion: app.active.version,
			operationId: "scope-shrink-proposal",
		});
		const confirmed = await app.runtime.confirmPlanRevision({
			planId: proposed.id,
			revisionId: proposed.proposedRevisionId ?? "missing",
			expectedVersion: proposed.version,
			operationId: "scope-shrink-confirm",
		});

		expect(confirmed.tasks.find((task) => task.id === removedTask.id)).toEqual(
			removedTask,
		);
		expect(confirmed.revisions.at(-1)?.tasks).toHaveLength(1);
		expect(confirmed.revisions.at(-1)?.tasks[0]?.sourceKey).toBe("task-1");
		await expect(
			app.runtime.setTaskStatus({
				planId: confirmed.id,
				taskId: removedTask.id,
				status: "completed",
				expectedVersion: confirmed.version,
				operationId: "inactive-history-task-status",
			}),
		).rejects.toMatchObject({ code: "task-not-found" });
	});

	test("preserves a pending proposal through automatic progress and refreshes stale confirmation", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term", { taskCount: 2 }),
				proposal("short-term", { taskCount: 1 }),
				proposal("short-term", { taskCount: 1 }),
				proposal("short-term", { taskCount: 1 }),
			],
		});
		const proposed = await app.runtime.sendPlanMessage({
			planId: app.active.id,
			content: "缩小为一个任务",
			expectedVersion: app.active.version,
			operationId: "pending-before-progress",
		});
		const pendingRevisionId = proposed.proposedRevisionId;
		const completedTaskId = app.active.tasks[0]?.id ?? "missing";
		const adjusted = await app.runtime.setTaskStatus({
			planId: proposed.id,
			taskId: completedTaskId,
			status: "completed",
			expectedVersion: proposed.version,
			operationId: "progress-with-pending-proposal",
		});
		expect(adjusted.proposedRevisionId).toBe(pendingRevisionId);
		expect(
			adjusted.tasks.find((task) => task.id === completedTaskId)?.status,
		).toBe("completed");

		const refreshed = await app.runtime.confirmPlanRevision({
			planId: adjusted.id,
			revisionId: pendingRevisionId ?? "missing",
			expectedVersion: adjusted.version,
			operationId: "refresh-stale-proposal",
		});
		expect(refreshed.status).toBe("active");
		expect(refreshed.proposedRevisionId).not.toBe(pendingRevisionId);
		expect(refreshed.messages.at(-1)?.content).toContain("请再次确认");
		const confirmed = await app.runtime.confirmPlanRevision({
			planId: refreshed.id,
			revisionId: refreshed.proposedRevisionId ?? "missing",
			expectedVersion: refreshed.version,
			operationId: "confirm-refreshed-proposal",
		});
		expect(confirmed.proposedRevisionId).toBeNull();
		expect(
			confirmed.tasks.find((task) => task.id === completedTaskId)?.status,
		).toBe("completed");
	});

	test("records an empty automatic checkpoint without calling the calendar port", async () => {
		const app = await createAndConfirm("long-term", {
			outputs: [proposal("long-term"), proposal("long-term")],
		});
		let applyCalls = 0;
		const originalApply = app.calendar.applyChangeSet.bind(app.calendar);
		app.calendar.applyChangeSet = async (changeSet) => {
			applyCalls += 1;
			return originalApply(changeSet);
		};
		const adjusted = await app.runtime.notifyCalendarChanged({
			planId: app.active.id,
			expectedVersion: app.active.version,
			operationId: "automatic-noop",
		});

		expect(applyCalls).toBe(0);
		expect(adjusted.adjustments.at(-1)).toMatchObject({
			status: "applied",
			summary: { created: 0, moved: 0, cancelled: 0 },
		});
		expect(adjusted.adjustments.at(-1)?.calendarChangeSet.changes).toEqual([]);
	});

	test("keeps the calendar byte-for-byte unchanged when automatic capacity is insufficient", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term"),
				proposal("short-term", { taskCount: 2 }),
			],
		});
		const before = await app.calendar.listEvents({
			startDate: "2026-08-13",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		});
		let applyCalls = 0;
		const originalApply = app.calendar.applyChangeSet.bind(app.calendar);
		app.calendar.applyChangeSet = async (changeSet) => {
			applyCalls += 1;
			return originalApply(changeSet);
		};
		const adjusted = await app.runtime.notifyCalendarChanged({
			planId: app.active.id,
			expectedVersion: app.active.version,
			operationId: "automatic-capacity-shortage",
		});
		const after = await app.calendar.listEvents({
			startDate: "2026-08-13",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		});

		expect(applyCalls).toBe(0);
		expect(after).toEqual(before);
		expect(adjusted.revisions.at(-1)?.unscheduledTaskIds).toHaveLength(1);
		expect(adjusted.messages.at(-1)?.content).toContain("没有移动、新增或取消");
	});

	test("requires reconfirmation when a fuzzy validation or review can no longer be scheduled", async () => {
		const app = harness([proposal("fuzzy")]);
		const draft = await app.runtime.createPlanDraft({
			input: { goal: "验证一个模糊方向", startToday: false },
			operationId: "fuzzy-conflict-draft",
		});
		for (let offset = 0; offset < 7; offset += 1) {
			const day = 14 + offset;
			app.calendar.upsertUserEvent({
				id: `fuzzy-block-${offset}`,
				title: "用户占用",
				kind: "manual-block",
				state: "committed",
				start: `2026-08-${String(day).padStart(2, "0")}T01:00:00Z`,
				end: `2026-08-${String(day).padStart(2, "0")}T02:00:00Z`,
				timeZone: "Asia/Shanghai",
				planId: null,
				sourceTaskId: null,
				scheduleOrigin: "user",
				userLocked: false,
				version: 1,
			});
		}
		let applyCalls = 0;
		const originalApply = app.calendar.applyChangeSet.bind(app.calendar);
		app.calendar.applyChangeSet = async (changeSet) => {
			applyCalls += 1;
			return originalApply(changeSet);
		};
		const refreshed = await app.runtime.confirmPlanRevision({
			planId: draft.id,
			revisionId: draft.proposedRevisionId ?? "missing",
			expectedVersion: draft.version,
			operationId: "fuzzy-conflict-confirm",
		});

		expect(applyCalls).toBe(0);
		expect(refreshed.status).toBe("awaiting-confirmation");
		expect(refreshed.activeRevisionId).toBeNull();
		expect(refreshed.proposedRevisionId).not.toBe(draft.proposedRevisionId);
		expect(refreshed.messages.at(-1)?.content).toContain("再次确认");
	});

	test("retries a failed automatic analysis with its original trigger and mode", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term"),
				new PlanningModelInvocationError("model-unavailable", true),
				proposal("short-term"),
			],
		});
		const failed = await app.runtime.setTaskStatus({
			planId: app.active.id,
			taskId: app.active.tasks[0]?.id ?? "missing",
			status: "completed",
			expectedVersion: app.active.version,
			operationId: "automatic-failure",
		});
		expect(failed.pendingAnalysis).toEqual({
			trigger: "task-status",
			automatic: true,
			useActiveBaseline: false,
		});
		const retried = await app.runtime.retryPlanAnalysis({
			planId: failed.id,
			expectedVersion: failed.version,
			operationId: "retry-automatic-failure",
		});
		expect(app.model.requests.at(-1)).toMatchObject({
			analysisMode: "automatic-adjustment",
			trigger: "task-status",
		});
		expect(retried.proposedRevisionId).toBeNull();
		expect(retried.pendingAnalysis).toBeNull();
	});

	test("completes only terminal active work and clears future unlocked model events", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term", { taskCount: 3 }),
				new PlanningModelInvocationError("model-unavailable", true),
				new PlanningModelInvocationError("model-unavailable", true),
				new PlanningModelInvocationError("model-unavailable", true),
			],
		});
		await expect(
			app.runtime.completePlan({
				planId: app.active.id,
				expectedVersion: app.active.version,
				operationId: "complete-with-pending",
			}),
		).rejects.toMatchObject({ code: "invalid-state" });
		const before = await app.calendar.listEvents({
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		});
		const todayEvent = before[0];
		const locked = before[1];
		if (!todayEvent || !locked) {
			throw new Error("Expected current and future events.");
		}
		app.calendar.upsertUserEvent({ ...locked, userLocked: true, version: 2 });
		app.clock.set("2026-08-13T16:01:00Z");
		let current = app.active;
		for (const [index, task] of app.active.tasks.entries()) {
			current = await app.runtime.setTaskStatus({
				planId: current.id,
				taskId: task.id,
				status: "completed",
				expectedVersion: current.version,
				operationId: `terminal-task-${index}`,
			});
		}
		const completed = await app.runtime.completePlan({
			planId: current.id,
			expectedVersion: current.version,
			operationId: "complete-terminal-plan",
		});
		const after = await app.calendar.listEvents({
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		});

		expect(completed.status).toBe("completed");
		expect(after.map((event) => event.id)).toEqual([todayEvent.id, locked.id]);
		expect(after[0]?.start).toBe(todayEvent.start);
		expect(after[1]?.userLocked).toBeTrue();
	});
	test("only an explicit user command completes a task and observations never do", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [proposal("short-term"), proposal("short-term")],
		});
		const taskId = app.active.tasks[0]?.id ?? "missing";
		app.observations.setSummaries([
			{
				id: "observation-1",
				startedAt: "2026-08-14T01:00:00Z",
				endedAt: "2026-08-14T02:00:00Z",
				relevantMinutes: 55,
				coverage: "complete",
				authorized: true,
				candidates: [{ planId: app.active.id, taskId, confidence: 0.92 }],
			},
		]);
		const observed = await app.runtime.consumeObservations({
			planId: app.active.id,
			from: "2026-08-14T00:00:00Z",
			to: "2026-08-15T00:00:00Z",
			expectedVersion: app.active.version,
			operationId: "observe-1",
		});
		expect(observed.tasks[0]?.status).toBe("pending");
		expect(observed.observationEvidence).toHaveLength(1);

		app.model.outputs.push(proposal("short-term"));
		const completed = await app.runtime.setTaskStatus({
			planId: observed.id,
			taskId,
			status: "completed",
			expectedVersion: observed.version,
			operationId: "complete-task-1",
		});
		expect(completed.tasks[0]).toMatchObject({
			status: "completed",
			statusChangedBy: "user",
		});
	});

	test("model omissions never delete stable tasks or explicit user status", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term", { taskCount: 2 }),
				proposal("short-term", { taskCount: 1 }),
			],
		});
		const omittedTask = app.active.tasks[1];
		if (!omittedTask) throw new Error("Missing task that should be retained.");

		const completed = await app.runtime.setTaskStatus({
			planId: app.active.id,
			taskId: omittedTask.id,
			status: "completed",
			expectedVersion: app.active.version,
			operationId: "complete-then-model-omits",
		});

		expect(completed.tasks).toHaveLength(2);
		expect(
			completed.tasks.find((task) => task.id === omittedTask.id),
		).toMatchObject({
			status: "completed",
			statusChangedBy: "user",
		});
		expect(
			completed.revisions.at(-1)?.tasks.map((task) => task.taskId),
		).toContain(omittedTask.id);
	});

	test("keeps cross-plan observation overlap pending for user attribution", async () => {
		const app = await createAndConfirm("short-term");
		const taskId = app.active.tasks[0]?.id ?? "missing";
		app.observations.setSummaries([
			{
				id: "observation-ambiguous",
				startedAt: "2026-08-14T01:00:00Z",
				endedAt: "2026-08-14T02:00:00Z",
				relevantMinutes: 60,
				coverage: "complete",
				authorized: true,
				candidates: [
					{ planId: app.active.id, taskId, confidence: 0.9 },
					{ planId: "another-plan", taskId: "another-task", confidence: 0.8 },
				],
			},
		]);
		const observed = await app.runtime.consumeObservations({
			planId: app.active.id,
			from: "2026-08-14T00:00:00Z",
			to: "2026-08-15T00:00:00Z",
			expectedVersion: app.active.version,
			operationId: "observe-ambiguous",
		});
		expect(observed.observationEvidence).toEqual([]);
		expect(observed.pendingObservationAttributions[0]?.status).toBe(
			"awaiting-user",
		);
		expect(app.model.requests).toHaveLength(1);
	});

	test("does not copy an observation explicitly attributed to another plan into this plan", async () => {
		const app = await createAndConfirm("short-term");
		app.observations.setSummaries([
			{
				id: "observation-other-plan",
				startedAt: "2026-08-14T01:00:00Z",
				endedAt: "2026-08-14T02:00:00Z",
				relevantMinutes: 60,
				coverage: "complete",
				authorized: true,
				candidates: [
					{ planId: "another-plan", taskId: "another-task", confidence: 0.9 },
				],
			},
		]);
		const observed = await app.runtime.consumeObservations({
			planId: app.active.id,
			from: "2026-08-14T00:00:00Z",
			to: "2026-08-15T00:00:00Z",
			expectedVersion: app.active.version,
			operationId: "observe-other-plan",
		});
		expect(observed.observationEvidence).toEqual([]);
		expect(observed.pendingObservationAttributions).toEqual([]);
		expect(app.model.requests).toHaveLength(1);
	});

	test("keeps the last applied revision active when an automatic calendar batch fails", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term"),
				proposal("short-term", { taskCount: 2 }),
			],
		});
		const previousRevisionId = app.active.activeRevisionId;
		const originalApply = app.calendar.applyChangeSet.bind(app.calendar);
		let rejectNext = true;
		app.calendar.applyChangeSet = async (changeSet) => {
			if (rejectNext) {
				rejectNext = false;
				return {
					ok: false as const,
					changeSetId: changeSet.id,
					conflicts: [
						{
							code: "overlap" as const,
							affectedEventIds: changeSet.changes.map((item) => item.eventId),
						},
					],
				};
			}
			return originalApply(changeSet);
		};

		const failed = await app.runtime.setTaskStatus({
			planId: app.active.id,
			taskId: app.active.tasks[0]?.id ?? "missing",
			status: "completed",
			expectedVersion: app.active.version,
			operationId: "calendar-failure-rolls-back-revision",
		});

		expect(failed.adjustments.at(-1)?.status).toBe("failed");
		expect(failed.activeRevisionId).toBe(previousRevisionId);
		expect(failed.revisions.at(-1)?.id).not.toBe(previousRevisionId);
		expect(failed.messages.at(-1)?.content).toContain("原有安排已保留");
	});

	test("recovers an interrupted pending calendar stage with the same idempotent operation", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term"),
				proposal("short-term", { taskCount: 2 }),
			],
		});
		const originalApply = app.calendar.applyChangeSet.bind(app.calendar);
		let interrupted = true;
		app.calendar.applyChangeSet = async (changeSet) => {
			if (interrupted) {
				interrupted = false;
				throw new Error("simulated process interruption");
			}
			return originalApply(changeSet);
		};

		await expect(
			app.runtime.setTaskStatus({
				planId: app.active.id,
				taskId: app.active.tasks[0]?.id ?? "missing",
				status: "completed",
				expectedVersion: app.active.version,
				operationId: "recover-interrupted-calendar",
			}),
		).rejects.toThrow("simulated process interruption");
		const staged = await app.repository.getPlan(app.active.id);
		expect(staged?.adjustments.at(-1)?.status).toBe("pending");

		const recovered = await app.runtime.recoverPendingAdjustments();
		expect(recovered).toHaveLength(1);
		expect(recovered[0]?.adjustments.at(-1)?.status).toBe("applied");
		expect(recovered[0]?.activeRevisionId).toBe(
			recovered[0]?.adjustments.at(-1)?.nextRevisionId,
		);
	});

	test("today and user-locked future events remain byte-for-byte scheduled", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [
				proposal("short-term", { taskCount: 2 }),
				proposal("fuzzy", { confidence: 0.4, taskCount: 2, eta: "2026-10-30" }),
			],
		});
		const before = await app.calendar.listEvents({
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		});
		expect(before).toHaveLength(2);
		const locked = before[1];
		if (!locked) throw new Error("Missing second event.");
		app.calendar.upsertUserEvent({ ...locked, userLocked: true, version: 2 });
		app.clock.set("2026-08-13T16:01:00Z");

		const adjusted = await app.runtime.notifyCalendarChanged({
			planId: app.active.id,
			expectedVersion: app.active.version,
			operationId: "calendar-replan-1",
		});
		const after = await app.calendar.listEvents({
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		});
		expect(after.map(({ id, start, end }) => ({ id, start, end }))).toEqual(
			before.map(({ id, start, end }) => ({ id, start, end })),
		);
		expect(after[1]?.userLocked).toBeTrue();
		expect(adjusted.type).toBe("short-term");
		expect(adjusted.revisions.at(-1)?.scheduleWindow).toEqual({
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-21",
		});
	});

	test("runs one idempotent adjustment for the first local daily summary", async () => {
		const app = await createAndConfirm("long-term", {
			outputs: [
				proposal("long-term", { eta: "2026-10-01" }),
				proposal("long-term", { eta: "2026-10-08" }),
			],
		});
		const request = {
			planId: app.active.id,
			localDate: "2026-08-14",
			expectedVersion: app.active.version,
			operationId: "daily:plan-1:2026-08-14",
		};

		const summarized = await app.runtime.runDailySummary(request);
		const replayed = await app.runtime.runDailySummary(request);

		expect(summarized.dailySummaryDates).toEqual(["2026-08-14"]);
		expect(
			summarized.adjustments.filter(
				(adjustment) => adjustment.trigger === "daily-summary",
			),
		).toHaveLength(1);
		expect(replayed).toEqual(summarized);
		expect(app.model.requests).toHaveLength(2);
	});

	test("undo restores calendar changes but never rewrites the explicit task status", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [proposal("short-term"), proposal("short-term")],
		});
		const taskId = app.active.tasks[0]?.id ?? "missing";
		const skipped = await app.runtime.setTaskStatus({
			planId: app.active.id,
			taskId,
			status: "skipped",
			expectedVersion: app.active.version,
			operationId: "skip-task-1",
		});
		const empty = await app.calendar.listEvents({
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		});
		expect(empty).toHaveLength(0);
		const adjustment = skipped.adjustments.at(-1);
		if (!adjustment) throw new Error("Missing adjustment.");

		const undone = await app.runtime.undoPlanAdjustment({
			planId: skipped.id,
			adjustmentId: adjustment.id,
			adjustmentVersion: skipped.adjustments.length,
			expectedVersion: skipped.version,
			operationId: "undo-skip-1",
		});
		const restored = await app.calendar.listEvents({
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		});
		expect(restored).toHaveLength(1);
		expect(undone.tasks[0]?.status).toBe("skipped");
		expect(undone.adjustments.at(-1)?.status).toBe("undone");
	});

	test("replays undo safely when the calendar committed before an interrupted response", async () => {
		const app = await createAndConfirm("short-term", {
			outputs: [proposal("short-term"), proposal("short-term")],
		});
		const skipped = await app.runtime.setTaskStatus({
			planId: app.active.id,
			taskId: app.active.tasks[0]?.id ?? "missing",
			status: "skipped",
			expectedVersion: app.active.version,
			operationId: "skip-before-interrupted-undo",
		});
		const adjustment = skipped.adjustments.at(-1);
		if (!adjustment) throw new Error("Missing adjustment to undo.");
		const originalApply = app.calendar.applyChangeSet.bind(app.calendar);
		let interruptAfterCommit = true;
		app.calendar.applyChangeSet = async (changeSet) => {
			const result = await originalApply(changeSet);
			if (interruptAfterCommit) {
				interruptAfterCommit = false;
				throw new Error("simulated interrupted calendar response");
			}
			return result;
		};
		const request = {
			planId: skipped.id,
			adjustmentId: adjustment.id,
			adjustmentVersion: skipped.adjustments.length,
			expectedVersion: skipped.version,
			operationId: "interrupted-undo-replay",
		};

		await expect(app.runtime.undoPlanAdjustment(request)).rejects.toThrow(
			"simulated interrupted calendar response",
		);
		const undone = await app.runtime.undoPlanAdjustment(request);
		expect(undone.adjustments.at(-1)?.status).toBe("undone");
	});
});
