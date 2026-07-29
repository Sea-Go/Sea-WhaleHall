import { describe, expect, test } from "bun:test";
import {
	DESKTOP_EVENT_SCHEMA_VERSION,
	DeterministicWindowBuilder,
	InMemoryReflectionRepository,
	InvalidReflectionJobTransitionError,
	REFLECTION_SCHEMA_VERSION,
	ReflectionCollector,
	ReflectionJobRunner,
	type DesktopEventForKind,
	type EventWindowV1,
	type ReflectionClock,
	type ReflectionInferenceProvider,
	type ReflectionJobClock,
	type ReflectionTimerHandle,
	type ReflectionV1,
	WebCryptoReflectionHasher,
} from "../src/agent/reflection";

class ManualClock implements ReflectionClock, ReflectionJobClock {
	constructor(private currentMs = 0) {}

	nowMs(): number {
		return this.currentMs;
	}

	setTimer(_callback: () => void, _delayMs: number): ReflectionTimerHandle {
		return { unref() {} } as unknown as ReflectionTimerHandle;
	}

	clearTimer(_handle: ReflectionTimerHandle): void {}

	advance(deltaMs: number): void {
		this.currentMs += deltaMs;
	}
}

function event(
	collectorIndex: number,
	eventIndex: number,
	atMs: number,
): DesktopEventForKind<"application.foregroundChanged"> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `event-${collectorIndex}-${eventIndex}`,
		cursor: `cursor-${collectorIndex}-${eventIndex}`,
		deviceId: "device-1",
		sessionId: `session-${collectorIndex}`,
		kind: "application.foregroundChanged",
		source: "test",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		sensitivity: "metadata",
		payload: { appId: `app-${eventIndex}`, appName: `App ${eventIndex}` },
	};
}

async function enqueueWindow(
	repository: InMemoryReflectionRepository,
	clock: ManualClock,
	collectorIndex = 1,
	eventCount = 1,
): Promise<EventWindowV1> {
	const collector = new ReflectionCollector({
		collectorId: `collector-${collectorIndex}`,
		deviceId: "device-1",
		sessionId: `session-${collectorIndex}`,
		repository,
		windowBuilder: new DeterministicWindowBuilder(new WebCryptoReflectionHasher()),
		clock,
		semanticEventThreshold: eventCount,
	});
	await collector.recover();
	let window: EventWindowV1 | null = null;
	for (let index = 1; index <= eventCount; index += 1) {
		window = await collector.ingest(event(collectorIndex, index, clock.nowMs()));
	}
	collector.dispose();
	if (!window) throw new Error("Test failed to seal its reflection window.");
	return window;
}

function reflectionFor(window: EventWindowV1): ReflectionV1 {
	return {
		schemaVersion: REFLECTION_SCHEMA_VERSION,
		windowId: window.windowId,
		triggerReason: window.triggerReason,
		eventCount: window.eventCount,
		durationMs: window.endedAtMs - window.startedAtMs,
		goalVersion: window.goalVersion,
		activity: {
			label: "development",
			probabilities: activityProbabilities(),
		},
		goalRelevance: null,
		embedding: Array.from({ length: 256 }, (_, index) => (index === 0 ? 1 : 0)),
		confidence: 0.95,
		entropy: 0.1,
		abstain: false,
		evidenceEventIds: window.events.slice(0, 1).map((entry) => entry.eventId),
		feedbackCode: "silent",
		modelVersion: "modernbert-test",
		taxonomyVersion: "taxonomy-test",
	};
}

function activityProbabilities(): ReflectionV1["activity"]["probabilities"] {
	return {
		development: 0.945,
		writing: 0.005,
		research: 0.005,
		communication: 0.005,
		planning: 0.005,
		data_work: 0.005,
		media: 0.005,
		gaming: 0.005,
		system_file_ops: 0.005,
		commerce: 0.005,
		idle_transition: 0.005,
		other_unknown: 0.005,
	};
}

function createRunner(options: {
	repository: InMemoryReflectionRepository;
	clock: ManualClock;
	inference?: ReflectionInferenceProvider;
	commit?: (window: EventWindowV1, reflection: ReflectionV1) => Promise<void>;
	terminalAfterMs?: number;
	drainingJobThreshold?: number;
	drainingEventThreshold?: number;
	leaseDurationMs?: number;
}) {
	let inferenceCalls = 0;
	let commitCalls = 0;
	const inference: ReflectionInferenceProvider =
		options.inference ??
		({
			async infer(window) {
				inferenceCalls += 1;
				return reflectionFor(window);
			},
		} satisfies ReflectionInferenceProvider);
	const runner = new ReflectionJobRunner({
		repository: options.repository,
		clock: options.clock,
		inference: {
			async infer(window) {
				if (options.inference) inferenceCalls += 1;
				return inference.infer(window);
			},
		},
		committer: {
			async commit(window, reflection) {
				commitCalls += 1;
				await options.commit?.(window, reflection);
			},
		},
		jitterMs: () => 0,
		terminalAfterMs: options.terminalAfterMs,
		drainingJobThreshold: options.drainingJobThreshold,
		drainingEventThreshold: options.drainingEventThreshold,
		leaseDurationMs: options.leaseDurationMs,
	});
	return {
		runner,
		get inferenceCalls() {
			return inferenceCalls;
		},
		get commitCalls() {
			return commitCalls;
		},
	};
}

describe("ReflectionJobRunner durable state flow", () => {
	test("persists, commits, and never infers an already committed window twice", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new ManualClock();
		const window = await enqueueWindow(repository, clock);
		const harness = createRunner({ repository, clock });

		expect(await harness.runner.runOnce()).toEqual({
			status: "committed",
			windowId: window.windowId,
		});
		expect(harness.inferenceCalls).toBe(1);
		expect(harness.commitCalls).toBe(1);
		expect(await repository.getJob(window.windowId)).toMatchObject({
			state: "COMMITTED",
			attempt: 1,
			reflection: { windowId: window.windowId },
		});
		expect(await harness.runner.runOnce()).toEqual({ status: "idle" });
		expect(harness.inferenceCalls).toBe(1);
	});

	test("an expired RUNNING lease is reclaimed after restart", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new ManualClock();
		const window = await enqueueWindow(repository, clock);
		expect(await repository.claimNextRunnable(0, 100)).toMatchObject({
			state: "RUNNING",
			attempt: 1,
		});
		clock.advance(100);

		const harness = createRunner({ repository, clock, leaseDurationMs: 100 });
		expect((await harness.runner.runOnce()).status).toBe("committed");
		expect(harness.inferenceCalls).toBe(1);
		expect(await repository.getJob(window.windowId)).toMatchObject({
			state: "COMMITTED",
			attempt: 2,
		});
	});

	test("invalid direct state transitions are rejected", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new ManualClock();
		const window = await enqueueWindow(repository, clock);
		await expect(
			repository.persistResult(window.windowId, reflectionFor(window), 0),
		).rejects.toBeInstanceOf(InvalidReflectionJobTransitionError);
	});
});

describe("ReflectionJobRunner retries and terminal failure", () => {
	test("inference failure waits 5 seconds before retrying", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new ManualClock();
		const window = await enqueueWindow(repository, clock);
		let shouldFail = true;
		const harness = createRunner({
			repository,
			clock,
			inference: {
				async infer(candidate) {
					if (shouldFail) throw new Error("model offline");
					return reflectionFor(candidate);
				},
			},
		});

		expect(await harness.runner.runOnce()).toEqual({
			status: "retry_scheduled",
			windowId: window.windowId,
			nextAttemptAtMs: 5_000,
			phase: "inference",
		});
		clock.advance(4_999);
		expect(await harness.runner.runOnce()).toEqual({ status: "idle" });
		shouldFail = false;
		clock.advance(1);
		expect((await harness.runner.runOnce()).status).toBe("committed");
		expect(harness.inferenceCalls).toBe(2);
	});

	test("commit retry reuses the persisted result instead of rerunning inference", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new ManualClock();
		const window = await enqueueWindow(repository, clock);
		let shouldFailCommit = true;
		const harness = createRunner({
			repository,
			clock,
			commit: async () => {
				if (shouldFailCommit) throw new Error("journal busy");
			},
		});

		expect(await harness.runner.runOnce()).toMatchObject({
			status: "retry_scheduled",
			phase: "commit",
		});
		expect(await repository.getJob(window.windowId)).toMatchObject({
			state: "RETRY_WAIT",
			reflection: { windowId: window.windowId },
		});
		shouldFailCommit = false;
		clock.advance(5_000);
		expect((await harness.runner.runOnce()).status).toBe("committed");
		expect(harness.inferenceCalls).toBe(1);
		expect(harness.commitCalls).toBe(2);
	});

	test("an explicitly non-retryable model contract error is quarantined immediately", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new ManualClock();
		const window = await enqueueWindow(repository, clock);
		const failure = Object.assign(new Error("taxonomy mismatch"), {
			retryable: false,
		});
		const harness = createRunner({
			repository,
			clock,
			inference: { infer: async () => Promise.reject(failure) },
		});

		expect(await harness.runner.runOnce()).toEqual({
			status: "terminal_failed",
			windowId: window.windowId,
			phase: "inference",
		});
		expect(await repository.getJob(window.windowId)).toMatchObject({
			state: "TERMINAL_FAILED",
			attempt: 1,
			lastFailure: { message: "taxonomy mismatch" },
		});
	});

	test("24 hours of continuous failure becomes terminal and can be replayed", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new ManualClock();
		const window = await enqueueWindow(repository, clock);
		let shouldFail = true;
		const harness = createRunner({
			repository,
			clock,
			terminalAfterMs: 24 * 60 * 60 * 1000,
			inference: {
				async infer(candidate) {
					if (shouldFail) throw new Error("model offline");
					return reflectionFor(candidate);
				},
			},
		});
		expect((await harness.runner.runOnce()).status).toBe("retry_scheduled");
		clock.advance(24 * 60 * 60 * 1000);
		expect(await harness.runner.runOnce()).toMatchObject({
			status: "terminal_failed",
			phase: "inference",
		});
		expect(await repository.getJob(window.windowId)).toMatchObject({
			state: "TERMINAL_FAILED",
			terminalCursorReleasedAtMs: clock.nowMs(),
		});

		await repository.replayTerminal(window.windowId, clock.nowMs());
		shouldFail = false;
		expect((await harness.runner.runOnce()).status).toBe("committed");
		expect(await repository.getJob(window.windowId)).toMatchObject({
			state: "COMMITTED",
			replayCount: 1,
		});
	});
});

describe("ReflectionJobRunner backpressure", () => {
	test("eight pending windows enter draining mode and suppress immediate feedback", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new ManualClock();
		const harness = createRunner({ repository, clock });
		for (let index = 1; index <= 7; index += 1) {
			await enqueueWindow(repository, clock, index);
		}
		expect(await harness.runner.getQueuePressure()).toMatchObject({
			mode: "accepting",
			stats: { pendingJobs: 7, pendingEvents: 7 },
			emitImmediateFeedback: true,
		});
		await enqueueWindow(repository, clock, 8);
		expect(await harness.runner.getQueuePressure()).toMatchObject({
			mode: "draining",
			stats: { pendingJobs: 8, pendingEvents: 8 },
			emitImmediateFeedback: false,
		});
	});

	test("the independent event-volume threshold also enters draining mode", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new ManualClock();
		await enqueueWindow(repository, clock, 1, 2);
		const harness = createRunner({
			repository,
			clock,
			drainingJobThreshold: 99,
			drainingEventThreshold: 2,
		});
		expect(await harness.runner.getQueuePressure()).toMatchObject({
			mode: "draining",
			stats: { pendingJobs: 1, pendingEvents: 2 },
		});
	});
});
