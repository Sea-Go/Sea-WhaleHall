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

	test("retains the failed intent and later operations for the next candidate", async () => {
		const operations = new DeferredReflectionOperations();
		const calls: string[] = [];
		let failClear = true;
		operations.deferCutover(null);
		operations.deferClearHandoffs("account-a");
		operations.deferCutover("account-a");
		const target = {
			cutoverCloudOwner: async (accountId: string | null) => {
				calls.push(`cutover:${accountId ?? "null"}`);
			},
			clearWindowsForAccount: async (accountId: string) => {
				calls.push(`clear:${accountId}`);
				if (failClear) throw new Error("storage unavailable");
			},
		};

		await expect(operations.replay(target)).rejects.toThrow(
			"storage unavailable",
		);
		expect(calls).toEqual(["cutover:null", "clear:account-a"]);
		expect(operations.pendingCount()).toBe(2);

		failClear = false;
		await operations.replay(target);
		expect(calls).toEqual([
			"cutover:null",
			"clear:account-a",
			"clear:account-a",
			"cutover:account-a",
		]);
		expect(operations.pendingCount()).toBe(0);
	});

	test("publishes in the same turn as the final drain so a late barrier reaches the live target", async () => {
		const operations = new DeferredReflectionOperations();
		const calls: string[] = [];
		let liveTarget: {
			cutoverCloudOwner(accountId: string | null): Promise<void>;
			clearWindowsForAccount(accountId: string): Promise<void>;
		} | null = null;
		const target = {
			cutoverCloudOwner: async (accountId: string | null) => {
				calls.push(`cutover:${accountId ?? "null"}`);
			},
			clearWindowsForAccount: async (accountId: string) => {
				calls.push(`clear:${accountId}`);
			},
		};
		const routeCutover = (accountId: string | null): Promise<void> => {
			const runtime = liveTarget;
			if (runtime !== null) return runtime.cutoverCloudOwner(accountId);
			operations.deferCutover(accountId);
			return Promise.resolve();
		};

		operations.deferCutover("account-a");
		const publication = operations.replayAndPublish(target, () => {
			liveTarget = target;
		});
		// Register this continuation before awaiting publication. With a separate
		// replay-then-publish sequence it deterministically lands in the gap and
		// leaves an intent behind. Atomic publication makes it use the live target.
		const lateBarrier = publication.then(() => routeCutover(null));

		await publication;
		await lateBarrier;

		expect(calls).toEqual(["cutover:account-a", "cutover:null"]);
		expect(operations.pendingCount()).toBe(0);
	});

	test("never publishes a candidate when shutdown closes an in-flight drain", async () => {
		const operations = new DeferredReflectionOperations();
		let releaseCutover!: () => void;
		const cutoverBlocked = new Promise<void>((resolve) => {
			releaseCutover = resolve;
		});
		let publishCalls = 0;
		operations.deferCutover("account-a");
		const publication = operations.replayAndPublish(
			{
				cutoverCloudOwner: async () => cutoverBlocked,
				clearWindowsForAccount: async () => undefined,
			},
			() => {
				publishCalls += 1;
			},
		);
		await Promise.resolve();

		operations.close();
		releaseCutover();

		await expect(publication).rejects.toBeInstanceOf(
			DeferredReflectionOperationsClosedError,
		);
		expect(publishCalls).toBe(0);
		expect(operations.pendingCount()).toBe(0);
	});

	test("rejects every new intent after the shutdown latch closes", () => {
		const operations = new DeferredReflectionOperations();
		operations.deferCutover("account-a");
		operations.close();
		operations.close();

		expect(() => operations.deferCutover(null)).toThrow(
			DeferredReflectionOperationsClosedError,
		);
		expect(() => operations.deferClearHandoffs("account-a")).toThrow(
			DeferredReflectionOperationsClosedError,
		);
		expect(operations.pendingCount()).toBe(0);
	});

	test("does not confirm a destructive clear before its durable target runs", () => {
		const operations = new DeferredReflectionOperations();

		expect(() =>
			operations.deferClearHandoffs("account-a", {
				requireCompletion: true,
			}),
		).toThrow(DeferredReflectionOperationUnconfirmedError);
		expect(operations.pendingCount()).toBe(1);
	});
});
