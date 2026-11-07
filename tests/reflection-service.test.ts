import { describe, expect, test } from "bun:test";
import type {
	LocalEventCommitResult,
	LocalEventGoalChange,
	LocalEventGoalChangeResult,
	LocalEventQuery,
	LocalEventQueryResult,
} from "../src/agent/local-protocol";
import type { ReflectionClock } from "../src/agent/reflection/collector";
import {
	InMemoryReflectionRepository,
	type SealWindowResult,
} from "../src/agent/reflection/repository";
import {
	type DesktopEventTransport,
	DesktopReflectionService,
	type TelemetryEnvelopeV1,
	type TelemetrySink,
} from "../src/agent/reflection/service";
import {
	type ActiveGoalContextV1,
	COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
	type DesktopEventV1,
	type EventWindowV1,
	REFLECTION_SCHEMA_VERSION,
	type ReflectionCollectorSnapshotV1,
	type ReflectionV1,
} from "../src/agent/reflection/types";

describe("DesktopReflectionService", () => {
	test("anonymous backlog is discarded before account B opens its durable epoch", async () => {
		const transport = new FakeTransport([foregroundEvent(1, "Anonymous")]);
		const repository = new InMemoryReflectionRepository();
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock: new FakeClock(10_000),
			semanticEventThreshold: 2,
			jobPollMs: 60_000,
			eventPollMs: 60_000,
		});

		await service.start();
		await service.cutoverCloudOwner("account-b");
		transport.appendDurable(foregroundEvent(2, "B-Editor"));
		transport.appendDurable(foregroundEvent(3, "B-Terminal"));
		await service.pullNow();
		await service.pullNow();

		const windows = await repository.listWindowsForAccount("account-b");
		expect(windows).toHaveLength(1);
		expect(windows[0]?.events.map((event) => event.eventId)).toEqual([
			"event-2",
			"event-3",
		]);
		expect(
			windows[0]?.events.some((event) => event.eventId === "event-1"),
		).toBeFalse();
		await service.stop();
	});

	test("A to B to A cutovers never reassign open or context evidence", async () => {
		const transport = new FakeTransport([]);
		const repository = new InMemoryReflectionRepository();
		const service = new DesktopReflectionService({
			transport,
			repository,
			inference: { infer: async (window) => reflectionFor(window) },
			identity: identity(),
			clock: new FakeClock(10_000),
			semanticEventThreshold: 2,
			jobPollMs: 60_000,
			eventPollMs: 60_000,
			cloudOwnerAccountId: () => "account-a",
		});

		await service.start();
		transport.appendDurable(foregroundEvent(1, "A-Open"));
		await service.pullNow();
		await service.cutoverCloudOwner(null);
		transport.appendDurable(foregroundEvent(2, "Transition"));
		await service.pullNow();
		await service.cutoverCloudOwner("account-b");
		transport.appendDurable(foregroundEvent(3, "B-Editor"));
		transport.appendDurable(foregroundEvent(4, "B-Terminal"));
		await service.pullNow();
		await service.pullNow();
		await service.cutoverCloudOwner(null);
		transport.appendDurable(foregroundEvent(5, "Transition-Back"));
		await service.pullNow();
		await service.cutoverCloudOwner("account-a");
		transport.appendDurable(foregroundEvent(6, "A-Editor"));
		transport.appendDurable(foregroundEvent(7, "A-Terminal"));
		await service.pullNow();
		await service.pullNow();

		const bWindows = await repository.listWindowsForAccount("account-b");
		const aWindows = await repository.listWindowsForAccount("account-a");
		expect(
			bWindows.flatMap((window) => window.events.map((event) => event.eventId)),
		).toEqual(["event-3", "event-4"]);
		expect(
			aWindows.flatMap((window) => window.events.map((event) => event.eventId)),
		).toEqual(["event-6", "event-7"]);
		expect(await repository.loadCollector("collector-1")).toMatchObject({
			activeGoal: null,
			cloudOwnerEpoch: { epoch: 5, accountId: "account-a" },
		});
		await service.stop();
	});

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
});

class FakeTransport implements DesktopEventTransport {
	readonly queries: LocalEventQuery[] = [];
	readonly commits: string[] = [];
	readonly preparedStartupChanges: Array<LocalEventGoalChange | null> = [];
	startupGoalAcknowledgements = 0;
	emitDuringStart: DesktopEventV1 | null = null;
	durableDuringStart: DesktopEventV1 | null = null;
	failNextCommit = false;
	beforeGoalAppend: (() => void) | null = null;
	afterGoalAppend: (() => void) | null = null;
	private readonly listeners = new Set<(event: DesktopEventV1) => void>();
	private committedIndex = 0;
	private readonly goalEvents = new Map<string, DesktopEventV1>();
	private preparedStartupChange: LocalEventGoalChange | null | undefined;

	constructor(private readonly events: DesktopEventV1[]) {}

	get listenerCount(): number {
		return this.listeners.size;
	}

	async prepareStartupGoalChange(
		change: LocalEventGoalChange | null,
	): Promise<void> {
		this.preparedStartupChanges.push(structuredClone(change));
		this.preparedStartupChange = structuredClone(change);
	}

	async acknowledgeStartupGoalChange(): Promise<void> {
		this.startupGoalAcknowledgements += 1;
	}

	async start(): Promise<void> {
		if (this.preparedStartupChange) {
			await this.reconcileStartupGoalChange(this.preparedStartupChange);
		}
		this.preparedStartupChange = undefined;
		if (this.durableDuringStart) {
			this.appendDurable(this.durableDuringStart);
			this.emit(this.durableDuringStart);
		}
		if (this.emitDuringStart) this.emit(this.emitDuringStart);
	}

	async queryDesktopEvents(
		query: LocalEventQuery,
	): Promise<LocalEventQueryResult> {
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
		if (index >= 0)
			this.committedIndex = Math.max(this.committedIndex, index + 1);
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

	allEvents(): DesktopEventV1[] {
		return structuredClone(this.events);
	}

	private async reconcileStartupGoalChange(
		intent: LocalEventGoalChange,
	): Promise<void> {
		let current = structuredClone(intent.previous);
		let revision = Math.max(
			current?.version ?? 0,
			(intent.next?.version ?? 1) - 1,
		);
		for (const event of this.events) {
			if (event.kind !== "goal.contextChanged") continue;
			const eventRevision =
				event.payload.next?.version ??
				(event.payload.previous?.version ?? -1) + 1;
			if (eventRevision < revision) continue;
			current = structuredClone(event.payload.next);
			revision = eventRevision;
		}
		if (sameGoalTargetForTest(current, intent.next)) return;
		await this.appendDesktopGoalChange({
			...structuredClone(intent),
			previous: current,
			next: intent.next
				? {
						...structuredClone(intent.next),
						version: revision + 1,
					}
				: null,
		});
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
		cloudOwnerAccountId: string | null,
	): Promise<SealWindowResult> {
		if (!this.gateUsed) {
			this.gateUsed = true;
			this.sealSignal.resolve(undefined);
			await this.sealRelease.promise;
		}
		return super.sealWindow(
			window,
			nextSnapshot,
			expectedRevision,
			cloudOwnerAccountId,
		);
	}
}

class FakeClock implements ReflectionClock {
	private nextTimerId = 1;
	private readonly timers = new Map<
		number,
		{ callback: () => void; deadlineAtMs: number }
	>();

	constructor(private value: number) {}

	get pendingTimerCount(): number {
		return this.timers.size;
	}

	nowMs(): number {
		return this.value;
	}

	setTimer(
		callback: () => void,
		delayMs: number,
	): ReturnType<typeof setTimeout> {
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

function sameGoalTargetForTest(
	left: ActiveGoalContextV1 | null,
	right: ActiveGoalContextV1 | null,
): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.goalId === right.goalId &&
			left.planId === right.planId &&
			left.text === right.text &&
			left.activatedAtMs === right.activatedAtMs)
	);
}

function goalChangeEvent(
	sequence: number,
	previous: ActiveGoalContextV1 | null,
	next: ActiveGoalContextV1 | null,
	atMs: number,
): DesktopEventV1 {
	return {
		schemaVersion: "desktop-event.v1",
		eventId: `goal-event-${sequence}`,
		cursor: `ec1_${sequence.toString(16).padStart(16, "0")}`,
		deviceId: "native-device",
		sessionId: "native-session",
		kind: "goal.contextChanged",
		source: "planning.controller",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: previous?.version ?? null,
		sensitivity: "content",
		payload: {
			previous: structuredClone(previous),
			next: structuredClone(next),
		},
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
		cloudOwnerEpoch: { epoch: 0, accountId: null },
		openWindow: {
			cloudOwnerEpoch: { epoch: 0, accountId: null },
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
