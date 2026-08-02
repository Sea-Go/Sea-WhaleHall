import type { AgentRuntime } from "../agent-runtime";
import { MAX_ACTIVE_GOAL_TEXT_LENGTH } from "../../shared/goal-context";
import type {
	LocalEventCommitResult,
	LocalEventGoalChange,
	LocalEventGoalChangeResult,
	LocalEventQuery,
	LocalEventQueryResult,
} from "../local-protocol";
import {
	DEFAULT_MAX_WAIT_MS,
	DEFAULT_SEMANTIC_EVENT_THRESHOLD,
	ReflectionCollector,
	type ReflectionClock,
} from "./collector";
import {
	ReflectionJobRunner,
	type ReflectionCommitter,
	type ReflectionInferenceProvider,
	type ReflectionJobRunResult,
} from "./job-runner";
import type { ReflectionRepository } from "./repository";
import {
	type ActiveGoalContextV1,
	type DesktopEventV1,
	type EventWindowV1,
	type ReflectionQueueMode,
	type ReflectionV1,
} from "./types";
import {
	DeterministicWindowBuilder,
} from "./window-builder";
import { WebCryptoReflectionHasher } from "./hash";

export const REFLECTION_EVENT_CONSUMER_ID = "whalehall.reflection.v1";
export const DEFAULT_EVENT_PULL_LIMIT = 256;
export const DEFAULT_JOB_POLL_MS = 1_000;
export const DEFAULT_EVENT_POLL_MS = 5_000;
export const DEFAULT_DEADLINE_PULL_RETRY_MS = 1_000;

export interface DesktopEventTransport {
	prepareStartupGoalChange(change: LocalEventGoalChange | null): Promise<void>;
	acknowledgeStartupGoalChange(): Promise<void>;
	start(): Promise<void>;
	queryDesktopEvents(query: LocalEventQuery): Promise<LocalEventQueryResult>;
	commitDesktopEventCursor(
		consumerId: string,
		cursor: string,
	): Promise<LocalEventCommitResult>;
	appendDesktopGoalChange(
		change: LocalEventGoalChange,
	): Promise<LocalEventGoalChangeResult>;
	onDesktopEvent(listener: (event: DesktopEventV1) => void): () => void;
}

export type ReflectionServiceIdentity = {
	collectorId: string;
	deviceId: string;
	sessionId: string;
};

export type TelemetryEnvelopeV1 = {
	schemaVersion: "telemetry-envelope.v1";
	name: "whalehall.reflection.v1";
	idempotencyKey: string;
	occurredAtMs: number;
	window: EventWindowV1;
	reflection: ReflectionV1;
};

/**
 * Sinks must upsert by idempotencyKey. A crash after sink delivery but before
 * COMMITTED can retry the same envelope.
 */
export interface TelemetrySink {
	emit(envelope: TelemetryEnvelopeV1): Promise<void>;
}

export type DesktopReflectionServiceOptions = {
	transport: DesktopEventTransport;
	repository: ReflectionRepository;
	inference: ReflectionInferenceProvider;
	identity: ReflectionServiceIdentity;
	sinks?: readonly TelemetrySink[];
	clock?: ReflectionClock;
	consumerId?: string;
	pullLimit?: number;
	jobPollMs?: number;
	eventPollMs?: number;
	semanticEventThreshold?: number;
	maxWaitMs?: number;
	/**
	 * An authoritative goal known during startup. The service injects its
	 * durable boundary into the native process before any resident sensor
	 * starts. `undefined` preserves recovered goal state.
	 */
	startupGoal?: Omit<ActiveGoalContextV1, "version"> | null;
	/**
	 * Called after a reflection window is atomically sealed. This is an
	 * observation hook only: errors are contained by the collector so a cloud
	 * delivery outage cannot stall EventJournal cursor progress.
	 */
	onWindowSealed?: (window: EventWindowV1) => void | Promise<void>;
	onError?: (error: unknown) => void;
};

type ActiveGoalChangePlan = {
	change: LocalEventGoalChange | null;
	startupChange: LocalEventGoalChange;
	expectedGoal: ActiveGoalContextV1 | null;
};

/**
 * Connects the durable Rust event stream to deterministic windowing and the
 * persisted reflection job state machine.
 */
export class DesktopReflectionService {
	private readonly transport: DesktopEventTransport;
	private readonly repository: ReflectionRepository;
	private readonly inference: ReflectionInferenceProvider;
	private readonly identity: ReflectionServiceIdentity;
	private readonly clock: ReflectionClock;
	private readonly consumerId: string;
	private readonly pullLimit: number;
	private readonly jobPollMs: number;
	private readonly eventPollMs: number;
	private readonly startupGoal:
		| Omit<ActiveGoalContextV1, "version">
		| null
		| undefined;
	private readonly onError: (error: unknown) => void;
	private readonly collector: ReflectionCollector;
	private readonly jobs: ReflectionJobRunner;
	private readonly hasher = new WebCryptoReflectionHasher();

	private started = false;
	private acceptingLiveEvents = false;
	private pausedLiveGeneration = 0;
	private operationTail: Promise<void> = Promise.resolve();
	private unsubscribeLive: (() => void) | null = null;
	private jobTimer: ReturnType<typeof setTimeout> | null = null;
	private eventPollTimer: ReturnType<typeof setTimeout> | null = null;
	private deadlineRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private countRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private catchUpRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private activeJobPump: Promise<void> | null = null;
	private lastCommittedCursor: string | null = null;

	constructor(options: DesktopReflectionServiceOptions) {
		this.transport = options.transport;
		this.repository = options.repository;
		this.inference = options.inference;
		this.identity = { ...options.identity };
		this.clock = options.clock ?? {
			nowMs: () => Date.now(),
			setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimer: (handle) => clearTimeout(handle),
		};
		this.consumerId = options.consumerId ?? REFLECTION_EVENT_CONSUMER_ID;
		this.pullLimit = options.pullLimit ?? DEFAULT_EVENT_PULL_LIMIT;
		this.jobPollMs = options.jobPollMs ?? DEFAULT_JOB_POLL_MS;
		this.eventPollMs = options.eventPollMs ?? DEFAULT_EVENT_POLL_MS;
		this.startupGoal =
			options.startupGoal === undefined || options.startupGoal === null
				? options.startupGoal
				: validateRequestedGoal(options.startupGoal);
		this.onError = options.onError ?? ((error) => console.error("[reflection]", error));
		if (!Number.isInteger(this.pullLimit) || this.pullLimit < 1 || this.pullLimit > 1_000) {
			throw new Error("pullLimit must be between 1 and 1000.");
		}
		if (!Number.isFinite(this.jobPollMs) || this.jobPollMs <= 0) {
			throw new Error("jobPollMs must be positive.");
		}
		if (!Number.isFinite(this.eventPollMs) || this.eventPollMs <= 0) {
			throw new Error("eventPollMs must be positive.");
		}

		this.collector = new ReflectionCollector({
			...this.identity,
			repository: this.repository,
			windowBuilder: new DeterministicWindowBuilder(this.hasher),
			clock: this.clock,
			semanticEventThreshold:
				options.semanticEventThreshold ?? DEFAULT_SEMANTIC_EVENT_THRESHOLD,
			maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
			onBackgroundError: this.onError,
			onDeadlineReady: (deadlineAtMs) => this.coordinateDeadline(deadlineAtMs),
			onCountReady: (reachedAtMs) => this.coordinateCount(reachedAtMs),
			onWindowSealed: options.onWindowSealed,
		});
		const committer = new TelemetryReflectionCommitter(
			options.sinks ?? [],
			this.clock,
		);
		this.jobs = new ReflectionJobRunner({
			repository: this.repository,
			inference: this.inference,
			committer,
			clock: this.clock,
		});
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.acceptingLiveEvents = false;
		this.unsubscribeLive = this.transport.onDesktopEvent((event) => {
			if (!this.acceptingLiveEvents) {
				this.pausedLiveGeneration += 1;
				return;
			}
			void this.enqueue(async () => {
				// A previous queued event may have failed after this callback was
				// enqueued. Never let a later cursor jump over that durable gap.
				if (!this.acceptingLiveEvents) {
					this.pausedLiveGeneration += 1;
					return;
				}
				try {
					await this.ingestJournalEvent(event);
				} catch (error) {
					this.pauseLiveFastPath();
					throw error;
				}
			}).catch(this.onError);
		});

		try {
			await this.collector.recover({ deferDeadline: true });
			let startupPlan: ActiveGoalChangePlan | null = null;
			if (this.startupGoal !== undefined) {
				startupPlan = await this.planActiveGoalChange(this.startupGoal);
				await this.transport.prepareStartupGoalChange(
					startupPlan.startupChange,
				);
			} else {
				await this.transport.prepareStartupGoalChange(null);
			}
			await this.transport.start();
			for (;;) {
				const generation = this.pausedLiveGeneration;
				await this.pullBacklog();
				// Push is only a wake-up/latency path. Every event is replayed
				// from the durable named consumer in cursor order.
				if (generation === this.pausedLiveGeneration) break;
			}
			if (
				startupPlan !== null &&
				!sameGoalTarget(
					this.collector.getSnapshot().activeGoal,
					startupPlan.expectedGoal,
				)
			) {
				throw new Error(
					"Durable startup goal boundary did not materialize as requested.",
				);
			}
			await this.transport.acknowledgeStartupGoalChange();
			const resumeDeadlines = this.enqueue(() => this.collector.resumeDeadlines());
			this.acceptingLiveEvents = true;
			await resumeDeadlines;
			this.armJobPump(0);
			this.armEventPoll(this.eventPollMs);
		} catch (error) {
			this.started = false;
			this.acceptingLiveEvents = false;
			this.cancelCatchUpRetry();
			this.unsubscribeLive?.();
			this.unsubscribeLive = null;
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.acceptingLiveEvents = false;
		this.started = false;
		this.unsubscribeLive?.();
		this.unsubscribeLive = null;
		if (this.jobTimer !== null) {
			this.clock.clearTimer(this.jobTimer);
			this.jobTimer = null;
		}
		if (this.eventPollTimer !== null) {
			this.clock.clearTimer(this.eventPollTimer);
			this.eventPollTimer = null;
		}
		this.cancelDeadlineRetry();
		this.cancelCountRetry();
		this.cancelCatchUpRetry();
		await this.operationTail;
		await this.activeJobPump;
		this.collector.dispose();
	}

	async setActiveGoal(
		requestedGoal: Omit<ActiveGoalContextV1, "version"> | null,
	): Promise<ActiveGoalContextV1 | null> {
		const validatedGoal =
			requestedGoal === null ? null : validateRequestedGoal(requestedGoal);
		let normalized: ActiveGoalContextV1 | null = null;
		await this.enqueue(async () => {
			if (!this.started) throw new Error("DesktopReflectionService is not started.");
			await this.pullBacklog();
			normalized = await this.appendActiveGoalToJournal(validatedGoal);
		});
		return normalized;
	}

	async pullNow(): Promise<void> {
		await this.enqueue(async () => {
			if (!this.acceptingLiveEvents && this.started) {
				await this.restorePausedLiveFastPath();
				return;
			}
			await this.pullBacklog();
		});
	}

	async runJobsNow(maxJobs = 100): Promise<ReflectionJobRunResult[]> {
		return this.jobs.runUntilIdle(maxJobs);
	}

	async getStatus(): Promise<{
		collectorState: ReturnType<ReflectionCollector["getState"]>;
		queueMode: ReflectionQueueMode;
		pendingJobs: number;
		pendingEvents: number;
		lastCommittedCursor: string | null;
	}> {
		const pressure = await this.jobs.getQueuePressure();
		return {
			collectorState: this.collector.getState(),
			queueMode: pressure.mode,
			pendingJobs: pressure.stats.pendingJobs,
			pendingEvents: pressure.stats.pendingEvents,
			lastCommittedCursor: this.lastCommittedCursor,
		};
	}

	/**
	 * Read-only startup handoff for downstream durable consumers. Call after
	 * start() has reconciled the native goal boundary and pulled its backlog.
	 */
	getActiveGoalContext(): ActiveGoalContextV1 | null {
		return structuredClone(this.collector.getSnapshot().activeGoal);
	}

	private async pullBacklog(): Promise<void> {
		try {
			for (;;) {
				const page = await this.transport.queryDesktopEvents({
					consumerId: this.consumerId,
					limit: this.pullLimit,
				});
				for (const event of page.events) await this.ingestJournalEvent(event);
				if (page.events.length === 0 || !page.hasMore) return;
			}
		} catch (error) {
			if (this.acceptingLiveEvents) this.pauseLiveFastPath();
			throw error;
		}
	}

	private async appendActiveGoalToJournal(
		validatedGoal: Omit<ActiveGoalContextV1, "version"> | null,
	): Promise<ActiveGoalContextV1 | null> {
		const plan = await this.planActiveGoalChange(validatedGoal);
		if (plan.change === null) return structuredClone(plan.expectedGoal);
		await this.transport.appendDesktopGoalChange(plan.change);
		// The append response is not the materialization barrier. Pull through
		// the named consumer so the boundary and surrounding sensor events are
		// assigned strictly by their durable cursor order.
		await this.pullBacklog();
		const activeGoal = this.collector.getSnapshot().activeGoal;
		if (!sameGoalContext(activeGoal, plan.expectedGoal)) {
			throw new Error("Durable goal boundary did not materialize as requested.");
		}
		return structuredClone(activeGoal);
	}

	private async planActiveGoalChange(
		validatedGoal: Omit<ActiveGoalContextV1, "version"> | null,
	): Promise<ActiveGoalChangePlan> {
		const collectorSnapshot = this.collector.getSnapshot();
		const previous = collectorSnapshot.activeGoal;
		let expectedGoal: ActiveGoalContextV1 | null;
		let shouldAppend: boolean;
		if (
			validatedGoal !== null &&
			previous !== null &&
			validatedGoal.activatedAtMs < previous.activatedAtMs
		) {
			expectedGoal = structuredClone(previous);
			shouldAppend = false;
		} else if (
			validatedGoal !== null &&
			previous?.goalId === validatedGoal.goalId &&
			previous.planId === validatedGoal.planId &&
			previous.text === validatedGoal.text
		) {
			expectedGoal = structuredClone(previous);
			shouldAppend = false;
		} else if (validatedGoal === null && previous === null) {
			expectedGoal = null;
			shouldAppend = false;
		} else {
			expectedGoal = validatedGoal
				? {
						...structuredClone(validatedGoal),
						version: collectorSnapshot.goalRevision + 1,
					}
				: null;
			shouldAppend = true;
		}
		const occurredAtMs = this.clock.nowMs();
		if (
			expectedGoal !== null &&
			expectedGoal.activatedAtMs > occurredAtMs
		) {
			throw new Error("Active goal activatedAtMs cannot be in the future.");
		}
		const change = shouldAppend
			? {
					previous: structuredClone(previous),
					next: structuredClone(expectedGoal),
					occurredAtMs,
					deduplicationKey: `whalehall-goal-v1:${await this.hasher.sha256(
						JSON.stringify({
							collectorId: this.identity.collectorId,
							deviceId: this.identity.deviceId,
							revision: collectorSnapshot.goalRevision + 1,
							previous,
							next: expectedGoal,
						}),
					)}`,
				}
			: null;
		const startupChange =
			change ??
			{
				previous: structuredClone(previous),
				next: structuredClone(expectedGoal),
				occurredAtMs,
				deduplicationKey: `whalehall-startup-goal-v1:${await this.hasher.sha256(
					JSON.stringify({
						collectorId: this.identity.collectorId,
						deviceId: this.identity.deviceId,
						revision: collectorSnapshot.goalRevision,
						previous,
						desired: expectedGoal,
					}),
				)}`,
			};
		return {
			change,
			startupChange,
			expectedGoal: structuredClone(expectedGoal),
		};
	}

	private async ingestJournalEvent(rawEvent: DesktopEventV1): Promise<void> {
		if (!this.belongsToCurrentInstallation(rawEvent)) return;
		if (
			this.lastCommittedCursor !== null &&
			compareEventCursors(rawEvent.cursor, this.lastCommittedCursor) <= 0
		) {
			return;
		}
		const activeGoalVersion = this.collector.getSnapshot().activeGoal?.version ?? null;
		const event = structuredClone(rawEvent);
		event.deviceId = this.identity.deviceId;
		event.sessionId = this.identity.sessionId;
		if (
			event.kind !== "goal.contextChanged" &&
			!event.kind.startsWith("reflection.") &&
			!event.kind.startsWith("tool.")
		) {
			event.goalVersion = activeGoalVersion;
		}
		// EventJournal contains completed semantic events. Native sensors own
		// aggregation and transition de-duplication, while the collector's
		// durable recent-event receipts make replay after a cursor-commit crash
		// deterministic across process restarts.
		await this.collector.ingest(event);
		await this.commitCursor(rawEvent.cursor);
	}

	private belongsToCurrentInstallation(event: DesktopEventV1): boolean {
		// The native journal owns its own stable device id. Once this service has
		// accepted a stream, device identity is normalized to the app installation
		// id for window hashing. Empty identifiers are always rejected by protocol.
		return event.deviceId.length > 0;
	}

	private async commitCursor(cursor: string): Promise<void> {
		if (
			this.lastCommittedCursor !== null &&
			compareEventCursors(cursor, this.lastCommittedCursor) <= 0
		) {
			return;
		}
		await this.transport.commitDesktopEventCursor(this.consumerId, cursor);
		this.lastCommittedCursor = cursor;
	}

	private armJobPump(delayMs: number): void {
		if (!this.started || this.jobTimer !== null) return;
		this.jobTimer = this.clock.setTimer(() => {
			this.jobTimer = null;
			const pump = this.jobs
				.runUntilIdle()
				.then(() => undefined)
				.catch(this.onError)
				.finally(() => {
					if (this.activeJobPump === pump) this.activeJobPump = null;
					this.armJobPump(this.jobPollMs);
				});
			this.activeJobPump = pump;
		}, delayMs);
	}

	private armEventPoll(delayMs: number): void {
		if (!this.started || this.eventPollTimer !== null) return;
		this.eventPollTimer = this.clock.setTimer(() => {
			this.eventPollTimer = null;
			void this.enqueue(async () => {
				if (!this.started) return;
				if (this.acceptingLiveEvents) {
					await this.pullBacklog();
				} else {
					await this.restorePausedLiveFastPath();
				}
			})
				.catch(this.onError)
				.finally(() => this.armEventPoll(this.eventPollMs));
		}, delayMs);
	}

	private coordinateDeadline(_deadlineAtMs: number): void {
		if (!this.started) return;
		void this.enqueue(async () => {
			if (!this.started) return;
			try {
				await this.pullBacklog();
			} catch (error) {
				this.scheduleDeadlineRetry();
				throw error;
			}
			this.cancelDeadlineRetry();
			await this.collector.flushDue();
		}).catch(this.onError);
	}

	private coordinateCount(_reachedAtMs: number): void {
		// Startup replay has its own materialization barrier and calls
		// resumeDeadlines(), which resolves count before time. Avoid starting a
		// second pull concurrently with that barrier.
		if (!this.started || !this.acceptingLiveEvents) return;
		void this.enqueue(async () => {
			if (!this.started) return;
			try {
				await this.pullBacklog();
			} catch (error) {
				this.scheduleCountRetry();
				throw error;
			}
			this.cancelCountRetry();
			await this.collector.flushCountDue();
		}).catch(this.onError);
	}

	private scheduleDeadlineRetry(): void {
		if (!this.started || this.deadlineRetryTimer !== null) return;
		this.deadlineRetryTimer = this.clock.setTimer(() => {
			this.deadlineRetryTimer = null;
			this.coordinateDeadline(this.clock.nowMs());
		}, DEFAULT_DEADLINE_PULL_RETRY_MS);
	}

	private cancelDeadlineRetry(): void {
		if (this.deadlineRetryTimer === null) return;
		this.clock.clearTimer(this.deadlineRetryTimer);
		this.deadlineRetryTimer = null;
	}

	private scheduleCountRetry(): void {
		if (!this.started || this.countRetryTimer !== null) return;
		this.countRetryTimer = this.clock.setTimer(() => {
			this.countRetryTimer = null;
			this.coordinateCount(this.clock.nowMs());
		}, DEFAULT_DEADLINE_PULL_RETRY_MS);
	}

	private cancelCountRetry(): void {
		if (this.countRetryTimer === null) return;
		this.clock.clearTimer(this.countRetryTimer);
		this.countRetryTimer = null;
	}

	private pauseLiveFastPath(): void {
		if (!this.started) return;
		this.acceptingLiveEvents = false;
		this.scheduleCatchUpRetry();
	}

	private scheduleCatchUpRetry(): void {
		if (!this.started || this.catchUpRetryTimer !== null) return;
		this.catchUpRetryTimer = this.clock.setTimer(() => {
			this.catchUpRetryTimer = null;
			void this.enqueue(async () => {
				if (!this.started) return;
				try {
					await this.restorePausedLiveFastPath();
				} catch (error) {
					this.scheduleCatchUpRetry();
					throw error;
				}
			}).catch(this.onError);
		}, DEFAULT_DEADLINE_PULL_RETRY_MS);
	}

	/**
	 * Replays until no push notification arrived during either the durable pull
	 * or the count/deadline flush. The final generation comparison and enabling
	 * the live path are synchronous, so a later cursor can never jump over an
	 * event that arrived while recovery was sealing a window.
	 */
	private async restorePausedLiveFastPath(): Promise<void> {
		for (;;) {
			const generation = this.pausedLiveGeneration;
			await this.pullBacklog();
			await this.collector.flushCountDue();
			await this.collector.flushDue();
			if (generation === this.pausedLiveGeneration) break;
		}
		if (!this.started) return;
		this.cancelCatchUpRetry();
		this.acceptingLiveEvents = true;
	}

	private cancelCatchUpRetry(): void {
		if (this.catchUpRetryTimer === null) return;
		this.clock.clearTimer(this.catchUpRetryTimer);
		this.catchUpRetryTimer = null;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function validateRequestedGoal(
	goal: Omit<ActiveGoalContextV1, "version">,
): Omit<ActiveGoalContextV1, "version"> {
	const text = goal.text.trim();
	if (!isBoundedGoalString(goal.goalId, 200)) {
		throw new Error("goalId must contain 1 to 200 non-control UTF-8 bytes.");
	}
	if (goal.planId !== null && !isBoundedGoalString(goal.planId, 200)) {
		throw new Error("planId must be null or contain 1 to 200 non-control UTF-8 bytes.");
	}
	if (
		text.length === 0 ||
		Array.from(text).length > MAX_ACTIVE_GOAL_TEXT_LENGTH ||
		containsDisallowedGoalTextControl(text)
	) {
		throw new Error(
			`goal text must contain 1 to ${MAX_ACTIVE_GOAL_TEXT_LENGTH} printable characters (line whitespace is allowed).`,
		);
	}
	if (!Number.isSafeInteger(goal.activatedAtMs) || goal.activatedAtMs < 0) {
		throw new Error("activatedAtMs must be a non-negative safe integer.");
	}
	return {
		goalId: goal.goalId,
		planId: goal.planId,
		text,
		activatedAtMs: goal.activatedAtMs,
	};
}

function isBoundedGoalString(value: string, maximum: number): boolean {
	const byteLength = new TextEncoder().encode(value).byteLength;
	return (
		byteLength >= 1 &&
		byteLength <= maximum &&
		!Array.from(value).some((character) => /\p{Cc}/u.test(character))
	);
}

function containsDisallowedGoalTextControl(value: string): boolean {
	return Array.from(value).some(
		(character) =>
			/\p{Cc}/u.test(character) &&
			character !== "\n" &&
			character !== "\r" &&
			character !== "\t",
	);
}

function sameGoalContext(
	left: ActiveGoalContextV1 | null,
	right: ActiveGoalContextV1 | null,
): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.goalId === right.goalId &&
			left.planId === right.planId &&
			left.version === right.version &&
			left.text === right.text &&
			left.activatedAtMs === right.activatedAtMs)
	);
}

function sameGoalTarget(
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

class TelemetryReflectionCommitter implements ReflectionCommitter {
	constructor(
		private readonly sinks: readonly TelemetrySink[],
		private readonly clock: Pick<ReflectionClock, "nowMs">,
	) {}

	async commit(window: EventWindowV1, reflection: ReflectionV1): Promise<void> {
		const envelope: TelemetryEnvelopeV1 = {
			schemaVersion: "telemetry-envelope.v1",
			name: "whalehall.reflection.v1",
			idempotencyKey: window.windowId,
			occurredAtMs: this.clock.nowMs(),
			window: structuredClone(window),
			reflection: structuredClone(reflection),
		};
		for (const sink of this.sinks) await sink.emit(envelope);
	}
}

function compareEventCursors(left: string, right: string): number {
	const leftSequence = eventCursorSequence(left);
	const rightSequence = eventCursorSequence(right);
	if (leftSequence !== null && rightSequence !== null) {
		return leftSequence === rightSequence ? 0 : leftSequence > rightSequence ? 1 : -1;
	}
	return left.localeCompare(right);
}

function eventCursorSequence(cursor: string): bigint | null {
	if (!/^ec1_[0-9a-f]{16}$/.test(cursor)) return null;
	return BigInt(`0x${cursor.slice(4)}`);
}

export function asDesktopEventTransport(runtime: AgentRuntime): DesktopEventTransport {
	return runtime;
}
