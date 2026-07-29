import { describe, expect, test } from "bun:test";
import {
	DESKTOP_EVENT_SCHEMA_VERSION,
	DeterministicWindowBuilder,
	GoalVersionMismatchError,
	InMemoryReflectionRepository,
	ReflectionCollector,
	type ActiveGoalContextV1,
	type DesktopEventForKind,
	type ReflectionClock,
	type ReflectionTimerHandle,
	WebCryptoReflectionHasher,
} from "../src/agent/reflection";

class FakeClock implements ReflectionClock {
	private nextTimerId = 1;
	private readonly timers = new Map<
		number,
		{ callback: () => void; deadlineAtMs: number }
	>();

	constructor(private currentMs = 0) {}

	nowMs(): number {
		return this.currentMs;
	}

	setTimer(callback: () => void, delayMs: number): ReflectionTimerHandle {
		const id = this.nextTimerId;
		this.nextTimerId += 1;
		this.timers.set(id, {
			callback,
			deadlineAtMs: this.currentMs + Math.max(0, delayMs),
		});
		return id as unknown as ReflectionTimerHandle;
	}

	clearTimer(handle: ReflectionTimerHandle): void {
		this.timers.delete(handle as unknown as number);
	}

	advance(deltaMs: number): void {
		this.currentMs += deltaMs;
		while (true) {
			const due = Array.from(this.timers.entries())
				.filter(([, timer]) => timer.deadlineAtMs <= this.currentMs)
				.sort(
					([leftId, left], [rightId, right]) =>
						left.deadlineAtMs - right.deadlineAtMs || leftId - rightId,
				)[0];
			if (!due) return;
			this.timers.delete(due[0]);
			due[1].callback();
		}
	}

	get timerCount(): number {
		return this.timers.size;
	}
}

function goal(version: number): ActiveGoalContextV1 {
	return {
		goalId: `goal-${version}`,
		planId: null,
		version,
		text: `Finish milestone ${version}`,
		activatedAtMs: 0,
	};
}

function foregroundEvent(
	index: number,
	atMs: number,
	goalVersion: number | null = null,
): DesktopEventForKind<"application.foregroundChanged"> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `event-${index}`,
		cursor: `cursor-${index.toString().padStart(4, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "application.foregroundChanged",
		source: "test",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion,
		sensitivity: "metadata",
		payload: { appId: `app-${index}`, appName: `App ${index}` },
	};
}

function presenceBoundary(
	index: number,
	atMs: number,
	goalVersion: number | null = null,
): DesktopEventForKind<"presence.afkStarted"> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `event-${index}`,
		cursor: `cursor-${index.toString().padStart(4, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "presence.afkStarted",
		source: "test",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion,
		sensitivity: "metadata",
		payload: { idleForMs: 60_000 },
	};
}

function goalBoundary(
	index: number,
	atMs: number,
	previous: ActiveGoalContextV1 | null,
	next: ActiveGoalContextV1 | null,
): DesktopEventForKind<"goal.contextChanged"> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `event-${index}`,
		cursor: `cursor-${index.toString().padStart(4, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "goal.contextChanged",
		source: "test",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: previous?.version ?? null,
		sensitivity: "metadata",
		payload: { previous, next },
	};
}

function ignoredReflectionEvent(
	index: number,
	atMs: number,
): DesktopEventForKind<"reflection.completed"> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `event-${index}`,
		cursor: `cursor-${index.toString().padStart(4, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "reflection.completed",
		source: "test",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		sensitivity: "metadata",
		payload: { windowId: "old-window" },
	};
}

function inputActivityEvent(
	index: number,
	atMs: number,
): DesktopEventForKind<"input.activityAggregated"> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `event-${index}`,
		cursor: `cursor-${index.toString().padStart(4, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "input.activityAggregated",
		source: "input.activity.sensor",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		sensitivity: "metadata",
		payload: {
			bucketStartedAtMs: Math.max(0, atMs - 5_000),
			bucketEndedAtMs: atMs,
			keyCount: 1,
			clickCount: 0,
			scrollDelta: 0,
			mouseDistance: 0,
		},
	};
}

function authorizationEvent(
	index: number,
	atMs: number,
	kind: "authorization.revoked" | "authorization.granted",
): DesktopEventForKind<typeof kind> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `event-${index}`,
		cursor: `cursor-${index.toString().padStart(4, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind,
		source: "input.activity.sensor",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		sensitivity: "metadata",
		payload: { permissions: ["input.monitoring"] },
	};
}

function createCollector(options: {
	repository?: InMemoryReflectionRepository;
	clock?: FakeClock;
	initialGoal?: ActiveGoalContextV1 | null;
	threshold?: number;
}) {
	const repository = options.repository ?? new InMemoryReflectionRepository();
	const clock = options.clock ?? new FakeClock();
	const collector = new ReflectionCollector({
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
		repository,
		windowBuilder: new DeterministicWindowBuilder(new WebCryptoReflectionHasher()),
		clock,
		initialGoal: options.initialGoal,
		semanticEventThreshold: options.threshold,
	});
	return { collector, repository, clock };
}

describe("ReflectionCollector count and deadline triggers", () => {
	test("the 63rd finalized semantic event does not seal and the 64th seals once", async () => {
		const { collector, repository, clock } = createCollector({});
		await collector.recover();
		for (let index = 1; index <= 63; index += 1) {
			expect(await collector.ingest(foregroundEvent(index, 0))).toBeNull();
		}
		expect(collector.getState()).toBe("ACTIVE_COLLECTING");
		expect(collector.getSnapshot().openWindow?.finalizedSemanticEventCount).toBe(63);
		expect(clock.timerCount).toBe(1);
		expect((await repository.getQueueStats()).pendingJobs).toBe(0);

		const window = await collector.ingest(foregroundEvent(64, 0));
		expect(window).toMatchObject({
			triggerReason: "event_count",
			eventCount: 64,
			firstCursor: "cursor-0001",
			lastCursor: "cursor-0064",
		});
		expect(collector.getState()).toBe("ACTIVE_EMPTY");
		expect(clock.timerCount).toBe(0);
		expect((await repository.getQueueStats()).pendingJobs).toBe(1);
	});

	test("299999ms does not seal and exactly 300000ms seals by max_wait", async () => {
		const { collector, repository, clock } = createCollector({});
		await collector.recover();
		await collector.ingest(foregroundEvent(1, 0));

		clock.advance(299_999);
		await collector.whenIdle();
		expect(collector.getState()).toBe("ACTIVE_COLLECTING");
		expect((await repository.getQueueStats()).pendingJobs).toBe(0);

		clock.advance(1);
		await collector.whenIdle();
		expect(collector.getState()).toBe("ACTIVE_EMPTY");
		expect((await repository.getQueueStats()).pendingJobs).toBe(1);
	});

	test("backlog replay splits by event time even when the timer never had a chance to run", async () => {
		const { collector, repository } = createCollector({});
		await collector.recover();
		await collector.ingest(foregroundEvent(1, 0));

		const firstWindow = await collector.ingest(foregroundEvent(2, 300_001));

		expect(firstWindow?.triggerReason).toBe("max_wait");
		expect(firstWindow?.eventCount).toBe(1);
		expect(collector.getSnapshot().openWindow).toMatchObject({
			startedAtMs: 300_001,
			finalizedSemanticEventCount: 1,
		});
		expect((await repository.getQueueStats()).pendingJobs).toBe(1);
	});

	test("the 64th event at the exact deadline prefers count over max_wait", async () => {
		const { collector } = createCollector({});
		await collector.recover();
		for (let index = 1; index < 64; index += 1) {
			await collector.ingest(foregroundEvent(index, index === 1 ? 0 : index));
		}

		const window = await collector.ingest(foregroundEvent(64, 300_000));

		expect(window?.triggerReason).toBe("event_count");
		expect(window?.eventCount).toBe(64);
	});

	test("an empty collector owns no timer and never emits periodic empty windows", async () => {
		const { collector, repository, clock } = createCollector({});
		await collector.recover();
		expect(clock.timerCount).toBe(0);
		clock.advance(30 * 60 * 1000);
		await collector.whenIdle();
		expect(clock.timerCount).toBe(0);
		expect((await repository.getQueueStats()).pendingJobs).toBe(0);
	});
});

describe("ReflectionCollector boundaries and goal isolation", () => {
	test("AFK seals a non-empty window without counting the boundary", async () => {
		const { collector, clock } = createCollector({});
		await collector.recover();
		await collector.ingest(foregroundEvent(1, 0));
		await collector.ingest(foregroundEvent(2, 100));
		const window = await collector.ingest(presenceBoundary(3, 200));

		expect(window?.triggerReason).toBe("presence_boundary");
		expect(window?.eventCount).toBe(2);
		expect(window?.events.map((event) => event.kind)).toEqual([
			"application.foregroundChanged",
			"application.foregroundChanged",
			"presence.afkStarted",
		]);
		expect(clock.timerCount).toBe(0);
		expect(await collector.ingest(presenceBoundary(4, 300))).toBeNull();
	});

	test("returning from AFK also seals any events observed while absent", async () => {
		const { collector } = createCollector({});
		await collector.recover();
		await collector.ingest(foregroundEvent(1, 1_000));
		const boundary: DesktopEventForKind<"presence.afkEnded"> = {
			...presenceBoundary(2, 2_000),
			kind: "presence.afkEnded",
		};

		const window = await collector.ingest(boundary);

		expect(window?.triggerReason).toBe("presence_boundary");
		expect(window?.eventCount).toBe(1);
		expect(window?.events.at(-1)?.kind).toBe("presence.afkEnded");
	});

	test("a late historical sleep boundary cannot close a newer wake window", async () => {
		const { collector, repository } = createCollector({});
		await collector.recover();
		await collector.ingest(foregroundEvent(1, 10_000));
		const lateSleep: DesktopEventForKind<"presence.sleep"> = {
			...presenceBoundary(2, 5_000),
			kind: "presence.sleep",
			observedAtMs: 10_500,
			payload: {},
		};

		expect(await collector.ingest(lateSleep)).toBeNull();
		expect(collector.getSnapshot()).toMatchObject({
			state: "ACTIVE_COLLECTING",
			materializedCursor: "cursor-0002",
			openWindow: {
				startedAtMs: 10_000,
				finalizedSemanticEventCount: 1,
				events: [{ eventId: "event-1" }],
			},
		});
		expect((await repository.getQueueStats()).pendingJobs).toBe(0);
	});

	test("goal change seals the old version and the next event starts a new version", async () => {
		const firstGoal = goal(1);
		const secondGoal = goal(2);
		const { collector } = createCollector({ initialGoal: firstGoal });
		await collector.recover();
		await collector.ingest(foregroundEvent(1, 0, 1));
		const oldWindow = await collector.ingest(
			goalBoundary(2, 100, firstGoal, secondGoal),
		);
		expect(oldWindow?.triggerReason).toBe("goal_boundary");
		expect(oldWindow?.goalVersion).toBe(1);
		expect(oldWindow?.eventCount).toBe(1);
		expect(collector.getSnapshot().activeGoal?.version).toBe(2);

		await collector.ingest(foregroundEvent(3, 200, 2));
		expect(collector.getSnapshot().openWindow).toMatchObject({
			goalVersion: 2,
			finalizedSemanticEventCount: 1,
		});
	});

	test("a mismatched goal version is rejected before entering a mixed window", async () => {
		const { collector } = createCollector({ initialGoal: goal(1) });
		await collector.recover();
		await collector.ingest(foregroundEvent(1, 0, 1));
		await expect(collector.ingest(foregroundEvent(2, 100, 2))).rejects.toBeInstanceOf(
			GoalVersionMismatchError,
		);
		expect(collector.getSnapshot().openWindow).toMatchObject({
			goalVersion: 1,
			finalizedSemanticEventCount: 1,
		});
	});

	test("boundary-only input does not create an empty reflection", async () => {
		const firstGoal = goal(1);
		const { collector, repository, clock } = createCollector({});
		await collector.recover();
		await collector.ingest(goalBoundary(1, 0, null, firstGoal));
		await collector.ingest(presenceBoundary(2, 100, 1));
		expect(clock.timerCount).toBe(0);
		expect(collector.getSnapshot().activeGoal?.version).toBe(1);
		expect((await repository.getQueueStats()).pendingJobs).toBe(0);
	});
});

describe("ReflectionCollector recovery, context, and idempotency", () => {
	test("reflection/tool lifecycle input cannot trigger reflection", async () => {
		const { collector, repository, clock } = createCollector({});
		await collector.recover();
		for (let index = 1; index <= 100; index += 1) {
			await collector.ingest(ignoredReflectionEvent(index, 0));
		}
		expect(collector.getState()).toBe("ACTIVE_EMPTY");
		expect(clock.timerCount).toBe(0);
		expect((await repository.getQueueStats()).pendingJobs).toBe(0);
	});

	test("restart recovers an overdue open window exactly once", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new FakeClock();
		const first = createCollector({ repository, clock }).collector;
		await first.recover();
		await first.ingest(foregroundEvent(1, 0));
		first.dispose();
		clock.advance(300_000);

		const second = createCollector({ repository, clock }).collector;
		await second.recover();
		expect(second.getState()).toBe("ACTIVE_EMPTY");
		expect((await repository.getQueueStats()).pendingJobs).toBe(1);

		second.dispose();
		const third = createCollector({ repository, clock }).collector;
		await third.recover();
		expect((await repository.getQueueStats()).pendingJobs).toBe(1);
	});

	test("a duplicate event remains idempotent after restart", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new FakeClock();
		const event = foregroundEvent(1, 0);
		const first = createCollector({ repository, clock }).collector;
		await first.recover();
		await first.ingest(event);
		first.dispose();

		const second = createCollector({ repository, clock }).collector;
		await second.recover();
		await second.ingest(event);
		expect(second.getSnapshot().openWindow?.finalizedSemanticEventCount).toBe(1);
	});

	test("deterministic identity produces the same windowId when sealing is replayed", async () => {
		const first = createCollector({ threshold: 2 });
		const second = createCollector({ threshold: 2 });
		await first.collector.recover();
		await second.collector.recover();
		await first.collector.ingest(foregroundEvent(1, 0));
		await second.collector.ingest(foregroundEvent(1, 0));
		const firstWindow = await first.collector.ingest(foregroundEvent(2, 1));
		const secondWindow = await second.collector.ingest(foregroundEvent(2, 1));
		expect(firstWindow?.windowId).toBe(secondWindow?.windowId);
		expect(firstWindow?.inputHash).toBe(secondWindow?.inputHash);
	});

	test("the next window may carry bounded context without recounting it", async () => {
		const { collector } = createCollector({ threshold: 2 });
		await collector.recover();
		await collector.ingest(foregroundEvent(1, 0));
		await collector.ingest(foregroundEvent(2, 1));
		await collector.ingest(foregroundEvent(3, 10_000));
		const secondWindow = await collector.ingest(foregroundEvent(4, 10_001));

		expect(secondWindow?.eventCount).toBe(2);
		expect(secondWindow?.events.map((event) => event.eventId)).toEqual([
			"event-3",
			"event-4",
		]);
		expect(secondWindow?.contextOnly.length).toBeGreaterThan(0);
		expect(secondWindow?.contextOnly.length).toBeLessThanOrEqual(5);
		expect(
			secondWindow?.contextOnly.every((event) => event.eventId === "event-1" || event.eventId === "event-2"),
		).toBe(true);
	});
});

describe("ReflectionCollector authorization gates", () => {
	test("revocation discards the open window and blocks only the revoked sensor", async () => {
		const { collector } = createCollector({});
		await collector.recover();
		await collector.ingest(inputActivityEvent(1, 5_000));
		await collector.ingest(authorizationEvent(2, 5_001, "authorization.revoked"));

		expect(collector.getSnapshot()).toMatchObject({
			openWindow: null,
			revokedPermissions: ["input.monitoring"],
		});
		await collector.ingest(inputActivityEvent(3, 10_000));
		expect(collector.getSnapshot().openWindow).toBeNull();

		await collector.ingest(foregroundEvent(4, 10_001));
		expect(collector.getSnapshot().openWindow?.finalizedSemanticEventCount).toBe(1);
		await collector.ingest(authorizationEvent(5, 10_002, "authorization.granted"));
		await collector.ingest(inputActivityEvent(6, 15_000));
		expect(collector.getSnapshot()).toMatchObject({
			revokedPermissions: [],
			openWindow: { finalizedSemanticEventCount: 2 },
		});
	});

	test("revoked permissions survive restart until an explicit grant", async () => {
		const repository = new InMemoryReflectionRepository();
		const first = createCollector({ repository }).collector;
		await first.recover();
		await first.ingest(authorizationEvent(1, 1_000, "authorization.revoked"));
		first.dispose();

		const second = createCollector({ repository }).collector;
		await second.recover();
		await second.ingest(inputActivityEvent(2, 5_000));
		expect(second.getSnapshot().openWindow).toBeNull();
		await second.ingest(authorizationEvent(3, 5_001, "authorization.granted"));
		await second.ingest(inputActivityEvent(4, 10_000));
		expect(second.getSnapshot().openWindow?.finalizedSemanticEventCount).toBe(1);
	});
});
