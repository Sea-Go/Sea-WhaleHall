import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ActivityWindowDeliveryService,
	ActivityWindowDeliveryStore,
	type ActivityWindowSource,
} from "../src/agent/activity-window-worker";
import type { EventWindowV1 } from "../src/agent/reflection/types";
import { stopActivityWindowDeliveryResources } from "../src/bun/activity-window-delivery-lifecycle";
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
