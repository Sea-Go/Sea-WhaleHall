export async function runAccountSessionCleanup(
	operations: ReadonlyArray<() => unknown | Promise<unknown>>,
): Promise<void> {
	const results = await Promise.allSettled(
		operations.map((operation) => Promise.resolve().then(operation)),
	);
	const failures = results.filter(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failures.length > 0) {
		throw new AggregateError(
			failures.map((failure) => failure.reason),
			"One or more local account cleanup barriers failed.",
		);
	}
}
