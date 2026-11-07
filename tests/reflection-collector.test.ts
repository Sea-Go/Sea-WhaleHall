import { describe, expect, test } from "bun:test";
import {
	type ActiveGoalContextV1,
	COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
	DESKTOP_EVENT_SCHEMA_VERSION,
	type DesktopEventForKind,
	DeterministicWindowBuilder,
	type EventWindowV1,
	GoalVersionMismatchError,
	InMemoryReflectionRepository,
	type ReflectionClock,
	ReflectionCollector,
	type ReflectionCollectorSnapshotV1,
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
	onCountReady?: (reachedAtMs: number) => void;
	onWindowSealed?: (window: EventWindowV1) => void | Promise<void>;
}) {
	const repository = options.repository ?? new InMemoryReflectionRepository();
	const clock = options.clock ?? new FakeClock();
	const collector = new ReflectionCollector({
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
		repository,
		windowBuilder: new DeterministicWindowBuilder(
			new WebCryptoReflectionHasher(),
		),
		clock,
		initialGoal: options.initialGoal,
		semanticEventThreshold: options.threshold,
		onCountReady: options.onCountReady,
		onWindowSealed: options.onWindowSealed,
	});
	return { collector, repository, clock };
}

describe("ReflectionCollector count and deadline triggers", () => {
	test("the 63rd finalized semantic event does not seal and the 64th seals once", async () => {
		const sealedWindows: EventWindowV1[] = [];
		const { collector, repository, clock } = createCollector({
			onWindowSealed: (window) => {
				sealedWindows.push(window);
			},
		});
		await collector.recover();
		for (let index = 1; index <= 63; index += 1) {
			expect(await collector.ingest(foregroundEvent(index, 0))).toBeNull();
		}
		expect(collector.getState()).toBe("ACTIVE_COLLECTING");
		expect(
			collector.getSnapshot().openWindow?.finalizedSemanticEventCount,
		).toBe(63);
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
		expect(sealedWindows).toHaveLength(1);
		expect(sealedWindows[0]).toMatchObject({
			windowId: window?.windowId,
			eventCount: 64,
			events: expect.arrayContaining([
				expect.objectContaining({ eventId: "event-1" }),
				expect.objectContaining({ eventId: "event-64" }),
			]),
		});
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
});

describe("ReflectionCollector boundaries and goal isolation", () => {});

describe("ReflectionCollector recovery, context, and idempotency", () => {});

describe("ReflectionCollector authorization gates", () => {});
