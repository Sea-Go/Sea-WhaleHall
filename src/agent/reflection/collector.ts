import type { ReflectionCollectorRepository } from "./repository";
import {
	type ActiveGoalContextV1,
	COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
	type CollectorRuntimeState,
	type DesktopEventV1,
	type EventWindowV1,
	isCountedSemanticEvent,
	isIgnoredReflectionInput,
	isPresenceFlushBoundary,
	type OpenEventWindowV1,
	type ReflectionCloudOwnerEpochV1,
	type ReflectionCollectorSnapshotV1,
	type ReflectionTriggerReason,
} from "./types";
import {
	contextCandidatesFromWindow,
	type DeterministicWindowBuilder,
} from "./window-builder";

export const DEFAULT_SEMANTIC_EVENT_THRESHOLD = 64;
export const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;
export const DEFAULT_RECENT_EVENT_ID_LIMIT = 2_048;

export type ReflectionTimerHandle = ReturnType<typeof setTimeout>;

export interface ReflectionClock {
	nowMs(): number;
	setTimer(callback: () => void, delayMs: number): ReflectionTimerHandle;
	clearTimer(handle: ReflectionTimerHandle): void;
}

export class SystemReflectionClock implements ReflectionClock {
	nowMs(): number {
		return Date.now();
	}

	setTimer(callback: () => void, delayMs: number): ReflectionTimerHandle {
		return setTimeout(callback, delayMs);
	}

	clearTimer(handle: ReflectionTimerHandle): void {
		clearTimeout(handle);
	}
}

export class GoalVersionMismatchError extends Error {
	constructor(
		eventGoalVersion: number | null,
		activeGoalVersion: number | null,
	) {
		super(
			`Event goal version ${String(eventGoalVersion)} does not match active goal version ${String(activeGoalVersion)}. Ingest goal.contextChanged first.`,
		);
		this.name = "GoalVersionMismatchError";
	}
}

export type ReflectionCollectorOptions = {
	collectorId: string;
	deviceId: string;
	sessionId: string;
	repository: ReflectionCollectorRepository;
	windowBuilder: DeterministicWindowBuilder;
	clock?: ReflectionClock;
	initialGoal?: ActiveGoalContextV1 | null;
	semanticEventThreshold?: number;
	maxWaitMs?: number;
	recentEventIdLimit?: number;
	onBackgroundError?: (error: unknown) => void;
	/**
	 * Production services use this hook to pull the durable EventJournal
	 * watermark before deciding a deadline. Standalone collectors omit it.
	 */
	onDeadlineReady?: (deadlineAtMs: number) => void;
	/**
	 * Production services use this hook to inspect already-durable events at
	 * the same timestamp before sealing the count threshold. This preserves
	 * authorization/boundary > count priority without delaying standalone use.
	 */
	onCountReady?: (reachedAtMs: number) => void;
	/**
	 * Observes an immutable window only after the collector has atomically
	 * persisted it. Consumers must treat this as an outbox notification and
	 * keep any failure isolated from EventJournal materialization.
	 */
	onWindowSealed?: (window: EventWindowV1) => void | Promise<void>;
};

/**
 * Serial, persistence-first window collector. All public mutations are placed
 * on one promise chain, including timer callbacks, so a boundary and a count
 * trigger can never seal the same open window twice.
 */
export class ReflectionCollector {
	private readonly repository: ReflectionCollectorRepository;
	private readonly windowBuilder: DeterministicWindowBuilder;
	private readonly clock: ReflectionClock;
	private readonly threshold: number;
	private readonly maxWaitMs: number;
	private readonly recentEventIdLimit: number;
	private readonly onBackgroundError: (error: unknown) => void;
	private readonly onDeadlineReady: ((deadlineAtMs: number) => void) | null;
	private readonly onCountReady: ((reachedAtMs: number) => void) | null;
	private readonly onWindowSealed:
		| ((window: EventWindowV1) => void | Promise<void>)
		| null;
	private readonly collectorId: string;
	private readonly deviceId: string;
	private readonly sessionId: string;
	private readonly initialGoal: ActiveGoalContextV1 | null;

	private snapshot: ReflectionCollectorSnapshotV1 | null = null;
	private runtimeState: CollectorRuntimeState = "RECOVERING";
	private timer: ReflectionTimerHandle | null = null;
	private operationTail: Promise<void> = Promise.resolve();
	private deadlinesDeferred = false;
	private disposed = false;

	constructor(options: ReflectionCollectorOptions) {
		this.repository = options.repository;
		this.windowBuilder = options.windowBuilder;
		this.clock = options.clock ?? new SystemReflectionClock();
		this.threshold =
			options.semanticEventThreshold ?? DEFAULT_SEMANTIC_EVENT_THRESHOLD;
		this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
		this.recentEventIdLimit =
			options.recentEventIdLimit ?? DEFAULT_RECENT_EVENT_ID_LIMIT;
		this.onBackgroundError = options.onBackgroundError ?? (() => {});
		this.onDeadlineReady = options.onDeadlineReady ?? null;
		this.onCountReady = options.onCountReady ?? null;
		this.onWindowSealed = options.onWindowSealed ?? null;
		this.collectorId = options.collectorId;
		this.deviceId = options.deviceId;
		this.sessionId = options.sessionId;
		this.initialGoal = options.initialGoal ? { ...options.initialGoal } : null;
		if (!Number.isInteger(this.threshold) || this.threshold < 1) {
			throw new Error("semanticEventThreshold must be a positive integer.");
		}
		if (!Number.isFinite(this.maxWaitMs) || this.maxWaitMs <= 0) {
			throw new Error("maxWaitMs must be positive.");
		}
	}

	recover(options: { deferDeadline?: boolean } = {}): Promise<void> {
		return this.enqueue(async () => {
			this.cancelTimer();
			this.runtimeState = "RECOVERING";
			this.deadlinesDeferred = options.deferDeadline ?? false;
			const recovered = await this.repository.loadCollector(this.collectorId);
			if (recovered) {
				this.assertSnapshotIdentity(recovered);
				const normalized = normalizeRecoveredSnapshot(recovered);
				this.snapshot = normalized.snapshot;
				if (normalized.migratedCloudOwnerEpoch) {
					this.snapshot = await this.repository.saveCollector(
						{
							...this.snapshot,
							revision: recovered.revision + 1,
							updatedAtMs: this.clock.nowMs(),
						},
						recovered.revision,
					);
				}
			} else {
				const nowMs = this.clock.nowMs();
				const initial: ReflectionCollectorSnapshotV1 = {
					schemaVersion: COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
					collectorId: this.collectorId,
					deviceId: this.deviceId,
					sessionId: this.sessionId,
					state: "ACTIVE_EMPTY",
					activeGoal: cloneGoal(this.initialGoal),
					goalRevision: this.initialGoal?.version ?? 0,
					cloudOwnerEpoch: { epoch: 0, accountId: null },
					openWindow: null,
					contextCandidates: [],
					recentEventIds: [],
					revokedPermissions: [],
					materializedCursor: null,
					revision: 0,
					updatedAtMs: nowMs,
				};
				this.snapshot = await this.repository.saveCollector(initial, null);
			}

			const openWindow = this.snapshot.openWindow;
			if (openWindow) {
				this.assertValidOpenWindow(openWindow, this.snapshot.cloudOwnerEpoch);
				this.runtimeState = "ACTIVE_COLLECTING";
				if (this.deadlinesDeferred) {
					return;
				}
				if (openWindow.finalizedSemanticEventCount >= this.threshold) {
					await this.sealOpenWindow(
						"event_count",
						countThresholdReachedAt(openWindow),
					);
				} else if (this.clock.nowMs() >= openWindow.deadlineAtMs) {
					await this.sealOpenWindow("max_wait", openWindow.deadlineAtMs);
				} else {
					this.armDeadline(openWindow.deadlineAtMs);
				}
			} else {
				this.runtimeState = "ACTIVE_EMPTY";
			}
		});
	}

	/**
	 * Ends startup replay mode only after the durable native backlog has been
	 * materialized. An overdue timer must not seal ahead of a persisted 64th
	 * event or a higher-priority boundary.
	 */
	resumeDeadlines(): Promise<EventWindowV1 | null> {
		let sealed: EventWindowV1 | null = null;
		return this.enqueue(async () => {
			this.deadlinesDeferred = false;
			const openWindow = this.requireSnapshot().openWindow;
			if (!openWindow) return;
			if (openWindow.finalizedSemanticEventCount >= this.threshold) {
				sealed = await this.sealOpenWindow(
					"event_count",
					countThresholdReachedAt(openWindow),
				);
				return;
			}
			if (this.clock.nowMs() >= openWindow.deadlineAtMs) {
				sealed = await this.sealOpenWindow("max_wait", openWindow.deadlineAtMs);
				return;
			}
			this.armDeadline(openWindow.deadlineAtMs);
		}).then(() => sealed);
	}

	ingest(event: DesktopEventV1): Promise<EventWindowV1 | null> {
		let sealed: EventWindowV1 | null = null;
		return this.enqueue(async () => {
			sealed = await this.ingestSerialized(event);
		}).then(() => sealed);
	}

	/**
	 * Useful for hosts that prefer a scheduler loop over setTimeout. It is also
	 * the deterministic deadline entry point used by recovery.
	 */
	flushDue(): Promise<EventWindowV1 | null> {
		let sealed: EventWindowV1 | null = null;
		return this.enqueue(async () => {
			const snapshot = this.requireSnapshot();
			const openWindow = snapshot.openWindow;
			if (!openWindow) return;
			if (openWindow.finalizedSemanticEventCount >= this.threshold) {
				sealed = await this.sealOpenWindow(
					"event_count",
					countThresholdReachedAt(openWindow),
				);
			} else if (this.clock.nowMs() >= openWindow.deadlineAtMs) {
				sealed = await this.sealOpenWindow("max_wait", openWindow.deadlineAtMs);
			}
		}).then(() => sealed);
	}

	flushCountDue(): Promise<EventWindowV1 | null> {
		let sealed: EventWindowV1 | null = null;
		return this.enqueue(async () => {
			const openWindow = this.requireSnapshot().openWindow;
			if (
				openWindow &&
				openWindow.finalizedSemanticEventCount >= this.threshold
			) {
				sealed = await this.sealOpenWindow(
					"event_count",
					countThresholdReachedAt(openWindow),
				);
			}
		}).then(() => sealed);
	}

	/**
	 * Atomically changes the durable cloud owner epoch. Evidence collected under
	 * the previous epoch is discarded rather than reassigned to a later login.
	 * Every collector mutation, including count/deadline sealing, uses the same
	 * serial queue, so a racing window is wholly old-owned or wholly discarded.
	 */
	cutoverCloudOwner(accountId: string | null): Promise<void> {
		const normalizedAccountId = normalizeCloudOwnerAccountId(accountId);
		return this.enqueue(async () => {
			const snapshot = this.requireSnapshot();
			if (snapshot.cloudOwnerEpoch.accountId === normalizedAccountId) return;
			if (snapshot.cloudOwnerEpoch.epoch >= Number.MAX_SAFE_INTEGER) {
				throw new Error("Reflection cloud owner epoch is exhausted.");
			}
			this.cancelTimer();
			await this.saveSnapshot({
				...snapshot,
				state: "ACTIVE_EMPTY",
				cloudOwnerEpoch: {
					epoch: snapshot.cloudOwnerEpoch.epoch + 1,
					accountId: normalizedAccountId,
				},
				openWindow: null,
				contextCandidates: [],
			});
			this.runtimeState = "ACTIVE_EMPTY";
		});
	}

	whenIdle(): Promise<void> {
		return this.operationTail;
	}

	getState(): CollectorRuntimeState {
		return this.runtimeState;
	}

	getSnapshot(): ReflectionCollectorSnapshotV1 {
		return structuredClone(this.requireSnapshot());
	}

	dispose(): void {
		this.disposed = true;
		this.deadlinesDeferred = false;
		this.cancelTimer();
	}

	private async ingestSerialized(
		event: DesktopEventV1,
	): Promise<EventWindowV1 | null> {
		const snapshot = this.requireSnapshot();
		if (snapshot.recentEventIds.includes(event.eventId)) return null;
		if (isIgnoredReflectionInput(event)) return null;

		if (event.kind === "authorization.revoked") {
			// Revocation is higher priority than reflection: discard the
			// unprocessed materialization, persist the permission gate, and stop
			// its timer. Other explicitly authorized sensors may continue.
			this.cancelTimer();
			await this.saveSnapshot({
				...snapshot,
				state: "ACTIVE_EMPTY",
				openWindow: null,
				contextCandidates: [],
				recentEventIds: this.withRecentEventId(snapshot, event.eventId),
				revokedPermissions: mergePermissions(
					snapshot.revokedPermissions,
					event.payload.permissions,
				),
				materializedCursor: event.cursor,
			});
			this.runtimeState = "ACTIVE_EMPTY";
			return null;
		}

		if (event.kind === "authorization.granted") {
			await this.saveSnapshot({
				...snapshot,
				recentEventIds: this.withRecentEventId(snapshot, event.eventId),
				revokedPermissions: removePermissions(
					snapshot.revokedPermissions,
					event.payload.permissions,
				),
				materializedCursor: event.cursor,
			});
			return null;
		}

		if (isBlockedByRevocation(event, snapshot.revokedPermissions)) {
			await this.saveSnapshot({
				...snapshot,
				recentEventIds: this.withRecentEventId(snapshot, event.eventId),
				materializedCursor: event.cursor,
			});
			return null;
		}

		if (
			isPresenceFlushBoundary(event) &&
			snapshot.openWindow &&
			event.occurredAtMs < latestEventTime(snapshot.openWindow)
		) {
			return this.handleRetroactivePresenceBoundary(event);
		}

		const thresholdOpenWindow = snapshot.openWindow;
		if (
			thresholdOpenWindow &&
			thresholdOpenWindow.finalizedSemanticEventCount >= this.threshold
		) {
			const reachedAtMs = countThresholdReachedAt(thresholdOpenWindow);
			const sameTimestampBoundary =
				event.occurredAtMs === reachedAtMs &&
				(event.kind === "goal.contextChanged" ||
					isPresenceFlushBoundary(event));
			if (!sameTimestampBoundary) {
				const sealed = await this.sealOpenWindow("event_count", reachedAtMs);
				await this.ingestSerialized(event);
				return sealed;
			}
		}

		// A timer may not have run while the process was stopped or while a
		// durable backlog is replayed. Split by the persisted event timeline,
		// rather than allowing old events to race through the collector and
		// incorrectly reach the count threshold. Equality is handled below so
		// boundary > count > deadline remains deterministic.
		if (
			snapshot.openWindow &&
			event.occurredAtMs > snapshot.openWindow.deadlineAtMs
		) {
			const overdue = await this.sealOpenWindow(
				"max_wait",
				snapshot.openWindow.deadlineAtMs,
			);
			await this.ingestSerialized(event);
			return overdue;
		}

		if (event.kind === "goal.contextChanged") {
			return this.handleGoalBoundary(event);
		}

		const activeGoalVersion = snapshot.activeGoal?.version ?? null;
		if (event.goalVersion !== activeGoalVersion) {
			throw new GoalVersionMismatchError(event.goalVersion, activeGoalVersion);
		}

		if (isPresenceFlushBoundary(event)) {
			// The native presence tracker can discover a sleep transition only
			// after wake. EventJournal cursor order remains authoritative, so a
			// historical boundary must not close an already-started wake window.
			// Persist its receipt/cursor and leave current evidence untouched.
			if (
				snapshot.openWindow &&
				event.occurredAtMs < snapshot.openWindow.startedAtMs
			) {
				await this.saveSnapshot({
					...snapshot,
					recentEventIds: this.withRecentEventId(snapshot, event.eventId),
					materializedCursor: event.cursor,
				});
				return null;
			}
			return this.handlePresenceBoundary(event);
		}

		if (!isCountedSemanticEvent(event)) {
			const nextOpen = snapshot.openWindow
				? {
						...snapshot.openWindow,
						events: [...snapshot.openWindow.events, structuredClone(event)],
					}
				: null;
			await this.saveSnapshot({
				...snapshot,
				openWindow: nextOpen,
				recentEventIds: this.withRecentEventId(snapshot, event.eventId),
				materializedCursor: event.cursor,
			});
			return null;
		}

		const openWindow = snapshot.openWindow
			? appendCountedEvent(snapshot.openWindow, event)
			: startOpenWindow(
					event,
					snapshot.activeGoal,
					this.maxWaitMs,
					snapshot.cloudOwnerEpoch,
				);

		const candidateSnapshot: ReflectionCollectorSnapshotV1 = {
			...snapshot,
			state: "ACTIVE_COLLECTING",
			openWindow,
			recentEventIds: this.withRecentEventId(snapshot, event.eventId),
			materializedCursor: event.cursor,
		};
		this.runtimeState = "ACTIVE_COLLECTING";

		if (openWindow.finalizedSemanticEventCount >= this.threshold) {
			if (this.onCountReady) {
				this.cancelTimer();
				await this.saveSnapshot(candidateSnapshot);
				this.onCountReady(event.occurredAtMs);
				return null;
			}
			return this.sealCandidate(
				candidateSnapshot,
				"event_count",
				event.occurredAtMs,
			);
		}
		if (event.occurredAtMs >= openWindow.deadlineAtMs) {
			return this.sealCandidate(
				candidateSnapshot,
				"max_wait",
				openWindow.deadlineAtMs,
			);
		}

		await this.saveSnapshot(candidateSnapshot);
		if (!this.deadlinesDeferred) this.armDeadline(openWindow.deadlineAtMs);
		return null;
	}

	private async handleGoalBoundary(
		event: Extract<DesktopEventV1, { kind: "goal.contextChanged" }>,
	): Promise<EventWindowV1 | null> {
		const snapshot = this.requireSnapshot();
		const activeVersion = snapshot.activeGoal?.version ?? null;
		const previousVersion = event.payload.previous?.version ?? null;
		if (
			activeVersion !== previousVersion ||
			event.goalVersion !== activeVersion
		) {
			throw new GoalVersionMismatchError(previousVersion, activeVersion);
		}
		const nextRevision = snapshot.goalRevision + 1;
		if (
			event.payload.next !== null &&
			event.payload.next.version !== nextRevision
		) {
			throw new Error(
				`Next goal version ${event.payload.next.version} must equal monotonic revision ${nextRevision}.`,
			);
		}
		const recentEventIds = this.withRecentEventId(snapshot, event.eventId);
		if (!snapshot.openWindow) {
			await this.saveSnapshot({
				...snapshot,
				activeGoal: cloneGoal(event.payload.next),
				goalRevision: nextRevision,
				recentEventIds,
				materializedCursor: event.cursor,
			});
			return null;
		}

		const candidate: ReflectionCollectorSnapshotV1 = {
			...snapshot,
			goalRevision: nextRevision,
			openWindow: {
				...snapshot.openWindow,
				events: [...snapshot.openWindow.events, structuredClone(event)],
			},
			recentEventIds,
			materializedCursor: event.cursor,
		};
		return this.sealCandidate(
			candidate,
			"goal_boundary",
			event.occurredAtMs,
			event.payload.next,
		);
	}

	private async handlePresenceBoundary(
		event: DesktopEventV1,
	): Promise<EventWindowV1 | null> {
		const snapshot = this.requireSnapshot();
		const recentEventIds = this.withRecentEventId(snapshot, event.eventId);
		if (!snapshot.openWindow) {
			await this.saveSnapshot({
				...snapshot,
				recentEventIds,
				materializedCursor: event.cursor,
			});
			return null;
		}
		const candidate: ReflectionCollectorSnapshotV1 = {
			...snapshot,
			openWindow: {
				...snapshot.openWindow,
				events: [...snapshot.openWindow.events, structuredClone(event)],
			},
			recentEventIds,
			materializedCursor: event.cursor,
		};
		return this.sealCandidate(
			candidate,
			"presence_boundary",
			event.occurredAtMs,
		);
	}

	private async handleRetroactivePresenceBoundary(
		event: DesktopEventV1,
	): Promise<EventWindowV1 | null> {
		const snapshot = this.requireSnapshot();
		const openWindow = snapshot.openWindow;
		if (!openWindow) return null;
		const recentEventIds = this.withRecentEventId(snapshot, event.eventId);

		// A boundary older than the first counted evidence belongs entirely to
		// historical presence state and must not close the newer wake window.
		if (event.occurredAtMs < openWindow.startedAtMs) {
			await this.saveSnapshot({
				...snapshot,
				recentEventIds,
				materializedCursor: event.cursor,
			});
			return null;
		}

		// Cursor order is the durable cross-sensor total order. When an older
		// producer timestamp arrives late, the boundary still outranks a
		// count-ready window, but its observed time (and all already-materialized
		// evidence) determines a non-regressing window end. This avoids moving a
		// cursor backwards into the next window.
		const endedAtMs = Math.max(event.observedAtMs, latestEventTime(openWindow));
		const candidate: ReflectionCollectorSnapshotV1 = {
			...snapshot,
			openWindow: {
				...openWindow,
				events: [...openWindow.events, structuredClone(event)],
			},
			recentEventIds,
			materializedCursor: event.cursor,
		};
		return this.sealCandidate(candidate, "presence_boundary", endedAtMs);
	}

	private async sealOpenWindow(
		reason: ReflectionTriggerReason,
		endedAtMs: number,
	): Promise<EventWindowV1> {
		return this.sealCandidate(this.requireSnapshot(), reason, endedAtMs);
	}

	private async sealCandidate(
		candidateSnapshot: ReflectionCollectorSnapshotV1,
		reason: ReflectionTriggerReason,
		endedAtMs: number,
		nextGoal: ActiveGoalContextV1 | null = candidateSnapshot.activeGoal,
	): Promise<EventWindowV1> {
		const openWindow = candidateSnapshot.openWindow;
		if (!openWindow)
			throw new Error("Cannot seal without an open reflection window.");
		this.cancelTimer();
		this.runtimeState = "SEALED";
		const window = await this.windowBuilder.build({
			collectorId: this.collectorId,
			deviceId: this.deviceId,
			sessionId: this.sessionId,
			openWindow,
			triggerReason: reason,
			endedAtMs,
			contextCandidates: candidateSnapshot.contextCandidates,
		});
		const current = this.requireSnapshot();
		const nextSnapshot: ReflectionCollectorSnapshotV1 = {
			...candidateSnapshot,
			state: "ACTIVE_EMPTY",
			activeGoal: cloneGoal(nextGoal),
			openWindow: null,
			contextCandidates: contextCandidatesFromWindow(window),
			revision: current.revision + 1,
			updatedAtMs: this.clock.nowMs(),
		};
		const result = await this.repository.sealWindow(
			window,
			nextSnapshot,
			current.revision,
			openWindow.cloudOwnerEpoch.accountId,
		);
		this.snapshot = result.snapshot;
		this.runtimeState = "ACTIVE_EMPTY";
		if (result.inserted && this.onWindowSealed !== null) {
			try {
				await this.onWindowSealed(structuredClone(result.window));
			} catch (error) {
				// A downstream outbox must never reopen a sealed collector window or
				// block the durable Reflection cursor. The account attribution stored
				// with the window lets its recovery scan repair this notification gap.
				this.onBackgroundError(error);
			}
		}
		return result.window;
	}

	private async saveSnapshot(
		candidate: ReflectionCollectorSnapshotV1,
	): Promise<ReflectionCollectorSnapshotV1> {
		const current = this.requireSnapshot();
		const next: ReflectionCollectorSnapshotV1 = {
			...candidate,
			revision: current.revision + 1,
			updatedAtMs: this.clock.nowMs(),
		};
		const saved = await this.repository.saveCollector(next, current.revision);
		this.snapshot = saved;
		this.runtimeState = saved.openWindow ? "ACTIVE_COLLECTING" : "ACTIVE_EMPTY";
		return saved;
	}

	private withRecentEventId(
		snapshot: ReflectionCollectorSnapshotV1,
		eventId: string,
	): string[] {
		return [...snapshot.recentEventIds, eventId].slice(
			-this.recentEventIdLimit,
		);
	}

	private armDeadline(deadlineAtMs: number): void {
		this.cancelTimer();
		if (this.disposed) return;
		const delayMs = Math.max(0, deadlineAtMs - this.clock.nowMs());
		this.timer = this.clock.setTimer(() => {
			this.timer = null;
			if (this.onDeadlineReady) {
				this.onDeadlineReady(deadlineAtMs);
				return;
			}
			void this.enqueue(async () => {
				const openWindow = this.requireSnapshot().openWindow;
				if (!openWindow) return;
				if (this.clock.nowMs() < openWindow.deadlineAtMs) {
					this.armDeadline(openWindow.deadlineAtMs);
					return;
				}
				await this.sealOpenWindow("max_wait", openWindow.deadlineAtMs);
			}).catch(this.onBackgroundError);
		}, delayMs);
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

	private requireSnapshot(): ReflectionCollectorSnapshotV1 {
		if (!this.snapshot)
			throw new Error("ReflectionCollector.recover() must finish first.");
		return this.snapshot;
	}

	private assertSnapshotIdentity(
		snapshot: ReflectionCollectorSnapshotV1,
	): void {
		if (
			snapshot.collectorId !== this.collectorId ||
			snapshot.deviceId !== this.deviceId ||
			snapshot.sessionId !== this.sessionId
		) {
			throw new Error(
				"Recovered reflection collector identity does not match configuration.",
			);
		}
	}

	private assertValidOpenWindow(
		openWindow: OpenEventWindowV1,
		cloudOwnerEpoch: ReflectionCloudOwnerEpochV1,
	): void {
		if (
			!sameCloudOwnerEpoch(openWindow.cloudOwnerEpoch, cloudOwnerEpoch) ||
			openWindow.events.length === 0 ||
			openWindow.finalizedSemanticEventCount < 1 ||
			openWindow.finalizedSemanticEventCount > this.threshold ||
			openWindow.finalizedSemanticEventCount !==
				openWindow.events.filter(isCountedSemanticEvent).length
		) {
			throw new Error(
				"Recovered reflection collector has an invalid open window.",
			);
		}
	}
}

function startOpenWindow(
	event: DesktopEventV1,
	goal: ActiveGoalContextV1 | null,
	maxWaitMs: number,
	cloudOwnerEpoch: ReflectionCloudOwnerEpochV1,
): OpenEventWindowV1 {
	return {
		cloudOwnerEpoch: { ...cloudOwnerEpoch },
		goal: cloneGoal(goal),
		goalVersion: goal?.version ?? null,
		startedAtMs: event.occurredAtMs,
		deadlineAtMs: event.occurredAtMs + maxWaitMs,
		events: [structuredClone(event)],
		finalizedSemanticEventCount: 1,
	};
}

function appendCountedEvent(
	openWindow: OpenEventWindowV1,
	event: DesktopEventV1,
): OpenEventWindowV1 {
	return {
		...openWindow,
		events: [...openWindow.events, structuredClone(event)],
		finalizedSemanticEventCount: openWindow.finalizedSemanticEventCount + 1,
	};
}

function countThresholdReachedAt(openWindow: OpenEventWindowV1): number {
	for (let index = openWindow.events.length - 1; index >= 0; index -= 1) {
		const event = openWindow.events[index];
		if (event && isCountedSemanticEvent(event)) return event.occurredAtMs;
	}
	throw new Error("Counted reflection window has no counted event timestamp.");
}

function latestEventTime(openWindow: OpenEventWindowV1): number {
	return Math.max(...openWindow.events.map((event) => event.occurredAtMs));
}

function cloneGoal(
	goal: ActiveGoalContextV1 | null,
): ActiveGoalContextV1 | null {
	return goal ? { ...goal } : null;
}

function normalizeRecoveredSnapshot(snapshot: ReflectionCollectorSnapshotV1): {
	snapshot: ReflectionCollectorSnapshotV1;
	migratedCloudOwnerEpoch: boolean;
} {
	const legacy = snapshot as ReflectionCollectorSnapshotV1 & {
		revokedPermissions?: unknown;
		goalRevision?: unknown;
		cloudOwnerEpoch?: unknown;
	};
	const raw = legacy.revokedPermissions;
	const cloudOwnerEpoch = normalizeRecoveredCloudOwnerEpoch(
		legacy.cloudOwnerEpoch,
	);
	const recoveredOpenCloudOwnerEpoch = normalizeRecoveredCloudOwnerEpoch(
		(
			snapshot.openWindow as
				| (OpenEventWindowV1 & { cloudOwnerEpoch?: unknown })
				| null
		)?.cloudOwnerEpoch,
	);
	const normalizedOpenWindow =
		snapshot.openWindow !== null &&
		recoveredOpenCloudOwnerEpoch !== null &&
		cloudOwnerEpoch !== null &&
		sameCloudOwnerEpoch(recoveredOpenCloudOwnerEpoch, cloudOwnerEpoch)
			? {
					...snapshot.openWindow,
					cloudOwnerEpoch: recoveredOpenCloudOwnerEpoch,
				}
			: null;
	const invalidOpenOwner =
		snapshot.openWindow !== null && normalizedOpenWindow === null;
	const migratedCloudOwnerEpoch = cloudOwnerEpoch === null || invalidOpenOwner;
	const normalizedCloudOwnerEpoch = cloudOwnerEpoch ?? {
		epoch: 0,
		accountId: null,
	};
	return {
		snapshot: {
			...snapshot,
			// v1 snapshots created before the permission gate did not carry this
			// field. Treating them as authorized preserves compatibility; only an
			// observed revocation may close the gate.
			revokedPermissions:
				raw === undefined
					? []
					: normalizePermissions(raw, "revokedPermissions", true),
			goalRevision: normalizeGoalRevision(legacy),
			cloudOwnerEpoch: normalizedCloudOwnerEpoch,
			// An open window without the exact same durable owner epoch cannot prove
			// who collected its evidence. Migration drops it and its prior context.
			state: migratedCloudOwnerEpoch ? "ACTIVE_EMPTY" : snapshot.state,
			openWindow: migratedCloudOwnerEpoch ? null : normalizedOpenWindow,
			contextCandidates: migratedCloudOwnerEpoch
				? []
				: snapshot.contextCandidates,
		},
		migratedCloudOwnerEpoch,
	};
}

function normalizeRecoveredCloudOwnerEpoch(
	value: unknown,
): ReflectionCollectorSnapshotV1["cloudOwnerEpoch"] | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const candidate = value as Record<string, unknown>;
	const epoch = candidate.epoch;
	if (
		Object.keys(candidate).length !== 2 ||
		!("epoch" in candidate) ||
		!("accountId" in candidate) ||
		typeof epoch !== "number" ||
		!Number.isSafeInteger(epoch) ||
		epoch < 0
	) {
		return null;
	}
	try {
		return {
			epoch,
			accountId: normalizeCloudOwnerAccountId(candidate.accountId),
		};
	} catch {
		return null;
	}
}

function normalizeCloudOwnerAccountId(value: unknown): string | null {
	if (value === null) return null;
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 256 ||
		value.trim() !== value ||
		value.includes("\u0000")
	) {
		throw new Error("Reflection cloud owner account id is invalid.");
	}
	return value;
}

function sameCloudOwnerEpoch(
	left: ReflectionCloudOwnerEpochV1,
	right: ReflectionCloudOwnerEpochV1,
): boolean {
	return left.epoch === right.epoch && left.accountId === right.accountId;
}

function normalizeGoalRevision(
	snapshot: ReflectionCollectorSnapshotV1 & { goalRevision?: unknown },
): number {
	if (
		Number.isSafeInteger(snapshot.goalRevision) &&
		(snapshot.goalRevision as number) >= 0
	) {
		return snapshot.goalRevision as number;
	}
	let revision = snapshot.activeGoal?.version ?? 0;
	revision = Math.max(revision, snapshot.openWindow?.goalVersion ?? 0);
	for (const event of [
		...(snapshot.openWindow?.events ?? []),
		...snapshot.contextCandidates,
	]) {
		revision = Math.max(revision, event.goalVersion ?? 0);
		if (event.kind === "goal.contextChanged") {
			revision = Math.max(
				revision,
				event.payload.previous?.version ?? 0,
				event.payload.next?.version ?? 0,
			);
		}
	}
	return revision;
}

function mergePermissions(
	current: readonly string[],
	added: readonly string[],
): string[] {
	return Array.from(
		new Set([
			...normalizePermissions(current, "revokedPermissions", true),
			...normalizePermissions(added, "authorization.revoked.permissions"),
		]),
	).sort();
}

function removePermissions(
	current: readonly string[],
	granted: readonly string[],
): string[] {
	const normalizedGranted = normalizePermissions(
		granted,
		"authorization.granted.permissions",
	);
	if (normalizedGranted.includes("*")) return [];
	const grantedSet = new Set(normalizedGranted);
	return normalizePermissions(current, "revokedPermissions", true).filter(
		(permission) => !grantedSet.has(permission),
	);
}

function normalizePermissions(
	value: unknown,
	field: string,
	allowEmpty = false,
): string[] {
	if (
		!Array.isArray(value) ||
		(!allowEmpty && value.length === 0) ||
		value.length > 32 ||
		!value.every(
			(permission) =>
				typeof permission === "string" &&
				(permission === "*" || /^[a-z][a-z0-9.-]{0,127}$/u.test(permission)),
		)
	) {
		throw new Error(
			`${field} must contain 1 to 32 canonical permission names.`,
		);
	}
	return Array.from(new Set(value as string[])).sort();
}

function isBlockedByRevocation(
	event: DesktopEventV1,
	revokedPermissions: readonly string[],
): boolean {
	if (revokedPermissions.includes("*")) return true;
	const requirements = permissionsForEvent(event);
	return requirements.some((permission) =>
		revokedPermissions.includes(permission),
	);
}

function permissionsForEvent(event: DesktopEventV1): readonly string[] {
	switch (event.kind) {
		case "input.activityAggregated":
			return ["input.monitoring"];
		case "editor.documentChanged":
			return ["editor.monitoring"];
		case "browser.tabOpened":
		case "browser.tabNavigated":
			return event.sensitivity === "content"
				? ["browser.event-monitoring", "browser.content-monitoring"]
				: ["browser.event-monitoring"];
		case "browser.tabClosed":
			return ["browser.event-monitoring"];
		case "accessibility.focusChanged":
		case "accessibility.valueChanged":
		case "accessibility.documentChanged":
			return ["accessibility.monitoring"];
		default:
			return [];
	}
}
