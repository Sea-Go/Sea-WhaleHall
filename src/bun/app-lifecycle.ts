export interface BackgroundWindow {
	activate(): unknown;
	show(): unknown;
}

export interface BeforeQuitEvent {
	response?: { allow: boolean };
}

export interface ShutdownStep {
	name: string;
	critical?: boolean;
	timeoutMs?: number;
	run(): void | Promise<void>;
}

export type ShutdownStepOutcome = "completed" | "failed" | "timed_out";

export interface ShutdownStepResult {
	name: string;
	critical: boolean;
	outcome: ShutdownStepOutcome;
	durationMs: number;
}

export interface BestEffortShutdownOptions {
	nowMs?: () => number;
	/** Caps the complete sequence so critical owners can be prioritized. */
	overallTimeoutMs?: number;
	/** Rechecks a historical critical failure after later owner barriers run. */
	isCriticalFailureRecovered?(step: string): boolean;
	onStepSettled?(result: ShutdownStepResult): void;
}

export class ShutdownStepTimeoutError extends Error {
	constructor(
		public readonly step: string,
		public readonly timeoutMs: number,
	) {
		super(`Shutdown step '${step}' exceeded its ${timeoutMs} ms deadline.`);
		this.name = "ShutdownStepTimeoutError";
	}
}

export class CriticalShutdownError extends Error {
	constructor(public readonly failedSteps: readonly string[]) {
		super(`Critical shutdown steps failed: ${failedSteps.join(", ")}`);
		this.name = "CriticalShutdownError";
	}
}

/** Synchronously closes request ingress, then joins every already-accepted job. */
export class ShutdownWorkBarrier {
	private readonly active = new Set<Promise<unknown>>();
	private closed = false;

	run<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.closed) {
			return Promise.reject(new Error("Application shutdown is in progress."));
		}
		const result = Promise.resolve().then(operation);
		this.active.add(result);
		void result
			.finally(() => this.active.delete(result))
			.catch(() => undefined);
		return result;
	}

	close(): void {
		this.closed = true;
	}

	async drain(): Promise<void> {
		for (;;) {
			const active = [...this.active];
			if (active.length === 0) return;
			await Promise.allSettled(active);
		}
	}
}

/**
 * Closes a shared owner only after every producer has stopped and a fresh
 * fixed-point drain of the owner has observed work registered by those
 * producers. Keeping these phases sequential prevents a late producer from
 * registering work after an eager owner drain has already returned.
 */
export async function closeOwnerAfterDraining(
	drainProducers: () => Promise<void>,
	drainOwner: () => Promise<void>,
	closeOwner: () => void | Promise<void>,
): Promise<void> {
	await drainProducers();
	await drainOwner();
	await closeOwner();
}

export async function runBestEffortShutdown(
	steps: readonly ShutdownStep[],
	onError: (step: string, error: unknown) => void = () => {},
	options: BestEffortShutdownOptions = {},
): Promise<void> {
	const criticalFailures: string[] = [];
	const nowMs = options.nowMs ?? Date.now;
	const overallTimeoutMs = options.overallTimeoutMs;
	if (
		overallTimeoutMs !== undefined &&
		(!Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs <= 0)
	) {
		throw new Error("Shutdown overall deadline is invalid.");
	}
	const deadlineAtMs =
		overallTimeoutMs === undefined ? null : nowMs() + overallTimeoutMs;
	for (const step of steps) {
		const startedAtMs = nowMs();
		let outcome: ShutdownStepOutcome = "completed";
		try {
			const remainingMs =
				deadlineAtMs === null ? null : Math.max(0, deadlineAtMs - startedAtMs);
			if (remainingMs === 0) {
				throw new ShutdownStepTimeoutError(step.name, 0);
			}
			await runShutdownStep(
				remainingMs === null
					? step
					: {
							...step,
							timeoutMs:
								step.timeoutMs === undefined
									? remainingMs
									: Math.min(step.timeoutMs, remainingMs),
						},
			);
		} catch (error) {
			outcome =
				error instanceof ShutdownStepTimeoutError ? "timed_out" : "failed";
			if (step.critical) criticalFailures.push(step.name);
			try {
				onError(step.name, error);
			} catch {
				// Diagnostics must not prevent later process owners from shutting down.
			}
		} finally {
			try {
				options.onStepSettled?.({
					name: step.name,
					critical: step.critical === true,
					outcome,
					durationMs: Math.max(0, nowMs() - startedAtMs),
				});
			} catch {
				// Observability must not prevent later process owners from shutting down.
			}
		}
	}
	const unrecoveredCriticalFailures = criticalFailures.filter((step) => {
		try {
			return options.isCriticalFailureRecovered?.(step) !== true;
		} catch {
			// A broken recovery predicate cannot authorize process exit.
			return true;
		}
	});
	if (unrecoveredCriticalFailures.length > 0) {
		throw new CriticalShutdownError(unrecoveredCriticalFailures);
	}
}

async function runShutdownStep(step: ShutdownStep): Promise<void> {
	const timeoutMs = step.timeoutMs;
	if (timeoutMs === undefined) {
		const operation = Promise.resolve().then(() => step.run());
		await operation;
		return;
	}
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error(`Shutdown step '${step.name}' has an invalid deadline.`);
	}
	const operation = Promise.resolve().then(() => step.run());
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new ShutdownStepTimeoutError(step.name, timeoutMs)),
			timeoutMs,
		);
	});
	try {
		await Promise.race([operation, deadline]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export interface BackgroundAppLifecycleOptions<
	WindowType extends BackgroundWindow,
> {
	createWindow(): Promise<WindowType>;
	/** Synchronous, one-way latch invoked before quit waits for any async work. */
	onQuitRequested?(): void;
	shutdown(): Promise<void>;
	/**
	 * For an ordinary quit only, returns an exact owner-settlement waiter that can
	 * make one fresh authorization attempt meaningful. Null disables auto retry.
	 */
	waitForShutdownRetry?(error: unknown): Promise<void> | null;
	exit(): void;
	onError?(operation: "open" | "quit", error: unknown): void;
}

/**
 * Keeps the native monitoring runtime alive when the control window closes.
 *
 * The window is presentation state. Explicit application quit is the only
 * transition that tears down Timeline, whalehall-local, and Observer.
 */
export class BackgroundAppLifecycle<WindowType extends BackgroundWindow> {
	private window: WindowType | null = null;
	private opening: Promise<WindowType> | null = null;
	private quitting: Promise<void> | null = null;
	private shutdownAttempt: Promise<
		| { readonly kind: "authorized" }
		| { readonly kind: "failed"; readonly error: unknown }
	> | null = null;
	private quitRequested = false;
	private quitRequestFailure: { error: unknown } | null = null;
	private exitAuthorized = false;
	private quitIntentGeneration = 0;
	private automaticRetry: Promise<void> | null = null;
	private externalExitRequested = false;

	constructor(
		private readonly options: BackgroundAppLifecycleOptions<WindowType>,
	) {}

	get currentWindow(): WindowType | null {
		return this.window;
	}

	open(): Promise<WindowType> {
		if (this.quitRequested) {
			return Promise.reject(
				new Error("Cannot open a control window while WhaleHall is quitting."),
			);
		}
		if (this.window !== null) {
			this.window.show();
			this.window.activate();
			return Promise.resolve(this.window);
		}
		if (this.opening !== null) return this.opening;

		const opening = this.options
			.createWindow()
			.then((window) => {
				if (this.quitRequested) {
					throw new Error(
						"Cannot attach a control window while WhaleHall is quitting.",
					);
				}
				this.window = window;
				return window;
			})
			.catch((error) => {
				this.options.onError?.("open", error);
				throw error;
			})
			.finally(() => {
				if (this.opening === opening) this.opening = null;
			});
		this.opening = opening;
		return opening;
	}

	didClose(window: WindowType): void {
		if (this.window === window) this.window = null;
	}

	handleBeforeQuit(event: BeforeQuitEvent): void {
		if (this.exitAuthorized) return;
		// Electrobun exits synchronously after this event unless it is vetoed.
		// Hold that exit until the application-owned child processes have stopped.
		event.response = { allow: false };
		// Closing the final window on Windows can emit before-quit while an updater
		// already owns the eventual process exit. Starting the ordinary quit path
		// here would race Utils.quit() against the updater's replace/relaunch script.
		if (this.shutdownAttempt === null) void this.quit();
	}

	/**
	 * Completes the application-owned shutdown barrier without exiting.
	 *
	 * External process owners such as the updater can call this immediately
	 * before their own atomic replace/relaunch sequence. Once it resolves, the
	 * raw Electrobun before-quit event is allowed through instead of starting a
	 * second shutdown or vetoing the updater's final exit.
	 */
	async prepareForExternalExit(): Promise<void> {
		// Never let an old ordinary-quit waiter race an updater-owned exit.
		this.externalExitRequested = true;
		this.quitIntentGeneration += 1;
		this.automaticRetry = null;
		const outcome = await this.requestShutdownAuthorization();
		if (outcome.kind === "failed") {
			this.externalExitRequested = false;
			throw outcome.error;
		}
	}

	quit(): Promise<void> {
		return this.startQuitAttempt(false);
	}

	private startQuitAttempt(
		automatic: boolean,
		generation = this.quitIntentGeneration,
	): Promise<void> {
		if (this.quitting !== null) return this.quitting;
		if (!automatic) {
			generation = this.quitIntentGeneration + 1;
			this.quitIntentGeneration = generation;
			this.automaticRetry = null;
		} else if (generation !== this.quitIntentGeneration) {
			return Promise.resolve();
		}
		let failure: { readonly error: unknown } | null = null;
		const quitting = (async () => {
			const outcome = await this.requestShutdownAuthorization();
			if (outcome.kind === "failed") {
				failure = { error: outcome.error };
				return;
			}
			if (
				generation !== this.quitIntentGeneration ||
				this.externalExitRequested
			) {
				return;
			}
			this.options.exit();
		})();
		this.quitting = quitting;
		void quitting.then(
			() => {
				if (!this.exitAuthorized && this.quitting === quitting) {
					this.quitting = null;
				}
				if (!automatic && failure !== null) {
					this.scheduleAutomaticRetry(failure.error, generation);
				}
			},
			() => {
				if (this.quitting === quitting) this.quitting = null;
			},
		);
		return quitting;
	}

	private scheduleAutomaticRetry(error: unknown, generation: number): void {
		if (
			generation !== this.quitIntentGeneration ||
			!(error instanceof CriticalShutdownError) ||
			this.options.waitForShutdownRetry === undefined
		) {
			return;
		}
		let ownerSettlement: Promise<void> | null;
		try {
			ownerSettlement = this.options.waitForShutdownRetry(error);
		} catch {
			return;
		}
		if (ownerSettlement === null) return;

		let retry!: Promise<void>;
		retry = Promise.resolve(ownerSettlement)
			.then(async () => {
				if (
					this.automaticRetry !== retry ||
					generation !== this.quitIntentGeneration ||
					this.exitAuthorized ||
					!this.quitRequested
				) {
					return;
				}
				await this.shutdownAttempt?.catch(() => undefined);
				await this.quitting?.catch(() => undefined);
				if (
					this.automaticRetry !== retry ||
					generation !== this.quitIntentGeneration ||
					this.exitAuthorized
				) {
					return;
				}
				this.automaticRetry = null;
				await this.startQuitAttempt(true, generation);
			})
			.catch(() => {
				// A waiter can trigger a retry, but can never authorize process exit.
			})
			.finally(() => {
				if (this.automaticRetry === retry) this.automaticRetry = null;
			});
		this.automaticRetry = retry;
	}

	private requestShutdownAuthorization(): Promise<
		| { readonly kind: "authorized" }
		| { readonly kind: "failed"; readonly error: unknown }
	> {
		if (this.exitAuthorized) {
			return Promise.resolve({ kind: "authorized" });
		}
		if (this.shutdownAttempt !== null) return this.shutdownAttempt;
		if (!this.quitRequested || this.quitRequestFailure !== null) {
			this.quitRequested = true;
			try {
				this.options.onQuitRequested?.();
				this.quitRequestFailure = null;
			} catch (error) {
				// A failed process-start latch preserves the veto for this attempt. A
				// later attempt retries the required idempotent synchronous latch.
				this.quitRequestFailure = { error };
			}
		}
		const attempt = (async () => {
			try {
				if (this.quitRequestFailure) throw this.quitRequestFailure.error;
				await this.opening?.catch(() => undefined);
				await this.options.shutdown();
				this.exitAuthorized = true;
				return { kind: "authorized" } as const;
			} catch (error) {
				try {
					this.options.onError?.("quit", error);
				} catch {
					// Diagnostics must not turn a failed shutdown into an authorized exit.
				}
				return { kind: "failed", error } as const;
			}
		})();
		this.shutdownAttempt = attempt;
		void attempt.then((outcome) => {
			if (outcome.kind === "failed" && this.shutdownAttempt === attempt) {
				this.shutdownAttempt = null;
			}
		});
		return attempt;
	}
}
