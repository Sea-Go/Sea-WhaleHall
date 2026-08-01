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
	PlanningAvailabilityRequest,
	PlanningCalendarGateway,
	PlanningGenerationContext,
	PlanningGenerationService,
} from "../src/views/client/features/planning/planning-service";
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
