export type DeferredReflectionOperation =
	| { kind: "cutover"; accountId: string | null }
	| { kind: "clear-handoffs"; accountId: string };

export interface DeferredReflectionOperationTarget {
	cutoverCloudOwner(accountId: string | null): Promise<void>;
	clearWindowsForAccount(accountId: string): Promise<unknown>;
}

export type PublishDeferredReflectionTarget = () => void;

export class DeferredReflectionOperationsClosedError extends Error {
	constructor() {
		super("Deferred Reflection operations are closed.");
		this.name = "DeferredReflectionOperationsClosedError";
	}
}

export class DeferredReflectionOperationUnconfirmedError extends Error {
	constructor() {
		super("Deferred Reflection operation has not completed.");
		this.name = "DeferredReflectionOperationUnconfirmedError";
	}
}

/**
 * Records account-bound Reflection intents while the optional runtime is not
 * published. Callers never wait for process startup; a candidate must replay
 * every intent successfully, in order, before it can become the live runtime.
 */
export class DeferredReflectionOperations {
	private readonly pending: DeferredReflectionOperation[] = [];
	private closed = false;

	deferCutover(accountId: string | null): void {
		this.assertOpen();
		this.pending.push({ kind: "cutover", accountId });
	}

	deferClearHandoffs(
		accountId: string,
		options: { requireCompletion?: boolean } = {},
	): void {
		this.assertOpen();
		this.pending.push({ kind: "clear-handoffs", accountId });
		// Account startup may safely leave a replayable intent behind, but a
		// user-confirmed destructive request must not report success until the
		// durable repository operation actually ran.
		if (options.requireCompletion === true) {
			throw new DeferredReflectionOperationUnconfirmedError();
		}
	}

	/**
	 * Permanently closes the startup handoff. Shutdown uses this as a synchronous
	 * latch before repositories or process owners begin closing.
	 */
	close(): void {
		this.closed = true;
		this.pending.length = 0;
	}

	async replay(target: DeferredReflectionOperationTarget): Promise<void> {
		await this.drain(target);
	}

	/**
	 * Replays every deferred barrier and publishes the target in the same
	 * synchronous turn that observes an empty queue. This closes the otherwise
	 * possible drain-to-publish gap: after publish returns, a new caller routes
	 * directly to the live runtime instead of appending an intent behind a drain
	 * that has already completed.
	 */
	replayAndPublish(
		target: DeferredReflectionOperationTarget,
		publish: PublishDeferredReflectionTarget,
	): Promise<void> {
		return this.drain(target, publish);
	}

	private async drain(
		target: DeferredReflectionOperationTarget,
		publish?: PublishDeferredReflectionTarget,
	): Promise<void> {
		this.assertOpen();
		while (this.pending.length > 0) {
			const operation = this.pending[0];
			if (!operation) break;
			if (operation.kind === "cutover") {
				await target.cutoverCloudOwner(operation.accountId);
			} else {
				await target.clearWindowsForAccount(operation.accountId);
			}
			// Shutdown may close this queue while a durable operation is awaiting I/O.
			// Never consume another intent or publish its candidate after that point.
			this.assertOpen();
			// Shift only after the durable target operation succeeds. A thrown
			// operation remains at the head for the next startup candidate.
			if (this.pending[0] === operation) this.pending.shift();
		}
		this.assertOpen();
		publish?.();
	}

	private assertOpen(): void {
		if (this.closed) throw new DeferredReflectionOperationsClosedError();
	}

	pendingCount(): number {
		return this.pending.length;
	}
}
