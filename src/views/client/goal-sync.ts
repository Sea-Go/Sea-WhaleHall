import {
	cloneActiveGoalContext,
	type ActiveGoalContextV1,
} from "../../shared/goal-context";

export type GoalSyncSender = (
	goal: ActiveGoalContextV1 | null,
) => Promise<ActiveGoalContextV1 | null>;

export type ActiveGoalSyncCoordinatorOptions = {
	send: GoalSyncSender;
	retryDelayMs?: number;
	delay?: (delayMs: number) => Promise<void>;
	onRetry?: (attempt: number) => void;
};

type DesiredGoal = {
	generation: number;
	key: string;
	goal: ActiveGoalContextV1 | null;
};

/**
 * Maintains one latest-wins desired goal and keeps retrying until the runtime
 * explicitly acknowledges that exact context. Transport availability is not a
 * signal to drop state: the native/runtime bridge may come up after the WebView.
 */
export class ActiveGoalSyncCoordinator {
	private readonly send: GoalSyncSender;
	private readonly retryDelayMs: number;
	private readonly delay: (delayMs: number) => Promise<void>;
	private readonly onRetry: (attempt: number) => void;
	private readonly acknowledgementWaiters = new Map<
		string,
		Set<() => void>
	>();
	private desired: DesiredGoal | null = null;
	private acknowledgedKey: string | null = null;
	private generation = 0;
	private running: Promise<void> | null = null;
	private disposed = false;

	constructor(options: ActiveGoalSyncCoordinatorOptions) {
		this.send = options.send;
		this.retryDelayMs = options.retryDelayMs ?? 1_000;
		this.delay = options.delay ?? wait;
		this.onRetry = options.onRetry ?? (() => {});
		if (
			!Number.isSafeInteger(this.retryDelayMs) ||
			this.retryDelayMs < 0
		) {
			throw new Error("retryDelayMs must be a non-negative safe integer.");
		}
	}

	setDesired(goal: ActiveGoalContextV1 | null): void {
		if (this.disposed) return;
		const snapshot = cloneActiveGoalContext(goal);
		const key = goalKey(snapshot);
		if (this.desired?.key === key) {
			this.ensureRunning();
			return;
		}
		this.generation += 1;
		this.desired = {
			generation: this.generation,
			key,
			goal: snapshot,
		};
		this.ensureRunning();
	}

	waitForAcknowledgement(
		goal: ActiveGoalContextV1 | null,
	): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("Goal synchronizer is disposed."));
		const snapshot = cloneActiveGoalContext(goal);
		const key = goalKey(snapshot);
		this.setDesired(snapshot);
		if (this.acknowledgedKey === key) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const waiters = this.acknowledgementWaiters.get(key) ?? new Set();
			waiters.add(resolve);
			this.acknowledgementWaiters.set(key, waiters);
			this.ensureRunning();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.generation += 1;
		this.desired = null;
		for (const waiters of this.acknowledgementWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.acknowledgementWaiters.clear();
	}

	private ensureRunning(): void {
		if (
			this.disposed ||
			this.running !== null ||
			this.desired === null ||
			this.desired.key === this.acknowledgedKey
		) {
			return;
		}
		this.running = this.drain().finally(() => {
			this.running = null;
			if (
				this.desired !== null &&
				this.desired.key !== this.acknowledgedKey
			) {
				this.ensureRunning();
			}
		});
	}

	private async drain(): Promise<void> {
		let failedAttempt = 0;
		let attemptedGeneration: number | null = null;
		for (;;) {
			if (this.disposed) return;
			const desired = this.desired;
			if (desired === null || desired.key === this.acknowledgedKey) return;
			if (attemptedGeneration !== desired.generation) {
				attemptedGeneration = desired.generation;
				failedAttempt = 0;
			}

			try {
				const acknowledged = await this.send(
					cloneActiveGoalContext(desired.goal),
				);
				if (!isAcknowledgementFor(desired.goal, acknowledged)) {
					throw new GoalAcknowledgementMismatchError();
				}
				this.acknowledgedKey = desired.key;
				this.resolveAcknowledgement(desired.key);
				failedAttempt = 0;
			} catch {
				if (this.disposed) return;
				// A newer desired state must not wait behind the retry delay of an
				// obsolete request.
				if (this.desired?.generation !== desired.generation) continue;
				failedAttempt += 1;
				this.onRetry(failedAttempt);
				await this.delay(this.retryDelayMs);
			}
		}
	}

	private resolveAcknowledgement(key: string): void {
		const waiters = this.acknowledgementWaiters.get(key);
		if (!waiters) return;
		this.acknowledgementWaiters.delete(key);
		for (const resolve of waiters) resolve();
	}
}

export function beginAccountTransition(options: {
	transition: () => void;
	clearLocalAccountState: () => void;
}): void {
	try {
		// AuthGate closes synchronously and the Bun sign-out request begins before
		// any best-effort Renderer cleanup. Bun owns the durable goal barrier.
		options.transition();
	} finally {
		options.clearLocalAccountState();
	}
}

class GoalAcknowledgementMismatchError extends Error {
	constructor() {
		super("The runtime did not acknowledge the requested active goal.");
		this.name = "GoalAcknowledgementMismatchError";
	}
}

function isAcknowledgementFor(
	requested: ActiveGoalContextV1 | null,
	acknowledged: ActiveGoalContextV1 | null,
): boolean {
	if (requested === null || acknowledged === null) {
		return requested === null && acknowledged === null;
	}
	return (
		acknowledged.schemaVersion === "active-goal.v1" &&
		acknowledged.goalId === requested.goalId &&
		acknowledged.planId === requested.planId &&
		acknowledged.text === requested.text &&
		acknowledged.activatedAtMs === requested.activatedAtMs
	);
}

function goalKey(goal: ActiveGoalContextV1 | null): string {
	return goal === null
		? "none"
		: JSON.stringify([
				goal.schemaVersion,
				goal.goalId,
				goal.planId,
				goal.version,
				goal.text,
				goal.activatedAtMs,
			]);
}

function wait(delayMs: number): Promise<void> {
	return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
