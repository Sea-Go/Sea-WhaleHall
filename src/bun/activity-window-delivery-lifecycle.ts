export interface ActivityWindowDeliveryShutdownResources {
	analyzer: { close(): void } | null;
	delivery: { stop(): void | Promise<void> } | null;
	dispatcher: { stop(): void | Promise<void> } | null;
	store: { close(): void | Promise<void> } | null;
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
	releaseActivityWindowDeliveryResource(
		"analyzer",
		() => resources.analyzer?.close(),
		onError,
	);
	await releaseActivityWindowDeliveryResource(
		"delivery",
		() => resources.delivery?.stop(),
		onError,
	);
	await releaseActivityWindowDeliveryResource(
		"dispatcher",
		() => resources.dispatcher?.stop(),
		onError,
	);
	await releaseActivityWindowDeliveryResource(
		"store",
		() => resources.store?.close(),
		onError,
	);
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
