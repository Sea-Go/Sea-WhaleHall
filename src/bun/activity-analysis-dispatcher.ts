import { randomUUID } from "node:crypto";
import type {
	ActivityAnalysisJob,
	ActivityWindowDeliveryStore,
} from "../agent/activity-window-worker";
import type { AuthSessionIdentity } from "../shared/session-identity";
import type { AgentRunCoordinator } from "./agent-run-coordinator";
import type { DesktopAuthSessionManager } from "./auth-session";
import type { EncryptedAgentRepository } from "./encrypted-agent-repository";

const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;

export interface ActivityAnalysisDispatcherOptions {
	store: ActivityWindowDeliveryStore;
	scoreThreshold: number;
	auth: DesktopAuthSessionManager;
	coordinator: Pick<AgentRunCoordinator, "startActivityAnalysis"> &
		Partial<Pick<AgentRunCoordinator, "reconcileOrphanedActivityRun">>;
	repository?: Pick<
		EncryptedAgentRepository,
		"verifyCompletedProactiveFeedbackRun"
	> &
		Partial<Pick<EncryptedAgentRepository, "deleteActivityAnalysisRuns">>;
	retryDelaysMs?: readonly number[];
	nowMs?: () => number;
	isEligible?: (identity: AuthSessionIdentity) => boolean;
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
	> &
		Partial<Pick<AgentRunCoordinator, "reconcileOrphanedActivityRun">>;
	private readonly repository:
		| (Pick<EncryptedAgentRepository, "verifyCompletedProactiveFeedbackRun"> &
				Partial<Pick<EncryptedAgentRepository, "deleteActivityAnalysisRuns">>)
		| undefined;
	private readonly retryDelaysMs: readonly number[];
	private readonly nowMs: () => number;
	private readonly isEligible: (identity: AuthSessionIdentity) => boolean;
	private readonly onError: (error: unknown) => void;
	private readonly attemptsByRunId = new Map<
		string,
		{ semanticAttempt: number; transportAttempt: number }
	>();
	private started = false;
	private drainScheduled = false;
	private wakePending = false;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private retryAtMs: number | null = null;
	private tail: Promise<void> = Promise.resolve();
	private prestartRecovery: Promise<void> | null = null;

	constructor(options: ActivityAnalysisDispatcherOptions) {
		this.store = options.store;
		this.scoreThreshold = options.scoreThreshold;
		this.auth = options.auth;
		this.coordinator = options.coordinator;
		this.repository = options.repository;
		this.retryDelaysMs = validateRetryDelays(
			options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
		);
		this.nowMs = options.nowMs ?? Date.now;
		this.isEligible = options.isEligible ?? (() => true);
		this.onError = options.onError ?? (() => {});
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.store.recoverActivityAnalysisJobs(this.scoreThreshold, this.nowMs());
		this.wake();
	}

	/**
	 * Reconciles an already-running durable job before retention cleanup. This
	 * phase never claims ready work or starts a provider; call start() afterward.
	 */
	startAndRecover(): Promise<void> {
		if (this.started) {
			return Promise.reject(
				new Error("Activity dispatcher recovery must precede start()."),
			);
		}
		if (this.prestartRecovery) return this.prestartRecovery;
		const recovery = (async () => {
			this.store.recoverActivityAnalysisJobs(this.scoreThreshold, this.nowMs());
			const identity = this.auth.captureCurrentSession();
			if (!identity || !this.isEligible(identity)) return;
			const next = this.store.nextActivityAnalysisJob(
				this.scoreThreshold,
				identity.accountId,
				this.nowMs(),
			);
			if (next.kind === "running") {
				await this.reconcileRunningJob(next.job, identity.accountId);
			}
		})();
		this.prestartRecovery = recovery;
		return recovery;
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
				try {
					await this.drain();
				} catch (error) {
					// A transient read, decrypt, reconciliation, or phase-two commit
					// failure must not consume the only wake for a durable running job.
					// Explicit identity mismatches are converted to terminal state inside
					// reconcileRunningJob and do not arrive here as exceptions.
					if (this.started) {
						this.armRetry(this.nowMs() + this.delayForAttempt(0));
					}
					throw error;
				}
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
		failureClass?: "transient" | "invalid-output" | "terminal" | null;
	}): Promise<void> {
		const attempts = this.attemptsByRunId.get(input.runId) ?? {
			semanticAttempt: 0,
			transportAttempt: 0,
		};
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
			} else if (
				input.failureClass === "invalid-output" &&
				attempts.semanticAttempt >= 2
			) {
				this.store.markActivityAnalysisJobTerminalFailure(
					input.jobId,
					input.accountId,
					input.runId,
					"invalid_output_limit",
					this.nowMs(),
				);
			} else if (input.failureClass === "terminal") {
				this.store.markActivityAnalysisJobTerminalFailure(
					input.jobId,
					input.accountId,
					input.runId,
					terminalErrorCode(input.status),
					this.nowMs(),
				);
			} else {
				const now = this.nowMs();
				const invalidOutput = input.failureClass === "invalid-output";
				this.store.deferActivityAnalysisJob(
					input.jobId,
					input.accountId,
					input.runId,
					now +
						this.delayForAttempt(invalidOutput ? 0 : attempts.transportAttempt),
					terminalErrorCode(input.status),
					now,
					invalidOutput,
				);
			}
			await this.deleteFinishedAttempt(input.accountId, input.runId);
		} catch (error) {
			this.report(error);
		}
		this.wake();
	}

	private async drain(): Promise<void> {
		if (!this.started) return;
		const identity = this.auth.captureCurrentSession();
		if (!identity || !this.isEligible(identity)) return;
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
		if (next.kind === "running") {
			if (!this.started || !this.isEligible(identity)) return;
			await this.reconcileRunningJob(next.job, identity.accountId);
			return;
		}
		if (!this.started || !this.isEligible(identity)) return;
		await this.startClaimedJob(next.job, identity);
	}

	private async reconcileRunningJob(
		job: ActivityAnalysisJob,
		accountId: string,
	): Promise<void> {
		if (job.runId && this.attemptsByRunId.has(job.runId)) return;
		if (
			!this.repository ||
			!this.coordinator.reconcileOrphanedActivityRun ||
			!job.runId
		) {
			this.store.markActivityAnalysisJobTerminalFailure(
				job.jobId,
				accountId,
				job.runId,
				"recovery_identity_missing",
				this.nowMs(),
			);
			return;
		}
		const reconciliation = await this.coordinator.reconcileOrphanedActivityRun({
			accountId,
			runId: job.runId,
			jobId: job.jobId,
			requestId: job.originatingRequestId,
			consumedScore: job.consumedScore,
			analyses: job.analyses,
		});
		let verifiedCompletion = false;
		if (reconciliation === "completed") {
			// A verifier exception means the encrypted completion proof could not be
			// read, not that it mismatched. Let it propagate while the Worker job
			// remains running for startup or normal retry reconciliation.
			verifiedCompletion =
				await this.repository.verifyCompletedProactiveFeedbackRun({
					accountId,
					runId: job.runId,
					jobId: job.jobId,
					originatingRequestId: job.originatingRequestId,
					consumedScore: job.consumedScore,
					analyses: job.analyses,
				});
		}
		if (reconciliation === "completed" && verifiedCompletion) {
			this.store.completeActivityAnalysisJob(
				job.jobId,
				accountId,
				job.runId,
				this.scoreThreshold,
				this.nowMs(),
			);
			await this.deleteFinishedAttempt(accountId, job.runId);
			this.wake();
			return;
		}
		if (reconciliation === "active") return;
		if (reconciliation === "invalid-output") {
			if (job.attempt >= 2) {
				this.store.markActivityAnalysisJobTerminalFailure(
					job.jobId,
					accountId,
					job.runId,
					"invalid_output_limit",
					this.nowMs(),
				);
				await this.deleteFinishedAttempt(accountId, job.runId);
				return;
			}
			const now = this.nowMs();
			const nextAttemptAtMs = now + this.delayForAttempt(0);
			this.store.deferActivityAnalysisJob(
				job.jobId,
				accountId,
				job.runId,
				nextAttemptAtMs,
				"recovered_invalid_output",
				now,
				true,
			);
			await this.deleteFinishedAttempt(accountId, job.runId);
			this.armRetry(nextAttemptAtMs);
			return;
		}
		if (reconciliation === "retryable") {
			const now = this.nowMs();
			const nextAttemptAtMs = now + this.delayForAttempt(job.transportAttempt);
			this.store.deferActivityAnalysisJob(
				job.jobId,
				accountId,
				job.runId,
				nextAttemptAtMs,
				"recovered_terminal_run",
				now,
				false,
			);
			await this.deleteFinishedAttempt(accountId, job.runId);
			this.armRetry(nextAttemptAtMs);
			return;
		}
		this.store.markActivityAnalysisJobTerminalFailure(
			job.jobId,
			accountId,
			job.runId,
			reconciliation === "completed"
				? "completed_run_not_atomic"
				: "recovery_identity_mismatch",
			this.nowMs(),
		);
	}

	private async startClaimedJob(
		job: ActivityAnalysisJob,
		identity: AuthSessionIdentity,
	): Promise<void> {
		if (!this.started || !this.isEligible(identity)) return;
		const accountId = identity.accountId;
		const attemptNumber = job.attempt + 1;
		const runId = `activity-run-${job.jobId}-${attemptNumber}-${randomUUID()}`;
		const requestId = job.originatingRequestId;
		const claimed = this.store.claimActivityAnalysisJob(
			job.jobId,
			accountId,
			runId,
			this.nowMs(),
		);
		if (!this.started || !this.isEligible(identity)) {
			const now = this.nowMs();
			this.store.deferActivityAnalysisJob(
				claimed.jobId,
				accountId,
				runId,
				now,
				"dispatch_ineligible",
				now,
				false,
			);
			return;
		}
		this.attemptsByRunId.set(runId, {
			semanticAttempt: claimed.attempt,
			transportAttempt: claimed.transportAttempt,
		});
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
					now + this.delayForAttempt(claimed.transportAttempt),
					"start_failed",
					now,
					false,
				);
				await this.deleteFinishedAttempt(accountId, runId);
			} catch (deferError) {
				this.report(deferError);
			}
			this.report(error);
			this.wake();
		}
	}

	private async deleteFinishedAttempt(
		accountId: string,
		runId: string,
	): Promise<void> {
		if (!this.repository?.deleteActivityAnalysisRuns) return;
		try {
			await this.repository.deleteActivityAnalysisRuns(accountId, [runId]);
		} catch (error) {
			// The Worker transition is authoritative. A failed best-effort deletion
			// is repaired by account retention cleanup and must not re-run a model.
			this.report(error);
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
