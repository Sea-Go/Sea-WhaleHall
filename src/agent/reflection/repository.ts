import {
	REFLECTION_JOB_SCHEMA_VERSION,
	type EventWindowV1,
	type ReflectionCollectorSnapshotV1,
	type ReflectionJobFailureV1,
	type ReflectionJobV1,
	type ReflectionQueueStats,
	type ReflectionV1,
} from "./types";

export class CollectorRevisionConflictError extends Error {
	constructor() {
		super("Reflection collector state changed concurrently.");
		this.name = "CollectorRevisionConflictError";
	}
}

export class InvalidReflectionJobTransitionError extends Error {
	constructor(from: ReflectionJobV1["state"], operation: string) {
		super(`Cannot ${operation} a reflection job in state ${from}.`);
		this.name = "InvalidReflectionJobTransitionError";
	}
}

export type SealWindowResult = {
	inserted: boolean;
	window: EventWindowV1;
	snapshot: ReflectionCollectorSnapshotV1;
	job: ReflectionJobV1;
};

export interface ReflectionCollectorRepository {
	loadCollector(collectorId: string): Promise<ReflectionCollectorSnapshotV1 | null>;
	saveCollector(
		snapshot: ReflectionCollectorSnapshotV1,
		expectedRevision: number | null,
	): Promise<ReflectionCollectorSnapshotV1>;
	/**
	 * Implementations must atomically persist the immutable window, enqueue its
	 * READY job, and replace the collector snapshot.
	 */
	sealWindow(
		window: EventWindowV1,
		nextSnapshot: ReflectionCollectorSnapshotV1,
		expectedRevision: number,
	): Promise<SealWindowResult>;
}

export interface DurableReflectionJobRepository {
	getWindow(windowId: string): Promise<EventWindowV1 | null>;
	getJob(windowId: string): Promise<ReflectionJobV1 | null>;
	getQueueStats(): Promise<ReflectionQueueStats>;
	/**
	 * Claims the oldest runnable unit atomically. READY/RETRY_WAIT jobs without
	 * results become RUNNING; jobs with persisted results become COMMITTING.
	 */
	claimNextRunnable(nowMs: number, leaseDurationMs: number): Promise<ReflectionJobV1 | null>;
	persistResult(
		windowId: string,
		reflection: ReflectionV1,
		nowMs: number,
	): Promise<ReflectionJobV1>;
	beginCommit(
		windowId: string,
		nowMs: number,
		leaseDurationMs: number,
	): Promise<ReflectionJobV1>;
	recordFailure(
		windowId: string,
		failure: ReflectionJobFailureV1,
		nextAttemptAtMs: number | null,
		terminal: boolean,
	): Promise<ReflectionJobV1>;
	markCommitted(windowId: string, nowMs: number): Promise<ReflectionJobV1>;
	replayTerminal(windowId: string, nowMs: number): Promise<ReflectionJobV1>;
}

export interface ReflectionRepository
	extends ReflectionCollectorRepository,
		DurableReflectionJobRepository {}

/**
 * Deterministic reference repository for tests and embedding. Production must
 * provide the same operations as SQLite transactions; this implementation is
 * intentionally not durable across process exits.
 */
export class InMemoryReflectionRepository implements ReflectionRepository {
	private readonly collectors = new Map<string, ReflectionCollectorSnapshotV1>();
	private readonly windows = new Map<string, EventWindowV1>();
	private readonly jobs = new Map<string, ReflectionJobV1>();

	async loadCollector(collectorId: string): Promise<ReflectionCollectorSnapshotV1 | null> {
		return clone(this.collectors.get(collectorId) ?? null);
	}

	async saveCollector(
		snapshot: ReflectionCollectorSnapshotV1,
		expectedRevision: number | null,
	): Promise<ReflectionCollectorSnapshotV1> {
		const current = this.collectors.get(snapshot.collectorId);
		if (
			(expectedRevision === null && current !== undefined) ||
			(expectedRevision !== null && current?.revision !== expectedRevision)
		) {
			throw new CollectorRevisionConflictError();
		}
		const saved = clone(snapshot);
		this.collectors.set(saved.collectorId, saved);
		return clone(saved);
	}

	async sealWindow(
		window: EventWindowV1,
		nextSnapshot: ReflectionCollectorSnapshotV1,
		expectedRevision: number,
	): Promise<SealWindowResult> {
		const existingWindow = this.windows.get(window.windowId);
		const existingJob = this.jobs.get(window.windowId);
		if (existingWindow && existingJob) {
			const currentSnapshot = this.collectors.get(nextSnapshot.collectorId);
			if (!currentSnapshot) throw new Error("Idempotent seal is missing collector state.");
			return {
				inserted: false,
				window: clone(existingWindow),
				snapshot: clone(currentSnapshot),
				job: clone(existingJob),
			};
		}

		const current = this.collectors.get(nextSnapshot.collectorId);
		if (current?.revision !== expectedRevision) throw new CollectorRevisionConflictError();

		const createdAtMs = window.endedAtMs;
		const job: ReflectionJobV1 = {
			schemaVersion: REFLECTION_JOB_SCHEMA_VERSION,
			windowId: window.windowId,
			state: "READY",
			attempt: 0,
			replayCount: 0,
			createdAtMs,
			firstAttemptAtMs: null,
			updatedAtMs: createdAtMs,
			nextAttemptAtMs: createdAtMs,
			leaseExpiresAtMs: null,
			lastFailure: null,
			reflection: null,
			terminalCursorReleasedAtMs: null,
		};
		const savedWindow = clone(window);
		const savedSnapshot = clone(nextSnapshot);
		const savedJob = clone(job);
		this.windows.set(window.windowId, savedWindow);
		this.jobs.set(window.windowId, savedJob);
		this.collectors.set(savedSnapshot.collectorId, savedSnapshot);
		return {
			inserted: true,
			window: clone(savedWindow),
			snapshot: clone(savedSnapshot),
			job: clone(savedJob),
		};
	}

	async getWindow(windowId: string): Promise<EventWindowV1 | null> {
		return clone(this.windows.get(windowId) ?? null);
	}

	async getJob(windowId: string): Promise<ReflectionJobV1 | null> {
		return clone(this.jobs.get(windowId) ?? null);
	}

	async getQueueStats(): Promise<ReflectionQueueStats> {
		let pendingJobs = 0;
		let pendingEvents = 0;
		for (const job of this.jobs.values()) {
			if (job.state === "COMMITTED" || job.state === "TERMINAL_FAILED") continue;
			pendingJobs += 1;
			pendingEvents += this.windows.get(job.windowId)?.eventCount ?? 0;
		}
		return { pendingJobs, pendingEvents };
	}

	async claimNextRunnable(
		nowMs: number,
		leaseDurationMs: number,
	): Promise<ReflectionJobV1 | null> {
		const candidate = Array.from(this.jobs.values())
			.filter((job) => isRunnable(job, nowMs))
			.sort(
				(left, right) =>
					(left.nextAttemptAtMs ?? left.createdAtMs) -
						(right.nextAttemptAtMs ?? right.createdAtMs) ||
					left.createdAtMs - right.createdAtMs ||
					left.windowId.localeCompare(right.windowId),
			)[0];
		if (!candidate) return null;

		const nextState = candidate.reflection ? "COMMITTING" : "RUNNING";
		const claimed: ReflectionJobV1 = {
			...candidate,
			state: nextState,
			attempt: candidate.attempt + 1,
			firstAttemptAtMs: candidate.firstAttemptAtMs ?? nowMs,
			updatedAtMs: nowMs,
			nextAttemptAtMs: null,
			leaseExpiresAtMs: nowMs + leaseDurationMs,
		};
		this.jobs.set(candidate.windowId, claimed);
		return clone(claimed);
	}

	async persistResult(
		windowId: string,
		reflection: ReflectionV1,
		nowMs: number,
	): Promise<ReflectionJobV1> {
		const current = this.requireJob(windowId);
		if (current.reflection) {
			if (current.reflection.windowId !== reflection.windowId) {
				throw new Error("A different reflection is already persisted for this window.");
			}
			return clone(current);
		}
		if (current.state !== "RUNNING") {
			throw new InvalidReflectionJobTransitionError(current.state, "persist result for");
		}
		if (reflection.windowId !== windowId) {
			throw new Error("Reflection result does not match its window.");
		}
		const next: ReflectionJobV1 = {
			...current,
			state: "RESULT_PERSISTED",
			reflection: clone(reflection),
			updatedAtMs: nowMs,
			leaseExpiresAtMs: null,
		};
		this.jobs.set(windowId, next);
		return clone(next);
	}

	async beginCommit(
		windowId: string,
		nowMs: number,
		leaseDurationMs: number,
	): Promise<ReflectionJobV1> {
		const current = this.requireJob(windowId);
		if (current.state === "COMMITTING" && current.leaseExpiresAtMs !== null) {
			return clone(current);
		}
		if (current.state !== "RESULT_PERSISTED") {
			throw new InvalidReflectionJobTransitionError(current.state, "begin commit for");
		}
		const next: ReflectionJobV1 = {
			...current,
			state: "COMMITTING",
			updatedAtMs: nowMs,
			leaseExpiresAtMs: nowMs + leaseDurationMs,
		};
		this.jobs.set(windowId, next);
		return clone(next);
	}

	async recordFailure(
		windowId: string,
		failure: ReflectionJobFailureV1,
		nextAttemptAtMs: number | null,
		terminal: boolean,
	): Promise<ReflectionJobV1> {
		const current = this.requireJob(windowId);
		if (current.state !== "RUNNING" && current.state !== "COMMITTING") {
			throw new InvalidReflectionJobTransitionError(current.state, "record failure for");
		}
		const next: ReflectionJobV1 = {
			...current,
			state: terminal ? "TERMINAL_FAILED" : "RETRY_WAIT",
			updatedAtMs: failure.failedAtMs,
			nextAttemptAtMs: terminal ? null : nextAttemptAtMs,
			leaseExpiresAtMs: null,
			lastFailure: clone(failure),
			terminalCursorReleasedAtMs: terminal ? failure.failedAtMs : null,
		};
		this.jobs.set(windowId, next);
		return clone(next);
	}

	async markCommitted(windowId: string, nowMs: number): Promise<ReflectionJobV1> {
		const current = this.requireJob(windowId);
		if (current.state === "COMMITTED") return clone(current);
		if (current.state !== "COMMITTING") {
			throw new InvalidReflectionJobTransitionError(current.state, "commit");
		}
		const next: ReflectionJobV1 = {
			...current,
			state: "COMMITTED",
			updatedAtMs: nowMs,
			leaseExpiresAtMs: null,
			nextAttemptAtMs: null,
		};
		this.jobs.set(windowId, next);
		return clone(next);
	}

	async replayTerminal(windowId: string, nowMs: number): Promise<ReflectionJobV1> {
		const current = this.requireJob(windowId);
		if (current.state !== "TERMINAL_FAILED") {
			throw new InvalidReflectionJobTransitionError(current.state, "replay");
		}
		const next: ReflectionJobV1 = {
			...current,
			state: "READY",
			attempt: 0,
			replayCount: current.replayCount + 1,
			createdAtMs: nowMs,
			firstAttemptAtMs: null,
			updatedAtMs: nowMs,
			nextAttemptAtMs: nowMs,
			leaseExpiresAtMs: null,
			lastFailure: null,
			terminalCursorReleasedAtMs: null,
		};
		this.jobs.set(windowId, next);
		return clone(next);
	}

	private requireJob(windowId: string): ReflectionJobV1 {
		const job = this.jobs.get(windowId);
		if (!job) throw new Error(`Unknown reflection job: ${windowId}`);
		return job;
	}
}

function isRunnable(job: ReflectionJobV1, nowMs: number): boolean {
	switch (job.state) {
		case "READY":
			return (job.nextAttemptAtMs ?? job.createdAtMs) <= nowMs;
		case "RETRY_WAIT":
			return job.nextAttemptAtMs !== null && job.nextAttemptAtMs <= nowMs;
		case "RUNNING":
		case "COMMITTING":
			return job.leaseExpiresAtMs !== null && job.leaseExpiresAtMs <= nowMs;
		case "RESULT_PERSISTED":
			return true;
		case "COMMITTED":
		case "TERMINAL_FAILED":
			return false;
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
