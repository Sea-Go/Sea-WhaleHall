import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ActivityWindowDeliveryService,
	ActivityWindowDeliveryStore,
	type ActivityWindowSource,
} from "../src/agent/activity-window-worker";
import type { EventWindowV1 } from "../src/agent/reflection/types";
import {
	ActivityWindowDeliveryLifecycle,
	type ActivityWindowDeliveryStartAttempt,
	stopActivityWindowDeliveryResources,
} from "../src/bun/activity-window-delivery-lifecycle";
import {
	type ActivityReflectionSidecar,
	MastraActivityReflectionAnalyzer,
} from "../src/bun/mastra-activity-reflection";
import type { AuthSessionIdentity } from "../src/shared/session-identity";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("activity window delivery shutdown", () => {
	test("invalidates and joins an unpublished start before stop completes", async () => {
		const gate = deferred<void>();
		const order: string[] = [];
		const lifecycle = testLifecycle(async (resource) => {
			order.push(`release:${resource.id}`);
		});
		const start = lifecycle.start("account-a", async (attempt) => {
			attempt.own({ id: "a" });
			order.push("owned");
			await gate.promise;
			attempt.assertCurrent();
			order.push("started");
		});
		await eventually(() => expect(order).toEqual(["owned"]));

		let stopSettled = false;
		const stop = lifecycle.stop().then(() => {
			stopSettled = true;
		});
		await Promise.resolve();
		expect(stopSettled).toBe(false);
		gate.resolve();

		await expect(start).rejects.toThrow("invalidated");
		await stop;
		expect(order).toEqual(["owned", "release:a"]);
		expect(lifecycle.currentResources).toBeNull();
		expect(lifecycle.isReady).toBe(false);
	});

	test("a synchronous close latch prevents a late start from becoming ready", async () => {
		const gate = deferred<void>();
		let releases = 0;
		const lifecycle = testLifecycle(async () => {
			releases += 1;
		});
		const start = lifecycle.start("account-a", async (attempt) => {
			attempt.own({ id: "a" });
			await gate.promise;
			attempt.assertCurrent();
		});
		await eventually(() => expect(lifecycle.currentResources).not.toBeNull());

		lifecycle.close();
		const stop = lifecycle.stop();
		gate.resolve();

		await expect(start).rejects.toThrow("invalidated");
		await stop;
		expect(releases).toBe(1);
		await expect(lifecycle.start("account-a", async () => {})).rejects.toThrow(
			"closed",
		);
	});

	test("deduplicates one exact start and rejects a competing owner", async () => {
		const gate = deferred<void>();
		let starts = 0;
		const lifecycle = testLifecycle(async () => {});
		const run = async (
			attempt: ActivityWindowDeliveryStartAttempt<{ id: string }>,
		): Promise<void> => {
			starts += 1;
			attempt.own({ id: "a" });
			await gate.promise;
		};
		const first = lifecycle.start("account-a", run);
		const duplicate = lifecycle.start("account-a", run);
		await expect(lifecycle.start("account-b", async () => {})).rejects.toThrow(
			"another session",
		);
		gate.resolve();
		await Promise.all([first, duplicate]);
		expect(starts).toBe(1);
		expect(lifecycle.isReady).toBe(true);
		await lifecycle.stop();
	});

	test("keeps the active attempt valid until stop invalidates its bundle", async () => {
		const lifecycle = testLifecycle(async () => {});
		let captured!: ActivityWindowDeliveryStartAttempt<{ id: string }>;
		await lifecycle.start("account-a", async (attempt) => {
			captured = attempt;
			attempt.own({ id: "a" });
		});

		expect(captured.isCurrent()).toBe(true);
		await lifecycle.start("account-a", async () => {
			throw new Error("an exact ready start must stay idempotent");
		});
		expect(captured.isCurrent()).toBe(true);

		const stop = lifecycle.stop();
		expect(captured.isCurrent()).toBe(false);
		await stop;
		let replacement!: ActivityWindowDeliveryStartAttempt<{ id: string }>;
		await lifecycle.start("account-a", async (attempt) => {
			replacement = attempt;
			attempt.own({ id: "replacement" });
		});
		expect(replacement.isCurrent()).toBe(true);
		expect(captured.isCurrent()).toBe(false);
		await lifecycle.stop();
	});

	test("retains a failed cleanup bundle for an exact stop retry", async () => {
		let releaseAttempts = 0;
		const lifecycle = testLifecycle(async () => {
			releaseAttempts += 1;
			if (releaseAttempts === 1) throw new Error("release failed");
		});
		await expect(
			lifecycle.start("account-a", async (attempt) => {
				attempt.own({ id: "a" });
				throw new Error("start failed");
			}),
		).rejects.toThrow("start and cleanup both failed");
		expect(lifecycle.currentResources).toEqual({ id: "a" });

		await lifecycle.stop();
		expect(releaseAttempts).toBe(2);
		expect(lifecycle.currentResources).toBeNull();
	});

	test("production wiring closes and revalidates the exact attempt", () => {
		const composition = readFileSync(
			join(import.meta.dir, "../src/bun/index.ts"),
			"utf8",
		);
		expect(composition).toContain("activityWindowDeliveryLifecycle.close();");
		expect(composition).toContain(
			"await activityWindowDeliveryLifecycle.start(key, async (attempt)",
		);
		expect(composition).toContain("await dispatcher.startAndRecover();");
		expect(composition).toContain("await delivery.start();");
		expect(
			composition.indexOf("await dispatcher.startAndRecover();"),
		).toBeLessThan(composition.indexOf("await delivery.start();"));
		expect(composition.indexOf("await delivery.start();")).toBeLessThan(
			composition.indexOf("\n\t\tdispatcher.start();"),
		);
		expect(
			composition.match(/assertAttemptCurrent\(\);/g)?.length ?? 0,
		).toBeGreaterThanOrEqual(5);
		expect(composition).not.toContain(
			"catch (error) {\n\t\tawait stopActivityWindowDelivery();",
		);
	});

	test("closes the analyzer before draining each dependent resource", async () => {
		const order: string[] = [];
		await stopActivityWindowDeliveryResources({
			analyzer: {
				close: () => {
					order.push("analyzer");
				},
			},
			delivery: {
				stop: () => {
					order.push("delivery");
				},
			},
			dispatcher: {
				stop: () => {
					order.push("dispatcher");
				},
			},
			store: {
				close: () => {
					order.push("store");
				},
			},
		});
		expect(order).toEqual(["analyzer", "delivery", "dispatcher", "store"]);
	});

	test("reports every stop failure after attempting all owned resources", async () => {
		const order: string[] = [];
		const reported: string[] = [];
		await expect(
			stopActivityWindowDeliveryResources(
				{
					analyzer: {
						close: () => {
							order.push("analyzer");
							throw new Error("analyzer stop failed");
						},
					},
					delivery: {
						stop: () => {
							order.push("delivery");
							throw new Error("delivery stop failed");
						},
					},
					dispatcher: {
						stop: () => {
							order.push("dispatcher");
						},
					},
					store: {
						close: () => {
							order.push("store");
						},
					},
				},
				(resource) => reported.push(resource),
			),
		).rejects.toThrow("did not stop every owned resource");
		expect(order).toEqual(["analyzer", "delivery", "dispatcher", "store"]);
		expect(reported).toEqual(["analyzer", "delivery"]);
	});

	test("aborts an in-flight analysis and preserves its durable outbox window", async () => {
		const directory = mkdtempSync(
			join(tmpdir(), "whalehall-activity-shutdown-"),
		);
		directories.push(directory);
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const source = new MutableWindowSource([]);
		let analysisStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			analysisStarted = resolve;
		});
		const abortedInvocations: string[] = [];
		const sidecar: ActivityReflectionSidecar = {
			request<TResult = unknown>(
				_method: Parameters<ActivityReflectionSidecar["request"]>[0],
				_params: Parameters<ActivityReflectionSidecar["request"]>[1],
				options: Parameters<ActivityReflectionSidecar["request"]>[2],
			): Promise<TResult> {
				analysisStarted();
				return new Promise<TResult>((_resolve, reject) => {
					const rejectAborted = () => reject(new Error("analysis aborted"));
					if (options?.signal?.aborted) rejectAborted();
					else
						options?.signal?.addEventListener("abort", rejectAborted, {
							once: true,
						});
				});
			},
		};
		const analyzer = new MastraActivityReflectionAnalyzer({
			sidecar,
			onInvocationAbort: (invocationId) =>
				abortedInvocations.push(invocationId),
		});
		const store = new ActivityWindowDeliveryStore(databasePath);
		const owner: AuthSessionIdentity = {
			accountId: "account-shutdown",
			sessionId: "session-shutdown",
			generation: 1,
		};
		const delivery = new ActivityWindowDeliveryService({
			source,
			analyzer,
			store,
			retryDelaysMs: [60_000],
			currentSession: () => ({ ...owner }),
			isCurrentSession: (candidate) =>
				candidate.accountId === owner.accountId &&
				candidate.sessionId === owner.sessionId &&
				candidate.generation === owner.generation,
		});
		await delivery.start();
		const window = sealedWindow("shutdown-window");
		source.windows.push(window);
		await delivery.enqueueWindow(window);
		await started;

		await stopActivityWindowDeliveryResources({
			analyzer,
			delivery,
			dispatcher: null,
			store,
		});
		expect(abortedInvocations).toHaveLength(1);

		const recovered = new ActivityWindowDeliveryStore(databasePath);
		try {
			expect(recovered.getStatus(1)).toMatchObject({
				pendingWindowCount: 1,
				terminalWindowCount: 0,
			});
		} finally {
			recovered.close();
		}
	});
});

function testLifecycle(
	release: (resource: { id: string }) => Promise<void>,
): ActivityWindowDeliveryLifecycle<string, { id: string }> {
	return new ActivityWindowDeliveryLifecycle({
		sameKey: (left, right) => left === right,
		release,
	});
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value?: T): void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return {
		promise,
		resolve(value?: T) {
			resolve(value as T);
		},
	};
}

async function eventually(assertion: () => void): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			assertion();
			return;
		} catch {
			await Promise.resolve();
		}
	}
	assertion();
}

class MutableWindowSource implements ActivityWindowSource {
	constructor(readonly windows: EventWindowV1[]) {}

	async listWindowsForAccount(): Promise<readonly EventWindowV1[]> {
		return [];
	}
}

function sealedWindow(windowId: string): EventWindowV1 {
	return {
		schemaVersion: "event-window.v1",
		windowId,
		collectorId: "collector-test",
		deviceId: "device-test",
		sessionId: "session-test",
		triggerReason: "event_count",
		goal: null,
		goalVersion: 0,
		startedAtMs: 1_000,
		endedAtMs: 1_001,
		deadlineAtMs: 301_000,
		eventCount: 1,
		firstCursor: "ec1_0000000000000001",
		lastCursor: "ec1_0000000000000001",
		events: [
			{
				schemaVersion: "desktop-event.v1",
				eventId: "event-1",
				cursor: "ec1_0000000000000001",
				deviceId: "device-test",
				sessionId: "session-test",
				kind: "application.foregroundChanged",
				source: "test",
				occurredAtMs: 1_000,
				observedAtMs: 1_001,
				goalVersion: 0,
				sensitivity: "metadata",
				payload: { appId: "com.example.Editor", appName: "Editor" },
			},
		],
		contextOnly: [],
		modelInput: "Complete sealed window",
		inputHash: `hash-${windowId}`,
	};
}
