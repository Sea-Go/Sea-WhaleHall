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

	test("process inventory never counts and never starts a timer", async () => {
		const runtime = collector();
		await runtime.collector.recover();
		for (let index = 1; index <= 10_000; index += 1) {
			await runtime.collector.ingest(processBatch(index, 0));
		}
		expect(runtime.collector.getState()).toBe("ACTIVE_EMPTY");
		expect(runtime.collector.getSnapshot().openWindow).toBeNull();
		expect(runtime.clock.timerCount).toBe(0);
	});

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
});
