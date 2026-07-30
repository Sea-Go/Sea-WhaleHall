import { describe, expect, test } from "bun:test";
import type {
	ReflectionClock,
	ReflectionTimerHandle,
} from "../src/agent/reflection/collector";
import { WebCryptoReflectionHasher } from "../src/agent/reflection/hash";
import {
	InMemoryTimelineV2Repository,
	TimelineV2Collector,
	type SemanticEventV2,
} from "../src/agent/timeline-v2";

class FakeClock implements ReflectionClock {
	private id = 0;
	private readonly timers = new Map<
		number,
		{ callback: () => void; atMs: number }
	>();

	constructor(private now = 0) {}

	nowMs(): number {
		return this.now;
	}

	setTimer(callback: () => void, delayMs: number): ReflectionTimerHandle {
		const id = ++this.id;
		this.timers.set(id, { callback, atMs: this.now + delayMs });
		return id as unknown as ReflectionTimerHandle;
	}

	clearTimer(handle: ReflectionTimerHandle): void {
		this.timers.delete(handle as unknown as number);
	}

	advance(deltaMs: number): void {
		this.now += deltaMs;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.atMs <= this.now)
				.sort(
					([leftId, left], [rightId, right]) =>
						left.atMs - right.atMs || leftId - rightId,
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

function event(
	index: number,
	atMs: number,
): SemanticEventV2 {
	return {
		schemaVersion: "semantic-event.v2",
		eventId: `event-${index}`,
		cursor: `sec2_${index.toString(16).padStart(16, "0")}`,
		deviceId: "native-device",
		sessionId: "native-session",
		kind: "application.foregroundChanged",
		source: "observer.workspace",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		countClass: "effective",
		reliability: "high",
		coverage: ["metadata"],
		contentState: "unavailable",
		sourceObservationIds: [`observation-${index}`],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "semantic-projector.v2",
		payload: {
			appId: `com.example.app${index}`,
			appName: `App ${index}`,
		},
	};
}

function processBatch(index: number, atMs: number): SemanticEventV2 {
	return {
		...event(index, atMs),
		kind: "application.processObservedBatch",
		countClass: "ignored",
		payload: { started: [], exited: [] },
	};
}

function authorization(
	index: number,
	atMs: number,
	transition: "baseline" | "changed" | "granted" | "revoked" | "mixed",
	automation: "granted" | "denied" | "not_determined" = "granted",
): SemanticEventV2 {
	return {
		...event(index, atMs),
		kind: "authorization.changed",
		source: "workspace.observer-authorization.v2",
		countClass: "boundary",
		reliability: "high",
		coverage: ["metadata"],
		contentState: "available",
		payload: {
			permissions: {
				accessibility: "granted",
				screenRecording: "granted",
				inputMonitoring: "granted",
				automation,
			},
			changedPermissions: ["automation"],
			transition,
			reason:
				transition === "baseline"
					? "startup_snapshot"
					: "runtime_change",
		},
	};
}

function collector(clock = new FakeClock()) {
	const repository = new InMemoryTimelineV2Repository();
	return {
		clock,
		repository,
		collector: new TimelineV2Collector({
			collectorId: "collector.timeline-v2",
			deviceId: "device-1",
			sessionId: "session-1",
			repository,
			hasher: new WebCryptoReflectionHasher(),
			clock,
		}),
	};
}

describe("TimelineV2Collector dual trigger", () => {
	test("the 63rd effective event does not seal and the 64th seals exactly once", async () => {
		const runtime = collector();
		await runtime.collector.recover();
		for (let index = 1; index <= 63; index += 1) {
			expect(
				await runtime.collector.ingest(event(index, index)),
			).toBeNull();
		}
		expect(runtime.collector.getSnapshot().openWindow).toMatchObject({
			effectiveEventCount: 63,
		});
		expect(runtime.clock.timerCount).toBe(1);

		const sealed = await runtime.collector.ingest(event(64, 64));
		expect(sealed).toMatchObject({
			triggerReason: "event_count",
			eventCount: 64,
			firstCursor: "sec2_0000000000000001",
			lastCursor: "sec2_0000000000000040",
		});
		expect(runtime.collector.getState()).toBe("ACTIVE_EMPTY");
		expect((await runtime.repository.getJob(sealed!.windowId))?.state).toBe(
			"READY",
		);
	});

	test("first effective event starts one timer and 300000ms seals sparse data", async () => {
		const runtime = collector();
		await runtime.collector.recover();
		expect(runtime.clock.timerCount).toBe(0);
		await runtime.collector.ingest(event(1, 0));
		expect(runtime.clock.timerCount).toBe(1);

		runtime.clock.advance(299_999);
		await runtime.collector.whenIdle();
		expect(runtime.collector.getState()).toBe("ACTIVE_COLLECTING");
		runtime.clock.advance(1);
		await runtime.collector.whenIdle();
		expect(runtime.collector.getState()).toBe("ACTIVE_EMPTY");
		const snapshot = runtime.collector.getSnapshot();
		expect(snapshot.openWindow).toBeNull();
		const context = snapshot.contextCandidates;
		expect(context).toHaveLength(1);
		const windowId = (
			await runtime.repository.readAuditRange(0, 300_001)
		).windows[0]?.windowId;
		expect((await runtime.repository.getWindow(windowId!))?.triggerReason).toBe(
			"max_wait",
		);
	});

	test(
		"process inventory never counts and never starts a timer",
		async () => {
			const runtime = collector();
			await runtime.collector.recover();
			for (let index = 1; index <= 10_000; index += 1) {
				await runtime.collector.ingest(processBatch(index, 0));
			}
			expect(runtime.collector.getState()).toBe("ACTIVE_EMPTY");
			expect(runtime.collector.getSnapshot().openWindow).toBeNull();
			expect(runtime.clock.timerCount).toBe(0);
		},
		30_000,
	);

	test("authorization revocation discards a non-empty open window", async () => {
		const runtime = collector();
		await runtime.collector.recover();
		await runtime.collector.ingest(event(1, 0));
		await runtime.collector.discardForAuthorizationRevocation(
			"sec2_0000000000000002",
		);
		expect(runtime.collector.getSnapshot()).toMatchObject({
			state: "ACTIVE_EMPTY",
			openWindow: null,
			contextCandidates: [],
			materializedCursor: "sec2_0000000000000002",
		});
		expect(runtime.clock.timerCount).toBe(0);
	});

	test("authorization boundaries never count and restoration starts a new window", async () => {
		const runtime = collector();
		await runtime.collector.recover();
		await runtime.collector.ingest(
			authorization(1, 0, "baseline", "not_determined"),
		);
		expect(runtime.collector.getState()).toBe("ACTIVE_EMPTY");
		expect(runtime.clock.timerCount).toBe(0);

		await runtime.collector.ingest(event(2, 1_000));
		await runtime.collector.ingest(
			authorization(3, 2_000, "revoked", "denied"),
		);
		expect(runtime.collector.getSnapshot()).toMatchObject({
			state: "ACTIVE_EMPTY",
			openWindow: null,
			contextCandidates: [],
			materializedCursor: "sec2_0000000000000003",
		});
		expect(runtime.clock.timerCount).toBe(0);
		expect(
			runtime.collector.getSnapshot().recentEventIds,
		).toContain("event-3");

		await runtime.collector.ingest(
			authorization(4, 3_000, "granted", "granted"),
		);
		await runtime.collector.ingest(event(5, 4_000));
		expect(runtime.collector.getSnapshot().openWindow).toMatchObject({
			startedAtMs: 4_000,
			effectiveEventCount: 1,
			events: [{ eventId: "event-5" }],
		});
	});

	test("recovery applies a durable revocation before sealing an overdue window", async () => {
		const clock = new FakeClock(400_000);
		const repository = new InMemoryTimelineV2Repository();
		const first = new TimelineV2Collector({
			collectorId: "collector.authorization-recovery",
			deviceId: "device-1",
			sessionId: "session-1",
			repository,
			hasher: new WebCryptoReflectionHasher(),
			clock,
		});
		await first.recover({ deferDeadline: true });
		await first.ingest(event(1, 0));
		first.dispose();

		const recovered = new TimelineV2Collector({
			collectorId: "collector.authorization-recovery",
			deviceId: "device-1",
			sessionId: "session-1",
			repository,
			hasher: new WebCryptoReflectionHasher(),
			clock,
		});
		await recovered.recover({ deferDeadline: true });
		await recovered.ingest(
			authorization(2, 300_000, "revoked", "denied"),
		);
		await recovered.resumeDeadlines();
		expect(recovered.getSnapshot()).toMatchObject({
			state: "ACTIVE_EMPTY",
			openWindow: null,
			materializedCursor: "sec2_0000000000000002",
		});
		expect(
			(await repository.readAuditRange(0, 500_000)).windows,
		).toHaveLength(0);
	});
});
