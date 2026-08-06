import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ActivityEventAnalyzer,
	ActivityEventWorkerRequest,
	ActivityEventWorkerResponse,
} from "../src/agent/activity-event-worker";
import {
	ActivityWindowDeliveryService,
	ActivityWindowDeliveryStore,
	type ActivityWindowSource,
	activityWindowWorkerDiagnostic,
} from "../src/agent/activity-window-worker";
import type {
	DesktopEventV1,
	EventWindowV1,
} from "../src/agent/reflection/types";
import { ActivityAnalysisDispatcher } from "../src/bun/activity-analysis-dispatcher";
import type { StartActivityAnalysisRun } from "../src/bun/agent-run-coordinator";
import type { DesktopAuthSessionManager } from "../src/bun/auth-session";

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
	const events = Array.from({ length: count }, (_, offset) =>
		activityEvent(offset + 1),
	);
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
		modelInput:
			"This retained field proves the complete EventWindowV1 is sent.",
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

function stateOnlyWorkerResponse(
	requestId: string,
	sourceEventId: string,
): ActivityEventWorkerResponse {
	return {
		schema_version: "activity-event-analysis-response.v1",
		request_id: requestId,
		events: [
			{
				time: "00:00:01-00:00:01",
				action: "确定：电脑已锁屏",
				source_event_ids: [sourceEventId],
				activity: "idle_transition",
				goal_relevance: "uncertain",
				confidence: 1,
				reason_codes: ["客户端状态边界"],
				evidence: ["检测到已确认的锁屏状态边界"],
				started_at_ms: 1_800,
				ended_at_ms: 1_800,
			},
		],
		score: 0,
		score_reason: "状态事件不计分，计 0 分",
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

	async analyze(
		request: ActivityEventWorkerRequest,
	): Promise<ActivityEventWorkerResponse> {
		this.requests.push(structuredClone(request));
		const raw = request.raw_event as EventWindowV1;
		const source = raw.events[0]?.cursor;
		if (source === undefined)
			throw new Error("A sealed window must include its raw events.");
		const score = this.scores[this.requests.length - 1] ?? 0;
		return workerResponse(request.request_id, source, score);
	}
}

class HallucinatedSourceAnalyzer implements ActivityEventAnalyzer {
	async analyze(
		request: ActivityEventWorkerRequest,
	): Promise<ActivityEventWorkerResponse> {
		return workerResponse(
			request.request_id,
			"not-an-event-from-this-window",
			0.7,
		);
	}
}

function authenticatedTestSession(
	accountId: string,
): DesktopAuthSessionManager {
	const identity = {
		accountId,
		sessionId: `session-${accountId}`,
		generation: 1,
	};
	return {
		accountId,
		getSession: () => null,
		restoreSession: async () => null,
		signIn: async () => {
			throw new Error("not used by this dispatcher test");
		},
		signOut: async () => {},
		authorizedFetch: async () => {
			throw new Error("not used by this dispatcher test");
		},
		captureCurrentSession: () => ({ ...identity }),
		isCurrentSession: (candidate) =>
			candidate.accountId === identity.accountId &&
			candidate.sessionId === identity.sessionId &&
			candidate.generation === identity.generation,
		clearSessionIfCurrent: async () => false,
	};
}

async function eventually(
	predicate: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error("Timed out waiting for activity dispatcher.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("ActivityWindowDeliveryService", () => {
	test("persists a deterministic zero-score state receipt without scheduling an Agent job", () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const window = sealedWindow("window-state-only", 2);
		const requestId = "request-state-only";
		try {
			store.initializeBaseline([]);
			store.enqueue(window, requestId, 1);
			const result = store.apply(
				window.windowId,
				stateOnlyWorkerResponse(requestId, window.windowId),
				1,
				2,
			);
			expect(result).toMatchObject({
				accepted: true,
				triggerBecamePending: false,
				status: { accumulatedScore: 0, agentTriggerPending: false },
			});
			expect(store.nextActivityAnalysisJob(1, "account-state", 3)).toEqual({
				kind: "none",
			});
		} finally {
			store.close();
		}
	});

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

	test("coalesces Worker results into one durable serial Agent job without retaining a raw window payload", async () => {
		const directory = temporaryDirectory();
		const source = new MutableWindowSource([]);
		const analyzer = new RecordingAnalyzer([0.6, 0.6]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const service = new ActivityWindowDeliveryService({
			source,
			analyzer,
			store,
			scoreThreshold: 1,
		});
		try {
			await service.start();
			const first = sealedWindow("window-job-first", 2);
			const second = sealedWindow("window-job-second", 2);
			source.windows.push(first, second);
			await service.enqueueWindow(first);
			await service.enqueueWindow(second);
			await service.whenIdle();

			const next = store.nextActivityAnalysisJob(1, "account-a", Date.now());
			expect(next.kind).toBe("ready");
			if (next.kind !== "ready")
				throw new Error("Expected a pending activity job.");
			expect(next.job).toMatchObject({
				state: "pending",
				consumedScore: 1.2,
				analyses: [
					{ request_id: expect.stringContaining("activity_window_") },
					{ request_id: expect.stringContaining("activity_window_") },
				],
			});
			const serializedJob = JSON.stringify(next.job);
			expect(serializedJob).not.toContain("raw_event");
			expect(serializedJob).not.toContain("modelInput");
			expect(serializedJob).not.toContain("Complete raw event");

			const claimed = store.claimActivityAnalysisJob(
				next.job.jobId,
				"account-a",
				"activity-run-a",
				Date.now(),
			);
			expect(claimed.state).toBe("running");
			expect(store.nextActivityAnalysisJob(1, "account-b", Date.now())).toEqual(
				{
					kind: "account_mismatch",
				},
			);

			// A process interruption releases only the same account's durable job.
			const recoveredAtMs = Date.now() + 1;
			store.recoverActivityAnalysisJobs(1, recoveredAtMs);
			expect(store.nextActivityAnalysisJob(1, "account-b", Date.now())).toEqual(
				{
					kind: "account_mismatch",
				},
			);
			const resumed = store.nextActivityAnalysisJob(
				1,
				"account-a",
				recoveredAtMs,
			);
			expect(resumed.kind).toBe("ready");
			if (resumed.kind !== "ready")
				throw new Error("Expected recovered activity job.");
			expect(resumed.job).toMatchObject({
				attempt: 1,
				nextAttemptAtMs: recoveredAtMs,
				updatedAtMs: recoveredAtMs,
			});
			store.claimActivityAnalysisJob(
				resumed.job.jobId,
				"account-a",
				"activity-run-a-retry",
				recoveredAtMs,
			);
			store.completeActivityAnalysisJob(
				resumed.job.jobId,
				"account-a",
				"activity-run-a-retry",
				1,
				recoveredAtMs + 1,
			);
			expect(service.getStatus()).toMatchObject({
				accumulatedScore: 0,
				agentTriggerPending: false,
			});
		} finally {
			await service.stop();
			store.close();
		}
	});

	test("automatically starts exactly one account-bound background Agent job after the score threshold", async () => {
		const directory = temporaryDirectory();
		const source = new MutableWindowSource([]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const starts: StartActivityAnalysisRun[] = [];
		const dispatcherErrors: string[] = [];
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator: {
				startActivityAnalysis: async (input) => {
					starts.push(structuredClone(input));
				},
			},
			onError: (error) =>
				dispatcherErrors.push(
					error instanceof Error ? error.message : String(error),
				),
		});
		const service = new ActivityWindowDeliveryService({
			source,
			analyzer: new RecordingAnalyzer([0.6, 0.6]),
			store,
			scoreThreshold: 1,
			onAgentTriggerRequired: () => dispatcher.wake(),
		});
		try {
			dispatcher.start();
			await service.start();
			const first = sealedWindow("window-auto-agent-first", 2);
			const second = sealedWindow("window-auto-agent-second", 2);
			source.windows.push(first, second);
			await service.enqueueWindow(first);
			await service.enqueueWindow(second);
			await service.whenIdle();
			await eventually(() => starts.length === 1);
			const started = structuredClone(starts[0]);
			if (!started)
				throw new Error("Expected an automatic activity analysis run.");
			const jobId = started.jobId;
			const runId = started.runId;
			expect(structuredClone(started)).toMatchObject({
				jobId: expect.stringContaining("activity_analysis_"),
				consumedScore: 1.2,
				analyses: [{ score: 0.6 }, { score: 0.6 }],
			});
			expect(JSON.stringify(structuredClone(started))).not.toContain(
				"raw_event",
			);
			expect(JSON.stringify(structuredClone(started))).not.toContain(
				"modelInput",
			);
			dispatcher.wake();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(starts).toHaveLength(1);

			await dispatcher.onActivityRunTerminal({
				jobId,
				runId,
				accountId: "account-a",
				status: "completed",
				failure: null,
			});
			expect(dispatcherErrors).toEqual([]);
			await eventually(() => service.getStatus().accumulatedScore === 0);
		} finally {
			await service.stop();
			await dispatcher.stop();
			store.close();
		}
	});

	test("re-arms a later retry timer when a wake discovers an earlier due job", async () => {
		let nextAttemptAtMs = Date.now() + 500;
		let nextCalls = 0;
		const store = {
			recoverActivityAnalysisJobs: () => false,
			nextActivityAnalysisJob: () => {
				nextCalls += 1;
				return { kind: "not_due" as const, nextAttemptAtMs };
			},
		} as unknown as ActivityWindowDeliveryStore;
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator: {
				startActivityAnalysis: async () => {
					throw new Error("The test store never returns a ready job.");
				},
			},
		});
		try {
			dispatcher.start();
			await eventually(() => nextCalls === 1);
			nextAttemptAtMs = Date.now() + 15;
			dispatcher.wake();
			await eventually(() => nextCalls >= 3, 250);
		} finally {
			await dispatcher.stop();
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
			const deliveredRequest = analyzer.requests[0];
			if (!deliveredRequest) {
				throw new Error("Expected the recovered activity window request.");
			}
			expect((deliveredRequest.raw_event as EventWindowV1).windowId).toBe(
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
		const errors: unknown[] = [];
		const service = new ActivityWindowDeliveryService({
			source,
			analyzer: new HallucinatedSourceAnalyzer(),
			store,
			onAcceptedAnalysis: ({ response }) => {
				accepted.push(response);
			},
			onError: (error) => errors.push(error),
		});
		try {
			await service.start();
			source.windows.push(window);
			await service.enqueueWindow(window);
			await service.whenIdle();
			expect(accepted).toMatchObject([
				{
					events: [{ source_event_ids: ["window-scope-anchor"] }],
				},
			]);
			expect(service.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
			});
			expect(errors).toHaveLength(1);
			expect(activityWindowWorkerDiagnostic(errors[0])).toMatchObject({
				code: "invalid_response",
				validationStage: "source_ids",
				triggerReason: "event_count",
				eventCount: 2,
			});
		} finally {
			await service.stop();
			store.close();
		}
	});

	test("splits a signed-out receipt backlog into bounded serial jobs without losing score", () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const threshold = 1;
		const receiptCount = 514;
		try {
			store.initializeBaseline([]);
			for (let index = 0; index < receiptCount; index += 1) {
				const window = sealedWindow(`window-backlog-${index}`, 1);
				const requestId = `request-backlog-${index}`;
				store.enqueue(window, requestId, index);
				store.apply(
					window.windowId,
					workerResponse(requestId, window.windowId, 1),
					threshold,
					receiptCount + index,
				);
			}

			let consumedResults = 0;
			let completedJobs = 0;
			while (true) {
				const next = store.nextActivityAnalysisJob(
					threshold,
					"account-backlog",
					receiptCount * 2 + completedJobs,
				);
				if (next.kind === "none") break;
				if (next.kind !== "ready")
					throw new Error("Expected a ready bounded activity job.");
				expect(next.job.analyses.length).toBeGreaterThan(0);
				expect(next.job.analyses.length).toBeLessThanOrEqual(512);
				expect(JSON.stringify(next.job.analyses).length).toBeLessThanOrEqual(
					48 * 1024,
				);
				expect(next.job.consumedScore).toBe(next.job.analyses.length);
				consumedResults += next.job.analyses.length;
				completedJobs += 1;
				const runId = `backlog-run-${completedJobs}`;
				store.claimActivityAnalysisJob(
					next.job.jobId,
					"account-backlog",
					runId,
					receiptCount * 3 + completedJobs,
				);
				store.completeActivityAnalysisJob(
					next.job.jobId,
					"account-backlog",
					runId,
					threshold,
					receiptCount * 4 + completedJobs,
				);
			}
			expect(consumedResults).toBe(receiptCount);
			expect(completedJobs).toBeGreaterThan(1);
		} finally {
			store.close();
		}
	});

	test("preserves leading zero-score event summaries after the threshold is reached", () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const threshold = 1;
		const zeroScoreReceiptCount = 200;
		try {
			store.initializeBaseline([]);
			for (let index = 0; index < zeroScoreReceiptCount + 1; index += 1) {
				const window = sealedWindow(`window-zero-score-${index}`, 1);
				const requestId = `request-zero-score-${index}`;
				const score = index === zeroScoreReceiptCount ? 1 : 0;
				store.enqueue(window, requestId, index);
				store.apply(
					window.windowId,
					workerResponse(requestId, window.windowId, score),
					threshold,
					zeroScoreReceiptCount + index,
				);
			}

			let consumedResults = 0;
			let consumedScore = 0;
			let observedZeroScoreJob = false;
			let completedJobs = 0;
			while (true) {
				const next = store.nextActivityAnalysisJob(
					threshold,
					"account-zero-score",
					zeroScoreReceiptCount * 2 + completedJobs,
				);
				if (next.kind === "none") break;
				if (next.kind !== "ready")
					throw new Error("Expected a ready zero-score activity job.");
				if (next.job.consumedScore === 0) observedZeroScoreJob = true;
				consumedResults += next.job.analyses.length;
				consumedScore += next.job.consumedScore;
				completedJobs += 1;
				const runId = `zero-score-run-${completedJobs}`;
				store.claimActivityAnalysisJob(
					next.job.jobId,
					"account-zero-score",
					runId,
					zeroScoreReceiptCount * 3 + completedJobs,
				);
				store.completeActivityAnalysisJob(
					next.job.jobId,
					"account-zero-score",
					runId,
					threshold,
					zeroScoreReceiptCount * 4 + completedJobs,
				);
			}
			expect(observedZeroScoreJob).toBeTrue();
			expect(consumedResults).toBe(zeroScoreReceiptCount + 1);
			expect(consumedScore).toBe(1);
		} finally {
			store.close();
		}
	});
});
