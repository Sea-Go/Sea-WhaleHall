import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ActivityWindowDeliveryService,
	ActivityWindowDeliveryStore,
	type ActivityWindowSource,
} from "../src/agent/activity-window-worker";
import type {
	ActivityEventAnalyzer,
	ActivityEventWorkerRequest,
	ActivityEventWorkerResponse,
} from "../src/agent/activity-event-worker";
import type { DesktopEventV1, EventWindowV1 } from "../src/agent/reflection/types";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-activity-window-"));
	directories.push(directory);
	return directory;
}

function sealedWindow(windowId: string, count = 64): EventWindowV1 {
	const events = Array.from({ length: count }, (_, offset) => activityEvent(offset + 1));
	const startedAtMs = events[0]?.occurredAtMs ?? 1_000;
	const endedAtMs = events.at(-1)?.observedAtMs ?? startedAtMs;
	return {
		schemaVersion: "event-window.v1",
		windowId,
		collectorId: "collector-test",
		deviceId: "device-test",
		sessionId: "session-test",
		triggerReason: "event_count",
		goal: {
			goalId: "goal-1",
			planId: null,
			version: 1,
			text: "Implement the reflection window delivery path",
			activatedAtMs: 0,
		},
		goalVersion: 1,
		startedAtMs,
		endedAtMs,
		deadlineAtMs: startedAtMs + 300_000,
		eventCount: events.length,
		firstCursor: events[0]?.cursor ?? "ec1_0000000000000001",
		lastCursor: events.at(-1)?.cursor ?? "ec1_0000000000000040",
		events,
		contextOnly: [],
		modelInput: "This retained field proves the complete EventWindowV1 is sent.",
		inputHash: `hash-${windowId}`,
	};
}

function activityEvent(index: number): DesktopEventV1 {
	const occurredAtMs = 1_000 + index * 10;
	return {
		schemaVersion: "desktop-event.v1",
		eventId: `event-${index}`,
		cursor: `ec1_${index.toString(16).padStart(16, "0")}`,
		deviceId: "device-test",
		sessionId: "session-test",
		kind: "application.foregroundChanged",
		source: "test",
		occurredAtMs,
		observedAtMs: occurredAtMs + 1,
		goalVersion: 1,
		sensitivity: "metadata",
		payload: {
			appId: `com.example.App${index}`,
			appName: `App ${index}`,
			windowTitle: `Complete raw event ${index}`,
		},
	};
}

function workerResponse(
	requestId: string,
	sourceEventId: string,
	score: number,
): ActivityEventWorkerResponse {
	return {
		schema_version: "activity-event-analysis-response.v1",
		request_id: requestId,
		events: [
			{
				source_event_ids: [sourceEventId],
				activity: "development",
				goal_relevance: "direct",
				confidence: 0.9,
				reason_codes: ["window_evidence"],
				evidence: ["Complete reflection window"],
				started_at_ms: 1_010,
				ended_at_ms: 1_011,
			},
		],
		score,
		score_reason: "Window contains goal-relevant work.",
	};
}

class MutableWindowSource implements ActivityWindowSource {
	constructor(readonly windows: EventWindowV1[]) {}

	async listWindows(): Promise<readonly EventWindowV1[]> {
		return structuredClone(this.windows);
	}
}

class RecordingAnalyzer implements ActivityEventAnalyzer {
	readonly requests: ActivityEventWorkerRequest[] = [];

	constructor(private readonly scores: readonly number[]) {}

	async analyze(request: ActivityEventWorkerRequest): Promise<ActivityEventWorkerResponse> {
		this.requests.push(structuredClone(request));
		const raw = request.raw_event as EventWindowV1;
		const source = raw.events[0]?.cursor;
		if (source === undefined) throw new Error("A sealed window must include its raw events.");
		const score = this.scores[this.requests.length - 1] ?? 0;
		return workerResponse(request.request_id, source, score);
	}
}

class HallucinatedSourceAnalyzer implements ActivityEventAnalyzer {
	async analyze(request: ActivityEventWorkerRequest): Promise<ActivityEventWorkerResponse> {
		return workerResponse(request.request_id, "not-an-event-from-this-window", 0.7);
	}
}

describe("ActivityWindowDeliveryService", () => {
	test("sends one complete sealed window, not one request per raw event", async () => {
		const directory = temporaryDirectory();
		const source = new MutableWindowSource([]);
		const analyzer = new RecordingAnalyzer([0.6, 0.6]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const triggerScores: number[] = [];
		const service = new ActivityWindowDeliveryService({
			source,
			analyzer,
			store,
			scoreThreshold: 1,
			onAgentTriggerRequired: (status) => {
				triggerScores.push(status.accumulatedScore);
			},
		});
		try {
			await service.start();
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(0);

			const first = sealedWindow("window-new-1");
			source.windows.push(first);
			await service.enqueueWindow(first);
			await service.whenIdle();

			expect(analyzer.requests).toHaveLength(1);
			expect(analyzer.requests[0]?.raw_event).toEqual(first);
			expect(analyzer.requests[0]?.context).toMatchObject({
				response_contract: {
					analysis_unit: "sealed_reflection_window",
					source_window_id: "window-new-1",
					source_event_ids: ["window-new-1"],
					source_event_cursor_ids: first.events.map((event) => event.cursor),
					window_trigger_reason: "event_count",
				},
			});
			expect(service.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				accumulatedScore: 0.6,
				pendingWindowCount: 0,
				agentTriggerPending: false,
			});

			await service.enqueueWindow(first);
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(1);

			const second = sealedWindow("window-new-2", 2);
			source.windows.push(second);
			await service.enqueueWindow(second);
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(2);
			expect(triggerScores).toEqual([1.2]);
			expect(service.getStatus()).toMatchObject({
				acceptedAnalysisCount: 2,
				accumulatedScore: 1.2,
				agentTriggerPending: true,
			});
		} finally {
			await service.stop();
			store.close();
		}
	});

	test("does not backfill windows sealed before cutover and repairs a missed new-window notification", async () => {
		const directory = temporaryDirectory();
		const legacy = sealedWindow("window-before-cutover", 2);
		const newWindow = sealedWindow("window-after-cutover", 2);
		const source = new MutableWindowSource([legacy]);

		const firstStore = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const firstService = new ActivityWindowDeliveryService({
			source,
			analyzer: new RecordingAnalyzer([0.8]),
			store: firstStore,
		});
		await firstService.start();
		await firstService.whenIdle();
		expect(firstService.getStatus().acceptedAnalysisCount).toBe(0);
		await firstService.stop();
		firstStore.close();

		// Simulate a process stop just after Reflection sealed a new window but
		// before its asynchronous notification reached the activity outbox.
		source.windows.push(newWindow);
		const analyzer = new RecordingAnalyzer([0.8]);
		const recoveredStore = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const recovered = new ActivityWindowDeliveryService({
			source,
			analyzer,
			store: recoveredStore,
		});
		try {
			await recovered.start();
			await recovered.whenIdle();
			expect(analyzer.requests).toHaveLength(1);
			expect((analyzer.requests[0]?.raw_event as EventWindowV1).windowId).toBe(
				"window-after-cutover",
			);
			expect(recovered.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
			});
		} finally {
			await recovered.stop();
			recoveredStore.close();
		}
	});

	test("binds a compact-model hallucinated sub-event id back to the submitted window", async () => {
		const directory = temporaryDirectory();
		const window = sealedWindow("window-scope-anchor", 2);
		const source = new MutableWindowSource([]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const accepted: ActivityEventWorkerResponse[] = [];
		const service = new ActivityWindowDeliveryService({
			source,
			analyzer: new HallucinatedSourceAnalyzer(),
			store,
			onAcceptedAnalysis: ({ response }) => {
				accepted.push(response);
			},
		});
		try {
			await service.start();
			source.windows.push(window);
			await service.enqueueWindow(window);
			await service.whenIdle();
			expect(accepted).toMatchObject([
				{
					events: [
						{ source_event_ids: ["window-scope-anchor"] },
					],
				},
			]);
			expect(service.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
			});
		} finally {
			await service.stop();
			store.close();
		}
	});
});
