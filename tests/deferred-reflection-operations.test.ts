import { describe, expect, test } from "bun:test";
import {
	DeferredReflectionOperations,
	DeferredReflectionOperationsClosedError,
	DeferredReflectionOperationUnconfirmedError,
} from "../src/bun/deferred-reflection-operations";

describe("DeferredReflectionOperations", () => {
	test("records startup intents without making auth wait for runtime publication", () => {
		const operations = new DeferredReflectionOperations();

		expect(operations.deferCutover(null)).toBeUndefined();
		expect(operations.deferClearHandoffs("account-a")).toBeUndefined();
		expect(operations.deferCutover("account-a")).toBeUndefined();
		expect(operations.pendingCount()).toBe(3);
	});

	test("replays account barriers in order before a runtime can be published", async () => {
		const operations = new DeferredReflectionOperations();
		const calls: string[] = [];
		operations.deferCutover(null);
		operations.deferClearHandoffs("account-a");
		operations.deferCutover("account-a");

		await operations.replay({
			cutoverCloudOwner: async (accountId) => {
				calls.push(`cutover:${accountId ?? "null"}`);
			},
			clearWindowsForAccount: async (accountId) => {
				calls.push(`clear:${accountId}`);
			},
		});

		expect(calls).toEqual([
			"cutover:null",
			"clear:account-a",
			"cutover:account-a",
		]);
		expect(operations.pendingCount()).toBe(0);
	});
});
