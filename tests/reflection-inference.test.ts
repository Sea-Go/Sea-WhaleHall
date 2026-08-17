import { describe, expect, test } from "bun:test";
import {
	chineseFeedbackTemplate,
	DeterministicReflectionInference,
	ReflectionInferenceUnavailableError,
	ReflectionReminderDeduper,
	selectFeedbackCode,
} from "../src/agent/reflection/inference";
import {
	DESKTOP_EVENT_SCHEMA_VERSION,
	type DesktopEventV1,
	EVENT_WINDOW_SCHEMA_VERSION,
	type EventWindowV1,
} from "../src/agent/reflection/types";

function foregroundEvent(hasGoal = true): DesktopEventV1 {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: "event-1",
		cursor: "cursor-1",
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "application.foregroundChanged",
		source: "activity",
		occurredAtMs: 1_000,
		observedAtMs: 1_001,
		goalVersion: hasGoal ? 1 : null,
		sensitivity: "metadata",
		payload: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			windowTitle: "project",
		},
	};
}

function windowFixture(hasGoal = true): EventWindowV1 {
	const event = foregroundEvent(hasGoal);
	return {
		schemaVersion: EVENT_WINDOW_SCHEMA_VERSION,
		windowId: hasGoal ? "window-with-goal" : "window-without-goal",
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
		triggerReason: "event_count",
		goal: hasGoal
			? {
					goalId: "goal-1",
					planId: "plan-1",
					version: 1,
					text: "完成 WhaleHall 推理层",
					activatedAtMs: 500,
				}
			: null,
		goalVersion: hasGoal ? 1 : null,
		startedAtMs: 1_000,
		endedAtMs: 61_000,
		deadlineAtMs: 301_000,
		eventCount: 1,
		firstCursor: event.cursor,
		lastCursor: event.cursor,
		events: [event],
		contextOnly: [],
		modelInput: "foreground app=VS Code; semantic action=editing",
		inputHash: "sha256:test-window",
	};
}

describe("DeterministicReflectionInference", () => {
	test("persists a conservative abstention without any model provider", async () => {
		const result = await new DeterministicReflectionInference().infer(
			windowFixture(),
		);

		expect(result).toMatchObject({
			schemaVersion: "reflection.v1",
			activity: { label: "other_unknown" },
			goalRelevance: { label: "uncertain" },
			abstain: true,
			feedbackCode: "silent",
			modelVersion: "deterministic-reflection.v1",
			taxonomyVersion: "activity-taxonomy.v1",
			evidenceEventIds: ["event-1"],
		});
		expect(result.embedding).toHaveLength(256);
		expect(Math.hypot(...result.embedding)).toBeCloseTo(1, 8);
	});

	test("keeps goal relevance null when no goal is active", async () => {
		const result = await new DeterministicReflectionInference().infer(
			windowFixture(false),
		);
		expect(result.goalVersion).toBeNull();
		expect(result.goalRelevance).toBeNull();
		expect(result.feedbackCode).toBe("silent");
	});

	test("creates stable content-free embeddings and honors cancellation", async () => {
		const inference = new DeterministicReflectionInference();
		const first = await inference.infer(windowFixture());
		const second = await inference.infer(windowFixture());
		expect(first.embedding).toEqual(second.embedding);

		const controller = new AbortController();
		controller.abort();
		await expect(
			inference.infer(windowFixture(), controller.signal),
		).rejects.toBeInstanceOf(ReflectionInferenceUnavailableError);
	});

	test("rejects inconsistent durable goal metadata", async () => {
		const invalid = { ...windowFixture(), goalVersion: null };
		await expect(
			new DeterministicReflectionInference().infer(invalid),
		).rejects.toThrow("inconsistent goal metadata");
	});
});

describe("fixed feedback and reminder suppression", () => {
	test("selects only fixed Chinese feedback templates", () => {
		expect(
			selectFeedbackCode({
				hasGoal: true,
				activity: "development",
				goalRelevance: "direct",
				abstain: false,
			}),
		).toBe("encourage");
		expect(chineseFeedbackTemplate("encourage")).toContain("推进当前目标");
		expect(chineseFeedbackTemplate("silent")).toBeNull();
	});

	test("suppresses the same active reminder without suppressing persistence", async () => {
		const reflection = await new DeterministicReflectionInference().infer(
			windowFixture(),
		);
		const active = { ...reflection, feedbackCode: "refocus" as const };
		const deduper = new ReflectionReminderDeduper(10 * 60 * 1_000);
		expect(deduper.shouldNotify(active, 1_000)).toBeTrue();
		expect(deduper.shouldNotify(active, 2_000)).toBeFalse();
		expect(deduper.shouldNotify(active, 10 * 60 * 1_000 + 1_000)).toBeTrue();
	});
});
