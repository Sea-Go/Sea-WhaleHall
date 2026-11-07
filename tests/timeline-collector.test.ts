import { describe, expect, test } from "bun:test";
import type {
	ReflectionClock,
	ReflectionTimerHandle,
} from "../src/agent/reflection/collector";
import { WebCryptoReflectionHasher } from "../src/agent/reflection/hash";
import {
	InMemoryTimelineV2Repository,
	type SemanticEventV2,
	TimelineV2Collector,
} from "../src/agent/timeline";

// 慢速集成层：默认 dev 套件不执行这些用例；WHALEHALL_FULL_TESTS=1
// （CI/发布前全量）时按原样注册运行。
const fullTest = process.env.WHALEHALL_FULL_TESTS === "1" ? test : () => {};

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
	observedAtMs = atMs,
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
		observedAtMs,
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
			reason: transition === "baseline" ? "startup_snapshot" : "runtime_change",
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
	fullTest(
		"the 63rd effective event does not seal and the 64th seals exactly once",
		async () => {
			const runtime = collector();
			await runtime.collector.recover();
			for (let index = 1; index <= 63; index += 1) {
				expect(await runtime.collector.ingest(event(index, index))).toBeNull();
			}
			expect(runtime.collector.getSnapshot().openWindow).toMatchObject({
				effectiveEventCount: 63,
			});
			expect(runtime.clock.timerCount).toBe(1);

			const sealed = await runtime.collector.ingest(event(64, 64, 5_064));
			expect(sealed).toMatchObject({
				triggerReason: "event_count",
				eventCount: 64,
				endedAtMs: 5_064,
				firstCursor: "sec2_0000000000000001",
				lastCursor: "sec2_0000000000000040",
			});
			expect(
				sealed!.events.every((item) => item.observedAtMs <= sealed!.endedAtMs),
			).toBe(true);
			expect(runtime.collector.getState()).toBe("ACTIVE_EMPTY");
			expect((await runtime.repository.getJob(sealed!.windowId))?.state).toBe(
				"READY",
			);
		},
	);

	fullTest(
		"sealed interval contains delayed event and observation timestamps",
		async () => {
			const runtime = collector();
			await runtime.collector.recover();
			await runtime.collector.ingest(event(1, 1_000));
			for (let index = 2; index <= 63; index += 1) {
				await runtime.collector.ingest(event(index, 1_000 + index));
			}

			const sealed = await runtime.collector.ingest(event(64, 900, 5_064));
			expect(sealed).toMatchObject({
				triggerReason: "event_count",
				startedAtMs: 900,
				endedAtMs: 5_064,
				deadlineAtMs: 301_000,
			});
			expect(
				sealed!.events.every(
					(item) =>
						item.occurredAtMs >= sealed!.startedAtMs &&
						item.observedAtMs <= sealed!.endedAtMs,
				),
			).toBe(true);
		},
	);
});
