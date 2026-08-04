import { randomUUID } from "node:crypto";
import type {
	ActivityAnalysisJob,
	ActivityWindowDeliveryStore,
} from "../agent/activity-window-worker";
import type { AgentRunCoordinator } from "./agent-run-coordinator";
import type { DesktopAuthSessionManager } from "./auth-session";

const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;

export interface ActivityAnalysisDispatcherOptions {
	store: ActivityWindowDeliveryStore;
	scoreThreshold: number;
	auth: DesktopAuthSessionManager;
	coordinator: Pick<AgentRunCoordinator, "startActivityAnalysis">;
	retryDelaysMs?: readonly number[];
	nowMs?: () => number;
	onError?: (error: unknown) => void;
}

/**
 * A local, serial dispatcher for the durable Worker-result ledger. It never
 * receives a raw activity window, never installs a Tool, and deliberately has
 * no renderer-facing API. A claimed job is bound to the exact login account;
 * another account can neither see nor replay it.
 */
export class ActivityAnalysisDispatcher {
	private readonly store: ActivityWindowDeliveryStore;
	private readonly scoreThreshold: number;
	private readonly auth: DesktopAuthSessionManager;
	private readonly coordinator: Pick<
		AgentRunCoordinator,
		"startActivityAnalysis"
	>;
	private readonly retryDelaysMs: readonly number[];
	private readonly nowMs: () => number;
	private readonly onError: (error: unknown) => void;
	private readonly attemptsByRunId = new Map<string, number>();
	private started = false;
	private drainScheduled = false;
	private wakePending = false;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private retryAtMs: number | null = null;
	private tail: Promise<void> = Promise.resolve();

	constructor(options: ActivityAnalysisDispatcherOptions) {
		this.store = options.store;
		this.scoreThreshold = options.scoreThreshold;
		this.auth = options.auth;
		this.coordinator = options.coordinator;
		this.retryDelaysMs = validateRetryDelays(
			options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
		);
		this.nowMs = options.nowMs ?? Date.now;
		this.onError = options.onError ?? (() => {});
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.store.recoverActivityAnalysisJobs(this.scoreThreshold, this.nowMs());
		this.wake();
	}

	async stop(): Promise<void> {
		this.started = false;
		this.wakePending = false;
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		this.retryAtMs = null;
		await this.tail;
	}

	/** Safe to call after login, receipt acceptance, or a retry timer. */
	wake(): void {
		if (!this.started) return;
		this.wakePending = true;
		this.scheduleDrain();
	}

	private scheduleDrain(): void {
		if (!this.started || !this.wakePending || this.drainScheduled) return;
		this.wakePending = false;
		this.drainScheduled = true;
		void this.enqueue(async () => {
			try {
				await this.drain();
			} finally {
				this.drainScheduled = false;
				this.scheduleDrain();
			}
		}).catch((error) => this.report(error));
	}

	async onActivityRunTerminal(input: {
		jobId: string;
		runId: string;
		accountId: string;
		status: "completed" | "failed" | "cancelled" | "interrupted";
		failure: unknown;
	}): Promise<void> {
		const attempt = this.attemptsByRunId.get(input.runId) ?? 0;
		this.attemptsByRunId.delete(input.runId);
		try {
			if (input.status === "completed") {
				this.store.completeActivityAnalysisJob(
					input.jobId,
					input.accountId,
					input.runId,
					this.scoreThreshold,
					this.nowMs(),
				);
			} else {
				const now = this.nowMs();
				this.store.deferActivityAnalysisJob(
					input.jobId,
					input.accountId,
					input.runId,
					now + this.delayForAttempt(attempt),
					terminalErrorCode(input.status),
					now,
				);
			}
		} catch (error) {
			this.report(error);
		}
		this.wake();
	}

	private async drain(): Promise<void> {
		if (!this.started) return;
		const identity = this.auth.captureCurrentSession();
		if (!identity) return;
		const next = this.store.nextActivityAnalysisJob(
			this.scoreThreshold,
			identity.accountId,
			this.nowMs(),
		);
		if (next.kind === "none" || next.kind === "account_mismatch") return;
		if (next.kind === "not_due") {
			this.armRetry(next.nextAttemptAtMs);
			return;
		}
		await this.startClaimedJob(next.job, identity.accountId);
	}

	private async startClaimedJob(
		job: ActivityAnalysisJob,
		accountId: string,
	): Promise<void> {
		const attemptNumber = job.attempt + 1;
		const runId = `activity-run-${job.jobId}-${attemptNumber}-${randomUUID()}`;
		const requestId = `activity-request-${job.jobId}-${attemptNumber}`;
		const claimed = this.store.claimActivityAnalysisJob(
			job.jobId,
			accountId,
			runId,
			this.nowMs(),
		);
		this.attemptsByRunId.set(runId, claimed.attempt);
		try {
			await this.coordinator.startActivityAnalysis({
				jobId: claimed.jobId,
				runId,
				requestId,
				analyses: claimed.analyses,
				consumedScore: claimed.consumedScore,
			});
		} catch (error) {
			this.attemptsByRunId.delete(runId);
			try {
				const now = this.nowMs();
				this.store.deferActivityAnalysisJob(
					claimed.jobId,
					accountId,
					runId,
					now + this.delayForAttempt(claimed.attempt),
					"start_failed",
					now,
				);
			} catch (deferError) {
				this.report(deferError);
			}
			this.report(error);
			this.wake();
		}
	}

	private armRetry(nextAttemptAtMs: number): void {
		if (!this.started) return;
		if (
			this.retryTimer !== null &&
			this.retryAtMs !== null &&
			this.retryAtMs <= nextAttemptAtMs
		) {
			return;
		}
		if (this.retryTimer !== null) clearTimeout(this.retryTimer);
		const delay = Math.max(0, nextAttemptAtMs - this.nowMs());
		this.retryAtMs = nextAttemptAtMs;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.retryAtMs = null;
			this.wake();
		}, delay);
	}

	private delayForAttempt(attempt: number): number {
		return (
			this.retryDelaysMs[
				Math.min(Math.max(0, attempt), this.retryDelaysMs.length - 1)
			] ?? 600_000
		);
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private report(error: unknown): void {
		try {
			this.onError(error);
		} catch {
			// An observability hook cannot make the durable local job disappear.
		}
	}
}

function validateRetryDelays(delays: readonly number[]): readonly number[] {
	if (
		delays.length === 0 ||
		delays.some((delay) => !Number.isSafeInteger(delay) || delay <= 0)
	) {
		throw new Error(
			"Activity analysis retry delays must be positive integers.",
		);
	}
	return [...delays];
}

function terminalErrorCode(
	status: "failed" | "cancelled" | "interrupted",
): string {
	return status === "failed"
		? "agent_failed"
		: status === "cancelled"
			? "agent_cancelled"
			: "agent_interrupted";
}
