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
	TimelineV2Service,
	type SemanticEventV2,
} from "../src/agent/timeline-v2";

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

	test("revocation outranks a due count window and restored authorization starts fresh", async () => {
		const clock = new FakeClock();
		const transport = new FakeSemanticTransport([
			authorization(1, 500, "baseline", "not_determined"),
			foreground(2, 1_000),
			textChange(3, 2_000, "must be discarded"),
			authorization(4, 2_000, "revoked", "denied"),
		]);
		const repository = new InMemoryTimelineV2Repository();
		const service = new TimelineV2Service({
			transport,
			repository,
			identity: {
				collectorId: "collector.timeline-v2.authorization-count",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock,
			effectiveEventThreshold: 2,
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});

		await service.start();
		expect(transport.commits).toEqual([
			"sec2_0000000000000001",
			"sec2_0000000000000002",
			"sec2_0000000000000003",
			"sec2_0000000000000004",
		]);
		expect(
			(await repository.readAuditRange(0, 10_000)).windows,
		).toHaveLength(0);
		expect((await service.getStatus()).collectorState).toBe("ACTIVE_EMPTY");

		transport.append(
			authorization(5, 3_000, "granted", "granted"),
			foreground(6, 4_000),
			textChange(7, 5_000, "fresh"),
		);
		await service.pullNow();
		expect(await service.runJobsNow()).toBe(1);
		const windows = (
			await repository.readAuditRange(0, 10_000)
		).windows;
		expect(windows).toHaveLength(1);
		expect(windows[0]).toMatchObject({
			firstCursor: "sec2_0000000000000006",
			lastCursor: "sec2_0000000000000007",
			eventCount: 2,
		});
		await service.stop();
	});

	test("revocation backlog discards an overdue recovered window before deadline resume", async () => {
		const clock = new FakeClock(400_000);
		const transport = new FakeSemanticTransport([
			foreground(1, 0),
			authorization(2, 300_000, "revoked", "denied"),
		]);
		const repository = new InMemoryTimelineV2Repository();
		const service = new TimelineV2Service({
			transport,
			repository,
			identity: {
				collectorId: "collector.timeline-v2.authorization-deadline",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock,
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});

		await service.start();
		expect(
			(await repository.readAuditRange(0, 500_000)).windows,
		).toHaveLength(0);
		expect((await service.getStatus()).collectorState).toBe("ACTIVE_EMPTY");
		await service.stop();
	});

	test("replays a persisted authorization reset after cursor commit failure", async () => {
		const clock = new FakeClock();
		const revocation = authorization(2, 2_000, "revoked", "denied");
		const transport = new FakeSemanticTransport([
			foreground(1, 1_000),
			revocation,
		]);
		transport.failNextCommit(revocation.cursor);
		const repository = new InMemoryTimelineV2Repository();
		const options = {
			transport,
			repository,
			identity: {
				collectorId: "collector.timeline-v2.authorization-replay",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock,
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		};
		const first = new TimelineV2Service(options);
		await expect(first.start()).rejects.toThrow(
			"injected semantic commit failure",
		);

		const recovered = new TimelineV2Service(options);
		await recovered.start();
		expect(transport.commits).toEqual([
			"sec2_0000000000000001",
			"sec2_0000000000000002",
		]);
		expect(
			(await repository.readAuditRange(0, 10_000)).windows,
		).toHaveLength(0);
		expect((await recovered.getStatus()).collectorState).toBe("ACTIVE_EMPTY");
		await recovered.stop();
	});

	test("pulls decrypted semantic data, builds meeting-style summary, and holds AgentInput locally", async () => {
		const clock = new FakeClock();
		const transport = new FakeSemanticTransport([
			foreground(1, 1_000),
			textChange(2, 1_010, "semantic.query"),
		]);
		const repository = new InMemoryTimelineV2Repository();
		const service = new TimelineV2Service({
			transport,
			repository,
			identity: {
				collectorId: "collector.timeline-v2",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock,
			effectiveEventThreshold: 2,
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});

		await service.start();
		expect(transport.queries[0]).toEqual({
			consumerId: "whalehall.timeline.v2",
			limit: 256,
			includeContent: true,
		});
		expect(transport.commits).toEqual([
			"sec2_0000000000000001",
			"sec2_0000000000000002",
		]);
		expect(await service.runJobsNow()).toBe(1);

		const held = await service.queryAgentInputs({
			includeHeldLocal: true,
		});
		expect(held.inputs).toHaveLength(1);
		expect(held.inputs[0]).toMatchObject({
			state: "HELD_LOCAL",
			leaseToken: null,
			input: {
				triggerReason: "event_count",
				goal: null,
			},
		});
		expect(held.inputs[0]?.input.renderedText).toContain(
			"可能在进行软件开发",
		);
		expect(held.inputs[0]?.input.renderedText).toContain(
			"最终增加了文本“semantic.query”",
		);
		expect(
			held.inputs[0]?.input.segments.every(
				(segment) => segment.goalRelevance === null,
			),
		).toBeTrue();
		expect((await service.getStatus()).trainingUploadEnabled).toBeFalse();

		expect(await service.releaseAgentInputs()).toBe(1);
		const leased = await service.queryAgentInputs();
		expect(leased.inputs[0]?.state).toBe("LEASED");
		const leaseToken = leased.inputs[0]?.leaseToken;
		expect(leaseToken).toBeString();
		const acked = await service.commitAgentInput(
			leased.inputs[0]!.input.agentInputId,
			leaseToken!,
		);
		expect(acked.state).toBe("ACKED");
		await service.stop();
	});

	test("accepts backlog events from the current non-empty startup goal", async () => {
		const clock = new FakeClock();
		const initialGoal = {
			goalId: "goal-7",
			planId: "plan-7",
			version: 7,
			text: "完成 Timeline v2",
			activatedAtMs: 500,
		};
		const transport = new FakeSemanticTransport([
			foreground(1, 1_000, initialGoal.version),
			textChange(
				2,
				1_010,
				"initialGoal",
				initialGoal.version,
			),
		]);
		const repository = new InMemoryTimelineV2Repository();
		const service = new TimelineV2Service({
			transport,
			repository,
			identity: {
				collectorId: "collector.timeline-v2.goal",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			initialGoal,
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock,
			effectiveEventThreshold: 2,
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});

		await service.start();
		expect(transport.commits).toEqual([
			"sec2_0000000000000001",
			"sec2_0000000000000002",
		]);
		expect(await service.runJobsNow()).toBe(1);
		const held = await service.queryAgentInputs({
			includeHeldLocal: true,
		});
		expect(held.inputs[0]?.input.goal).toEqual(initialGoal);
		expect(
			held.inputs[0]?.input.segments.every(
				(segment) => segment.goalRelevance === "uncertain",
			),
		).toBeTrue();
		await service.stop();
	});

	test("treats repeated push frames as wake-ups without duplicate cursor commits", async () => {
		const clock = new FakeClock();
		const first = foreground(1, 1_000);
		const second = textChange(2, 1_010, "dedupe");
		const transport = new FakeSemanticTransport([first, second]);
		const repository = new InMemoryTimelineV2Repository();
		const service = new TimelineV2Service({
			transport,
			repository,
			identity: {
				collectorId: "collector.timeline-v2.dedupe",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock,
			effectiveEventThreshold: 2,
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});

		await service.start();
		transport.wake(second);
		await service.pullNow();
		expect(transport.commits).toEqual([
			"sec2_0000000000000001",
			"sec2_0000000000000002",
		]);
		expect(await service.runJobsNow()).toBe(1);
		expect(await service.runJobsNow()).toBe(0);
		expect(
			(
				await service.queryAgentInputs({
					includeHeldLocal: true,
				})
			).inputs,
		).toHaveLength(1);
		await service.stop();
	});

	test("revises the same episode across adjacent processing windows", async () => {
		const clock = new FakeClock();
		const transport = new FakeSemanticTransport([
			foreground(1, 1_000),
			textChange(2, 1_010, "first"),
		]);
		const repository = new InMemoryTimelineV2Repository();
		const service = new TimelineV2Service({
			transport,
			repository,
			identity: {
				collectorId: "collector.timeline-v2",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock,
			effectiveEventThreshold: 2,
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});
		await service.start();
		await service.runJobsNow();
		const firstHeld = await service.queryAgentInputs({
			includeHeldLocal: true,
		});
		const firstWindowId = firstHeld.inputs[0]!.input.windowId;
		const first = await repository.getTimelineResult(firstWindowId);
		const firstEpisode = first!.episodes[0]!;

		transport.append(
			foreground(3, 1_100),
			textChange(4, 1_110, "second"),
		);
		await service.pullNow();
		await service.runJobsNow();
		const secondWindow = (
			await repository.readAuditRange(1_050, 2_000)
		).windows[0]!;
		const second = await repository.getTimelineResult(
			secondWindow.windowId,
		);
		const revised = second!.episodes[0]!;
		expect(revised).toMatchObject({
			episodeId: firstEpisode.episodeId,
			revision: 2,
			supersedesRevisionId: firstEpisode.revisionId,
			sourceWindowIds: [firstWindowId, secondWindow.windowId],
		});
		expect(second?.summary.segments[0]?.evidence).toHaveLength(4);
		expect(second?.summary.renderedText).toContain("first");
		expect(second?.summary.renderedText).toContain("second");
		expect(transport.commits).toEqual([
			"sec2_0000000000000001",
			"sec2_0000000000000002",
			"sec2_0000000000000003",
			"sec2_0000000000000004",
		]);
		await service.stop();
	});

	test("creates an immutable correction when a later cursor carries late evidence", async () => {
		const clock = new FakeClock();
		const transport = new FakeSemanticTransport([
			foreground(1, 1_000),
			textChange(2, 1_010, "original"),
		]);
		const repository = new InMemoryTimelineV2Repository();
		const service = new TimelineV2Service({
			transport,
			repository,
			identity: {
				collectorId: "collector.timeline-v2.late",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock,
			effectiveEventThreshold: 2,
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});
		await service.start();
		await service.runJobsNow();
		const firstWindow = (
			await repository.readAuditRange(0, 2_000)
		).windows[0]!;
		const first = await repository.getTimelineResult(
			firstWindow.windowId,
		);

		transport.append(
			foreground(3, 1_005),
			textChange(4, 1_006, "late"),
		);
		await service.pullNow();
		await service.runJobsNow();
		const windows = (
			await repository.readAuditRange(0, 2_000)
		).windows;
		const lateWindow = windows.find(
			(window) => window.windowId !== firstWindow.windowId,
		)!;
		const corrected = await repository.getTimelineResult(
			lateWindow.windowId,
		);

		expect(corrected?.episodes[0]).toMatchObject({
			episodeId: first?.episodes[0]?.episodeId,
			revision: 2,
			supersedesRevisionId:
				first?.episodes[0]?.revisionId,
		});
		expect(corrected?.summary).toMatchObject({
			revision: 2,
			correctsTimelineId: first?.summary.timelineId,
		});
		expect(corrected?.summary.renderedText).toContain("original");
		expect(corrected?.summary.renderedText).toContain("late");
		await service.stop();
	});

	test("does not create a correction for a normal interval whose start overlaps the prior episode", async () => {
		const clock = new FakeClock();
		const transport = new FakeSemanticTransport([
			foreground(1, 1_000),
			textChange(2, 1_010, "original"),
		]);
		const repository = new InMemoryTimelineV2Repository();
		const service = new TimelineV2Service({
			transport,
			repository,
			identity: {
				collectorId: "collector.timeline-v2.interval-overlap",
				deviceId: "device-1",
				sessionId: "session-1",
			},
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
			clock,
			effectiveEventThreshold: 2,
			eventPollMs: 60_000,
			jobPollMs: 60_000,
		});
		await service.start();
		await service.runJobsNow();
		const firstWindow = (
			await repository.readAuditRange(0, 2_000)
		).windows[0]!;

		transport.append(
			{
				...foreground(3, 1_005),
				observedAtMs: 1_020,
			},
			textChange(4, 1_025, "continued"),
		);
		await service.pullNow();
		await service.runJobsNow();
		const secondWindow = (
			await repository.readAuditRange(0, 2_000)
		).windows.find(
			(window) => window.windowId !== firstWindow.windowId,
		)!;
		const second = await repository.getTimelineResult(
			secondWindow.windowId,
		);

		expect(second?.summary).toMatchObject({
			revision: 1,
			correctsTimelineId: null,
		});
		await service.stop();
	});
});
