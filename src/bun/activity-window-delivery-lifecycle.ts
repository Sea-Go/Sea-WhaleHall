export interface ActivityWindowDeliveryShutdownResources {
	analyzer: { close(): void } | null;
	delivery: { stop(): void | Promise<void> } | null;
	dispatcher: { stop(): void | Promise<void> } | null;
	store: { close(): void | Promise<void> } | null;
}

export interface ActivityWindowDeliveryStartAttempt<TResources> {
	readonly resources: TResources | null;
	isCurrent(): boolean;
	assertCurrent(): void;
	own(resources: TResources): void;
}

export interface ActivityWindowDeliveryLifecycleOptions<TKey, TResources> {
	sameKey(left: TKey, right: TKey): boolean;
	release(resources: TResources): Promise<void>;
}

/**
 * Serializes one account-scoped delivery bundle across asynchronous start and
 * stop. Stop invalidates the exact start attempt synchronously, then joins it
 * before releasing resources, so an unpublished or half-started bundle cannot
 * appear after the stop barrier has completed.
 */
export class ActivityWindowDeliveryLifecycle<TKey, TResources> {
	private epoch = 0;
	private closed = false;
	private resources: TResources | null = null;
	private resourceKey: TKey | null = null;
	private startKey: TKey | null = null;
	private attemptToken: object | null = null;
	private startOperation: Promise<void> | null = null;
	private stopOperation: Promise<void> | null = null;
	private ready = false;

	constructor(
		private readonly options: ActivityWindowDeliveryLifecycleOptions<
			TKey,
			TResources
		>,
	) {}

	get currentResources(): TResources | null {
		return this.resources;
	}

	get isReady(): boolean {
		return this.ready;
	}

	/** Permanently prevents a new bundle while still allowing stop retries. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.epoch += 1;
		this.ready = false;
	}

	async start(
		key: TKey,
		run: (
			attempt: ActivityWindowDeliveryStartAttempt<TResources>,
		) => Promise<void>,
	): Promise<void> {
		if (this.closed) {
			throw new Error("Activity window delivery lifecycle is closed.");
		}
		if (this.stopOperation !== null) {
			await this.stopOperation;
			return this.start(key, run);
		}
		if (this.startOperation !== null) {
			if (this.startKey !== null && this.options.sameKey(this.startKey, key)) {
				return this.startOperation;
			}
			throw new Error(
				"Activity window delivery is starting for another session.",
			);
		}
		if (this.resources !== null) {
			if (
				this.ready &&
				this.resourceKey !== null &&
				this.options.sameKey(this.resourceKey, key)
			) {
				return;
			}
			throw new Error(
				"Activity window delivery resources must stop before another start.",
			);
		}

		const epoch = this.epoch;
		const token = {};
		const isCurrent = (): boolean =>
			!this.closed && this.epoch === epoch && this.attemptToken === token;
		const lifecycle = this;
		const attempt: ActivityWindowDeliveryStartAttempt<TResources> = {
			get resources() {
				return isCurrent() ? lifecycle.resources : null;
			},
			isCurrent,
			assertCurrent() {
				if (!isCurrent()) {
					throw new Error("Activity window delivery start was invalidated.");
				}
			},
			own(resources) {
				this.assertCurrent();
				if (lifecycle.resources !== null) {
					throw new Error(
						"Activity window delivery resources are already owned.",
					);
				}
				lifecycle.resources = resources;
				lifecycle.resourceKey = key;
			},
		};
		this.startKey = key;
		this.attemptToken = token;
		let operation!: Promise<void>;
		operation = Promise.resolve()
			.then(async () => {
				attempt.assertCurrent();
				await run(attempt);
				attempt.assertCurrent();
				if (this.resources === null) {
					throw new Error(
						"Activity window delivery start did not register its resources.",
					);
				}
				this.ready = true;
			})
			.catch(async (error: unknown) => {
				this.ready = false;
				if (this.attemptToken === token) this.attemptToken = null;
				const resources = this.resources;
				if (
					resources === null ||
					this.resourceKey === null ||
					!this.options.sameKey(this.resourceKey, key)
				) {
					throw error;
				}
				try {
					await this.releaseExact(resources);
				} catch (cleanupError) {
					throw new AggregateError(
						[error, cleanupError],
						"Activity window delivery start and cleanup both failed.",
					);
				}
				throw error;
			})
			.finally(() => {
				if (this.startOperation === operation) {
					this.startOperation = null;
					this.startKey = null;
				}
				if (this.resources === null && this.attemptToken === token) {
					this.attemptToken = null;
				}
			});
		this.startOperation = operation;
		return operation;
	}

	stop(): Promise<void> {
		if (this.stopOperation !== null) return this.stopOperation;
		this.epoch += 1;
		this.ready = false;
		const starting = this.startOperation;
		let operation!: Promise<void>;
		operation = (async () => {
			await starting?.catch(() => undefined);
			const resources = this.resources;
			if (resources !== null) await this.releaseExact(resources);
		})().finally(() => {
			if (this.stopOperation === operation) this.stopOperation = null;
		});
		this.stopOperation = operation;
		return operation;
	}

	private async releaseExact(resources: TResources): Promise<void> {
		await this.options.release(resources);
		if (this.resources !== resources) return;
		this.resources = null;
		this.resourceKey = null;
		this.attemptToken = null;
		this.ready = false;
	}
}

/**
 * Cancels live model work before waiting for the serial delivery tail. The
 * store remains open until that tail has drained, so an aborted window stays
 * durable and retryable on the next launch.
 */
export async function stopActivityWindowDeliveryResources(
	resources: ActivityWindowDeliveryShutdownResources,
	onError: (resource: string, error: unknown) => void = () => {},
): Promise<void> {
	const failures: unknown[] = [];
	const captureFailure = (resource: string, error: unknown): void => {
		failures.push(error);
		try {
			onError(resource, error);
		} catch {
			// Diagnostics must not prevent the remaining resources from draining.
		}
	};
	await releaseActivityWindowDeliveryResource(
		"analyzer",
		() => resources.analyzer?.close(),
		captureFailure,
	);
	await releaseActivityWindowDeliveryResource(
		"delivery",
		() => resources.delivery?.stop(),
		captureFailure,
	);
	await releaseActivityWindowDeliveryResource(
		"dispatcher",
		() => resources.dispatcher?.stop(),
		captureFailure,
	);
	await releaseActivityWindowDeliveryResource(
		"store",
		() => resources.store?.close(),
		captureFailure,
	);
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			"Activity window delivery did not stop every owned resource.",
		);
	}
}

async function releaseActivityWindowDeliveryResource(
	resource: "analyzer" | "delivery" | "dispatcher" | "store",
	release: () => unknown | Promise<unknown>,
	onError: (resource: string, error: unknown) => void,
): Promise<void> {
	try {
		await release();
	} catch (error) {
		try {
			onError(resource, error);
		} catch {
			// Diagnostics must not block release of later resources.
		}
	}
}
