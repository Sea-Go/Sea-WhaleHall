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

export async function runBestEffortShutdown(
	steps: readonly ShutdownStep[],
	onError: (step: string, error: unknown) => void = () => {},
	options: BestEffortShutdownOptions = {},
): Promise<void> {
	const criticalFailures: string[] = [];
	const nowMs = options.nowMs ?? Date.now;
	for (const step of steps) {
		const startedAtMs = nowMs();
		let outcome: ShutdownStepOutcome = "completed";
		try {
			await runShutdownStep(step);
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
	if (criticalFailures.length > 0) {
		throw new CriticalShutdownError(criticalFailures);
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
	private quitRequested = false;
	private quitRequestFailure: { error: unknown } | null = null;
	private exitAuthorized = false;

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
		void this.quit();
	}

	quit(): Promise<void> {
		if (!this.quitRequested) {
			this.quitRequested = true;
			try {
				this.options.onQuitRequested?.();
			} catch (error) {
				// A failed process-start latch must preserve the Electrobun quit veto.
				this.quitRequestFailure = { error };
			}
		}
		if (this.quitting !== null) return this.quitting;
		const quitting = (async () => {
			try {
				if (this.quitRequestFailure) throw this.quitRequestFailure.error;
				await this.opening?.catch(() => undefined);
				await this.options.shutdown();
			} catch (error) {
				try {
					this.options.onError?.("quit", error);
				} catch {
					// Diagnostics must not turn a failed shutdown into an authorized exit.
				}
				// Preserve the veto, but let a later quit retry any process owner that
				// could not be stopped during this attempt.
				this.quitting = null;
				return;
			}
			this.exitAuthorized = true;
			this.options.exit();
		})();
		this.quitting = quitting;
		return quitting;
	}
}
