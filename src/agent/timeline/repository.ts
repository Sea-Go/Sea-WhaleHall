import {
	TIMELINE_JOB_SCHEMA_VERSION,
	type ActivityEpisodeV2,
	type AgentInputEnvelopeV1,
	type AgentInputV1,
	type EvidenceFactV2,
	type TimelineCollectorSnapshotV2,
	type TimelineJobV2,
	type TimelineSummaryV2,
	type TimelineWindowV2,
} from "./types";

export const TIMELINE_RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type CommittedTimelineWindowListOptions = {
	/** Inclusive product scope bound; null means every still-open raw window. */
	endedAtOrAfterMs: number | null;
	/** Availability is evaluated at this immutable operation timestamp. */
	availableAtMs: number;
	order: "oldest_first" | "newest_first";
	limit: number;
};

export class TimelineCollectorRevisionConflictError extends Error {
	constructor() {
		super("Timeline collector state changed concurrently.");
		this.name = "TimelineCollectorRevisionConflictError";
	}
}

export type TimelineSealResult = {
	inserted: boolean;
	window: TimelineWindowV2;
	snapshot: TimelineCollectorSnapshotV2;
	job: TimelineJobV2;
};

export type PersistTimelineResult = {
	windowId: string;
	facts: EvidenceFactV2[];
	episodes: ActivityEpisodeV2[];
	summary: TimelineSummaryV2;
	agentInput: AgentInputV1;
};

export type AgentInputQuery = {
	limit?: number;
	nowMs: number;
	leaseDurationMs?: number;
	includeHeldLocal?: boolean;
};

export type AgentInputQueryResult = {
	inputs: AgentInputEnvelopeV1[];
};

export type TimelineAuditRangeResult = {
	windows: TimelineWindowV2[];
	facts: EvidenceFactV2[];
	episodes: ActivityEpisodeV2[];
	summaries: TimelineSummaryV2[];
};

export type TimelineCursorAuthority =
	| {
			state: "committed";
			windowId: string;
		}
	| {
			state: "pending";
			windowId: string | null;
		}
	| {
			state: "terminal_failed";
			windowId: string;
			failureCode: string | null;
		}
	| {
			state: "inconsistent";
			windowId: string;
		};

export interface TimelineV2Repository {
	loadCollector(
		collectorId: string,
	): Promise<TimelineCollectorSnapshotV2 | null>;
	saveCollector(
		snapshot: TimelineCollectorSnapshotV2,
		expectedRevision: number | null,
	): Promise<TimelineCollectorSnapshotV2>;
	sealWindow(
		window: TimelineWindowV2,
		nextSnapshot: TimelineCollectorSnapshotV2,
		expectedRevision: number,
	): Promise<TimelineSealResult>;
	getWindow(windowId: string): Promise<TimelineWindowV2 | null>;
	getJob(windowId: string): Promise<TimelineJobV2 | null>;
	listCommittedWindowIds(
		options: CommittedTimelineWindowListOptions,
	): Promise<string[]>;
	claimNextWindow(
		nowMs: number,
		leaseDurationMs: number,
	): Promise<TimelineJobV2 | null>;
	abandonWindowClaim(
		windowId: string,
		nowMs: number,
	): Promise<TimelineJobV2>;
	completeWindow(
		result: PersistTimelineResult,
		nowMs: number,
	): Promise<TimelineJobV2>;
	finalizeWindowCommit(
		windowId: string,
		nowMs: number,
	): Promise<TimelineJobV2>;
	recordWindowFailure(
		windowId: string,
		options: {
			nowMs: number;
			code: string;
			message: string;
			nextAttemptAtMs: number | null;
			terminal: boolean;
		},
	): Promise<TimelineJobV2>;
	findLatestEpisode(
		deviceId: string,
		sessionId: string,
		beforeOrAtMs: number,
	): Promise<ActivityEpisodeV2 | null>;
	getTimelineResult(windowId: string): Promise<PersistTimelineResult | null>;
	releaseAgentInputs(
		agentInputIds: readonly string[] | null,
		nowMs: number,
	): Promise<number>;
	queryAgentInputs(query: AgentInputQuery): Promise<AgentInputQueryResult>;
	commitAgentInput(
		agentInputId: string,
		leaseToken: string,
		nowMs: number,
	): Promise<AgentInputEnvelopeV1>;
	readCursorAuthority(cursor: string): Promise<TimelineCursorAuthority>;
	readAuditRange(fromMs: number, toMs: number): Promise<TimelineAuditRangeResult>;
}

export class InMemoryTimelineV2Repository implements TimelineV2Repository {
	private readonly collectors = new Map<string, TimelineCollectorSnapshotV2>();
	private readonly windows = new Map<string, TimelineWindowV2>();
	private readonly jobs = new Map<string, TimelineJobV2>();
	private readonly results = new Map<string, PersistTimelineResult>();
	private readonly outbox = new Map<string, AgentInputEnvelopeV1>();
	private readonly ackedLeaseTokenHashes = new Map<string, string>();

	async loadCollector(
		collectorId: string,
	): Promise<TimelineCollectorSnapshotV2 | null> {
		return clone(this.collectors.get(collectorId) ?? null);
	}

	async saveCollector(
		snapshot: TimelineCollectorSnapshotV2,
		expectedRevision: number | null,
	): Promise<TimelineCollectorSnapshotV2> {
		const current = this.collectors.get(snapshot.collectorId);
		assertExpectedRevision(current?.revision ?? null, expectedRevision);
		assertNextRevision(snapshot.revision, expectedRevision);
		const saved = clone(snapshot);
		this.collectors.set(snapshot.collectorId, saved);
		return clone(saved);
	}

	async sealWindow(
		window: TimelineWindowV2,
		nextSnapshot: TimelineCollectorSnapshotV2,
		expectedRevision: number,
	): Promise<TimelineSealResult> {
		const existingWindow = this.windows.get(window.windowId);
		const existingJob = this.jobs.get(window.windowId);
		if (existingWindow || existingJob) {
			if (
				!existingWindow ||
				!existingJob ||
				existingWindow.inputHash !== window.inputHash
			) {
				throw new Error(`Timeline window collision for ${window.windowId}.`);
			}
			const snapshot = this.collectors.get(nextSnapshot.collectorId);
			if (!snapshot) throw new Error("Idempotent seal lost its collector.");
			return {
				inserted: false,
				window: clone(existingWindow),
				snapshot: clone(snapshot),
				job: clone(existingJob),
			};
		}
		const current = this.collectors.get(nextSnapshot.collectorId);
		assertExpectedRevision(current?.revision ?? null, expectedRevision);
		assertNextRevision(nextSnapshot.revision, expectedRevision);
		const job = newTimelineJob(window);
		this.windows.set(window.windowId, clone(window));
		this.jobs.set(window.windowId, clone(job));
		this.collectors.set(nextSnapshot.collectorId, clone(nextSnapshot));
		return {
			inserted: true,
			window: clone(window),
			snapshot: clone(nextSnapshot),
			job: clone(job),
		};
	}

	async getWindow(windowId: string): Promise<TimelineWindowV2 | null> {
		return clone(this.windows.get(windowId) ?? null);
	}

	async getJob(windowId: string): Promise<TimelineJobV2 | null> {
		return clone(this.jobs.get(windowId) ?? null);
	}

	async listCommittedWindowIds(
		options: CommittedTimelineWindowListOptions,
	): Promise<string[]> {
		assertCommittedWindowListOptions(options);
		const rawCutoffMs =
			options.availableAtMs - TIMELINE_RAW_RETENTION_MS;
		return [...this.windows.values()]
			.filter((window) => {
				const job = this.jobs.get(window.windowId);
				return (
					job?.state === "COMMITTED" &&
					window.endedAtMs > rawCutoffMs &&
					(options.endedAtOrAfterMs === null ||
						window.endedAtMs >= options.endedAtOrAfterMs)
				);
			})
			.sort((left, right) => {
				const oldestFirst =
					left.endedAtMs - right.endedAtMs ||
					compareOpaqueIds(left.windowId, right.windowId);
				return options.order === "oldest_first" ? oldestFirst : -oldestFirst;
			})
			.slice(0, options.limit)
			.map((window) => window.windowId);
	}

	async claimNextWindow(
		nowMs: number,
		leaseDurationMs: number,
	): Promise<TimelineJobV2 | null> {
		assertPositiveDuration(leaseDurationMs, "leaseDurationMs");
		const candidate = [...this.jobs.values()]
			.filter((job) => isRunnable(job, nowMs))
			.sort(
				(left, right) =>
					(left.nextAttemptAtMs ?? left.createdAtMs) -
						(right.nextAttemptAtMs ?? right.createdAtMs) ||
					left.createdAtMs - right.createdAtMs ||
					left.windowId.localeCompare(right.windowId),
			)[0];
		if (!candidate) return null;
		if (
			candidate.state === "RESULT_PERSISTED" ||
			candidate.state === "COMMITTING"
		) {
			return clone(candidate);
		}
		const claimed: TimelineJobV2 = {
			...candidate,
			state: "RUNNING",
			attempt: candidate.attempt + 1,
			firstAttemptAtMs: candidate.firstAttemptAtMs ?? nowMs,
			updatedAtMs: nowMs,
			nextAttemptAtMs: null,
			leaseExpiresAtMs: nowMs + leaseDurationMs,
		};
		this.jobs.set(candidate.windowId, claimed);
		return clone(claimed);
	}

	async abandonWindowClaim(
		windowId: string,
		nowMs: number,
	): Promise<TimelineJobV2> {
		const current = this.requireJob(windowId);
		if (current.state !== "RUNNING") {
			throw new Error(
				`Cannot abandon timeline claim ${windowId} from ${current.state}.`,
			);
		}
		const attempt = Math.max(0, current.attempt - 1);
		const abandoned: TimelineJobV2 = {
			...current,
			state: "READY",
			attempt,
			firstAttemptAtMs: attempt === 0 ? null : current.firstAttemptAtMs,
			updatedAtMs: nowMs,
			nextAttemptAtMs: nowMs,
			leaseExpiresAtMs: null,
		};
		this.jobs.set(windowId, abandoned);
		return clone(abandoned);
	}

	async completeWindow(
		result: PersistTimelineResult,
		nowMs: number,
	): Promise<TimelineJobV2> {
		const current = this.requireJob(result.windowId);
		const existing = this.results.get(result.windowId);
		if (existing) {
			if (
				existing.summary.timelineId !== result.summary.timelineId ||
				existing.agentInput.payloadHash !== result.agentInput.payloadHash
			) {
				throw new Error(
					`A different timeline result already exists for ${result.windowId}.`,
				);
			}
			return this.finalizeWindowCommit(result.windowId, nowMs);
		}
		if (current.state !== "RUNNING") {
			throw new Error(
				`Cannot complete timeline job ${result.windowId} from ${current.state}.`,
			);
		}
		if (
			result.summary.windowId !== result.windowId ||
			result.agentInput.windowId !== result.windowId
		) {
			throw new Error("Timeline result does not match its window.");
		}
		if (this.outbox.has(result.agentInput.agentInputId)) {
			throw new Error(
				`Agent input id collision: ${result.agentInput.agentInputId}.`,
			);
		}
		this.results.set(result.windowId, clone(result));
		this.outbox.set(result.agentInput.agentInputId, {
			input: clone(result.agentInput),
			state: "HELD_LOCAL",
			leaseToken: null,
			leaseExpiresAtMs: null,
			attempt: 0,
			ackedAtMs: null,
		});
		const resultPersisted: TimelineJobV2 = {
			...current,
			state: "RESULT_PERSISTED",
			updatedAtMs: nowMs,
			nextAttemptAtMs: null,
			leaseExpiresAtMs: null,
			failureCode: null,
			failureMessage: null,
		};
		this.jobs.set(result.windowId, resultPersisted);
		return this.finalizeWindowCommit(result.windowId, nowMs);
	}

	async finalizeWindowCommit(
		windowId: string,
		nowMs: number,
	): Promise<TimelineJobV2> {
		const current = this.requireJob(windowId);
		if (current.state === "COMMITTED") return clone(current);
		if (
			current.state !== "RESULT_PERSISTED" &&
			current.state !== "COMMITTING"
		) {
			throw new Error(
				`Cannot finalize timeline job ${windowId} from ${current.state}.`,
			);
		}
		const committing: TimelineJobV2 = {
			...current,
			state: "COMMITTING",
			updatedAtMs: nowMs,
			nextAttemptAtMs: null,
			leaseExpiresAtMs: null,
		};
		this.jobs.set(windowId, committing);
		const committed: TimelineJobV2 = {
			...committing,
			state: "COMMITTED",
			failureCode: null,
			failureMessage: null,
		};
		this.jobs.set(windowId, committed);
		return clone(committed);
	}

	async recordWindowFailure(
		windowId: string,
		options: {
			nowMs: number;
			code: string;
			message: string;
			nextAttemptAtMs: number | null;
			terminal: boolean;
		},
	): Promise<TimelineJobV2> {
		const current = this.requireJob(windowId);
		if (current.state !== "RUNNING") {
			throw new Error(
				`Cannot record timeline failure ${windowId} from ${current.state}.`,
			);
		}
		const failed: TimelineJobV2 = {
			...current,
			state: options.terminal ? "TERMINAL_FAILED" : "RETRY_WAIT",
			updatedAtMs: options.nowMs,
			nextAttemptAtMs: options.terminal ? null : options.nextAttemptAtMs,
			leaseExpiresAtMs: null,
			failureCode: boundedFailureText(options.code, 128),
			failureMessage: boundedFailureText(options.message, 512),
		};
		this.jobs.set(windowId, failed);
		return clone(failed);
	}

	async findLatestEpisode(
		deviceId: string,
		sessionId: string,
		beforeOrAtMs: number,
	): Promise<ActivityEpisodeV2 | null> {
		const candidates = [...this.results.values()]
			.flatMap((result) => result.episodes)
			.filter((episode) => {
				const window = this.windows.get(episode.sourceWindowIds.at(-1) ?? "");
				return (
					window?.deviceId === deviceId &&
					window.sessionId === sessionId &&
					episode.endedAtMs <= beforeOrAtMs
				);
			})
			.sort(
				(left, right) =>
					right.endedAtMs - left.endedAtMs ||
					right.revision - left.revision ||
					right.revisionId.localeCompare(left.revisionId),
			);
		return clone(candidates[0] ?? null);
	}

	async getTimelineResult(
		windowId: string,
	): Promise<PersistTimelineResult | null> {
		return clone(this.results.get(windowId) ?? null);
	}

	async releaseAgentInputs(
		agentInputIds: readonly string[] | null,
		_nowMs: number,
	): Promise<number> {
		const selected = agentInputIds ? new Set(agentInputIds) : null;
		let changed = 0;
		for (const [id, envelope] of this.outbox) {
			if (
				envelope.state !== "HELD_LOCAL" ||
				(selected !== null && !selected.has(id))
			) {
				continue;
			}
			this.outbox.set(id, { ...envelope, state: "READY" });
			changed += 1;
		}
		return changed;
	}

	async queryAgentInputs(query: AgentInputQuery): Promise<AgentInputQueryResult> {
		const limit = boundedLimit(query.limit ?? 32, 1, 100);
		const leaseDurationMs = query.leaseDurationMs ?? 30_000;
		assertPositiveDuration(leaseDurationMs, "leaseDurationMs");
		const candidates = [...this.outbox.values()]
			.filter(
				(envelope) =>
					envelope.state === "READY" ||
					(envelope.state === "LEASED" &&
						envelope.leaseExpiresAtMs !== null &&
						envelope.leaseExpiresAtMs <= query.nowMs) ||
					(query.includeHeldLocal === true &&
						envelope.state === "HELD_LOCAL"),
			)
			.sort(
				(left, right) =>
					left.input.createdAtMs - right.input.createdAtMs ||
					left.input.agentInputId.localeCompare(right.input.agentInputId),
			)
			.slice(0, limit);
		const result: AgentInputEnvelopeV1[] = [];
		for (const candidate of candidates) {
			if (candidate.state === "HELD_LOCAL") {
				result.push(clone(candidate));
				continue;
			}
			const leased: AgentInputEnvelopeV1 = {
				...candidate,
				state: "LEASED",
				leaseToken: crypto.randomUUID(),
				leaseExpiresAtMs: query.nowMs + leaseDurationMs,
				attempt: candidate.attempt + 1,
			};
			this.outbox.set(candidate.input.agentInputId, leased);
			result.push(clone(leased));
		}
		return { inputs: result };
	}

	async commitAgentInput(
		agentInputId: string,
		leaseToken: string,
		nowMs: number,
	): Promise<AgentInputEnvelopeV1> {
		const current = this.outbox.get(agentInputId);
		if (!current) throw new Error(`Unknown AgentInput: ${agentInputId}.`);
		const leaseTokenHash = await opaqueLeaseTokenHash(leaseToken);
		if (current.state === "ACKED") {
			if (
				this.ackedLeaseTokenHashes.get(agentInputId) !== leaseTokenHash
			) {
				throw new Error("AgentInput ACK lease token does not match.");
			}
			return clone(current);
		}
		if (
			current.state !== "LEASED" ||
			current.leaseToken !== leaseToken ||
			current.leaseExpiresAtMs === null ||
			current.leaseExpiresAtMs < nowMs
		) {
			throw new Error("AgentInput lease is missing, expired, or does not match.");
		}
		const acked: AgentInputEnvelopeV1 = {
			...current,
			state: "ACKED",
			leaseToken: null,
			leaseExpiresAtMs: null,
			ackedAtMs: nowMs,
		};
		this.outbox.set(agentInputId, acked);
		this.ackedLeaseTokenHashes.set(agentInputId, leaseTokenHash);
		return clone(acked);
	}

	async readCursorAuthority(cursor: string): Promise<TimelineCursorAuthority> {
		const window = [...this.windows.values()].find((candidate) =>
			candidate.events.some((event) => event.cursor === cursor),
		);
		if (!window) return { state: "pending", windowId: null };
		const job = this.jobs.get(window.windowId);
		if (!job) {
			return { state: "inconsistent", windowId: window.windowId };
		}
		if (job.state === "TERMINAL_FAILED") {
			return {
				state: "terminal_failed",
				windowId: window.windowId,
				failureCode: job.failureCode,
			};
		}
		if (job.state !== "COMMITTED") {
			return { state: "pending", windowId: window.windowId };
		}
		if (!this.results.has(window.windowId)) {
			return { state: "inconsistent", windowId: window.windowId };
		}
		return { state: "committed", windowId: window.windowId };
	}

	async readAuditRange(
		fromMs: number,
		toMs: number,
	): Promise<TimelineAuditRangeResult> {
		const windows = [...this.windows.values()].filter(
			(window) => window.endedAtMs >= fromMs && window.startedAtMs < toMs,
		);
		const windowIds = new Set(windows.map((window) => window.windowId));
		const results = [...this.results.values()].filter((result) =>
			windowIds.has(result.windowId),
		);
		return clone({
			windows,
			facts: results.flatMap((result) => result.facts),
			episodes: results.flatMap((result) => result.episodes),
			summaries: results.map((result) => result.summary),
		});
	}

	private requireJob(windowId: string): TimelineJobV2 {
		const job = this.jobs.get(windowId);
		if (!job) throw new Error(`Unknown timeline job: ${windowId}.`);
		return job;
	}
}

function newTimelineJob(window: TimelineWindowV2): TimelineJobV2 {
	return {
		schemaVersion: TIMELINE_JOB_SCHEMA_VERSION,
		windowId: window.windowId,
		state: "READY",
		attempt: 0,
		createdAtMs: window.endedAtMs,
		updatedAtMs: window.endedAtMs,
		nextAttemptAtMs: window.endedAtMs,
		leaseExpiresAtMs: null,
		firstAttemptAtMs: null,
		failureCode: null,
		failureMessage: null,
	};
}

function isRunnable(job: TimelineJobV2, nowMs: number): boolean {
	switch (job.state) {
		case "READY":
		case "RETRY_WAIT":
			return (job.nextAttemptAtMs ?? job.createdAtMs) <= nowMs;
		case "RUNNING":
			return job.leaseExpiresAtMs !== null && job.leaseExpiresAtMs <= nowMs;
		case "RESULT_PERSISTED":
		case "COMMITTING":
			return true;
		case "COMMITTED":
		case "TERMINAL_FAILED":
			return false;
	}
}

function assertExpectedRevision(
	actual: number | null,
	expected: number | null,
): void {
	if (actual !== expected) throw new TimelineCollectorRevisionConflictError();
}

function assertNextRevision(next: number, expected: number | null): void {
	const required = expected === null ? 0 : expected + 1;
	if (next !== required) {
		throw new Error(
			`Timeline collector revision must advance to ${required}; received ${next}.`,
		);
	}
}

function boundedLimit(value: number, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
	}
	return value;
}

function assertCommittedWindowListOptions(
	options: CommittedTimelineWindowListOptions,
): void {
	if (
		options.endedAtOrAfterMs !== null &&
		(!Number.isSafeInteger(options.endedAtOrAfterMs) ||
			options.endedAtOrAfterMs < 0)
	) {
		throw new Error("endedAtOrAfterMs must be null or a non-negative safe integer.");
	}
	if (!Number.isSafeInteger(options.availableAtMs) || options.availableAtMs < 0) {
		throw new Error("availableAtMs must be a non-negative safe integer.");
	}
	if (options.order !== "oldest_first" && options.order !== "newest_first") {
		throw new Error("order must be oldest_first or newest_first.");
	}
	boundedLimit(options.limit, 1, 10_001);
}

function compareOpaqueIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function assertPositiveDuration(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${field} must be a positive safe integer.`);
	}
}

function boundedFailureText(value: string, maximum: number): string {
	const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, maximum);
	return normalized || "unknown";
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

async function opaqueLeaseTokenHash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
