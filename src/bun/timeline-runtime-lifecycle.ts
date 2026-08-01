import type { LocalVaultKeyStatus } from "../agent/local-protocol";

export type ManagedTimelineRuntime = {
	start(): Promise<void>;
	close(): Promise<void>;
};

export type TimelineRuntimeLifecycleOptions<
	Runtime extends ManagedTimelineRuntime,
> = {
	createRuntime(): Promise<Runtime>;
	retryDelaysMs: readonly number[];
	onError?(error: unknown): void;
	scheduleRetry?(callback: () => void, delayMs: number): unknown;
	cancelRetry?(handle: unknown): void;
};

export type EnsureTimelineRuntimeOptions = {
	retryOnFailure?: boolean;
};

/**
 * Owns the single Timeline runtime installed in the Bun process.
 *
 * A candidate is published only after start() has recovered the collector and
 * drained its durable semantic backlog. Failed candidates are always closed,
 * while an explicitly enabled retry remains able to build a fresh candidate.
 */
export class TimelineRuntimeLifecycle<
	Runtime extends ManagedTimelineRuntime,
> {
	private runtime: Runtime | null = null;
	private startPromise: Promise<Runtime> | null = null;
	private closePromise: Promise<void> | null = null;
	private retryHandle: unknown | null = null;
	private retryIndex = 0;
	private retryEnabled = false;
	private closed = false;

	private readonly scheduleRetry: (callback: () => void, delayMs: number) => unknown;
	private readonly cancelRetry: (handle: unknown) => void;

	constructor(
		private readonly options: TimelineRuntimeLifecycleOptions<Runtime>,
	) {
		if (
			options.retryDelaysMs.length === 0 ||
			options.retryDelaysMs.some(
				(delayMs) =>
					!Number.isSafeInteger(delayMs) || delayMs <= 0,
			)
		) {
			throw new Error(
				"Timeline runtime retry delays must be positive safe integers.",
			);
		}
		this.scheduleRetry =
			options.scheduleRetry ??
			((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
		this.cancelRetry =
			options.cancelRetry ??
			((handle) =>
				globalThis.clearTimeout(
					handle as ReturnType<typeof globalThis.setTimeout>,
				));
	}

	get current(): Runtime | null {
		return this.runtime;
	}

	get recoveryPending(): boolean {
		return this.startPromise !== null || this.retryHandle !== null;
	}

	ensureStarted(
		options: EnsureTimelineRuntimeOptions = {},
	): Promise<Runtime> {
		if (this.closed) {
			return Promise.reject(
				new Error("Timeline runtime lifecycle is closed."),
			);
		}
		if (this.runtime !== null) return Promise.resolve(this.runtime);

		if (options.retryOnFailure === true) {
			this.retryEnabled = true;
			if (this.retryHandle !== null) {
				this.cancelScheduledRetry();
				this.retryIndex = 0;
			}
		}
		if (this.startPromise !== null) return this.startPromise;

		const startPromise = this.startCandidate();
		this.startPromise = startPromise;
		void startPromise.finally(() => {
			if (this.startPromise === startPromise) this.startPromise = null;
		}).catch(() => {
			// The caller observes the original promise. This chained promise exists
			// only to clear the in-flight slot without creating an unhandled reject.
		});
		return startPromise;
	}

	close(): Promise<void> {
		if (this.closePromise !== null) return this.closePromise;
		this.closed = true;
		this.retryEnabled = false;
		this.cancelScheduledRetry();
		this.closePromise = (async () => {
			await this.startPromise?.catch(() => undefined);
			const runtime = this.runtime;
			this.runtime = null;
			if (runtime !== null) await runtime.close();
		})();
		return this.closePromise;
	}

	private async startCandidate(): Promise<Runtime> {
		let candidate: Runtime | null = null;
		try {
			candidate = await this.options.createRuntime();
			if (this.closed) {
				await candidate.close();
				candidate = null;
				throw new Error("Timeline runtime lifecycle is closed.");
			}
			await candidate.start();
			if (this.closed) {
				await candidate.close();
				candidate = null;
				throw new Error("Timeline runtime lifecycle is closed.");
			}
			this.runtime = candidate;
			this.retryEnabled = false;
			this.retryIndex = 0;
			return candidate;
		} catch (error) {
			if (candidate !== null) {
				await candidate.close().catch((closeError) => {
					this.reportError(closeError);
				});
			}
			this.reportError(error);
			this.scheduleNextRetry();
			throw error;
		}
	}

	private scheduleNextRetry(): void {
		if (
			this.closed ||
			!this.retryEnabled ||
			this.runtime !== null ||
			this.retryHandle !== null
		) {
			return;
		}
		const delayIndex = Math.min(
			this.retryIndex,
			this.options.retryDelaysMs.length - 1,
		);
		const delayMs = this.options.retryDelaysMs[delayIndex]!;
		this.retryIndex += 1;
		this.retryHandle = this.scheduleRetry(() => {
			this.retryHandle = null;
			if (this.closed || !this.retryEnabled || this.runtime !== null) return;
			void this.ensureStarted({ retryOnFailure: true }).catch(() => {
				// The failed attempt has already been reported and scheduled again.
			});
		}, delayMs);
	}

	private cancelScheduledRetry(): void {
		if (this.retryHandle === null) return;
		this.cancelRetry(this.retryHandle);
		this.retryHandle = null;
	}

	private reportError(error: unknown): void {
		try {
			this.options.onError?.(error);
		} catch {
			// Diagnostics must not weaken candidate cleanup or retry behavior.
		}
	}
}

/**
 * A successful vault migration is durable even if Timeline startup fails.
 * Keep that result, leave Timeline unpublished, and let the lifecycle retry.
 */
export async function resumeTimelineRuntimeForAvailableVault<
	Runtime extends ManagedTimelineRuntime,
>(
	vault: Pick<LocalVaultKeyStatus, "availability">,
	lifecycle: Pick<
		TimelineRuntimeLifecycle<Runtime>,
		"ensureStarted"
	>,
): Promise<boolean> {
	if (vault.availability !== "available") return false;
	try {
		await lifecycle.ensureStarted({ retryOnFailure: true });
		return true;
	} catch {
		return false;
	}
}
