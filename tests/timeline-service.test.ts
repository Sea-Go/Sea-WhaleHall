import { describe, expect, test } from "bun:test";
import type {
	LocalSemanticCommitResult,
	LocalSemanticQuery,
	LocalSemanticQueryResult,
} from "../src/agent/local-protocol";
import type {
	ReflectionClock,
	ReflectionTimerHandle,
} from "../src/agent/reflection/collector";
import {
	DeterministicTimelineHypothesisGenerator,
	InMemoryTimelineV2Repository,
	TimelineV2JobRunner,
	TimelineV2Service,
	type SemanticEventV2,
	type TimelineV2Processor,
} from "../src/agent/timeline";

class FakeClock implements ReflectionClock {
	private id = 0;
	private readonly timers = new Map<
		number,
		{ callback: () => void; atMs: number }
	>();

	constructor(private now = 10_000) {}

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

	setNow(nowMs: number): void {
		this.now = nowMs;
	}

	pendingTimerCount(): number {
		return this.timers.size;
	}

	runNextTimer(): void {
		const next = [...this.timers.entries()].sort(
			([leftId, left], [rightId, right]) =>
				left.atMs - right.atMs || leftId - rightId,
		)[0];
		if (!next) throw new Error("No pending fake timer.");
		this.timers.delete(next[0]);
		next[1].callback();
	}
}

class FakeSemanticTransport {
	readonly queries: LocalSemanticQuery[] = [];
	readonly commits: string[] = [];
	private readonly listeners = new Set<(event: SemanticEventV2) => void>();
	private readonly failCommitOnce = new Set<string>();
	private committedIndex = 0;

	constructor(private readonly durable: SemanticEventV2[]) {}

	async start(): Promise<void> {}

	async querySemanticEvents(
		query: LocalSemanticQuery,
	): Promise<LocalSemanticQueryResult> {
		this.queries.push(structuredClone(query));
		const events = this.durable.slice(this.committedIndex);
		return {
			events: structuredClone(events),
			nextCursor: events.at(-1)?.cursor ?? null,
			hasMore: false,
		};
	}

	async commitSemanticEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalSemanticCommitResult> {
		if (this.failCommitOnce.delete(cursor)) {
			throw new Error("injected semantic commit failure");
		}
		this.commits.push(cursor);
		const index = this.durable.findIndex(
			(event) => event.cursor === cursor,
		);
		this.committedIndex = Math.max(this.committedIndex, index + 1);
		return { consumerId, cursor, advanced: true };
	}

	onSemanticEvent(
		listener: (event: SemanticEventV2) => void,
	): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	append(...events: SemanticEventV2[]): void {
		this.durable.push(...events);
		for (const event of events) {
			for (const listener of this.listeners) listener(event);
		}
	}

	wake(event: SemanticEventV2): void {
		for (const listener of this.listeners) listener(event);
	}

	failNextCommit(cursor: string): void {
		this.failCommitOnce.add(cursor);
	}
}

function foreground(
	index: number,
	atMs: number,
	goalVersion: number | null = null,
): SemanticEventV2 {
	return {
		schemaVersion: "semantic-event.v2",
		eventId: `event-${index}`,
		cursor: `sec2_${index.toString(16).padStart(16, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "application.foregroundChanged",
		source: "observer.workspace",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion,
		countClass: "effective",
		reliability: "high",
		coverage: ["content", "metadata"],
		contentState: "available",
		sourceObservationIds: [`observation-${index}`],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "semantic-projector.v2",
		payload: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			opaqueWindowId: "window-code",
			windowTitle: "whalehall-local",
		},
	};
}

function textChange(
	index: number,
	atMs: number,
	text: string,
	goalVersion: number | null = null,
): SemanticEventV2 {
	return {
		...foreground(index, atMs, goalVersion),
		kind: "application.textValueChanged",
		source: "observer.ax",
		payload: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			opaqueWindowId: "window-code",
			opaqueControlId: "editor-visible",
			role: "AXTextArea",
			insertedChars: text.length,
			deletedChars: 0,
			deltaAvailable: true,
			inputMethod: "unknown",
			label: "代码编辑区",
			addedText: text,
			finalValue: text,
		},
	};
}

function authorization(
	index: number,
	atMs: number,
	transition: "baseline" | "changed" | "granted" | "revoked" | "mixed",
	automation: "granted" | "denied" | "not_determined",
): SemanticEventV2 {
	return {
		...foreground(index, atMs),
		kind: "authorization.changed",
		source: "workspace.observer-authorization.v2",
		countClass: "boundary",
		reliability: "high",
		coverage: ["metadata"],
		contentState: "available",
		sourceObservationIds: [`authorization-observation-${index}`],
		payload: {
			permissions: {
				accessibility: "granted",
				screenRecording: "granted",
				inputMonitoring: "granted",
				automation,
			},
			changedPermissions:
				transition === "baseline"
					? [
							"accessibility",
							"screenRecording",
							"inputMonitoring",
							"automation",
						]
					: ["automation"],
			transition,
			reason:
				transition === "baseline"
					? "startup_snapshot"
					: "runtime_change",
		},
	};
}

describe("TimelineV2Service", () => {
	test("rejects semantic events whose durable identity differs from the runtime identity", async () => {
		const forged = {
			...foreground(1, 1_000),
			deviceId: "forged-device",
		};
		const transport = new FakeSemanticTransport([forged]);
		const service = new TimelineV2Service({
			transport,
			repository: new InMemoryTimelineV2Repository(),
			identity: {
				collectorId: "collector.timeline-v2.identity",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock: new FakeClock(),
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});

		await expect(service.start()).rejects.toThrow(
			"Semantic event identity mismatch",
		);
		expect(transport.commits).toHaveLength(0);
	});

	test("retries startup after a transient transport failure", async () => {
		const transport = new FakeSemanticTransport([]);
		let startCalls = 0;
		transport.start = async () => {
			startCalls += 1;
			if (startCalls === 1) throw new Error("transient transport startup failure");
		};
		const service = new TimelineV2Service({
			transport,
			repository: new InMemoryTimelineV2Repository(),
			identity: {
				collectorId: "collector.timeline-v2.start-retry",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses: new DeterministicTimelineHypothesisGenerator(),
			clock: new FakeClock(),
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});

		await expect(service.start()).rejects.toThrow(
			"transient transport startup failure",
		);
		await expect(service.start()).resolves.toBeUndefined();
		expect(startCalls).toBe(2);
		await service.stop();
	});












});
