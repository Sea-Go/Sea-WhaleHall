import type { DurableReflectionJobRepository } from "./repository";
import {
	REFLECTION_SCHEMA_VERSION,
	type EventWindowV1,
	type FeedbackCode,
	type ReflectionJobV1,
	type ReflectionJobFailureV1,
	type ReflectionQueueMode,
	type ReflectionQueueStats,
	type ReflectionV1,
	isCountedSemanticEvent,
} from "./types";

const ACTIVITY_LABELS = [
	"development",
	"writing",
	"research",
	"communication",
	"planning",
	"data_work",
	"media",
	"gaming",
	"system_file_ops",
	"commerce",
	"idle_transition",
	"other_unknown",
] as const;
const GOAL_RELEVANCE_LABELS = [
	"direct",
	"supporting",
	"unrelated",
	"uncertain",
] as const;

export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;
export const DEFAULT_TERMINAL_AFTER_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_JOB_LEASE_MS = 2 * 60 * 1000;
export const DEFAULT_DRAINING_JOB_THRESHOLD = 8;
export const DEFAULT_DRAINING_EVENT_THRESHOLD = 512;

export interface ReflectionJobClock {
	nowMs(): number;
}

export interface ReflectionInferenceProvider {
	infer(window: EventWindowV1, signal?: AbortSignal): Promise<ReflectionV1>;
}

export interface ReflectionCommitter {
	commit(window: EventWindowV1, reflection: ReflectionV1): Promise<void>;
}

export type ReflectionJobRunResult =
	| { status: "idle" }
	| { status: "committed"; windowId: string }
	| {
			status: "abandoned";
			windowId: string;
			phase: "inference" | "commit";
		}
	| {
			status: "retry_scheduled";
			windowId: string;
			nextAttemptAtMs: number;
			phase: "inference" | "commit";
		}
	| {
			status: "terminal_failed";
			windowId: string;
			phase: "inference" | "commit";
		};

export type ReflectionJobRunnerOptions = {
	repository: DurableReflectionJobRepository;
	inference: ReflectionInferenceProvider;
	committer: ReflectionCommitter;
	clock?: ReflectionJobClock;
	retryDelaysMs?: readonly number[];
	terminalAfterMs?: number;
	leaseDurationMs?: number;
	drainingJobThreshold?: number;
	drainingEventThreshold?: number;
	jitterMs?: (baseDelayMs: number, attempt: number) => number;
};

export class ReflectionJobRunner {
	private readonly repository: DurableReflectionJobRepository;
	private readonly inference: ReflectionInferenceProvider;
	private readonly committer: ReflectionCommitter;
	private readonly clock: ReflectionJobClock;
	private readonly retryDelaysMs: readonly number[];
	private readonly terminalAfterMs: number;
	private readonly leaseDurationMs: number;
	private readonly drainingJobThreshold: number;
	private readonly drainingEventThreshold: number;
	private readonly jitterMs: (baseDelayMs: number, attempt: number) => number;
	private running = false;

	constructor(options: ReflectionJobRunnerOptions) {
		this.repository = options.repository;
		this.inference = options.inference;
		this.committer = options.committer;
		this.clock = options.clock ?? { nowMs: () => Date.now() };
		this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
		this.terminalAfterMs = options.terminalAfterMs ?? DEFAULT_TERMINAL_AFTER_MS;
		this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_JOB_LEASE_MS;
		this.drainingJobThreshold =
			options.drainingJobThreshold ?? DEFAULT_DRAINING_JOB_THRESHOLD;
		this.drainingEventThreshold =
			options.drainingEventThreshold ?? DEFAULT_DRAINING_EVENT_THRESHOLD;
		this.jitterMs = options.jitterMs ?? defaultJitter;
		if (this.retryDelaysMs.length === 0 || this.retryDelaysMs.some((delay) => delay < 0)) {
			throw new Error("retryDelaysMs must contain non-negative delays.");
		}
	}

	async runOnce(signal?: AbortSignal): Promise<ReflectionJobRunResult> {
		if (this.running) throw new Error("ReflectionJobRunner only supports concurrency 1.");
		if (signal?.aborted) return { status: "idle" };
		this.running = true;
		try {
			const nowMs = this.clock.nowMs();
			let job = await this.repository.claimNextRunnable(nowMs, this.leaseDurationMs);
			if (!job) return { status: "idle" };
			const window = await this.repository.getWindow(job.windowId);
			if (!window) throw new Error(`Reflection job ${job.windowId} has no immutable window.`);

			let reflection = job.reflection;
			if (job.state === "RUNNING") {
				try {
					throwIfAborted(signal);
					reflection = await this.inference.infer(window, signal);
					throwIfAborted(signal);
					assertReflectionMatchesWindow(reflection, window);
				} catch (error) {
					if (signal?.aborted) {
						return this.abandonClaim(job, "inference");
					}
					return this.handleFailure(job, "inference", error);
				}
				job = await this.repository.persistResult(
					window.windowId,
					reflection,
					this.clock.nowMs(),
				);
				if (signal?.aborted) {
					return this.abandonClaim(job, "commit");
				}
				job = await this.repository.beginCommit(
					window.windowId,
					this.clock.nowMs(),
					this.leaseDurationMs,
				);
			}

			if (job.state !== "COMMITTING" || !reflection) {
				throw new Error(`Claimed reflection job ${job.windowId} cannot be committed.`);
			}
			if (signal?.aborted) {
				return this.abandonClaim(job, "commit");
			}
			try {
				await this.committer.commit(window, reflection);
				await this.repository.markCommitted(window.windowId, this.clock.nowMs());
				return { status: "committed", windowId: window.windowId };
			} catch (error) {
				if (signal?.aborted) {
					return this.abandonClaim(job, "commit");
				}
				return this.handleFailure(job, "commit", error);
			}
		} finally {
			this.running = false;
		}
	}

	async runUntilIdle(
		maxJobs = 100,
		signal?: AbortSignal,
	): Promise<ReflectionJobRunResult[]> {
		const results: ReflectionJobRunResult[] = [];
		for (let index = 0; index < maxJobs; index += 1) {
			if (signal?.aborted) break;
			const result = await this.runOnce(signal);
			results.push(result);
			if (result.status === "idle" || signal?.aborted) break;
		}
		return results;
	}

	async getQueuePressure(): Promise<{
		mode: ReflectionQueueMode;
		stats: ReflectionQueueStats;
		emitImmediateFeedback: boolean;
	}> {
		const stats = await this.repository.getQueueStats();
		const mode: ReflectionQueueMode =
			stats.pendingJobs >= this.drainingJobThreshold ||
			stats.pendingEvents >= this.drainingEventThreshold
				? "draining"
				: "accepting";
		return {
			mode,
			stats,
			emitImmediateFeedback: mode === "accepting",
		};
	}

	private async abandonClaim(
		job: ReflectionJobV1,
		phase: "inference" | "commit",
	): Promise<ReflectionJobRunResult> {
		await this.repository.abandonClaim(job.windowId, this.clock.nowMs());
		return { status: "abandoned", windowId: job.windowId, phase };
	}

	private async handleFailure(
		job: ReflectionJobV1,
		phase: "inference" | "commit",
		error: unknown,
	): Promise<ReflectionJobRunResult> {
		const failedAtMs = this.clock.nowMs();
		const failure: ReflectionJobFailureV1 = {
			code: failureCode(error),
			message: errorMessage(error),
			failedAtMs,
		};
		const firstAttemptAtMs = job.firstAttemptAtMs ?? failedAtMs;
		const terminal =
			isExplicitlyNonRetryable(error) ||
			failedAtMs - firstAttemptAtMs >= this.terminalAfterMs;
		if (terminal) {
			await this.repository.recordFailure(job.windowId, failure, null, true);
			return { status: "terminal_failed", windowId: job.windowId, phase };
		}

		const baseDelay =
			this.retryDelaysMs[Math.min(job.attempt - 1, this.retryDelaysMs.length - 1)];
		if (baseDelay === undefined) throw new Error("Retry delay configuration is empty.");
		const nextAttemptAtMs =
			failedAtMs + baseDelay + Math.max(0, this.jitterMs(baseDelay, job.attempt));
		await this.repository.recordFailure(
			job.windowId,
			failure,
			nextAttemptAtMs,
			false,
		);
		return {
			status: "retry_scheduled",
			windowId: job.windowId,
			nextAttemptAtMs,
			phase,
		};
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw new DOMException(
		"Reflection inference was cancelled during shutdown.",
		"AbortError",
	);
}

function isExplicitlyNonRetryable(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"retryable" in error &&
		error.retryable === false
	);
}

export function assertReflectionMatchesWindow(
	reflection: ReflectionV1,
	window: EventWindowV1,
): void {
	if (
		reflection.schemaVersion !== REFLECTION_SCHEMA_VERSION ||
		reflection.windowId !== window.windowId ||
		reflection.triggerReason !== window.triggerReason ||
		reflection.eventCount !== window.eventCount ||
		reflection.durationMs !== window.endedAtMs - window.startedAtMs ||
		reflection.goalVersion !== window.goalVersion
	) {
		throw new Error("Reflection output does not match its immutable event window.");
	}
	if ((window.goalVersion === null) !== (reflection.goalRelevance === null)) {
		throw new Error("Goal relevance must be null exactly when the window has no goal.");
	}
	assertDistribution(
		reflection.activity.probabilities,
		ACTIVITY_LABELS,
		reflection.activity.label,
		"activity",
	);
	if (reflection.goalRelevance) {
		assertDistribution(
			reflection.goalRelevance.probabilities,
			GOAL_RELEVANCE_LABELS,
			reflection.goalRelevance.label,
			"goalRelevance",
		);
	}
	if (
		!isUnitInterval(reflection.confidence) ||
		!isUnitInterval(reflection.entropy)
	) {
		throw new Error("Reflection confidence and entropy must be between zero and one.");
	}
	if (
		reflection.embedding.length !== 256 ||
		reflection.embedding.some((value) => !Number.isFinite(value))
	) {
		throw new Error("Reflection embedding must contain 256 finite values.");
	}
	const embeddingNorm = Math.hypot(...reflection.embedding);
	if (embeddingNorm === 0 || Math.abs(embeddingNorm - 1) > 0.01) {
		throw new Error("Reflection embedding must be L2-normalized.");
	}
	if (
		(window.goal === null || reflection.abstain) &&
		reflection.feedbackCode !== "silent"
	) {
		throw new Error("No-goal and abstained reflections must remain silent.");
	}
	if (!isFeedbackCode(reflection.feedbackCode)) {
		throw new Error("Reflection feedbackCode is outside the fixed taxonomy.");
	}
	if (reflection.feedbackCode !== expectedFeedbackCode(reflection)) {
		throw new Error(
			"Reflection feedbackCode does not match the fixed activity/relevance policy.",
		);
	}
	if (
		typeof reflection.modelVersion !== "string" ||
		reflection.modelVersion.length === 0 ||
		typeof reflection.taxonomyVersion !== "string" ||
		reflection.taxonomyVersion.length === 0
	) {
		throw new Error("Reflection model and taxonomy versions are required.");
	}
	const eventIds = new Set(
		window.events.filter(isCountedSemanticEvent).map((event) => event.eventId),
	);
	if (
		reflection.evidenceEventIds.length === 0 ||
		new Set(reflection.evidenceEventIds).size !==
			reflection.evidenceEventIds.length ||
		reflection.evidenceEventIds.some((eventId) => !eventIds.has(eventId))
	) {
		throw new Error("Reflection evidence may only reference primary window events.");
	}
}

function expectedFeedbackCode(reflection: ReflectionV1): FeedbackCode {
	if (reflection.goalRelevance === null || reflection.abstain) return "silent";
	if (reflection.activity.label === "idle_transition") return "takeBreak";
	switch (reflection.goalRelevance.label) {
		case "direct":
		case "supporting":
			return "encourage";
		case "unrelated":
			return "refocus";
		case "uncertain":
			return "clarifyGoal";
	}
}

function assertDistribution<L extends string>(
	value: Partial<Record<L, number>>,
	labels: readonly L[],
	selected: L,
	field: string,
): void {
	const keys = Object.keys(value);
	if (
		keys.length !== labels.length ||
		!labels.every((label) => Object.hasOwn(value, label))
	) {
		throw new Error(`Reflection ${field} probabilities must contain the full taxonomy.`);
	}
	let sum = 0;
	let maximum = -1;
	for (const label of labels) {
		const probability = value[label];
		if (!isUnitInterval(probability)) {
			throw new Error(`Reflection ${field} contains an invalid probability.`);
		}
		sum += probability;
		maximum = Math.max(maximum, probability);
	}
	if (Math.abs(sum - 1) > 0.0001) {
		throw new Error(`Reflection ${field} probabilities must sum to one.`);
	}
	if (!Object.hasOwn(value, selected) || Math.abs((value[selected] ?? -1) - maximum) > 1e-12) {
		throw new Error(`Reflection ${field} label must select a maximum probability.`);
	}
}

function isUnitInterval(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

function isFeedbackCode(value: unknown): value is FeedbackCode {
	return (
		value === "silent" ||
		value === "encourage" ||
		value === "refocus" ||
		value === "clarifyGoal" ||
		value === "takeBreak"
	);
}

function defaultJitter(baseDelayMs: number): number {
	const maximum = Math.min(1_000, Math.floor(baseDelayMs * 0.2));
	return Math.floor(Math.random() * (maximum + 1));
}

function failureCode(error: unknown): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return error.code.slice(0, 128);
	}
	return error instanceof Error ? error.name : "UNKNOWN";
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}
