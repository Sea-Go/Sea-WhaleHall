import { describe, expect, test } from "bun:test";
import type {
	GeneratedPlanDraft,
	GenerationStatus,
	Plan,
	PlanInput,
	PlanningBusyWindow,
	ProposedScheduleItem,
} from "../src/views/client/features/planning/domain";
import { PlanningController } from "../src/views/client/features/planning/PlanningController";
import type {
	PlanApplyResult,
	PlanningAuthorityGateway,
	PlanningAvailabilityRequest,
	PlanningCalendarGateway,
	PlanningGenerationContext,
	PlanningGenerationService,
} from "../src/views/client/features/planning/planning-service";
import type {
	PlanningAuthoritySnapshot,
	PlanningCommitResult,
} from "../src/shared/planning-authority";
import { MockPlanningGenerationService } from "../src/views/client/infrastructure/planning/MockPlanningGenerationService";

class FakePlanningCalendarGateway implements PlanningCalendarGateway {
	availability: readonly PlanningBusyWindow[] = [];
	applyCalls = 0;
	lastApplied: readonly ProposedScheduleItem[] = [];
	result: PlanApplyResult | null = null;

	async loadAvailability(
		_request: PlanningAvailabilityRequest,
	): Promise<readonly PlanningBusyWindow[]> {
		return this.availability;
	}

	async applyPlan(
		_plan: Plan,
		proposals: readonly ProposedScheduleItem[],
		applyId: string,
	): Promise<PlanApplyResult> {
		this.applyCalls += 1;
		this.lastApplied = proposals;
		return (
			this.result ?? {
				ok: true,
				kind: "success",
				applyId,
				committedCount: proposals.length,
				warnings: [],
			}
		);
	}
}

function ids() {
	let value = 0;
	return () => `id-${++value}`;
}

function createController(
	generator: PlanningGenerationService = new MockPlanningGenerationService({
		latencyMs: 0,
	}),
	gateway = new FakePlanningCalendarGateway(),
) {
	return {
		controller: new PlanningController(
			generator,
			gateway,
			() => "2026-07-29",
			() => "Asia/Shanghai",
			ids(),
		),
		gateway,
	};
}

function fillInput(
	controller: PlanningController,
	type: "long-term" | "short-term",
) {
	controller.start();
	controller.updateInput({ goal: "完成个人作品集与求职材料" });
	controller.next();
	controller.updateInput({ type });
	controller.next();
	controller.updateInput({
		deadline: type === "long-term" ? "2026-10-01" : "2026-08-05",
		weeklyCapacityHours: 6,
		preferredDayPart: "evening",
	});
}

async function generateReview(
	controller: PlanningController,
	type: "long-term" | "short-term",
) {
	fillInput(controller, type);
	await controller.generate();
	const state = controller.getSnapshot();
	expect(state.status).toBe("review");
	if (state.status !== "review") throw new Error("Expected review");
	return state;
}

describe("PlanningController generation flow", () => {
	test("long plans prioritize phases and only precision-schedule the near window", async () => {
		const { controller } = createController();
		const state = await generateReview(controller, "long-term");
		expect(state.draft.plan.phases).toHaveLength(3);
		expect(state.draft.plan.milestones).toHaveLength(3);
		expect(state.draft.plan.scheduleWindow).toEqual({
			startDate: "2026-07-29",
			endDateExclusive: "2026-08-08",
		});
		expect(state.draft.proposals.length).toBeLessThanOrEqual(6);
		expect(state.draft.plan.deadline).toBe("2026-10-01");
	});

	test("short plans produce tasks and a near-term schedule", async () => {
		const { controller } = createController();
		const state = await generateReview(controller, "short-term");
		expect(state.draft.plan.phases).toHaveLength(1);
		expect(state.draft.plan.tasks).toHaveLength(3);
		expect(state.draft.proposals).toHaveLength(3);
	});

	test("shows incomplete input at the relevant progressive step", () => {
		const { controller } = createController();
		controller.start();
		controller.updateInput({ goal: "短" });
		controller.next();
		const state = controller.getSnapshot();
		expect(state.status).toBe("drafting");
		if (state.status !== "drafting") return;
		expect(state.step).toBe("describe");
		expect(state.issues[0]?.field).toBe("goal");
	});

	test("suggests an editable deadline after choosing long or short type", () => {
		const { controller } = createController();
		controller.start();
		controller.updateInput({ goal: "完成一个可以交付的作品集" });
		controller.next();
		controller.updateInput({ type: "short-term" });
		controller.next();
		const state = controller.getSnapshot();
		expect(state.status).toBe("drafting");
		if (state.status !== "drafting") return;
		expect(state.input.deadline).toBe("2026-08-12");
	});

	test("understands an explicit month in the natural-language goal", () => {
		const { controller } = createController();
		controller.start();
		controller.updateInput({ goal: "在 9 月前完成个人作品集" });
		controller.next();
		controller.updateInput({ type: "long-term" });
		controller.next();
		const state = controller.getSnapshot();
		expect(state.status).toBe("drafting");
		if (state.status !== "drafting") return;
		expect(state.input.deadline).toBe("2026-08-31");
	});

	test("exposes generation failure and supports retry", async () => {
		const generator = new MockPlanningGenerationService({ latencyMs: 0 });
		generator.failNextGeneration();
		const { controller } = createController(generator);
		fillInput(controller, "short-term");
		await controller.generate();
		expect(controller.getSnapshot().status).toBe("generation-error");
		await controller.retryGeneration();
		expect(controller.getSnapshot().status).toBe("review");
	});

	test("exposes an empty draft with deadline, scope, and capacity suggestions", async () => {
		const generator = new MockPlanningGenerationService({ latencyMs: 0 });
		generator.returnEmptyNextGeneration();
		const { controller } = createController(generator);
		fillInput(controller, "short-term");
		await controller.generate();
		const state = controller.getSnapshot();
		expect(state.status).toBe("empty-draft");
		if (state.status !== "empty-draft") return;
		expect(state.suggestions.join(" ")).toContain("截止");
		expect(state.suggestions.join(" ")).toContain("范围");
		expect(state.suggestions.join(" ")).toContain("投入");
	});

	test("keeps Agent follow-up questions inside the planning flow before reviewing the draft", async () => {
		let receivedAnswers: readonly import("../src/shared/task-planning").TaskPlanningAnswer[] = [];
		const generator: PlanningGenerationService = {
			async generate() {
				return {
					kind: "clarification",
					sessionId: "agent-session",
					questions: [{ key: "current_progress", text: "目前进展如何？", required: true }],
				};
			},
			async continueAfterClarification(_input, sessionId, answers) {
				expect(sessionId).toBe("agent-session");
				receivedAnswers = answers;
				return { kind: "draft", draft: sampleDraft() };
			},
		};
		const { controller } = createController(generator);
		fillInput(controller, "short-term");
		await controller.generate();
		expect(controller.getSnapshot()).toMatchObject({ status: "clarifying", step: "clarify" });
		await controller.submitClarificationAnswers([
			{ questionKey: "current_progress", answerText: "还没有开始。" },
		]);
		expect(receivedAnswers).toHaveLength(1);
		expect(controller.getSnapshot().status).toBe("review");
	});

	test("restores a persisted planning clarification after the WebView reloads", async () => {
		const recoveredInput: PlanInput = {
			goal: "完成个人作品集与求职材料",
			type: "short-term",
			deadline: "2026-08-05",
			priority: "high",
			weeklyCapacityHours: 6,
			unavailableDays: [],
			preferredSessionMinutes: 60,
			preferredDayPart: "evening",
		};
		const generator: PlanningGenerationService = {
			async findRestorable() {
				return { runId: "run-restored", input: recoveredInput };
			},
			async restore(run, _availability, context) {
				expect(run.runId).toBe("run-restored");
				context.onStatus("checking-calendar");
				return {
					kind: "clarification",
					sessionId: "session-restored",
					questions: [{ key: "scope", text: "首版范围是什么？", required: true }],
				};
			},
			async generate() {
				throw new Error("restore must not restart generation");
			},
			async continueAfterClarification(_input, sessionId) {
				expect(sessionId).toBe("session-restored");
				return { kind: "draft", draft: sampleDraft() };
			},
		};
		const { controller } = createController(generator);
		await controller.restore();
		expect(controller.getSnapshot()).toMatchObject({
			status: "clarifying",
			input: recoveredInput,
			sessionId: "session-restored",
		});
		await controller.submitClarificationAnswers([
			{ questionKey: "scope", answerText: "先完成核心页面。" },
		]);
		expect(controller.getSnapshot().status).toBe("review");
	});
});

describe("PlanningController draft isolation and confirmation", () => {
	test("cancel during generation never writes to committed calendar", async () => {
		let resolveGeneration: (result: import("../src/views/client/features/planning/planning-service").PlanningGenerationResult) => void = () => {};
		const generator: PlanningGenerationService = {
			generate(
				_input: PlanInput,
				_availability: readonly PlanningBusyWindow[],
				context: PlanningGenerationContext,
			) {
				context.onStatus("checking-calendar" as GenerationStatus);
				return new Promise((resolve) => {
					resolveGeneration = resolve;
				});
			},
			async continueAfterClarification() {
				throw new Error("not used by this test");
			},
		};
		const { controller, gateway } = createController(generator);
		fillInput(controller, "short-term");
		const request = controller.generate();
		controller.cancel();
		resolveGeneration({ kind: "draft", draft: sampleDraft() });
		await request;
		expect(controller.getSnapshot().status).toBe("cancelled");
		expect(gateway.applyCalls).toBe(0);
	});

	test("blocks confirmation on unavailable-time conflicts", async () => {
		const { controller, gateway } = createController();
		gateway.availability = [
			{
				id: "manual",
				title: "不可用时间",
				kind: "manual-block",
				start: "2026-07-29T11:00:00Z",
				end: "2026-07-29T12:00:00Z",
				timeZone: "Asia/Shanghai",
			},
		];
		const state = await generateReview(controller, "short-term");
		expect(state.draft.conflicts[0]?.severity).toBe("error");
		controller.openSchedule();
		controller.openConfirm();
		expect(controller.getSnapshot()).toMatchObject({
			status: "review",
			step: "schedule",
		});
		expect(await controller.apply()).toBeNull();
		expect(gateway.applyCalls).toBe(0);
	});

	test("confirm writes once and guards repeated confirmation", async () => {
		const { controller, gateway } = createController();
		expect(controller.getActiveGoalContext()).toBeNull();
		await generateReview(controller, "short-term");
		controller.openSchedule();
		controller.openConfirm();
		const first = await controller.apply();
		const second = await controller.apply();
		expect(first?.ok).toBe(true);
		expect(second).toBeNull();
		expect(gateway.applyCalls).toBe(1);
		expect(gateway.lastApplied.every((item) => item.state === "proposed")).toBe(
			true,
		);
		expect(controller.getSnapshot().status).toBe("success");
		expect(controller.getActiveGoalContext()).toMatchObject({
			schemaVersion: "active-goal.v1",
			version: 1,
			text: "完成个人作品集与求职材料",
		});
	});

	test("explicitly clears an active goal and notifies subscribers once", async () => {
		const { controller } = createController();
		let notifications = 0;
		controller.subscribe(() => {
			notifications += 1;
		});
		await generateReview(controller, "short-term");
		controller.openSchedule();
		controller.openConfirm();
		await controller.apply();
		const beforeClear = notifications;

		expect(controller.clearActiveGoalContext()).toBe(true);
		expect(controller.getActiveGoalContext()).toBeNull();
		expect(notifications).toBe(beforeClear + 1);
		expect(controller.clearActiveGoalContext()).toBe(false);
		expect(notifications).toBe(beforeClear + 1);
	});

	test("preserves an explicit partial-apply failure and allows retry", async () => {
		const { controller, gateway } = createController();
		await generateReview(controller, "short-term");
		controller.openSchedule();
		controller.openConfirm();
		gateway.result = {
			ok: false,
			kind: "partial",
			applyId: "partial",
			committedCount: 1,
			failedProposalIds: ["plan-1-proposal-2"],
			message: "1 项已写入，1 项冲突。",
		};
		await controller.apply();
		expect(controller.getSnapshot().status).toBe("partial-failure");
		const partial = controller.getSnapshot();
		if (partial.status !== "partial-failure") {
			throw new Error("Expected partial failure");
		}
		expect(partial.draft.proposals.map((item) => item.id)).toEqual([
			"plan-1-proposal-2",
		]);
		gateway.result = null;
		await controller.retryApply();
		expect(controller.getSnapshot().status).toBe("success");
		expect(gateway.applyCalls).toBe(2);
		expect(gateway.lastApplied.map((item) => item.id)).toEqual([
			"plan-1-proposal-2",
		]);
		const success = controller.getSnapshot();
		if (success.status === "success") {
			expect(success.committedCount).toBe(2);
		}
	});
});

describe("PlanningController local planning authority", () => {
	test("persists generation, edits, and deletion, then restores the completed draft", async () => {
		const authority = new FakePlanningAuthorityGateway();
		const controller = authorityController(authority);
		fillInputWithGoal(controller, "第一份本地草案");
		await controller.generate();
		expect(controller.getSnapshot().status).toBe("review");
		expect(authority.saveCalls).toHaveLength(1);

		controller.openSchedule();
		controller.updateProposal("proposal-a", {
			title: "已编辑的安排",
			start: "2026-07-30T03:00:00Z",
			end: "2026-07-30T04:00:00Z",
		});
		await eventually(() => authority.saveCalls.length === 2);
		expect(authority.snapshot?.draft.proposals[0]?.title).toBe("已编辑的安排");
		controller.deleteProposal("proposal-b");
		await eventually(() => authority.saveCalls.length === 3);
		expect(authority.snapshot?.draft.proposals.map((item) => item.id)).toEqual([
			"proposal-a",
		]);

		const restored = authorityController(authority);
		await restored.restore();
		expect(restored.getSnapshot()).toMatchObject({
			status: "review",
			input: { goal: "第一份本地草案" },
			draft: { proposals: [{ id: "proposal-a", title: "已编辑的安排" }] },
		});
	});

	test("serializes a cancelled save behind a newer flow without reviving stale UI", async () => {
		const authority = new FakePlanningAuthorityGateway();
		const gate = authority.blockNextSave();
		const controller = authorityController(authority);
		fillInputWithGoal(controller, "即将取消的旧计划");
		const oldGeneration = controller.generate();
		await gate.started;

		controller.cancel();
		fillInputWithGoal(controller, "必须保留的新计划");
		const newGeneration = controller.generate();
		gate.release();
		await Promise.all([oldGeneration, newGeneration]);

		expect(controller.getSnapshot()).toMatchObject({
			status: "review",
			input: { goal: "必须保留的新计划" },
		});
		expect(authority.snapshot?.input.goal).toBe("必须保留的新计划");
		expect(authority.saveCalls.map((call) => call.input.goal)).toEqual([
			"即将取消的旧计划",
			"必须保留的新计划",
		]);
	});

	test("reuses the exact commit id after an ACK loss and never duplicates calendar writes", async () => {
		const authority = new FakePlanningAuthorityGateway();
		authority.throwAfterCommitOnce = true;
		const controller = authorityController(authority);
		fillInputWithGoal(controller, "提交 ACK 恢复计划");
		await controller.generate();
		controller.openSchedule();
		controller.openConfirm();

		const first = await controller.apply();
		expect(first).toEqual(expect.objectContaining({ ok: false, calendarState: "unknown" }));
		expect(controller.getSnapshot().status).toBe("partial-failure");
		const retried = await controller.retryApply();
		expect(retried?.ok).toBe(true);
		expect(controller.getSnapshot().status).toBe("success");
		expect(authority.commitIds).toEqual(["id-1", "id-1"]);
		expect(authority.calendarWrites).toBe(1);
	});

	test("shows a recoverable warning when calendar commit succeeds but the local goal effect is pending", async () => {
		const authority = new FakePlanningAuthorityGateway();
		authority.effectsApplied = false;
		const controller = authorityController(authority);
		fillInputWithGoal(controller, "等待本地目标同步");
		await controller.generate();
		controller.openSchedule();
		controller.openConfirm();
		const result = await controller.apply();
		expect(result?.ok).toBe(true);
		expect(controller.getSnapshot()).toMatchObject({
			status: "success",
			effectWarning: "目标事件暂未同步",
		});
		expect(authority.calendarWrites).toBe(1);
	});
});

class FakePlanningAuthorityGateway implements PlanningAuthorityGateway {
	snapshot: PlanningAuthoritySnapshot | null = null;
	saveCalls: Array<{ input: PlanInput; draft: GeneratedPlanDraft }> = [];
	commitIds: string[] = [];
	calendarWrites = 0;
	throwAfterCommitOnce = false;
	effectsApplied = true;
	private saveGate: {
		started: () => void;
		wait: Promise<void>;
	} | null = null;

	blockNextSave(): { started: Promise<void>; release: () => void } {
		let release!: () => void;
		let markStarted!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		this.saveGate = { started: markStarted, wait };
		return { started, release };
	}

	async load(): Promise<PlanningAuthoritySnapshot | null> {
		return structuredClone(this.snapshot);
	}

	async saveDraft(
		input: PlanInput,
		draft: GeneratedPlanDraft,
		expectedRevision: number | null,
	): Promise<PlanningAuthoritySnapshot> {
		this.saveCalls.push({ input: structuredClone(input), draft: structuredClone(draft) });
		const gate = this.saveGate;
		if (gate) {
			this.saveGate = null;
			gate.started();
			await gate.wait;
		}
		if (!input.type) throw new Error("missing plan type");
		if ((this.snapshot?.revision ?? null) !== expectedRevision) {
			throw new Error("计划草案版本已变化");
		}
		this.snapshot = {
			schemaVersion: "planning-authority.v1",
			revision: (expectedRevision ?? 0) + 1,
			status: "draft",
			input: { ...structuredClone(input), type: input.type },
			draft: structuredClone(draft),
			confirmedPlan: structuredClone(this.snapshot?.confirmedPlan ?? null),
			activeGoal: structuredClone(this.snapshot?.activeGoal ?? null),
			commit: structuredClone(this.snapshot?.commit ?? null),
			updatedAtMs: 100,
		};
		return structuredClone(this.snapshot);
	}

	async commitDraft(
		commitId: string,
		expectedRevision: number,
		expectedCalendarRevision: number,
	): Promise<PlanningCommitResult> {
		this.commitIds.push(commitId);
		if (!this.snapshot) throw new Error("missing draft");
		if (this.snapshot.status === "committed") {
			if (this.snapshot.commit?.commitId !== commitId) throw new Error("commit conflict");
			return this.commitResult(true);
		}
		if (this.snapshot.revision !== expectedRevision) throw new Error("revision conflict");
		this.calendarWrites += 1;
		const draft = structuredClone(this.snapshot);
		const activeGoal = {
			schemaVersion: "active-goal.v1" as const,
			goalId: draft.draft.plan.id,
			planId: draft.draft.plan.id,
			version: (draft.activeGoal?.version ?? 0) + 1,
			text: draft.input.goal,
			activatedAtMs: 100,
		};
		this.snapshot = {
			...draft,
			revision: draft.revision + 1,
			status: "committed",
			confirmedPlan: structuredClone(draft.draft.plan),
			activeGoal,
			commit: {
				commitId,
				draftRevision: draft.revision,
				draftDigest: "a".repeat(64),
				calendarRevision: expectedCalendarRevision + 1,
				committedAtMs: 100,
				committedCount: draft.draft.proposals.length,
				warnings: [],
				effect: {
					status: this.effectsApplied ? "applied" : "pending",
					attempts: 1,
					lastAttemptAtMs: 100,
					lastError: this.effectsApplied ? null : "目标事件暂未同步",
				},
			},
			updatedAtMs: 100,
		};
		if (this.throwAfterCommitOnce) {
			this.throwAfterCommitOnce = false;
			throw new Error("提交响应丢失");
		}
		return this.commitResult(false);
	}

	private commitResult(idempotent: boolean): PlanningCommitResult {
		if (!this.snapshot?.commit) throw new Error("missing commit");
		return {
			snapshot: structuredClone(this.snapshot),
			calendarCommitted: true,
			idempotent,
			effectsApplied: this.snapshot.commit.effect.status === "applied",
		};
	}
}

function authorityController(authority: PlanningAuthorityGateway): PlanningController {
	return new PlanningController(
		new ImmediatePlanningGenerationService(),
		new FakePlanningCalendarGateway(),
		() => "2026-07-29",
		() => "Asia/Shanghai",
		ids(),
		() => 100,
		authority,
	);
}

class ImmediatePlanningGenerationService implements PlanningGenerationService {
	async generate(
		input: PlanInput,
		_availability: readonly PlanningBusyWindow[],
		context: PlanningGenerationContext,
	): Promise<import("../src/views/client/features/planning/planning-service").PlanningGenerationResult> {
		context.onStatus("ready");
		return { kind: "draft", draft: authorityDraft(input, context.revision) };
	}

	async continueAfterClarification(): Promise<never> {
		throw new Error("not used");
	}
}

function fillInputWithGoal(controller: PlanningController, goal: string): void {
	controller.start();
	controller.updateInput({ goal });
	controller.next();
	controller.updateInput({ type: "short-term" });
	controller.next();
	controller.updateInput({
		deadline: "2026-08-05",
		weeklyCapacityHours: 6,
		preferredDayPart: "evening",
	});
}

function authorityDraft(input: PlanInput, revision: number): GeneratedPlanDraft {
	if (!input.type) throw new Error("missing plan type");
	const planId = `authority-plan-${revision}`;
	const phaseId = `${planId}-phase`;
	const taskA = `${planId}-task-a`;
	const taskB = `${planId}-task-b`;
	return {
		plan: {
			id: planId,
			type: input.type,
			title: input.goal,
			goal: input.goal,
			deadline: input.deadline,
			priority: input.priority,
			weeklyCapacityHours: input.weeklyCapacityHours,
			calendarRevision: 0,
			totalEstimatedMinutes: 120,
			phases: [{ id: phaseId, title: "阶段", objective: input.goal, order: 1 }],
			milestones: [],
			tasks: [
				{ id: taskA, phaseId, milestoneId: null, title: "任务 A", estimatedMinutes: 60 },
				{ id: taskB, phaseId, milestoneId: null, title: "任务 B", estimatedMinutes: 60 },
			],
			scheduleWindow: { startDate: "2026-07-29", endDateExclusive: "2026-08-06" },
			generationRun: {
				id: `authority-run-${revision}`,
				startedAt: "2026-07-29T00:00:00Z",
				completedAt: "2026-07-29T00:00:01Z",
				statuses: ["ready"],
				revision,
			},
		},
		proposals: [
			{
				id: "proposal-a",
				sourcePlanId: planId,
				taskId: taskA,
				title: "任务 A",
				state: "proposed",
				start: "2026-07-30T01:00:00Z",
				end: "2026-07-30T02:00:00Z",
				timeZone: "Asia/Shanghai",
				version: 0,
			},
			{
				id: "proposal-b",
				sourcePlanId: planId,
				taskId: taskB,
				title: "任务 B",
				state: "proposed",
				start: "2026-07-30T03:00:00Z",
				end: "2026-07-30T04:00:00Z",
				timeZone: "Asia/Shanghai",
				version: 0,
			},
		],
		busyWindows: [],
		conflicts: [],
		suggestions: [],
	};
}

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition was not reached");
}

function sampleDraft(): GeneratedPlanDraft {
	const plan: Plan = {
		id: "sample-plan",
		type: "short-term",
		title: "示例",
		goal: "示例目标",
		deadline: "2026-08-05",
		priority: "medium",
		weeklyCapacityHours: 5,
		totalEstimatedMinutes: 60,
		phases: [
			{ id: "phase", title: "推进", objective: "完成", order: 1 },
		],
		milestones: [
			{
				id: "milestone",
				phaseId: "phase",
				title: "完成",
				targetDate: "2026-08-05",
			},
		],
		tasks: [
			{
				id: "task",
				phaseId: "phase",
				milestoneId: "milestone",
				title: "核心任务",
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
	return {
		plan,
		proposals: [
			{
				id: "proposal",
				sourcePlanId: plan.id,
				taskId: "task",
				title: "核心任务",
				state: "proposed",
				start: "2026-07-30T01:00:00Z",
				end: "2026-07-30T02:00:00Z",
				timeZone: "Asia/Shanghai",
				version: 0,
			},
		],
		busyWindows: [],
		conflicts: [],
		suggestions: [],
	};
}
