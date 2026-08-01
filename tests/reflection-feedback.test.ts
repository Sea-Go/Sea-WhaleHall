import { describe, expect, test } from "bun:test";
import type {
	ReflectionV1,
	TelemetryEnvelopeV1,
} from "../src/agent/reflection";
import type { SqliteReflectionRepository } from "../src/agent/reflection/sqlite-repository";
import { ReflectionFeedbackSink } from "../src/bun/reflection-feedback";

function reflection(
	overrides: Partial<ReflectionV1> = {},
): ReflectionV1 {
	return {
		schemaVersion: "reflection.v1",
		windowId: "window-1",
		triggerReason: "event_count",
		eventCount: 64,
		durationMs: 10_000,
		goalVersion: 1,
		activity: {
			label: "development",
			probabilities: {
				development: 0.89,
				writing: 0.01,
				research: 0.01,
				communication: 0.01,
				planning: 0.01,
				data_work: 0.01,
				media: 0.01,
				gaming: 0.01,
				system_file_ops: 0.01,
				commerce: 0.01,
				idle_transition: 0.01,
				other_unknown: 0.01,
			},
		},
		goalRelevance: {
			label: "direct",
			probabilities: {
				direct: 0.94,
				supporting: 0.02,
				unrelated: 0.02,
				uncertain: 0.02,
			},
		},
		embedding: Array.from({ length: 256 }, (_, index) =>
			index === 0 ? 1 : 0,
		),
		confidence: 0.94,
		entropy: 0.1,
		abstain: false,
		evidenceEventIds: ["event-1"],
		feedbackCode: "encourage",
		modelVersion: "test-model",
		taxonomyVersion: "activity-taxonomy.v1",
		...overrides,
	};
}

function envelope(value = reflection()): TelemetryEnvelopeV1 {
	return {
		schemaVersion: "telemetry-envelope.v1",
		name: "whalehall.reflection.v1",
		idempotencyKey: value.windowId,
		occurredAtMs: 1_000,
		window: {
			schemaVersion: "event-window.v1",
			windowId: value.windowId,
			collectorId: "collector-1",
			deviceId: "device-1",
			sessionId: "session-1",
			triggerReason: value.triggerReason,
			goal: {
				goalId: "goal-1",
				planId: null,
				version: 1,
				text: "finish",
				activatedAtMs: 0,
			},
			goalVersion: 1,
			startedAtMs: 0,
			endedAtMs: 10_000,
			deadlineAtMs: 300_000,
			eventCount: value.eventCount,
			firstCursor: "cursor-1",
			lastCursor: "cursor-64",
			events: [],
			contextOnly: [],
			modelInput: "input",
			inputHash: "hash",
		},
		reflection: value,
	};
}

function repository(options: {
	pendingJobs?: number;
	pendingEvents?: number;
	claim?: boolean;
} = {}): {
	value: SqliteReflectionRepository;
	claims: string[];
} {
	const claims: string[] = [];
	return {
		value: {
			async getQueueStats() {
				return {
					pendingJobs: options.pendingJobs ?? 1,
					pendingEvents: options.pendingEvents ?? 64,
				};
			},
			async claimReminder(value: ReflectionV1) {
				claims.push(value.windowId);
				return options.claim === false
					? null
					: {
							windowId: value.windowId,
							notificationKey: "key",
							notifiedAtMs: 1_000,
						};
			},
		} as unknown as SqliteReflectionRepository,
		claims,
	};
}

describe("ReflectionFeedbackSink", () => {
	test("presents only a durably claimed fixed feedback code", async () => {
		const store = repository();
		const presented: string[] = [];
		const sink = new ReflectionFeedbackSink({
			repository: store.value,
			present: (code) => {
				presented.push(code);
			},
			nowMs: () => 1_000,
		});

		await sink.emit(envelope());

		expect(store.claims).toEqual(["window-1"]);
		expect(presented).toEqual(["encourage"]);
	});

	test("suppresses abstentions, invisible UI, duplicates, and draining queues", async () => {
		const cases = [
			{
				value: envelope(reflection({ abstain: true })),
				store: repository(),
				canPresent: () => true,
			},
			{
				value: envelope(),
				store: repository(),
				canPresent: () => false,
			},
			{
				value: envelope(),
				store: repository({ claim: false }),
				canPresent: () => true,
			},
			{
				value: envelope(),
				store: repository({ pendingJobs: 8 }),
				canPresent: () => true,
			},
		];
		for (const scenario of cases) {
			const presented: string[] = [];
			const sink = new ReflectionFeedbackSink({
				repository: scenario.store.value,
				present: (code) => {
					presented.push(code);
				},
				canPresent: scenario.canPresent,
			});
			await sink.emit(scenario.value);
			expect(presented).toEqual([]);
		}
	});
});
