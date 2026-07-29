import { describe, expect, test } from "bun:test";
import type {
	LocalEventCommitResult,
	LocalEventGoalChange,
	LocalEventGoalChangeResult,
	LocalEventQuery,
	LocalEventQueryResult,
} from "../src/agent/local-protocol";
import {
	InMemoryReflectionRepository,
	type SealWindowResult,
} from "../src/agent/reflection/repository";
import {
	DesktopReflectionService,
	type DesktopEventTransport,
	type TelemetryEnvelopeV1,
	type TelemetrySink,
} from "../src/agent/reflection/service";
import {
	COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
	REFLECTION_SCHEMA_VERSION,
	type DesktopEventV1,
	type EventWindowV1,
	type ReflectionCollectorSnapshotV1,
	type ReflectionV1,
} from "../src/agent/reflection/types";
import type { ReflectionClock } from "../src/agent/reflection/collector";

describe("DesktopReflectionService", () => {
	test("pulls from the durable consumer, commits each cursor, and runs a sealed job", async () => {
		const clock = new FakeClock(10_000);
		const transport = new FakeTransport([
			foregroundEvent(1, "Code"),
			foregroundEvent(2, "Safari"),
		]);
		const repository = new InMemoryReflectionRepository();
		const envelopes: TelemetryEnvelopeV1[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 2,
			jobPollMs: 60_000,
			sinks: [collectingSink(envelopes)],
		});

		await service.start();
		expect(transport.queries[0]).toEqual({
			consumerId: "whalehall.reflection.v1",
			limit: 256,
		});
		expect(transport.commits).toEqual([
			"ec1_0000000000000001",
			"ec1_0000000000000002",
		]);
		expect((await service.getStatus()).pendingJobs).toBe(1);
		await service.runJobsNow();
		expect(envelopes).toHaveLength(1);
		expect(envelopes[0]?.reflection.activity.label).toBe("development");
		expect((await service.getStatus()).pendingJobs).toBe(0);
		await service.stop();
	});

	test("buffers live events during recovery and suppresses pull/push duplicates", async () => {
		const clock = new FakeClock(20_000);
		const duplicate = foregroundEvent(1, "Code");
		const transport = new FakeTransport([duplicate]);
		transport.emitDuringStart = duplicate;
		const service = new DesktopReflectionService({
			transport,
			repository: new InMemoryReflectionRepository(),
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
		});
		await service.start();
		expect(transport.commits).toEqual(["ec1_0000000000000001"]);
		expect((await service.getStatus()).collectorState).toBe("ACTIVE_COLLECTING");
		await service.stop();
	});

	test("replays a live event after collector persistence fails without poisoning dedupe", async () => {
		const clock = new FakeClock(20_000);
		const transport = new FakeTransport([]);
		const repository = new FailOnceSaveRepository();
		const errors: unknown[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
			onError: (error) => errors.push(error),
		});
		await service.start();

		const first = foregroundEvent(1, "Code");
		transport.appendDurable(first);
		repository.failNextSave = true;
		transport.emit(first);
		// pullNow is serialized behind the failed live operation and must repair
		// it from the durable named consumer before re-enabling the fast path.
		await service.pullNow();

		expect(errors).toHaveLength(1);
		expect(transport.commits).toEqual(["ec1_0000000000000001"]);
		expect(await repository.loadCollector("collector-1")).toMatchObject({
			state: "ACTIVE_COLLECTING",
			materializedCursor: "ec1_0000000000000001",
			openWindow: {
				finalizedSemanticEventCount: 1,
			},
		});
		await service.stop();
	});

	test("never commits a later queued cursor over a failed durable gap", async () => {
		const clock = new FakeClock(20_000);
		const transport = new FakeTransport([]);
		const repository = new FailOnceSaveRepository();
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
			onError: () => undefined,
		});
		await service.start();

		const first = foregroundEvent(1, "Code");
		const second = foregroundEvent(2, "Terminal");
		transport.appendDurable(first);
		transport.appendDurable(second);
		repository.failNextSave = true;
		transport.emit(first);
		transport.emit(second);
		await service.pullNow();

		expect(transport.commits).toEqual([
			"ec1_0000000000000001",
			"ec1_0000000000000002",
		]);
		expect(await repository.loadCollector("collector-1")).toMatchObject({
			materializedCursor: "ec1_0000000000000002",
			openWindow: {
				finalizedSemanticEventCount: 2,
			},
		});
		await service.stop();
	});

	test("replays an already materialized event when native cursor commit fails", async () => {
		const clock = new FakeClock(20_000);
		const transport = new FakeTransport([]);
		const repository = new InMemoryReflectionRepository();
		const errors: unknown[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
			onError: (error) => errors.push(error),
		});
		await service.start();

		const first = foregroundEvent(1, "Code");
		transport.appendDurable(first);
		transport.failNextCommit = true;
		transport.emit(first);
		await service.pullNow();

		expect(errors).toHaveLength(1);
		expect(transport.commits).toEqual(["ec1_0000000000000001"]);
		expect(await repository.loadCollector("collector-1")).toMatchObject({
			materializedCursor: "ec1_0000000000000001",
			openWindow: {
				finalizedSemanticEventCount: 1,
			},
		});
		await service.stop();
	});

	test("re-pulls a push that arrives while paused recovery is sealing", async () => {
		const clock = new FakeClock(20_000);
		const transport = new FakeTransport([]);
		const repository = new GatedSealRepository();
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 1,
			jobPollMs: 60_000,
			eventPollMs: 60_000,
			onError: () => undefined,
		});
		await service.start();

		const first = foregroundEvent(1, "Code");
		transport.appendDurable(first);
		repository.failNextSave = true;
		transport.emit(first);
		const recovery = service.pullNow();
		await repository.sealStarted;

		const second = foregroundEvent(2, "Terminal");
		transport.appendDurable(second);
		transport.emit(second);
		repository.releaseSeal();
		await recovery;

		expect(transport.commits).toEqual([
			"ec1_0000000000000001",
			"ec1_0000000000000002",
		]);
		expect((await service.getStatus()).pendingJobs).toBe(2);
		await service.stop();
	});

	test("periodic durable polling recovers events even when no push wakes the service", async () => {
		const clock = new FakeClock(20_000);
		const transport = new FakeTransport([]);
		const repository = new InMemoryReflectionRepository();
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
			eventPollMs: 100,
		});
		await service.start();

		transport.appendDurable(foregroundEvent(1, "Code"));
		clock.advance(100);
		await spinUntil(() => transport.commits.length === 1);

		expect(transport.commits).toEqual(["ec1_0000000000000001"]);
		expect(await repository.loadCollector("collector-1")).toMatchObject({
			openWindow: { finalizedSemanticEventCount: 1 },
		});
		await service.stop();
	});

	test("stop waits for an in-flight job pump before repository ownership ends", async () => {
		const clock = new FakeClock(20_000);
		const transport = new FakeTransport([foregroundEvent(1, "Code")]);
		const repository = new InMemoryReflectionRepository();
		const inferenceStarted = deferred<void>();
		const releaseInference = deferred<void>();
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: {
				infer: async (window) => {
					inferenceStarted.resolve(undefined);
					await releaseInference.promise;
					return reflectionFor(window);
				},
			},
			identity: identity(),
			clock,
			semanticEventThreshold: 1,
			jobPollMs: 60_000,
			eventPollMs: 60_000,
		});
		await service.start();
		clock.advance(0);
		await inferenceStarted.promise;

		let stopCompleted = false;
		const stopping = service.stop().then(() => {
			stopCompleted = true;
		});
		await Promise.resolve();
		expect(stopCompleted).toBeFalse();

		releaseInference.resolve(undefined);
		await stopping;
		expect(stopCompleted).toBeTrue();
	});

	test("goal changes seal the old window and subsequent native events inherit the new version", async () => {
		const clock = new FakeClock(30_000);
		const transport = new FakeTransport([foregroundEvent(1, "Code")]);
		const repository = new InMemoryReflectionRepository();
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
		});
		await service.start();
		const goal = await service.setActiveGoal({
			goalId: "goal-1",
			planId: "plan-1",
			text: "完成 WhaleHall 反思系统",
			activatedAtMs: clock.nowMs(),
		});
		expect(goal?.version).toBe(1);
		expect((await service.getStatus()).pendingJobs).toBe(1);

		transport.emit(foregroundEvent(3, "Terminal"));
		await service.pullNow();
		const snapshot = await repository.loadCollector("collector-1");
		expect(snapshot?.openWindow?.goalVersion).toBe(1);
		expect(snapshot?.openWindow?.events[0]?.goalVersion).toBe(1);
		await service.stop();
	});

	test("the native goal cursor orders racing sensor events on the correct goal side", async () => {
		const clock = new FakeClock(30_000);
		const transport = new FakeTransport([
			foregroundEvent(1, "Code", 1_000),
		]);
		transport.beforeGoalAppend = () => {
			transport.appendDurable(foregroundEvent(2, "Terminal", 29_999));
		};
		transport.afterGoalAppend = () => {
			transport.appendDurable(foregroundEvent(4, "Safari", 30_001));
		};
		const repository = new InMemoryReflectionRepository();
		const envelopes: TelemetryEnvelopeV1[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
			eventPollMs: 60_000,
			sinks: [collectingSink(envelopes)],
		});
		await service.start();

		const goal = await service.setActiveGoal({
			goalId: "goal-ordered",
			planId: null,
			text: "验证原生目标边界",
			activatedAtMs: 30_000,
		});
		await service.runJobsNow();

		expect(goal?.version).toBe(1);
		expect(envelopes[0]?.window).toMatchObject({
			triggerReason: "goal_boundary",
			goalVersion: null,
			eventCount: 2,
		});
		expect(
			envelopes[0]?.window.events
				.filter((event) => event.kind === "application.foregroundChanged")
				.map((event) => event.eventId),
		).toEqual(["event-1", "event-2"]);
		expect(await repository.loadCollector("collector-1")).toMatchObject({
			activeGoal: { version: 1 },
			openWindow: {
				goalVersion: 1,
				finalizedSemanticEventCount: 1,
				events: [{ eventId: "event-4", goalVersion: 1 }],
			},
		});
		await service.stop();
	});

	test("a durable same-timestamp presence boundary outranks the count threshold", async () => {
		const transport = new FakeTransport([
			foregroundEvent(1, "Code", 1_000),
			foregroundEvent(2, "Terminal", 2_000),
			presenceEvent(3, 2_000),
		]);
		const repository = new InMemoryReflectionRepository();
		const envelopes: TelemetryEnvelopeV1[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock: new FakeClock(2_000),
			semanticEventThreshold: 2,
			jobPollMs: 60_000,
			sinks: [collectingSink(envelopes)],
		});

		await service.start();
		await service.runJobsNow();

		expect(envelopes).toHaveLength(1);
		expect(envelopes[0]?.window).toMatchObject({
			triggerReason: "presence_boundary",
			eventCount: 2,
		});
		expect(envelopes[0]?.window.events.at(-1)?.kind).toBe("presence.afkStarted");
		await service.stop();
	});

	test("a live 64th-equivalent push pulls a durable same-time boundary before sealing", async () => {
		const first = foregroundEvent(1, "Code", 1_000);
		const second = foregroundEvent(2, "Terminal", 2_000);
		const boundary = presenceEvent(3, 2_000);
		const transport = new FakeTransport([first]);
		const repository = new InMemoryReflectionRepository();
		const envelopes: TelemetryEnvelopeV1[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock: new FakeClock(2_000),
			semanticEventThreshold: 2,
			jobPollMs: 60_000,
			sinks: [collectingSink(envelopes)],
		});
		await service.start();
		transport.appendDurable(second);
		transport.appendDurable(boundary);

		transport.emit(second);
		await service.pullNow();
		await service.runJobsNow();

		expect(envelopes[0]?.window.triggerReason).toBe("presence_boundary");
		expect(envelopes[0]?.window.eventCount).toBe(2);
		await service.stop();
	});

	test("a same-timestamp authorization revocation discards a count-ready window", async () => {
		const transport = new FakeTransport([
			foregroundEvent(1, "Code", 1_000),
			foregroundEvent(2, "Terminal", 2_000),
			authorizationRevokedEvent(3, 2_000),
		]);
		const repository = new InMemoryReflectionRepository();
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock: new FakeClock(2_000),
			semanticEventThreshold: 2,
			jobPollMs: 60_000,
		});

		await service.start();

		expect((await service.getStatus()).pendingJobs).toBe(0);
		expect(await repository.loadCollector("collector-1")).toMatchObject({
			state: "ACTIVE_EMPTY",
			openWindow: null,
			revokedPermissions: ["input.monitoring"],
		});
		await service.stop();
	});

	test("rejects oversized goal context before it can strand model input sealing", async () => {
		const service = new DesktopReflectionService({
			transport: new FakeTransport([]),
			repository: new InMemoryReflectionRepository(),
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock: new FakeClock(30_000),
			jobPollMs: 60_000,
		});
		await service.start();

		await expect(
			service.setActiveGoal({
				goalId: "goal-oversized",
				planId: null,
				text: "鲸".repeat(1_001),
				activatedAtMs: 30_000,
			}),
		).rejects.toThrow("1000");
		expect((await service.getStatus()).collectorState).toBe("ACTIVE_EMPTY");
		await service.stop();
	});

	test("matches native goal identifier and multiline text validation", async () => {
		const service = new DesktopReflectionService({
			transport: new FakeTransport([]),
			repository: new InMemoryReflectionRepository(),
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock: new FakeClock(30_000),
			jobPollMs: 60_000,
		});
		await service.start();

		await expect(
			service.setActiveGoal({
				goalId: "bad\nidentifier",
				planId: null,
				text: "valid",
				activatedAtMs: 30_000,
			}),
		).rejects.toThrow("goalId");
		await expect(
			service.setActiveGoal({
				goalId: "goal-multiline",
				planId: null,
				text: "第一行\n第二行",
				activatedAtMs: 30_000,
			}),
		).resolves.toMatchObject({
			version: 1,
			text: "第一行\n第二行",
		});
		await service.stop();
	});

	test("goal revisions remain monotonic across an explicit no-goal interval", async () => {
		const repository = new InMemoryReflectionRepository();
		const clock = new FakeClock(30_000);
		const service = new DesktopReflectionService({
			transport: new FakeTransport([]),
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			jobPollMs: 60_000,
		});
		await service.start();
		const first = await service.setActiveGoal({
			goalId: "goal-1",
			planId: null,
			text: "完成第一阶段",
			activatedAtMs: 30_000,
		});
		clock.advance(1);
		expect(await service.setActiveGoal(null)).toBeNull();
		expect(await repository.loadCollector("collector-1")).toMatchObject({
			activeGoal: null,
			goalRevision: 2,
		});
		clock.advance(1);
		const second = await service.setActiveGoal({
			goalId: "goal-2",
			planId: null,
			text: "完成第二阶段",
			activatedAtMs: 30_002,
		});

		expect(first?.version).toBe(1);
		expect(second?.version).toBe(3);
		await service.stop();
	});

	test("clears a recovered goal before native startup can attribute new events", async () => {
		const clock = new FakeClock(30_000);
		const repository = new InMemoryReflectionRepository();
		const oldGoal = {
			goalId: "old-goal",
			planId: "old-plan",
			version: 1,
			text: "上一账号的目标",
			activatedAtMs: 500,
		};
		const oldEvent = {
			...foregroundEvent(1, "Code", 1_000),
			goalVersion: 1,
		};
		await repository.saveCollector(
			{
				schemaVersion: COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
				collectorId: "collector-1",
				deviceId: "device-1",
				sessionId: "session-1",
				state: "ACTIVE_COLLECTING",
				activeGoal: oldGoal,
				goalRevision: 1,
				openWindow: {
					goal: oldGoal,
					goalVersion: 1,
					startedAtMs: 1_000,
					deadlineAtMs: 301_000,
					events: [oldEvent],
					finalizedSemanticEventCount: 1,
				},
				contextCandidates: [],
				recentEventIds: [oldEvent.eventId],
				revokedPermissions: [],
				materializedCursor: oldEvent.cursor,
				revision: 0,
				updatedAtMs: 1_000,
			},
			null,
		);
		const transport = new FakeTransport([
			foregroundEvent(2, "Terminal", 2_000),
		]);
		const envelopes: TelemetryEnvelopeV1[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			startupGoal: null,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
			eventPollMs: 60_000,
			sinks: [collectingSink(envelopes)],
		});

		await service.start();
		expect(await repository.loadCollector("collector-1")).toMatchObject({
			activeGoal: null,
			goalRevision: 2,
			openWindow: null,
		});
		expect((await service.getStatus()).pendingJobs).toBe(1);
		const results = await service.runJobsNow();
		expect(results.map((result) => result.status)).toEqual([
			"committed",
			"idle",
		]);
		expect(envelopes[0]?.window).toMatchObject({
			triggerReason: "goal_boundary",
			goalVersion: 1,
			eventCount: 2,
		});
		expect(
			envelopes[0]?.window.events
				.filter((event) => event.kind === "application.foregroundChanged")
				.map((event) => [event.eventId, event.goalVersion]),
		).toEqual([
			["event-1", 1],
			["event-2", 1],
		]);
		await service.stop();
	});

	test("replays a persisted 64th event before sealing an overdue recovered window", async () => {
		const clock = new FakeClock(400_000);
		const repository = new InMemoryReflectionRepository();
		await seedOpenCollector(repository, 63);
		const transport = new FakeTransport([
			foregroundEvent(64, "Terminal", 301_000),
		]);
		const envelopes: TelemetryEnvelopeV1[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
			sinks: [collectingSink(envelopes)],
		});

		await service.start();
		await service.runJobsNow();
		expect(envelopes).toHaveLength(1);
		expect(envelopes[0]?.window).toMatchObject({
			triggerReason: "event_count",
			eventCount: 64,
			lastCursor: "ec1_0000000000000040",
		});
		await service.stop();
	});

	test("replays a persisted presence boundary before an overdue deadline", async () => {
		const clock = new FakeClock(400_000);
		const repository = new InMemoryReflectionRepository();
		await seedOpenCollector(repository, 1);
		const boundary: DesktopEventV1 = {
			schemaVersion: "desktop-event.v1",
			eventId: "event-2",
			cursor: "ec1_0000000000000002",
			deviceId: "native-device",
			sessionId: "native-session",
			kind: "presence.afkStarted",
			source: "presence.sensor",
			occurredAtMs: 301_000,
			observedAtMs: 301_000,
			goalVersion: null,
			sensitivity: "metadata",
			payload: { idleForMs: 60_000 },
		};
		const transport = new FakeTransport([boundary]);
		const envelopes: TelemetryEnvelopeV1[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
			sinks: [collectingSink(envelopes)],
		});

		await service.start();
		await service.runJobsNow();
		expect(envelopes[0]?.window).toMatchObject({
			triggerReason: "presence_boundary",
			eventCount: 1,
			lastCursor: "ec1_0000000000000002",
		});
		await service.stop();
	});

	test("pulls the durable watermark before a live deadline can win", async () => {
		const clock = new FakeClock(0);
		const initialEvents = Array.from({ length: 63 }, (_, index) =>
			foregroundEvent(index + 1, `App ${index + 1}`, index === 0 ? 0 : index + 1),
		);
		const transport = new FakeTransport(initialEvents);
		const repository = new InMemoryReflectionRepository();
		const envelopes: TelemetryEnvelopeV1[] = [];
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock,
			semanticEventThreshold: 64,
			jobPollMs: 60_000,
			sinks: [collectingSink(envelopes)],
		});
		await service.start();

		// The push notification is deliberately absent: the EventJournal pull
		// at the deadline must still discover the already durable 64th event.
		transport.appendDurable(foregroundEvent(64, "Terminal", 300_000));
		clock.advance(300_000);
		await service.pullNow();
		await service.runJobsNow();

		expect(envelopes[0]?.window).toMatchObject({
			triggerReason: "event_count",
			eventCount: 64,
		});
		await service.stop();
	});
});

class FakeTransport implements DesktopEventTransport {
	readonly queries: LocalEventQuery[] = [];
	readonly commits: string[] = [];
	emitDuringStart: DesktopEventV1 | null = null;
	failNextCommit = false;
	beforeGoalAppend: (() => void) | null = null;
	afterGoalAppend: (() => void) | null = null;
	private readonly listeners = new Set<(event: DesktopEventV1) => void>();
	private committedIndex = 0;
	private readonly goalEvents = new Map<string, DesktopEventV1>();

	constructor(private readonly events: DesktopEventV1[]) {}

	async start(): Promise<void> {
		if (this.emitDuringStart) this.emit(this.emitDuringStart);
	}

	async queryDesktopEvents(query: LocalEventQuery): Promise<LocalEventQueryResult> {
		this.queries.push({ ...query });
		const events = this.events.slice(this.committedIndex);
		return {
			events: structuredClone(events),
			nextCursor: events.at(-1)?.cursor ?? null,
			hasMore: false,
		};
	}

	async commitDesktopEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult> {
		if (this.failNextCommit) {
			this.failNextCommit = false;
			throw new Error("injected native cursor commit failure");
		}
		this.commits.push(cursor);
		const index = this.events.findIndex((event) => event.cursor === cursor);
		if (index >= 0) this.committedIndex = Math.max(this.committedIndex, index + 1);
		return { consumerId, cursor, advanced: true };
	}

	async appendDesktopGoalChange(
		change: LocalEventGoalChange,
	): Promise<LocalEventGoalChangeResult> {
		const existing = this.goalEvents.get(change.deduplicationKey);
		if (existing) return { event: structuredClone(existing), inserted: false };
		this.beforeGoalAppend?.();
		const sequence =
			this.events.reduce(
				(maximum, event) =>
					Math.max(maximum, Number.parseInt(event.cursor.slice(4), 16) || 0),
				0,
			) + 1;
		const event: DesktopEventV1 = {
			schemaVersion: "desktop-event.v1",
			eventId: `goal-event-${sequence}`,
			cursor: `ec1_${sequence.toString(16).padStart(16, "0")}`,
			deviceId: "native-device",
			sessionId: "native-session",
			kind: "goal.contextChanged",
			source: "planning.controller",
			occurredAtMs: change.occurredAtMs,
			observedAtMs: change.occurredAtMs,
			goalVersion: change.previous?.version ?? null,
			sensitivity: "content",
			payload: {
				previous: structuredClone(change.previous),
				next: structuredClone(change.next),
			},
		};
		this.events.push(structuredClone(event));
		this.goalEvents.set(change.deduplicationKey, structuredClone(event));
		this.afterGoalAppend?.();
		return { event, inserted: true };
	}

	onDesktopEvent(listener: (event: DesktopEventV1) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: DesktopEventV1): void {
		for (const listener of this.listeners) listener(structuredClone(event));
	}

	appendDurable(event: DesktopEventV1): void {
		this.events.push(structuredClone(event));
	}
}

class FailOnceSaveRepository extends InMemoryReflectionRepository {
	failNextSave = false;

	override async saveCollector(
		snapshot: ReflectionCollectorSnapshotV1,
		expectedRevision: number | null,
	): Promise<ReflectionCollectorSnapshotV1> {
		if (this.failNextSave) {
			this.failNextSave = false;
			throw new Error("injected collector persistence failure");
		}
		return super.saveCollector(snapshot, expectedRevision);
	}
}

class GatedSealRepository extends FailOnceSaveRepository {
	private readonly sealRelease = deferred<void>();
	private readonly sealSignal = deferred<void>();
	private gateUsed = false;
	readonly sealStarted = this.sealSignal.promise;

	releaseSeal(): void {
		this.sealRelease.resolve(undefined);
	}

	override async sealWindow(
		window: EventWindowV1,
		nextSnapshot: ReflectionCollectorSnapshotV1,
		expectedRevision: number,
	): Promise<SealWindowResult> {
		if (!this.gateUsed) {
			this.gateUsed = true;
			this.sealSignal.resolve(undefined);
			await this.sealRelease.promise;
		}
		return super.sealWindow(window, nextSnapshot, expectedRevision);
	}
}

class FakeClock implements ReflectionClock {
	private nextTimerId = 1;
	private readonly timers = new Map<
		number,
		{ callback: () => void; deadlineAtMs: number }
	>();

	constructor(private value: number) {}

	nowMs(): number {
		return this.value;
	}

	setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		const id = this.nextTimerId;
		this.nextTimerId += 1;
		this.timers.set(id, {
			callback,
			deadlineAtMs: this.value + Math.max(0, delayMs),
		});
		return id as unknown as ReturnType<typeof setTimeout>;
	}

	clearTimer(handle: ReturnType<typeof setTimeout>): void {
		this.timers.delete(handle as unknown as number);
	}

	advance(deltaMs: number): void {
		this.value += deltaMs;
		for (;;) {
			const next = Array.from(this.timers.entries())
				.filter(([, timer]) => timer.deadlineAtMs <= this.value)
				.sort(
					([leftId, left], [rightId, right]) =>
						left.deadlineAtMs - right.deadlineAtMs || leftId - rightId,
				)[0];
			if (!next) return;
			this.timers.delete(next[0]);
			next[1].callback();
		}
	}
}

function identity() {
	return {
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
	};
}

function foregroundEvent(
	sequence: number,
	appName: string,
	atMs = sequence * 1_000,
): DesktopEventV1 {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: `event-${sequence}`,
		cursor: `ec1_${sequence.toString(16).padStart(16, "0")}`,
		deviceId: "native-device",
		sessionId: "native-session",
		kind: "application.foregroundChanged",
		source: "activity.sensor",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		sensitivity: "metadata",
		payload: { appId: appName.toLowerCase(), appName },
	};
}

function presenceEvent(sequence: number, atMs: number): DesktopEventV1 {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: `event-${sequence}`,
		cursor: `ec1_${sequence.toString(16).padStart(16, "0")}`,
		deviceId: "native-device",
		sessionId: "native-session",
		kind: "presence.afkStarted",
		source: "presence.sensor",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		sensitivity: "metadata",
		payload: { idleForMs: 60_000 },
	};
}

function authorizationRevokedEvent(
	sequence: number,
	atMs: number,
): DesktopEventV1 {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: `event-${sequence}`,
		cursor: `ec1_${sequence.toString(16).padStart(16, "0")}`,
		deviceId: "native-device",
		sessionId: "native-session",
		kind: "authorization.revoked",
		source: "input.activity.sensor",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		sensitivity: "metadata",
		payload: { permissions: ["input.monitoring"] },
	};
}

async function seedOpenCollector(
	repository: InMemoryReflectionRepository,
	eventCount: number,
): Promise<void> {
	const events = Array.from({ length: eventCount }, (_, index) =>
		foregroundEvent(index + 1, `App ${index + 1}`),
	);
	const snapshot: ReflectionCollectorSnapshotV1 = {
		schemaVersion: COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
		state: "ACTIVE_COLLECTING",
		activeGoal: null,
		goalRevision: 0,
		openWindow: {
			goal: null,
			goalVersion: null,
			startedAtMs: 1_000,
			deadlineAtMs: 301_000,
			events,
			finalizedSemanticEventCount: eventCount,
		},
		contextCandidates: [],
		recentEventIds: events.map((event) => event.eventId),
		revokedPermissions: [],
		materializedCursor: events.at(-1)?.cursor ?? null,
		revision: 0,
		updatedAtMs: 100_000,
	};
	await repository.saveCollector(snapshot, null);
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
		goalRelevance: window.goal
			? {
					label: "direct",
					probabilities: {
						direct: 0.91,
						supporting: 0.03,
						unrelated: 0.03,
						uncertain: 0.03,
					},
				}
			: null,
		embedding: Array.from({ length: 256 }, (_, index) => (index === 0 ? 1 : 0)),
		confidence: 0.91,
		entropy: 0.2,
		abstain: false,
		evidenceEventIds: window.events.slice(0, 1).map((event) => event.eventId),
		feedbackCode: window.goal ? "encourage" : "silent",
		modelVersion: "test-model",
		taxonomyVersion: "activity.v1",
	};
}

function activityProbabilities(): ReflectionV1["activity"]["probabilities"] {
	return {
		development: 0.94,
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
		other_unknown: 0.01,
	};
}

function collectingSink(output: TelemetryEnvelopeV1[]): TelemetrySink {
	return {
		async emit(envelope) {
			output.push(structuredClone(envelope));
		},
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: resolvePromise,
	};
}

async function spinUntil(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 100; index += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition was not reached");
}
