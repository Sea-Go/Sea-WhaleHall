import type { ReflectionClock, ReflectionTimerHandle } from "../reflection/collector";
import { canonicalJson, type ReflectionHasher } from "../reflection/hash";
import type { ActiveGoalContextV1, ReflectionTriggerReason } from "../reflection/types";
import type { TimelineV2Repository } from "./repository";
import {
	TIMELINE_COLLECTOR_SCHEMA_VERSION,
	TIMELINE_WINDOW_SCHEMA_VERSION,
	type OpenTimelineWindowV2,
	type SemanticEventV2,
	type TimelineCollectorSnapshotV2,
	type TimelineCollectorState,
	type TimelineWindowV2,
} from "./types";

export const TIMELINE_EFFECTIVE_EVENT_THRESHOLD = 64;
export const TIMELINE_MAX_WAIT_MS = 5 * 60 * 1000;
export const TIMELINE_CONTEXT_EVENT_LIMIT = 5;
export const TIMELINE_CONTEXT_LOOKBACK_MS = 30_000;
export const TIMELINE_RECENT_EVENT_ID_LIMIT = 2_048;

export type TimelineCollectorOptions = {
	collectorId: string;
	deviceId: string;
	sessionId: string;
	repository: TimelineV2Repository;
	hasher: ReflectionHasher;
	clock: ReflectionClock;
	initialGoal?: ActiveGoalContextV1 | null;
	effectiveEventThreshold?: number;
	maxWaitMs?: number;
	onDeadlineReady?: (deadlineAtMs: number) => void;
	onCountReady?: (reachedAtMs: number) => void;
	onBackgroundError?: (error: unknown) => void;
};

export class TimelineGoalVersionMismatchError extends Error {
	constructor(received: number | null, expected: number | null) {
		super(
			`Semantic event goal version ${String(received)} does not match active goal ${String(expected)}.`,
		);
		this.name = "TimelineGoalVersionMismatchError";
	}
}

export class TimelineGoalContentUnavailableError extends Error {
	constructor(eventId: string) {
		super(
			`Goal boundary ${eventId} has no decrypted previous/next content. Timeline collection is fail-closed until the Rust vault can replay it.`,
		);
		this.name = "TimelineGoalContentUnavailableError";
	}
}

export class TimelineV2Collector {
	private readonly collectorId: string;
	private readonly deviceId: string;
	private readonly sessionId: string;
	private readonly repository: TimelineV2Repository;
	private readonly hasher: ReflectionHasher;
	private readonly clock: ReflectionClock;
	private readonly initialGoal: ActiveGoalContextV1 | null;
	private readonly threshold: number;
	private readonly maxWaitMs: number;
	private readonly onDeadlineReady: ((deadlineAtMs: number) => void) | null;
	private readonly onCountReady: ((reachedAtMs: number) => void) | null;
	private readonly onBackgroundError: (error: unknown) => void;

	private snapshot: TimelineCollectorSnapshotV2 | null = null;
	private state: TimelineCollectorState = "RECOVERING";
	private timer: ReflectionTimerHandle | null = null;
	private deadlinesDeferred = false;
	private disposed = false;
	private operationTail: Promise<void> = Promise.resolve();

	constructor(options: TimelineCollectorOptions) {
		this.collectorId = options.collectorId;
		this.deviceId = options.deviceId;
		this.sessionId = options.sessionId;
		this.repository = options.repository;
		this.hasher = options.hasher;
		this.clock = options.clock;
		this.initialGoal = options.initialGoal
			? structuredClone(options.initialGoal)
			: null;
		this.threshold =
			options.effectiveEventThreshold ?? TIMELINE_EFFECTIVE_EVENT_THRESHOLD;
		this.maxWaitMs = options.maxWaitMs ?? TIMELINE_MAX_WAIT_MS;
		this.onDeadlineReady = options.onDeadlineReady ?? null;
		this.onCountReady = options.onCountReady ?? null;
		this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
		if (!Number.isInteger(this.threshold) || this.threshold < 1) {
			throw new Error("effectiveEventThreshold must be a positive integer.");
		}
		if (!Number.isSafeInteger(this.maxWaitMs) || this.maxWaitMs <= 0) {
			throw new Error("maxWaitMs must be a positive safe integer.");
		}
	}

	recover(options: { deferDeadline?: boolean } = {}): Promise<void> {
		return this.enqueue(async () => {
			this.cancelTimer();
			this.state = "RECOVERING";
			this.deadlinesDeferred = options.deferDeadline ?? false;
			const recovered = await this.repository.loadCollector(this.collectorId);
			if (recovered) {
				this.assertIdentity(recovered);
				this.assertSnapshot(recovered);
				this.snapshot = recovered;
			} else {
				const nowMs = this.clock.nowMs();
				const initial: TimelineCollectorSnapshotV2 = {
					schemaVersion: TIMELINE_COLLECTOR_SCHEMA_VERSION,
					collectorId: this.collectorId,
					deviceId: this.deviceId,
					sessionId: this.sessionId,
					state: "ACTIVE_EMPTY",
					activeGoal: structuredClone(this.initialGoal),
					openWindow: null,
					contextCandidates: [],
					recentEventIds: [],
					materializedCursor: null,
					revision: 0,
					updatedAtMs: nowMs,
				};
				this.snapshot = await this.repository.saveCollector(initial, null);
			}
			const open = this.snapshot.openWindow;
			if (!open) {
				this.state = "ACTIVE_EMPTY";
				return;
			}
			this.state = "ACTIVE_COLLECTING";
			if (this.deadlinesDeferred) return;
			if (open.effectiveEventCount >= this.threshold) {
				await this.seal("event_count", thresholdReachedAt(open));
			} else if (this.clock.nowMs() >= open.deadlineAtMs) {
				await this.seal("max_wait", open.deadlineAtMs);
			} else {
				this.armDeadline(open.deadlineAtMs);
			}
		});
	}

	resumeDeadlines(): Promise<TimelineWindowV2 | null> {
		let result: TimelineWindowV2 | null = null;
		return this.enqueue(async () => {
			this.deadlinesDeferred = false;
			const open = this.requireSnapshot().openWindow;
			if (!open) return;
			if (open.effectiveEventCount >= this.threshold) {
				result = await this.seal("event_count", thresholdReachedAt(open));
			} else if (this.clock.nowMs() >= open.deadlineAtMs) {
				result = await this.seal("max_wait", open.deadlineAtMs);
			} else {
				this.armDeadline(open.deadlineAtMs);
			}
		}).then(() => result);
	}

	ingest(event: SemanticEventV2): Promise<TimelineWindowV2 | null> {
		let result: TimelineWindowV2 | null = null;
		return this.enqueue(async () => {
			result = await this.ingestSerialized(event);
		}).then(() => result);
	}

	flushCountDue(): Promise<TimelineWindowV2 | null> {
		let result: TimelineWindowV2 | null = null;
		return this.enqueue(async () => {
			const open = this.requireSnapshot().openWindow;
			if (open && open.effectiveEventCount >= this.threshold) {
				result = await this.seal("event_count", thresholdReachedAt(open));
			}
		}).then(() => result);
	}

	flushDue(): Promise<TimelineWindowV2 | null> {
		let result: TimelineWindowV2 | null = null;
		return this.enqueue(async () => {
			const open = this.requireSnapshot().openWindow;
			if (!open) return;
			if (open.effectiveEventCount >= this.threshold) {
				result = await this.seal("event_count", thresholdReachedAt(open));
			} else if (this.clock.nowMs() >= open.deadlineAtMs) {
				result = await this.seal("max_wait", open.deadlineAtMs);
			}
		}).then(() => result);
	}

	/**
	 * Authorization revocation outranks every seal trigger. Pending content is
	 * dropped from the encrypted collector and no summary is generated.
	 */
	discardForAuthorizationRevocation(
		materializedCursor: string | null = null,
	): Promise<void> {
		return this.enqueue(async () => {
			await this.discardForAuthorizationRevocationSerialized(
				materializedCursor,
				null,
			);
		});
	}

	getState(): TimelineCollectorState {
		return this.state;
	}

	getSnapshot(): TimelineCollectorSnapshotV2 {
		return structuredClone(this.requireSnapshot());
	}

	whenIdle(): Promise<void> {
		return this.operationTail;
	}

	dispose(): void {
		this.disposed = true;
		this.cancelTimer();
		this.deadlinesDeferred = false;
	}

	private async ingestSerialized(
		event: SemanticEventV2,
	): Promise<TimelineWindowV2 | null> {
		let snapshot = this.requireSnapshot();
		if (snapshot.recentEventIds.includes(event.eventId)) return null;

		if (event.kind === "authorization.changed") {
			await this.handleAuthorizationBoundary(event);
			return null;
		}

		const openAtEntry = snapshot.openWindow;
		if (
			openAtEntry &&
			openAtEntry.effectiveEventCount >= this.threshold
		) {
			const reachedAtMs = thresholdReachedAt(openAtEntry);
			const sameTimestampBoundary =
				event.occurredAtMs === reachedAtMs &&
				(event.kind === "goal.changed" ||
					event.kind === "presence.changed");
			if (!sameTimestampBoundary) {
				const sealed = await this.seal(
					"event_count",
					reachedAtMs,
				);
				await this.ingestSerialized(event);
				return sealed;
			}
		}
		if (
			openAtEntry &&
			event.occurredAtMs > openAtEntry.deadlineAtMs
		) {
			const overdue = await this.seal("max_wait", openAtEntry.deadlineAtMs);
			await this.ingestSerialized(event);
			return overdue;
		}

		if (event.kind === "goal.changed") {
			return this.handleGoalBoundary(event);
		}

		const expectedGoalVersion = snapshot.activeGoal?.version ?? null;
		if (event.goalVersion !== expectedGoalVersion) {
			throw new TimelineGoalVersionMismatchError(
				event.goalVersion,
				expectedGoalVersion,
			);
		}

		if (event.kind === "presence.changed") {
			return this.handlePresenceBoundary(event);
		}

		if (event.countClass !== "effective") {
			const openWindow = snapshot.openWindow
				? {
						...snapshot.openWindow,
						events: [
							...snapshot.openWindow.events,
							structuredClone(event),
						],
					}
				: null;
			await this.save({
				...snapshot,
				openWindow,
				recentEventIds: addRecent(snapshot, event.eventId),
				materializedCursor: event.cursor,
			});
			return null;
		}

		const openWindow = snapshot.openWindow
			? appendEffective(snapshot.openWindow, event)
			: startWindow(event, snapshot.activeGoal, this.maxWaitMs);
		const candidate: TimelineCollectorSnapshotV2 = {
			...snapshot,
			state: "ACTIVE_COLLECTING",
			openWindow,
			recentEventIds: addRecent(snapshot, event.eventId),
			materializedCursor: event.cursor,
		};
		this.state = "ACTIVE_COLLECTING";
		if (openWindow.effectiveEventCount >= this.threshold) {
			if (this.onCountReady) {
				this.cancelTimer();
				await this.save(candidate);
				this.onCountReady(event.occurredAtMs);
				return null;
			}
			return this.sealCandidate(
				candidate,
				"event_count",
				event.occurredAtMs,
			);
		}
		await this.save(candidate);
		if (!this.deadlinesDeferred) this.armDeadline(openWindow.deadlineAtMs);
		return null;
	}

	private async handleGoalBoundary(
		event: Extract<SemanticEventV2, { kind: "goal.changed" }> | SemanticEventV2,
	): Promise<TimelineWindowV2 | null> {
		if (event.kind !== "goal.changed") {
			throw new Error("Expected a goal.changed event.");
		}
		const snapshot = this.requireSnapshot();
		if (
			!Object.hasOwn(event.payload, "previous") ||
			!Object.hasOwn(event.payload, "next")
		) {
			throw new TimelineGoalContentUnavailableError(event.eventId);
		}
		const previous = goalPayload(event, "previous");
		const next = goalPayload(event, "next");
		const activeVersion = snapshot.activeGoal?.version ?? null;
		if (
			event.goalVersion !== activeVersion ||
			(previous?.version ?? null) !== activeVersion
		) {
			throw new TimelineGoalVersionMismatchError(
				previous?.version ?? null,
				activeVersion,
			);
		}
		const candidate: TimelineCollectorSnapshotV2 = {
			...snapshot,
			activeGoal: structuredClone(next),
			openWindow: snapshot.openWindow
				? {
						...snapshot.openWindow,
						events: [
							...snapshot.openWindow.events,
							structuredClone(event),
						],
					}
				: null,
			recentEventIds: addRecent(snapshot, event.eventId),
			materializedCursor: event.cursor,
		};
		if (!snapshot.openWindow) {
			await this.save(candidate);
			return null;
		}
		return this.sealCandidate(
			candidate,
			"goal_boundary",
			Math.max(event.occurredAtMs, latestEventAt(snapshot.openWindow)),
			next,
		);
	}

	private async handlePresenceBoundary(
		event: SemanticEventV2,
	): Promise<TimelineWindowV2 | null> {
		const snapshot = this.requireSnapshot();
		const candidate: TimelineCollectorSnapshotV2 = {
			...snapshot,
			openWindow: snapshot.openWindow
				? {
						...snapshot.openWindow,
						events: [
							...snapshot.openWindow.events,
							structuredClone(event),
						],
					}
				: null,
			recentEventIds: addRecent(snapshot, event.eventId),
			materializedCursor: event.cursor,
		};
		if (!snapshot.openWindow) {
			await this.save(candidate);
			return null;
		}
		return this.sealCandidate(
			candidate,
			"presence_boundary",
			Math.max(event.observedAtMs, latestEventAt(snapshot.openWindow)),
		);
	}

	private async handleAuthorizationBoundary(
		event: SemanticEventV2,
	): Promise<void> {
		const transition = event.payload.transition;
		if (transition === "revoked" || transition === "mixed") {
			await this.discardForAuthorizationRevocationSerialized(
				event.cursor,
				event.eventId,
			);
			return;
		}
		await this.resetForAuthorizationBoundarySerialized(
			event.cursor,
			event.eventId,
		);
	}

	private async discardForAuthorizationRevocationSerialized(
		materializedCursor: string | null,
		eventId: string | null,
	): Promise<void> {
		await this.resetForAuthorizationBoundarySerialized(
			materializedCursor,
			eventId,
		);
	}

	private async resetForAuthorizationBoundarySerialized(
		materializedCursor: string | null,
		eventId: string | null,
	): Promise<void> {
		this.cancelTimer();
		const snapshot = this.requireSnapshot();
		await this.save({
			...snapshot,
			state: "ACTIVE_EMPTY",
			openWindow: null,
			contextCandidates: [],
			recentEventIds:
				eventId === null
					? snapshot.recentEventIds
					: addRecent(snapshot, eventId),
			materializedCursor:
				materializedCursor ?? snapshot.materializedCursor,
		});
		this.state = "ACTIVE_EMPTY";
	}

	private async seal(
		reason: ReflectionTriggerReason,
		endedAtMs: number,
	): Promise<TimelineWindowV2> {
		return this.sealCandidate(this.requireSnapshot(), reason, endedAtMs);
	}

	private async sealCandidate(
		candidate: TimelineCollectorSnapshotV2,
		reason: ReflectionTriggerReason,
		endedAtMs: number,
		nextGoal: ActiveGoalContextV1 | null = candidate.activeGoal,
	): Promise<TimelineWindowV2> {
		const open = candidate.openWindow;
		if (!open || open.effectiveEventCount < 1) {
			throw new Error("Cannot seal an empty Timeline v2 window.");
		}
		this.cancelTimer();
		this.state = "SEALED";
		const window = await buildTimelineWindow(
			{
				collectorId: this.collectorId,
				deviceId: this.deviceId,
				sessionId: this.sessionId,
				open,
				reason,
				endedAtMs,
				contextCandidates: candidate.contextCandidates,
			},
			this.hasher,
		);
		const current = this.requireSnapshot();
		const nextSnapshot: TimelineCollectorSnapshotV2 = {
			...candidate,
			state: "ACTIVE_EMPTY",
			activeGoal: structuredClone(nextGoal),
			openWindow: null,
			contextCandidates: window.events
				.filter((event) => event.countClass === "effective")
				.slice(-TIMELINE_CONTEXT_EVENT_LIMIT)
				.map((event) => structuredClone(event)),
			revision: current.revision + 1,
			updatedAtMs: this.clock.nowMs(),
		};
		const sealed = await this.repository.sealWindow(
			window,
			nextSnapshot,
			current.revision,
		);
		this.snapshot = sealed.snapshot;
		this.state = "ACTIVE_EMPTY";
		return sealed.window;
	}

	private async save(
		candidate: TimelineCollectorSnapshotV2,
	): Promise<TimelineCollectorSnapshotV2> {
		const current = this.requireSnapshot();
		const next: TimelineCollectorSnapshotV2 = {
			...candidate,
			state: candidate.openWindow
				? "ACTIVE_COLLECTING"
				: "ACTIVE_EMPTY",
			revision: current.revision + 1,
			updatedAtMs: this.clock.nowMs(),
		};
		const saved = await this.repository.saveCollector(next, current.revision);
		this.snapshot = saved;
		this.state = saved.openWindow ? "ACTIVE_COLLECTING" : "ACTIVE_EMPTY";
		return saved;
	}

	private armDeadline(deadlineAtMs: number): void {
		this.cancelTimer();
		if (this.disposed) return;
		this.timer = this.clock.setTimer(() => {
			this.timer = null;
			if (this.onDeadlineReady) {
				this.onDeadlineReady(deadlineAtMs);
				return;
			}
			void this.flushDue().catch(this.onBackgroundError);
		}, Math.max(0, deadlineAtMs - this.clock.nowMs()));
	}

	private cancelTimer(): void {
		if (this.timer === null) return;
		this.clock.clearTimer(this.timer);
		this.timer = null;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private requireSnapshot(): TimelineCollectorSnapshotV2 {
		if (!this.snapshot) {
			throw new Error("TimelineV2Collector.recover() must finish first.");
		}
		return this.snapshot;
	}

	private assertIdentity(snapshot: TimelineCollectorSnapshotV2): void {
		if (
			snapshot.collectorId !== this.collectorId ||
			snapshot.deviceId !== this.deviceId ||
			snapshot.sessionId !== this.sessionId
		) {
			throw new Error("Recovered Timeline v2 collector identity does not match.");
		}
	}

	private assertSnapshot(snapshot: TimelineCollectorSnapshotV2): void {
		const open = snapshot.openWindow;
		if (
			open &&
			(open.effectiveEventCount < 1 ||
				open.effectiveEventCount !==
					open.events.filter(
						(event) => event.countClass === "effective",
					).length)
		) {
			throw new Error("Recovered Timeline v2 collector is invalid.");
		}
	}
}

type BuildTimelineWindowRequest = {
	collectorId: string;
	deviceId: string;
	sessionId: string;
	open: OpenTimelineWindowV2;
	reason: ReflectionTriggerReason;
	endedAtMs: number;
	contextCandidates: SemanticEventV2[];
};

async function buildTimelineWindow(
	request: BuildTimelineWindowRequest,
	hasher: ReflectionHasher,
): Promise<TimelineWindowV2> {
	const events = request.open.events.map((event) => structuredClone(event));
	const first = events[0];
	const last = events.at(-1);
	if (!first || !last) throw new Error("Timeline window lost cursor bounds.");
	const contextOnly = request.contextCandidates
		.filter(
			(event) =>
				event.countClass === "effective" &&
				request.open.startedAtMs - event.occurredAtMs >= 0 &&
				request.open.startedAtMs - event.occurredAtMs <=
					TIMELINE_CONTEXT_LOOKBACK_MS,
		)
		.slice(-TIMELINE_CONTEXT_EVENT_LIMIT)
		.map((event) => structuredClone(event));
	const inputHash = await hasher.sha256(
		canonicalJson({
			goal: request.open.goal,
			events,
			contextOnly,
		}),
	);
	const identity = canonicalJson({
		deviceId: request.deviceId,
		sessionId: request.sessionId,
		goalVersion: request.open.goalVersion,
		firstCursor: first.cursor,
		lastCursor: last.cursor,
		triggerReason: request.reason,
	});
	const windowId = `timeline_window_${await hasher.sha256(identity)}`;
	const earliestOccurredAtMs = events.reduce(
		(earliest, event) => Math.min(earliest, event.occurredAtMs),
		request.open.startedAtMs,
	);
	const latestObservedAtMs = events.reduce(
		(latest, event) => Math.max(latest, event.observedAtMs),
		earliestOccurredAtMs,
	);
	return {
		schemaVersion: TIMELINE_WINDOW_SCHEMA_VERSION,
		windowId,
		collectorId: request.collectorId,
		deviceId: request.deviceId,
		sessionId: request.sessionId,
		triggerReason: request.reason,
		goal: structuredClone(request.open.goal),
		goalVersion: request.open.goalVersion,
		startedAtMs: earliestOccurredAtMs,
		endedAtMs: Math.max(request.endedAtMs, latestObservedAtMs),
		deadlineAtMs: request.open.deadlineAtMs,
		eventCount: request.open.effectiveEventCount,
		firstCursor: first.cursor,
		lastCursor: last.cursor,
		events,
		contextOnly,
		inputHash,
	};
}

function startWindow(
	event: SemanticEventV2,
	goal: ActiveGoalContextV1 | null,
	maxWaitMs: number,
): OpenTimelineWindowV2 {
	return {
		goal: structuredClone(goal),
		goalVersion: goal?.version ?? null,
		startedAtMs: event.occurredAtMs,
		deadlineAtMs: event.occurredAtMs + maxWaitMs,
		events: [structuredClone(event)],
		effectiveEventCount: 1,
	};
}

function appendEffective(
	open: OpenTimelineWindowV2,
	event: SemanticEventV2,
): OpenTimelineWindowV2 {
	return {
		...open,
		events: [...open.events, structuredClone(event)],
		effectiveEventCount: open.effectiveEventCount + 1,
	};
}

function thresholdReachedAt(open: OpenTimelineWindowV2): number {
	for (let index = open.events.length - 1; index >= 0; index -= 1) {
		const event = open.events[index];
		if (event?.countClass === "effective") return event.occurredAtMs;
	}
	throw new Error("Timeline window has no effective event.");
}

function latestEventAt(open: OpenTimelineWindowV2): number {
	return Math.max(...open.events.map((event) => event.occurredAtMs));
}

function addRecent(
	snapshot: TimelineCollectorSnapshotV2,
	eventId: string,
): string[] {
	return [...snapshot.recentEventIds, eventId].slice(
		-TIMELINE_RECENT_EVENT_ID_LIMIT,
	);
}

function goalPayload(
	event: SemanticEventV2,
	field: "previous" | "next",
): ActiveGoalContextV1 | null {
	const value = event.payload[field];
	return value === null
		? null
		: structuredClone(value as ActiveGoalContextV1);
}
