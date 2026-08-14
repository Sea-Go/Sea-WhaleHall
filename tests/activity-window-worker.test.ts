import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ActivityEventAnalyzer,
	ActivityEventWorkerRequest,
	ActivityEventWorkerResponse,
} from "../src/agent/activity-event-worker";
import { ActivityEventWorkerClientError } from "../src/agent/activity-event-worker";
import {
	type ActivityAnalysisJob,
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
import {
	CredentialHelperError,
	type CredentialKeyReference,
	type CredentialKeyStore,
} from "../src/bun/credential-helper-client";
import { EncryptedAgentRepository } from "../src/bun/encrypted-agent-repository";
import type { ActivityAnalysisWorkerResult } from "../src/shared/activity-analysis-contract";
import type { AuthSessionIdentity } from "../src/shared/session-identity";

const directories: string[] = [];
const activityOwner: AuthSessionIdentity = {
	accountId: "account-a",
	sessionId: "session-account-a",
	generation: 1,
};

function ownerBoundary(identity = activityOwner) {
	return {
		currentSession: () => ({ ...identity }),
		isCurrentSession: (candidate: AuthSessionIdentity) =>
			candidate.accountId === identity.accountId &&
			candidate.sessionId === identity.sessionId &&
			candidate.generation === identity.generation,
	};
}

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
	constructor(
		readonly windows: EventWindowV1[],
		readonly ownerAccountId: string | null = null,
	) {}

	async listWindowsForAccount(
		accountId: string,
	): Promise<readonly EventWindowV1[]> {
		return accountId === this.ownerAccountId
			? structuredClone(this.windows)
			: [];
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

type FirstStageOutcome =
	| "success"
	| "transient"
	| "control_character"
	| "timestamp"
	| "invalid_response";

class ScriptedFirstStageAnalyzer implements ActivityEventAnalyzer {
	readonly requests: ActivityEventWorkerRequest[] = [];

	constructor(private readonly outcomes: readonly FirstStageOutcome[]) {}

	async analyze(
		request: ActivityEventWorkerRequest,
	): Promise<ActivityEventWorkerResponse> {
		this.requests.push(structuredClone(request));
		const outcome = this.outcomes[this.requests.length - 1] ?? "success";
		if (outcome === "transient") {
			throw new ActivityEventWorkerClientError("http_error", true, 503);
		}
		const window = request.raw_event as EventWindowV1;
		const response = workerResponse(
			outcome === "invalid_response"
				? `${request.request_id}-mismatch`
				: request.request_id,
			window.windowId,
			0.5,
		);
		if (outcome === "control_character") {
			response.score_reason = "模型输出包含\u0085隐藏控制字符";
		}
		if (outcome === "timestamp") {
			const event = response.events[0];
			if (event === undefined) throw new Error("Expected one Worker event.");
			event.ended_at_ms = window.endedAtMs + 1;
		}
		return response;
	}
}

class ActivityTestKeyStore implements CredentialKeyStore {
	private readonly keys = new Map<string, Uint8Array>();

	async getKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const key = this.keys.get(activityKeyReference(reference));
		if (!key) throw new CredentialHelperError("NOT_FOUND");
		return key.slice();
	}

	async createKey(reference: CredentialKeyReference): Promise<Uint8Array> {
		const id = activityKeyReference(reference);
		if (this.keys.has(id)) throw new CredentialHelperError("ALREADY_EXISTS");
		const key = Uint8Array.from(
			{ length: 32 },
			(_, index) => (index * 29 + 17) & 0xff,
		);
		this.keys.set(id, key);
		return key.slice();
	}

	async deleteKey(
		reference: CredentialKeyReference,
	): Promise<{ deleted: boolean }> {
		return { deleted: this.keys.delete(activityKeyReference(reference)) };
	}
}

function activityKeyReference(reference: CredentialKeyReference): string {
	return `${reference.installationId}:${reference.accountId}:v${reference.keyVersion}`;
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

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function seedActivityAnalysisJob(
	store: ActivityWindowDeliveryStore,
	suffix: string,
	nowMs = 1_000,
): ActivityAnalysisJob {
	const window = sealedWindow(`window-${suffix}`, 1);
	const requestId = `worker-request-${suffix}`;
	const sourceEvent = window.events[0];
	if (sourceEvent === undefined) {
		throw new Error("Expected the seeded activity window to contain an event.");
	}
	store.initializeBaseline([], activityOwner);
	store.enqueue(window, requestId, nowMs, activityOwner);
	store.apply(
		window.windowId,
		workerResponse(requestId, sourceEvent.cursor, 1),
		1,
		nowMs + 1,
	);
	const ready = store.nextActivityAnalysisJob(1, "account-a", nowMs + 2);
	if (ready.kind !== "ready") {
		throw new Error("Expected a seeded activity analysis job.");
	}
	return ready.job;
}

describe("ActivityWindowDeliveryService", () => {
	test("clears legacy unowned rows before completing the policy cutover", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const legacy = new Database(databasePath, { create: true, strict: true });
		legacy.exec(`
			CREATE TABLE activity_window_worker_outbox (
				window_id TEXT PRIMARY KEY,
				request_id TEXT NOT NULL UNIQUE,
				window_json TEXT NOT NULL,
				queued_at_ms INTEGER NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt >= 0),
				next_attempt_at_ms INTEGER NOT NULL,
				terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
				last_error TEXT
			);
			INSERT INTO activity_window_worker_outbox
			 (window_id, request_id, window_json, queued_at_ms, attempt,
			  next_attempt_at_ms, terminal, last_error)
			 VALUES
			 ('legacy-pending', 'legacy-request-pending', '{}', 1, 0, 1, 0, NULL),
			 ('legacy-terminal', 'legacy-request-terminal', '{}', 2, 1, 2, 1, 'terminal');
		`);
		legacy.close();

		const store = new ActivityWindowDeliveryStore(databasePath);
		try {
			expect(store.getLegacyPolicyCutoverStatus("account-a")).toEqual({
				state: "pending",
				accountId: null,
			});
			expect(() => store.initializeBaseline([], activityOwner)).toThrow(
				"policy cutover is pending",
			);
			expect(store.clearLegacyPolicyCutoverWorkerData("account-a", 3)).toEqual({
				outboxCount: 2,
				receiptCount: 0,
				jobCount: 0,
			});
			expect(store.markLegacyPolicyCutoverComplete("account-a", 4)).toBe(true);
			store.initializeBaseline([], activityOwner);
			store.enqueue(
				sealedWindow("owned-pending", 2),
				"owned-request-pending",
				5,
				activityOwner,
			);
			expect(store.getStatus(1)).toMatchObject({
				pendingWindowCount: 1,
				terminalWindowCount: 0,
			});
		} finally {
			store.close();
		}
	});

	test("disable cleanup erases every unowned legacy copy while cutover stays pending", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const requestId = "legacy-clear-request";
		const sourceWindowId = "legacy-clear-window";
		const response = workerResponse(requestId, "legacy-clear-event", 1);
		const legacy = new Database(databasePath, { create: true, strict: true });
		legacy.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE activity_window_worker_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				accumulated_score REAL NOT NULL,
				trigger_pending INTEGER NOT NULL CHECK (trigger_pending IN (0, 1)),
				baseline_initialized INTEGER NOT NULL CHECK (baseline_initialized IN (0, 1)),
				updated_at_ms INTEGER NOT NULL
			);
			CREATE TABLE activity_window_worker_outbox (
				window_id TEXT PRIMARY KEY,
				request_id TEXT NOT NULL UNIQUE,
				window_json TEXT NOT NULL,
				queued_at_ms INTEGER NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt >= 0),
				next_attempt_at_ms INTEGER NOT NULL,
				terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
				last_error TEXT
			);
			CREATE TABLE activity_window_worker_receipts (
				request_id TEXT PRIMARY KEY,
				source_window_id TEXT NOT NULL UNIQUE,
				response_json TEXT NOT NULL,
				received_at_ms INTEGER NOT NULL
			);
			CREATE TABLE activity_window_worker_agent_jobs (
				job_id TEXT PRIMARY KEY,
				account_id TEXT,
				run_id TEXT,
				status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retry_wait', 'completed')),
				analyses_json TEXT NOT NULL,
				consumed_score REAL NOT NULL CHECK (consumed_score >= 0),
				attempt INTEGER NOT NULL CHECK (attempt >= 0),
				next_attempt_at_ms INTEGER NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				last_error TEXT
			);
			CREATE TABLE activity_window_worker_agent_job_receipts (
				job_id TEXT NOT NULL REFERENCES activity_window_worker_agent_jobs(job_id),
				request_id TEXT NOT NULL REFERENCES activity_window_worker_receipts(request_id),
				PRIMARY KEY (job_id, request_id),
				UNIQUE (request_id)
			);
			INSERT INTO activity_window_worker_state
			 (id, accumulated_score, trigger_pending, baseline_initialized, updated_at_ms)
			 VALUES (1, 1, 1, 1, 1000);
			INSERT INTO activity_window_worker_outbox
			 (window_id, request_id, window_json, queued_at_ms, attempt,
			  next_attempt_at_ms, terminal, last_error)
			 VALUES ('legacy-clear-window', 'legacy-clear-request',
			         '{"raw":"sensitive legacy window"}', 1000, 0, 1000, 0, NULL);
		`);
		legacy
			.query(
				`INSERT INTO activity_window_worker_receipts
				 (request_id, source_window_id, response_json, received_at_ms)
				 VALUES (?, ?, ?, 1001)`,
			)
			.run(requestId, sourceWindowId, JSON.stringify(response));
		legacy
			.query(
				`INSERT INTO activity_window_worker_agent_jobs
				 (job_id, account_id, run_id, status, analyses_json, consumed_score,
				  attempt, next_attempt_at_ms, created_at_ms, updated_at_ms, last_error)
				 VALUES ('legacy-clear-job', NULL, 'legacy-clear-run', 'running', '[]', 1,
				         0, 1002, 1002, 1002, NULL)`,
			)
			.run();
		legacy
			.query(
				`INSERT INTO activity_window_worker_agent_job_receipts
				 (job_id, request_id) VALUES ('legacy-clear-job', ?)`,
			)
			.run(requestId);
		legacy.close();

		const store = new ActivityWindowDeliveryStore(databasePath);
		try {
			const migrated = new Database(databasePath, { strict: true });
			const migratedColumns = (
				migrated
					.query("PRAGMA table_info(activity_window_worker_agent_jobs)")
					.all() as Array<{ name: string }>
			).map((column) => column.name);
			migrated.close();
			expect(migratedColumns).toContain("transport_attempt");
			expect(store.phaseTwoPendingRunIds("account-a")).toEqual([]);
			expect(
				store.clearPendingActivityAnalysisData("account-a", 2_000),
			).toEqual({
				outboxCount: 1,
				receiptCount: 1,
				jobCount: 1,
			});
			expect(store.getLegacyPolicyCutoverStatus("account-a")).toEqual({
				state: "pending",
				accountId: "account-a",
			});
			expect(store.getStatus(1)).toMatchObject({
				pendingWindowCount: 0,
				terminalWindowCount: 0,
				acceptedAnalysisCount: 0,
				accumulatedScore: 0,
			});
		} finally {
			store.close();
		}
	});

	test("upgrades legacy receipts and a running job behind a crash-safe policy cutover", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const requestId = "legacy-worker-request";
		const sourceWindowId = "legacy-source-window";
		const response = workerResponse(requestId, "legacy-source-event", 1);
		const analysis = {
			request_id: requestId,
			events: response.events,
			score: response.score,
			score_reason: response.score_reason,
		};
		const legacy = new Database(databasePath, { create: true, strict: true });
		legacy.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE activity_window_worker_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				owner_account_id TEXT,
				accumulated_score REAL NOT NULL,
				trigger_pending INTEGER NOT NULL CHECK (trigger_pending IN (0, 1)),
				baseline_initialized INTEGER NOT NULL CHECK (baseline_initialized IN (0, 1)),
				updated_at_ms INTEGER NOT NULL
			);
			CREATE TABLE activity_window_worker_baseline (
				window_id TEXT PRIMARY KEY
			);
			CREATE TABLE activity_window_worker_receipts (
				request_id TEXT PRIMARY KEY,
				source_window_id TEXT NOT NULL UNIQUE,
				response_json TEXT NOT NULL,
				received_at_ms INTEGER NOT NULL
			);
			CREATE TABLE activity_window_worker_outbox (
				window_id TEXT PRIMARY KEY,
				request_id TEXT NOT NULL UNIQUE,
				window_json TEXT NOT NULL,
				owner_account_id TEXT,
				owner_session_id TEXT,
				owner_generation INTEGER,
				queued_at_ms INTEGER NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt >= 0),
				next_attempt_at_ms INTEGER NOT NULL,
				terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
				last_error TEXT
			);
			CREATE TABLE activity_window_worker_agent_jobs (
				job_id TEXT PRIMARY KEY,
				account_id TEXT,
				run_id TEXT,
				status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retry_wait', 'completed')),
				analyses_json TEXT NOT NULL,
				consumed_score REAL NOT NULL CHECK (consumed_score >= 0),
				attempt INTEGER NOT NULL CHECK (attempt >= 0),
				next_attempt_at_ms INTEGER NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				last_error TEXT
			);
			CREATE TABLE activity_window_worker_agent_job_receipts (
				job_id TEXT NOT NULL REFERENCES activity_window_worker_agent_jobs(job_id),
				request_id TEXT NOT NULL REFERENCES activity_window_worker_receipts(request_id),
				PRIMARY KEY (job_id, request_id),
				UNIQUE (request_id)
			);
			INSERT INTO activity_window_worker_state
			 (id, owner_account_id, accumulated_score, trigger_pending,
			  baseline_initialized, updated_at_ms)
			 VALUES (1, 'account-a', 1, 1, 1, 1000);
		`);
		legacy
			.query(
				`INSERT INTO activity_window_worker_receipts
				 (request_id, source_window_id, response_json, received_at_ms)
				 VALUES (?, ?, ?, 1001)`,
			)
			.run(requestId, sourceWindowId, JSON.stringify(response));
		legacy
			.query(
				`INSERT INTO activity_window_worker_agent_jobs
				 (job_id, account_id, run_id, status, analyses_json, consumed_score,
				  attempt, next_attempt_at_ms, created_at_ms, updated_at_ms, last_error)
				 VALUES ('legacy-job', 'account-a', 'legacy-run', 'running', ?, 1,
				         0, 1002, 1002, 1002, NULL)`,
			)
			.run(JSON.stringify([analysis]));
		legacy
			.query(
				`INSERT INTO activity_window_worker_agent_job_receipts
				 (job_id, request_id) VALUES ('legacy-job', ?)`,
			)
			.run(requestId);
		legacy.close();

		let store = new ActivityWindowDeliveryStore(databasePath);
		expect(store.getLegacyPolicyCutoverStatus("account-a")).toEqual({
			state: "pending",
			accountId: null,
		});
		expect(() => store.recoverActivityAnalysisJobs(1, 1_003)).toThrow(
			"policy cutover is pending",
		);
		expect(() =>
			store.markLegacyPolicyCutoverComplete("account-a", 1_004),
		).toThrow("still has Worker pending data");
		expect(() =>
			store.clearLegacyPolicyCutoverWorkerData("account-b", 1_005),
		).toThrow("another account");
		expect(
			store.clearLegacyPolicyCutoverWorkerData("account-a", 1_006),
		).toEqual({
			outboxCount: 0,
			receiptCount: 1,
			jobCount: 1,
		});
		// Simulate a crash after Worker cleanup but before Reflection cleanup and
		// the final marker commit. Reopening must require the same idempotent phases.
		store.close();
		store = new ActivityWindowDeliveryStore(databasePath);
		try {
			expect(store.getLegacyPolicyCutoverStatus("account-a")).toEqual({
				state: "pending",
				accountId: "account-a",
			});
			expect(
				store.clearLegacyPolicyCutoverWorkerData("account-a", 1_007),
			).toEqual({
				outboxCount: 0,
				receiptCount: 0,
				jobCount: 0,
			});
			expect(store.markLegacyPolicyCutoverComplete("account-a", 1_008)).toBe(
				true,
			);
			expect(store.markLegacyPolicyCutoverComplete("account-a", 1_009)).toBe(
				false,
			);
			expect(store.recoverActivityAnalysisJobs(1, 1_010)).toBe(false);
			expect(store.nextActivityAnalysisJob(1, "account-a", 1_010)).toEqual({
				kind: "none",
			});
		} finally {
			store.close();
		}
	});

	test("marks a newly created Worker ledger policy cutover complete", () => {
		const store = new ActivityWindowDeliveryStore(
			join(temporaryDirectory(), "activity-window-worker.sqlite3"),
		);
		try {
			expect(store.getLegacyPolicyCutoverStatus("account-a")).toEqual({
				state: "complete",
				accountId: null,
			});
			expect(store.clearLegacyPolicyCutoverWorkerData("account-a")).toEqual({
				outboxCount: 0,
				receiptCount: 0,
				jobCount: 0,
			});
			expect(store.markLegacyPolicyCutoverComplete("account-a")).toBe(false);
		} finally {
			store.close();
		}
	});

	test("fails closed before creating an outbox without an authenticated owner", async () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const service = new ActivityWindowDeliveryService({
			source: new MutableWindowSource([]),
			analyzer: new RecordingAnalyzer([1]),
			store,
			currentSession: () => null,
			isCurrentSession: () => false,
		});
		try {
			await expect(service.start()).rejects.toThrow(
				"requires an authenticated account",
			);
			expect(service.getStatus().pendingWindowCount).toBe(0);
		} finally {
			await service.stop();
			store.close();
		}
	});

	test("serializes a seal notification behind the activation baseline", async () => {
		const directory = temporaryDirectory();
		const concurrent = sealedWindow("window-sealed-during-cutover", 2);
		let releaseList!: () => void;
		const listBlocked = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		const source: ActivityWindowSource = {
			async listWindowsForAccount() {
				await listBlocked;
				return [];
			},
		};
		const analyzer = new RecordingAnalyzer([0.5]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer,
			store,
		});
		try {
			const starting = service.start();
			const enqueueing = service.enqueueWindow(concurrent);
			releaseList();
			await starting;
			await enqueueing;
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(1);
			const analyzed = analyzer.requests[0];
			if (!analyzed) throw new Error("Expected one analyzed activity window.");
			expect((analyzed.raw_event as EventWindowV1).windowId).toBe(
				concurrent.windowId,
			);
			expect(service.getStatus().acceptedAnalysisCount).toBe(1);
		} finally {
			await service.stop();
			store.close();
		}
	});

	test("rejects activation when the exact session changes for the same account", async () => {
		const directory = temporaryDirectory();
		let releaseList!: () => void;
		const listBlocked = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		const source: ActivityWindowSource = {
			async listWindowsForAccount() {
				await listBlocked;
				return [sealedWindow("window-owned-by-old-session", 2)];
			},
		};
		let identity = { ...activityOwner };
		const analyzer = new RecordingAnalyzer([0.5]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const service = new ActivityWindowDeliveryService({
			source,
			analyzer,
			store,
			currentSession: () => ({ ...identity }),
			isCurrentSession: (candidate) =>
				candidate.accountId === identity.accountId &&
				candidate.sessionId === identity.sessionId &&
				candidate.generation === identity.generation,
		});
		try {
			const starting = service.start();
			identity = {
				...identity,
				sessionId: "session-account-a-replacement",
				generation: identity.generation + 1,
			};
			releaseList();
			await expect(starting).rejects.toThrow(
				"session changed during activation",
			);
			expect(analyzer.requests).toHaveLength(0);
			expect(service.getStatus().pendingWindowCount).toBe(0);
		} finally {
			await service.stop();
			store.close();
		}
	});

	test("recovers an account-owned seal lost before the live outbox handoff", async () => {
		const directory = temporaryDirectory();
		const lostNotification = sealedWindow("window-owned-seal-before-crash", 2);
		const source = new MutableWindowSource(
			[lostNotification],
			activityOwner.accountId,
		);
		const analyzer = new RecordingAnalyzer([0.5]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer,
			store,
		});
		try {
			await service.start();
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(1);
			const analyzed = analyzer.requests[0];
			if (!analyzed) throw new Error("Expected one recovered activity window.");
			expect((analyzed.raw_event as EventWindowV1).windowId).toBe(
				lostNotification.windowId,
			);
			expect(service.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
			});
		} finally {
			await service.stop();
			store.close();
		}
	});

	test("waits for an in-flight activation before account cleanup closes its ledger", async () => {
		const directory = temporaryDirectory();
		let releaseList!: () => void;
		const listBlocked = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		const source: ActivityWindowSource = {
			async listWindowsForAccount() {
				await listBlocked;
				return [];
			},
		};
		const analyzer = new RecordingAnalyzer([1]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer,
			store,
		});
		const starting = service.start();
		let stopped = false;
		const stopping = service.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBeFalse();
		releaseList();
		await Promise.all([starting, stopping]);
		store.close();
		expect(analyzer.requests).toHaveLength(0);
	});

	test("keeps raw outbox, receipts, score, and Agent jobs bound to account A", () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const window = sealedWindow("window-owned-by-a", 2);
		const requestId = "request-owned-by-a";
		const accountB: AuthSessionIdentity = {
			accountId: "account-b",
			sessionId: "session-account-b",
			generation: 1,
		};
		try {
			store.initializeBaseline([], activityOwner);
			store.enqueue(window, requestId, 1, activityOwner);
			expect(() => store.nextWindow(1, accountB)).toThrow(
				"belongs to another account",
			);
			store.apply(
				window.windowId,
				workerResponse(requestId, window.windowId, 1),
				1,
				2,
			);
			expect(store.nextActivityAnalysisJob(1, "account-b", 3)).toEqual({
				kind: "account_mismatch",
			});
			const owned = store.nextActivityAnalysisJob(1, "account-a", 3);
			expect(owned.kind).toBe("ready");
			if (owned.kind !== "ready") throw new Error("Expected account A job.");
			expect(() =>
				store.claimActivityAnalysisJob(
					owned.job.jobId,
					"account-b",
					"run-b",
					3,
				),
			).toThrow("belongs to another account");
		} finally {
			store.close();
		}
	});

	test("recovers account A exact wire after restart without assigning it to B", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const window = sealedWindow("window-response-lost-a", 2);
		const requestId = "request-response-lost-a";
		const first = new ActivityWindowDeliveryStore(databasePath);
		first.initializeBaseline([], activityOwner);
		first.enqueue(window, requestId, 1, activityOwner);
		first.defer(window.windowId, 1, "transport_error");
		first.close();

		const accountBOwner: AuthSessionIdentity = {
			accountId: "account-b",
			sessionId: "session-account-b",
			generation: 1,
		};
		const accountBAnalyzer = new RecordingAnalyzer([1]);
		const accountBStore = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker-account-b.sqlite3"),
		);
		const accountBService = new ActivityWindowDeliveryService({
			...ownerBoundary(accountBOwner),
			source: new MutableWindowSource([]),
			analyzer: accountBAnalyzer,
			store: accountBStore,
			nowMs: () => 2,
		});
		await accountBService.start();
		await accountBService.whenIdle();
		expect(accountBAnalyzer.requests).toHaveLength(0);
		await accountBService.stop();
		accountBStore.close();

		const resumedOwner: AuthSessionIdentity = {
			...activityOwner,
			sessionId: "session-account-a-after-restart",
			generation: 2,
		};
		const resumedStore = new ActivityWindowDeliveryStore(databasePath);
		const analyzer = new RecordingAnalyzer([0.5]);
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(resumedOwner),
			source: new MutableWindowSource([]),
			analyzer,
			store: resumedStore,
			nowMs: () => 2,
		});
		try {
			await service.start();
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(1);
			expect(analyzer.requests[0]?.request_id).toBe(requestId);
			expect(service.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
			});
		} finally {
			await service.stop();
			resumedStore.close();
		}
	});

	test("reuses the exact first-stage semantic request after a transient failure and restart", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const window = sealedWindow("window-first-stage-transient-restart", 2);
		const source = new MutableWindowSource([]);
		const firstAnalyzer = new ScriptedFirstStageAnalyzer(["transient"]);
		const firstStore = new ActivityWindowDeliveryStore(databasePath);
		let now = 1_000;
		const firstService = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer: firstAnalyzer,
			store: firstStore,
			nowMs: () => now,
			retryDelaysMs: [60_000],
		});
		await firstService.start();
		source.windows.push(window);
		await firstService.enqueueWindow(window);
		await firstService.whenIdle();
		expect(firstAnalyzer.requests).toHaveLength(1);
		const initialRequest = firstAnalyzer.requests[0];
		if (initialRequest === undefined) throw new Error("Expected one request.");
		const exactRequest = structuredClone(initialRequest);
		expect(firstService.getStatus()).toMatchObject({
			pendingWindowCount: 1,
			terminalWindowCount: 0,
			lastError: "http_error",
		});
		await firstService.stop();
		firstStore.close();

		const afterTransient = new Database(databasePath, { strict: true });
		expect(
			afterTransient
				.query(
					`SELECT attempt, semantic_attempt, terminal
					 FROM activity_window_worker_outbox WHERE window_id = ?`,
				)
				.get(window.windowId),
		).toEqual({ attempt: 1, semantic_attempt: 0, terminal: 0 });
		afterTransient.close();

		now = 61_000;
		const resumedAnalyzer = new ScriptedFirstStageAnalyzer(["success"]);
		const resumedStore = new ActivityWindowDeliveryStore(databasePath);
		const resumedService = new ActivityWindowDeliveryService({
			...ownerBoundary({
				...activityOwner,
				sessionId: "session-account-a-after-semantic-restart",
				generation: 2,
			}),
			source: new MutableWindowSource([window], activityOwner.accountId),
			analyzer: resumedAnalyzer,
			store: resumedStore,
			nowMs: () => now,
		});
		try {
			await resumedService.start();
			await resumedService.whenIdle();
			expect(resumedAnalyzer.requests).toHaveLength(1);
			expect(resumedAnalyzer.requests[0]).toEqual(exactRequest);
			expect(resumedService.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
				terminalWindowCount: 0,
			});
		} finally {
			await resumedService.stop();
			resumedStore.close();
		}
	});

	test("replays the current semantic attempt after restart and recovers its archive gap", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const window = sealedWindow("window-first-stage-semantic-restart", 2);
		const source = new MutableWindowSource([]);
		let now = 1_000;
		const firstAnalyzer = new ScriptedFirstStageAnalyzer(["timestamp"]);
		const firstStore = new ActivityWindowDeliveryStore(databasePath);
		const firstService = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer: firstAnalyzer,
			store: firstStore,
			nowMs: () => now,
			retryDelaysMs: [60_000],
		});
		await firstService.start();
		source.windows.push(window);
		await firstService.enqueueWindow(window);
		await firstService.whenIdle();
		expect(firstAnalyzer.requests).toHaveLength(1);
		await firstService.stop();
		firstStore.close();

		now = 61_000;
		const archiveState: { analysis: ActivityAnalysisWorkerResult | null } = {
			analysis: null,
		};
		const secondAnalyzer = new ScriptedFirstStageAnalyzer(["success"]);
		const secondStore = new ActivityWindowDeliveryStore(databasePath);
		const secondService = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source: new MutableWindowSource([window], activityOwner.accountId),
			analyzer: secondAnalyzer,
			store: secondStore,
			nowMs: () => now,
			retryDelaysMs: [60_000],
			archiveAnalysisBeforeReceipt: ({ analysis }) => {
				archiveState.analysis = structuredClone(analysis);
				throw new Error("simulated semantic-attempt archive gap");
			},
		});
		await secondService.start();
		await secondService.whenIdle();
		expect(secondAnalyzer.requests).toHaveLength(1);
		expect(secondAnalyzer.requests[0]?.request_id).not.toBe(
			firstAnalyzer.requests[0]?.request_id,
		);
		expect(archiveState.analysis?.request_id).toBe(
			secondAnalyzer.requests[0]?.request_id,
		);
		await secondService.stop();
		secondStore.close();

		now = 121_000;
		const recoveredAnalyzer = new RecordingAnalyzer([]);
		const recoveredStore = new ActivityWindowDeliveryStore(databasePath);
		const recoveredService = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source: new MutableWindowSource([window], activityOwner.accountId),
			analyzer: recoveredAnalyzer,
			store: recoveredStore,
			nowMs: () => now,
			recoverArchivedAnalysis: ({ requestId }) => {
				const analysis = archiveState.analysis;
				if (analysis === null)
					throw new Error("Expected an archived analysis.");
				expect(requestId).toBe(analysis.request_id);
				return { kind: "pending", analysis: structuredClone(analysis) };
			},
		});
		try {
			await recoveredService.start();
			await recoveredService.whenIdle();
			expect(recoveredAnalyzer.requests).toHaveLength(0);
			expect(recoveredService.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
				terminalWindowCount: 0,
			});
		} finally {
			await recoveredService.stop();
			recoveredStore.close();
		}
	});

	test("advances deterministic first-stage output failures three times then stops terminal", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const window = sealedWindow("window-first-stage-semantic-output", 2);
		const source = new MutableWindowSource([]);
		const analyzer = new ScriptedFirstStageAnalyzer([
			"control_character",
			"timestamp",
			"invalid_response",
		]);
		const errors: unknown[] = [];
		const store = new ActivityWindowDeliveryStore(databasePath);
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer,
			store,
			retryDelaysMs: [1],
			onError: (error) => errors.push(error),
		});
		try {
			await service.start();
			source.windows.push(window);
			await service.enqueueWindow(window);
			await eventually(
				() =>
					analyzer.requests.length === 3 &&
					service.getStatus().terminalWindowCount === 1,
			);
			await service.whenIdle();
			const requestIds = analyzer.requests.map((request) => request.request_id);
			expect(new Set(requestIds).size).toBe(3);
			expect(
				analyzer.requests.map(
					(request) => (request.raw_event as EventWindowV1).windowId,
				),
			).toEqual(Array.from({ length: 3 }, () => window.windowId));
			expect(errors.map(activityWindowWorkerDiagnostic)).toMatchObject([
				{ code: "invalid_response", validationStage: null },
				{ code: "invalid_response", validationStage: "timestamps" },
				{ code: "invalid_response", validationStage: null },
			]);
			expect(service.getStatus()).toMatchObject({
				acceptedAnalysisCount: 0,
				pendingWindowCount: 0,
				terminalWindowCount: 1,
				lastError: "invalid_response",
			});
		} finally {
			await service.stop();
			store.close();
		}

		const terminal = new Database(databasePath, { strict: true });
		expect(
			terminal
				.query(
					`SELECT attempt, semantic_attempt, terminal
					 FROM activity_window_worker_outbox WHERE window_id = ?`,
				)
				.get(window.windowId),
		).toEqual({ attempt: 3, semantic_attempt: 2, terminal: 1 });
		terminal.close();
	});

	test("fails closed on an archived semantic identity mismatch without advancing it", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const window = sealedWindow("window-archive-semantic-mismatch", 2);
		const source = new MutableWindowSource([]);
		const analyzer = new RecordingAnalyzer([]);
		const store = new ActivityWindowDeliveryStore(databasePath);
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer,
			store,
			recoverArchivedAnalysis: () => {
				const response = workerResponse(
					"wrong-archived-semantic-request",
					window.windowId,
					0.5,
				);
				return {
					kind: "pending",
					analysis: {
						request_id: response.request_id,
						events: response.events,
						score: response.score,
						score_reason: response.score_reason,
					},
				};
			},
		});
		try {
			await service.start();
			source.windows.push(window);
			await service.enqueueWindow(window);
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(0);
			expect(service.getStatus()).toMatchObject({
				pendingWindowCount: 0,
				terminalWindowCount: 1,
				lastError: "invalid_response",
			});
		} finally {
			await service.stop();
			store.close();
		}

		const failedClosed = new Database(databasePath, { strict: true });
		expect(
			failedClosed
				.query(
					`SELECT attempt, semantic_attempt, terminal
					 FROM activity_window_worker_outbox WHERE window_id = ?`,
				)
				.get(window.windowId),
		).toEqual({ attempt: 1, semantic_attempt: 0, terminal: 1 });
		failedClosed.close();
	});

	test("treats an explicitly invalid archive disposition as terminal without a semantic retry", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const window = sealedWindow("window-invalid-archive-disposition", 2);
		const source = new MutableWindowSource([]);
		const analyzer = new RecordingAnalyzer([]);
		const store = new ActivityWindowDeliveryStore(databasePath);
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer,
			store,
			recoverArchivedAnalysis: () => ({ kind: "invalid" }),
		});
		try {
			await service.start();
			source.windows.push(window);
			await service.enqueueWindow(window);
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(0);
			expect(service.getStatus()).toMatchObject({
				pendingWindowCount: 0,
				terminalWindowCount: 1,
				lastError: "invalid_response",
			});
		} finally {
			await service.stop();
			store.close();
		}

		const failedClosed = new Database(databasePath, { strict: true });
		expect(
			failedClosed
				.query(
					`SELECT attempt, semantic_attempt, terminal
					 FROM activity_window_worker_outbox WHERE window_id = ?`,
				)
				.get(window.windowId),
		).toEqual({ attempt: 1, semantic_attempt: 0, terminal: 1 });
		failedClosed.close();
	});

	test("retries a transient archive recovery failure with the same semantic identity", async () => {
		const directory = temporaryDirectory();
		const window = sealedWindow("window-transient-archive-recovery", 2);
		const source = new MutableWindowSource([]);
		const analyzer = new RecordingAnalyzer([0.5]);
		const recoveryInputs: Array<{
			requestId: string;
			sourceWindow: EventWindowV1;
		}> = [];
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer,
			store,
			retryDelaysMs: [1],
			recoverArchivedAnalysis: ({ requestId, sourceWindow }) => {
				recoveryInputs.push({
					requestId,
					sourceWindow: structuredClone(sourceWindow),
				});
				if (recoveryInputs.length === 1) {
					throw new Error("temporary encrypted archive I/O failure");
				}
				return null;
			},
		});
		try {
			await service.start();
			source.windows.push(window);
			await service.enqueueWindow(window);
			await eventually(
				() => recoveryInputs.length === 2 && analyzer.requests.length === 1,
			);
			await service.whenIdle();
			expect(recoveryInputs[1]).toEqual(recoveryInputs[0]);
			expect(analyzer.requests[0]?.request_id).toBe(
				recoveryInputs[0]?.requestId,
			);
			expect(service.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
				terminalWindowCount: 0,
			});
		} finally {
			await service.stop();
			store.close();
		}
	});

	test("does not call the first-stage model after lifecycle revocation during archive recovery", async () => {
		const directory = temporaryDirectory();
		const window = sealedWindow("window-revoked-during-archive", 2);
		const source = new MutableWindowSource([]);
		const analyzer = new RecordingAnalyzer([0.5]);
		const recovery = deferredSignal();
		let current = true;
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const service = new ActivityWindowDeliveryService({
			currentSession: () => (current ? { ...activityOwner } : null),
			isCurrentSession: () => current,
			source,
			analyzer,
			store,
			recoverArchivedAnalysis: async () => {
				await recovery.promise;
				return null;
			},
		});
		try {
			await service.start();
			source.windows.push(window);
			await service.enqueueWindow(window);
			current = false;
			recovery.resolve();
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(0);
			expect(service.getStatus().pendingWindowCount).toBe(1);
		} finally {
			await service.stop();
			store.close();
		}
	});

	test("persists a deterministic zero-score state receipt without scheduling an Agent job", () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const window = sealedWindow("window-state-only", 2);
		const requestId = "request-state-only";
		try {
			store.initializeBaseline([], activityOwner);
			store.enqueue(window, requestId, 1, activityOwner);
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
			expect(store.nextActivityAnalysisJob(1, "account-a", 3)).toEqual({
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
			...ownerBoundary(),
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
				goal: first.goal,
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

	test("recovers receipt-to-source-ack crash without calling the first-stage analyzer again", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const window = sealedWindow("window-source-ack-crash", 2);
		const source = new MutableWindowSource([]);
		const firstAnalyzer = new RecordingAnalyzer([1]);
		const firstStore = new ActivityWindowDeliveryStore(databasePath);
		let firstAckCount = 0;
		const firstService = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer: firstAnalyzer,
			store: firstStore,
			acknowledgeSourceAfterReceipt: () => {
				firstAckCount += 1;
				throw new Error("simulated crash before source acknowledgement");
			},
			retryDelaysMs: [60_000],
		});
		await firstService.start();
		source.windows.push(window);
		await firstService.enqueueWindow(window);
		await firstService.whenIdle();
		expect(firstAnalyzer.requests).toHaveLength(1);
		expect(firstAckCount).toBe(1);
		expect(firstService.getStatus()).toMatchObject({
			acceptedAnalysisCount: 1,
			pendingWindowCount: 1,
		});
		expect(
			firstStore.nextActivityAnalysisJob(1, "account-a", Date.now()),
		).toEqual({ kind: "none" });
		await firstService.stop();
		firstStore.close();

		const recoveredAnalyzer = new RecordingAnalyzer([]);
		const recoveredStore = new ActivityWindowDeliveryStore(databasePath);
		const acknowledgements: Array<{
			accountId: string;
			windowId: string;
		}> = [];
		const recoveredService = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer: recoveredAnalyzer,
			store: recoveredStore,
			acknowledgeSourceAfterReceipt: ({ owner, sourceWindowId }) => {
				acknowledgements.push({
					accountId: owner.accountId,
					windowId: sourceWindowId,
				});
			},
		});
		try {
			await recoveredService.start();
			await recoveredService.whenIdle();
			expect(recoveredAnalyzer.requests).toHaveLength(0);
			expect(acknowledgements).toEqual([
				{ accountId: "account-a", windowId: window.windowId },
			]);
			expect(recoveredService.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
			});
			expect(
				recoveredStore.nextActivityAnalysisJob(1, "account-a", Date.now()),
			).toMatchObject({ kind: "ready" });
		} finally {
			await recoveredService.stop();
			recoveredStore.close();
		}
	});

	test("recovers encrypted archive-to-receipt crash without calling the first-stage analyzer again", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const window = sealedWindow("window-archive-receipt-crash", 2);
		const source = new MutableWindowSource([]);
		const firstAnalyzer = new RecordingAnalyzer([1]);
		let archived: ActivityAnalysisWorkerResult | null = null;
		let now = 1_000;
		const firstStore = new ActivityWindowDeliveryStore(databasePath);
		const firstService = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer: firstAnalyzer,
			store: firstStore,
			nowMs: () => now,
			retryDelaysMs: [1],
			archiveAnalysisBeforeReceipt: ({ analysis }) => {
				archived = structuredClone(analysis);
				throw new Error("simulated crash after encrypted archive commit");
			},
		});
		await firstService.start();
		source.windows.push(window);
		await firstService.enqueueWindow(window);
		await firstService.whenIdle();
		expect(firstAnalyzer.requests).toHaveLength(1);
		expect(archived).not.toBeNull();
		await firstService.stop();
		firstStore.close();

		now += 10;
		const recoveredAnalyzer = new RecordingAnalyzer([]);
		const recoveredStore = new ActivityWindowDeliveryStore(databasePath);
		const recoveredService = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer: recoveredAnalyzer,
			store: recoveredStore,
			nowMs: () => now,
			recoverArchivedAnalysis: () => ({
				kind: "pending",
				analysis: structuredClone(archived!),
			}),
		});
		try {
			await recoveredService.start();
			await recoveredService.whenIdle();
			expect(recoveredAnalyzer.requests).toHaveLength(0);
			expect(recoveredService.getStatus()).toMatchObject({
				acceptedAnalysisCount: 1,
				pendingWindowCount: 0,
			});
		} finally {
			await recoveredService.stop();
			recoveredStore.close();
		}
	});

	test("acknowledges an already-consumed encrypted archive without re-scoring it", async () => {
		const directory = temporaryDirectory();
		const window = sealedWindow("window-consumed-archive-upgrade", 2);
		const source = new MutableWindowSource([window], "account-a");
		const analyzer = new RecordingAnalyzer([]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const acknowledged: string[] = [];
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer,
			store,
			recoverArchivedAnalysis: () => ({ kind: "consumed" }),
			acknowledgeSourceAfterReceipt: ({ sourceWindowId }) => {
				acknowledged.push(sourceWindowId);
			},
		});
		try {
			await service.start();
			await service.whenIdle();
			expect(analyzer.requests).toHaveLength(0);
			expect(acknowledged).toEqual([window.windowId]);
			expect(service.getStatus()).toMatchObject({
				acceptedAnalysisCount: 0,
				accumulatedScore: 0,
				pendingWindowCount: 0,
				agentTriggerPending: false,
			});
			expect(store.nextActivityAnalysisJob(1, "account-a", Date.now())).toEqual(
				{
					kind: "none",
				},
			);
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
			...ownerBoundary(),
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

			// A process interruption preserves the exact run/request identity so the
			// dispatcher can reconcile encrypted completion before any provider retry.
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
			expect(resumed.kind).toBe("running");
			if (resumed.kind !== "running")
				throw new Error("Expected recovered activity job.");
			expect(resumed.job).toMatchObject({
				attempt: 0,
				runId: "activity-run-a",
				originatingRequestId: claimed.originatingRequestId,
			});
			store.completeActivityAnalysisJob(
				resumed.job.jobId,
				"account-a",
				"activity-run-a",
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

	test("reaches the exact score threshold across restart without floating-point drift", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const applyTenth = (
			store: ActivityWindowDeliveryStore,
			from: number,
			to: number,
		) => {
			for (let index = from; index <= to; index += 1) {
				const window = sealedWindow(`window-decimal-score-${index}`, 1);
				const requestId = `request-decimal-score-${index}`;
				store.enqueue(window, requestId, index, activityOwner);
				store.apply(
					window.windowId,
					workerResponse(requestId, window.windowId, 0.1),
					1,
					100 + index,
				);
			}
		};

		let store = new ActivityWindowDeliveryStore(databasePath);
		store.initializeBaseline([], activityOwner);
		applyTenth(store, 1, 5);
		expect(store.getStatus(1)).toMatchObject({
			accumulatedScore: 0.5,
			agentTriggerPending: false,
		});
		store.close();

		store = new ActivityWindowDeliveryStore(databasePath);
		applyTenth(store, 6, 9);
		expect(store.getStatus(1).accumulatedScore).toBeCloseTo(0.9, 12);
		expect(store.nextActivityAnalysisJob(1, "account-a", 1_000)).toEqual({
			kind: "none",
		});
		applyTenth(store, 10, 10);
		const ready = store.nextActivityAnalysisJob(1, "account-a", 1_001);
		expect(ready.kind).toBe("ready");
		if (ready.kind !== "ready") throw new Error("Expected threshold job.");
		expect(ready.job.analyses).toHaveLength(10);
		expect(ready.job.consumedScore).toBeCloseTo(1, 12);
		store.close();
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
			...ownerBoundary(),
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

	test("a synchronous lifecycle revocation blocks a queued dispatcher claim", async () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		store.initializeBaseline([], activityOwner);
		for (const [index, score] of [0.6, 0.6].entries()) {
			const window = sealedWindow(`window-dispatch-revoked-${index}`, 1);
			const requestId = `request-dispatch-revoked-${index}`;
			store.enqueue(window, requestId, index + 1, activityOwner);
			store.apply(
				window.windowId,
				workerResponse(requestId, window.windowId, score),
				1,
				index + 10,
			);
		}
		let eligible = true;
		let providerStarts = 0;
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			isEligible: () => eligible,
			coordinator: {
				startActivityAnalysis: async () => {
					providerStarts += 1;
				},
			},
		});
		try {
			dispatcher.start();
			// Lifecycle stop/close invalidates eligibility synchronously, before its
			// asynchronous resource release reaches dispatcher.stop().
			eligible = false;
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(providerStarts).toBe(0);
			expect(
				store.nextActivityAnalysisJob(1, "account-a", Date.now()).kind,
			).toBe("ready");
		} finally {
			await dispatcher.stop();
			store.close();
		}
	});

	test("deletes a transient Agent run only after the Worker defer commits", async () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const repository = new EncryptedAgentRepository({
			databasePath: join(directory, "agent.sqlite3"),
			installationId: "activity-defer-delete-order",
			keyStore: new ActivityTestKeyStore(),
			now: () => 2_000,
		});
		seedActivityAnalysisJob(store, "defer-delete-order");
		const starts: StartActivityAnalysisRun[] = [];
		const errors: string[] = [];
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator: {
				startActivityAnalysis: async (input) => {
					starts.push(structuredClone(input));
				},
			},
			repository,
			onError: (error) =>
				errors.push(error instanceof Error ? error.message : String(error)),
		});
		let recovered: ActivityAnalysisDispatcher | null = null;
		try {
			dispatcher.start();
			await eventually(() => starts.length === 1);
			await dispatcher.stop();
			const started = starts[0];
			if (started === undefined) throw new Error("Expected an activity run.");
			const persistedRun = {
				accountId: "account-a",
				id: started.runId,
				conversationId: null,
				workflowId: started.jobId,
				status: "failed" as const,
				input: {
					kind: "activity-analysis",
					jobId: started.jobId,
					requestId: started.requestId,
					consumedScore: started.consumedScore,
					analyses: structuredClone(started.analyses),
				},
				output: null,
				error: { code: "unavailable", retryable: true },
				createdAtMs: 1_000,
				updatedAtMs: 1_001,
				completedAtMs: 1_001,
			};
			await repository.putRun(persistedRun);
			const durableDefer = store.deferActivityAnalysisJob.bind(store);
			store.deferActivityAnalysisJob = () => {
				throw new Error("simulated Worker defer transaction failure");
			};
			await dispatcher.onActivityRunTerminal({
				jobId: started.jobId,
				runId: started.runId,
				accountId: "account-a",
				status: "failed",
				failure: new Error("temporary relay outage"),
				failureClass: "transient",
			});
			await expect(
				repository.getRun("account-a", started.runId),
			).resolves.toEqual(persistedRun);
			expect(errors).toContain("simulated Worker defer transaction failure");
			expect(store.nextActivityAnalysisJob(1, "account-a", 2_000)).toEqual({
				kind: "running",
				job: expect.objectContaining({ runId: started.runId }),
			});

			store.deferActivityAnalysisJob = durableDefer;
			recovered = new ActivityAnalysisDispatcher({
				store,
				scoreThreshold: 1,
				auth: authenticatedTestSession("account-a"),
				coordinator: {
					startActivityAnalysis: async () => {
						throw new Error(
							"Deferred recovery must not call the provider yet.",
						);
					},
					reconcileOrphanedActivityRun: async () => "retryable" as const,
				},
				repository,
				retryDelaysMs: [60_000],
				nowMs: () => 2_000,
			});
			recovered.start();
			await eventually(() => {
				const next = store.nextActivityAnalysisJob(1, "account-a", 2_000);
				return next.kind === "not_due";
			});
			await recovered.stop();
			recovered = null;
			await expect(
				repository.getRun("account-a", started.runId),
			).resolves.toBeNull();
			expect(store.nextActivityAnalysisJob(1, "account-a", 2_000)).toEqual({
				kind: "not_due",
				nextAttemptAtMs: 62_000,
			});
			const recoveredRetry = store.nextActivityAnalysisJob(
				1,
				"account-a",
				62_000,
			);
			if (recoveredRetry.kind !== "ready") {
				throw new Error(
					"Expected the recovered transient retry to become ready.",
				);
			}
			expect(recoveredRetry.job).toMatchObject({
				attempt: 0,
				transportAttempt: 1,
				originatingRequestId: started.requestId,
			});
		} finally {
			await dispatcher.stop();
			if (recovered !== null) await recovered.stop();
			repository.close();
			store.close();
		}
	});

	test("persists start-failure backoff and its semantic request across restart", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		let now = 1_000;
		let store = new ActivityWindowDeliveryStore(databasePath);
		seedActivityAnalysisJob(store, "start-failure-backoff", now);
		const starts: StartActivityAnalysisRun[] = [];
		const createDispatcher = () =>
			new ActivityAnalysisDispatcher({
				store,
				scoreThreshold: 1,
				auth: authenticatedTestSession("account-a"),
				coordinator: {
					startActivityAnalysis: async (input) => {
						starts.push(structuredClone(input));
						throw new Error("simulated synchronous start failure");
					},
				},
				retryDelaysMs: [5_000, 30_000, 120_000, 600_000],
				nowMs: () => now,
			});
		let dispatcher = createDispatcher();
		try {
			dispatcher.start();
			await eventually(
				() =>
					store.nextActivityAnalysisJob(1, "account-a", now).kind === "not_due",
			);
			const first = starts[0];
			if (first === undefined)
				throw new Error("Expected the first start attempt.");
			expect(store.nextActivityAnalysisJob(1, "account-a", now)).toEqual({
				kind: "not_due",
				nextAttemptAtMs: 6_000,
			});
			await dispatcher.stop();
			store.close();

			now = 6_000;
			store = new ActivityWindowDeliveryStore(databasePath);
			dispatcher = createDispatcher();
			dispatcher.start();
			await eventually(() => starts.length === 2);
			await eventually(
				() =>
					store.nextActivityAnalysisJob(1, "account-a", now).kind === "not_due",
			);
			expect(starts[1]?.requestId).toBe(first.requestId);
			expect(store.nextActivityAnalysisJob(1, "account-a", now)).toEqual({
				kind: "not_due",
				nextAttemptAtMs: 36_000,
			});
			const durable = store.nextActivityAnalysisJob(1, "account-a", 36_000);
			if (durable.kind !== "ready") {
				throw new Error("Expected the durable second start retry.");
			}
			expect(durable.job).toMatchObject({
				attempt: 0,
				transportAttempt: 2,
				originatingRequestId: first.requestId,
			});
		} finally {
			await dispatcher.stop();
			store.close();
		}
	});

	test("keeps an unverified completed run instead of deleting its identity proof", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		const store = new ActivityWindowDeliveryStore(databasePath);
		const job = seedActivityAnalysisJob(store, "unverified-completion");
		const runId = "activity-run-unverified-completion";
		store.claimActivityAnalysisJob(job.jobId, "account-a", runId, 1_003);
		const deletedRunIds: string[] = [];
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator: {
				startActivityAnalysis: async () => {
					throw new Error("Unverified completion must not call the provider.");
				},
				reconcileOrphanedActivityRun: async () => "completed" as const,
			},
			repository: {
				verifyCompletedProactiveFeedbackRun: async () => false,
				deleteActivityAnalysisRuns: async (_accountId, runIds) => {
					deletedRunIds.push(...runIds);
					return runIds.length;
				},
			},
		});
		try {
			dispatcher.start();
			await eventually(
				() =>
					store.nextActivityAnalysisJob(1, "account-a", Date.now()).kind ===
					"none",
			);
			expect(deletedRunIds).toEqual([]);
			const inspector = new Database(databasePath, { strict: true });
			const row = inspector
				.query(
					`SELECT run_id, terminal_failure, last_error
					 FROM activity_window_worker_agent_jobs WHERE job_id = ?`,
				)
				.get(job.jobId) as {
				run_id: string;
				terminal_failure: number;
				last_error: string;
			};
			inspector.close();
			expect(row).toEqual({
				run_id: runId,
				terminal_failure: 1,
				last_error: "completed_run_not_atomic",
			});
		} finally {
			await dispatcher.stop();
			store.close();
		}
	});

	test("awaits exact completed-run reconciliation before enabling new provider work", async () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const window = sealedWindow("window-completed-recovery", 1);
		const requestId = "worker-request-completed-recovery";
		store.initializeBaseline([], activityOwner);
		store.enqueue(window, requestId, 1_000, activityOwner);
		store.apply(
			window.windowId,
			workerResponse(requestId, window.events[0]!.cursor, 1),
			1,
			1_001,
		);
		const ready = store.nextActivityAnalysisJob(1, "account-a", 1_002);
		if (ready.kind !== "ready")
			throw new Error("Expected a ready recovery job.");
		const runId = "activity-run-completed-recovery";
		const claimed = store.claimActivityAnalysisJob(
			ready.job.jobId,
			"account-a",
			runId,
			1_003,
		);
		const reconciliationStarted = deferredSignal();
		const releaseReconciliation = deferredSignal();
		const providerStarts: StartActivityAnalysisRun[] = [];
		let verifiedExpectation: unknown = null;
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator: {
				startActivityAnalysis: async (input) => {
					providerStarts.push(structuredClone(input));
				},
				reconcileOrphanedActivityRun: async (input) => {
					expect(input).toEqual({
						accountId: "account-a",
						runId,
						jobId: claimed.jobId,
						requestId: claimed.originatingRequestId,
						consumedScore: claimed.consumedScore,
						analyses: claimed.analyses,
					});
					reconciliationStarted.resolve();
					await releaseReconciliation.promise;
					return "completed";
				},
			},
			repository: {
				verifyCompletedProactiveFeedbackRun: async (expected) => {
					verifiedExpectation = structuredClone(expected);
					return true;
				},
			},
		});
		try {
			let recoverySettled = false;
			const recovery = dispatcher.startAndRecover().then(() => {
				recoverySettled = true;
			});
			await reconciliationStarted.promise;
			expect(recoverySettled).toBe(false);
			expect(providerStarts).toEqual([]);
			releaseReconciliation.resolve();
			await recovery;
			expect(verifiedExpectation).toEqual({
				accountId: "account-a",
				runId,
				jobId: claimed.jobId,
				originatingRequestId: claimed.originatingRequestId,
				consumedScore: claimed.consumedScore,
				analyses: claimed.analyses,
			});
			expect(store.getStatus(1)).toMatchObject({
				accumulatedScore: 0,
				agentTriggerPending: false,
			});
			dispatcher.start();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(providerStarts).toEqual([]);
		} finally {
			await dispatcher.stop();
			store.close();
		}
	});

	test("keeps a running completion proof when verification throws and retries it without a provider", async () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const window = sealedWindow("window-verifier-unavailable", 1);
		const requestId = "worker-request-verifier-unavailable";
		store.initializeBaseline([], activityOwner);
		store.enqueue(window, requestId, 1_000, activityOwner);
		store.apply(
			window.windowId,
			workerResponse(requestId, window.events[0]!.cursor, 1),
			1,
			1_001,
		);
		const ready = store.nextActivityAnalysisJob(1, "account-a", 1_002);
		if (ready.kind !== "ready")
			throw new Error("Expected a ready recovery job.");
		const runId = "activity-run-verifier-unavailable";
		const claimed = store.claimActivityAnalysisJob(
			ready.job.jobId,
			"account-a",
			runId,
			1_003,
		);
		const providerStarts: StartActivityAnalysisRun[] = [];
		const coordinator = {
			startActivityAnalysis: async (input: StartActivityAnalysisRun) => {
				providerStarts.push(structuredClone(input));
			},
			reconcileOrphanedActivityRun: async () => "completed" as const,
		};
		const startupDispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator,
			repository: {
				verifyCompletedProactiveFeedbackRun: async () => {
					throw new Error("temporary keychain outage");
				},
			},
		});
		try {
			await expect(startupDispatcher.startAndRecover()).rejects.toThrow(
				"temporary keychain outage",
			);
			expect(store.nextActivityAnalysisJob(1, "account-a", Date.now())).toEqual(
				{
					kind: "running",
					job: expect.objectContaining({
						jobId: claimed.jobId,
						runId,
						terminalFailure: false,
					}),
				},
			);
			expect(providerStarts).toEqual([]);
		} finally {
			await startupDispatcher.stop();
		}

		let verificationCalls = 0;
		const retryErrors: string[] = [];
		const liveDispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator,
			repository: {
				verifyCompletedProactiveFeedbackRun: async () => {
					verificationCalls += 1;
					if (verificationCalls === 1) {
						throw new Error("temporary encrypted repository outage");
					}
					return true;
				},
			},
			retryDelaysMs: [1],
			onError: (error) =>
				retryErrors.push(
					error instanceof Error ? error.message : String(error),
				),
		});
		try {
			liveDispatcher.start();
			await eventually(
				() =>
					verificationCalls >= 2 && store.getStatus(1).accumulatedScore === 0,
			);
			expect(retryErrors).toEqual(["temporary encrypted repository outage"]);
			expect(providerStarts).toEqual([]);
			expect(store.nextActivityAnalysisJob(1, "account-a", Date.now())).toEqual(
				{
					kind: "none",
				},
			);
		} finally {
			await liveDispatcher.stop();
			store.close();
		}
	});

	test("retries repeated phase-two completion failures without calling the provider", async () => {
		const directory = temporaryDirectory();
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const window = sealedWindow("window-phase-two-retry", 1);
		const requestId = "worker-request-phase-two-retry";
		store.initializeBaseline([], activityOwner);
		store.enqueue(window, requestId, 1_000, activityOwner);
		store.apply(
			window.windowId,
			workerResponse(requestId, window.events[0]!.cursor, 1),
			1,
			1_001,
		);
		const ready = store.nextActivityAnalysisJob(1, "account-a", 1_002);
		if (ready.kind !== "ready") throw new Error("Expected a ready retry job.");
		const runId = "activity-run-phase-two-retry";
		store.claimActivityAnalysisJob(ready.job.jobId, "account-a", runId, 1_003);
		expect(store.phaseTwoPendingRunIds("account-a")).toEqual([runId]);
		expect(() => store.phaseTwoPendingRunIds("account-b")).toThrow(
			"another account",
		);

		const complete = store.completeActivityAnalysisJob.bind(store);
		let completionCalls = 0;
		store.completeActivityAnalysisJob = (...args) => {
			completionCalls += 1;
			if (completionCalls <= 2) {
				throw new Error("temporary Worker phase-two outage");
			}
			return complete(...args);
		};
		const providerStarts: StartActivityAnalysisRun[] = [];
		const errors: string[] = [];
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator: {
				startActivityAnalysis: async (input) => {
					providerStarts.push(structuredClone(input));
				},
				reconcileOrphanedActivityRun: async () => "completed" as const,
			},
			repository: {
				verifyCompletedProactiveFeedbackRun: async () => true,
			},
			retryDelaysMs: [1],
			onError: (error) =>
				errors.push(error instanceof Error ? error.message : String(error)),
		});
		try {
			dispatcher.start();
			await eventually(
				() => completionCalls >= 3 && store.getStatus(1).accumulatedScore === 0,
			);
			expect(errors).toEqual([
				"temporary Worker phase-two outage",
				"temporary Worker phase-two outage",
			]);
			expect(providerStarts).toEqual([]);
			expect(store.phaseTwoPendingRunIds("account-a")).toEqual([]);
			expect(store.nextActivityAnalysisJob(1, "account-a", Date.now())).toEqual(
				{
					kind: "none",
				},
			);
		} finally {
			await dispatcher.stop();
			store.close();
		}
	});

	test("retention preserves an expired completion proof until repeated phase-two recovery succeeds", async () => {
		const directory = temporaryDirectory();
		let now = 100_000;
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const repository = new EncryptedAgentRepository({
			databasePath: join(directory, "agent.sqlite3"),
			installationId: "activity-retention-test",
			keyStore: new ActivityTestKeyStore(),
			now: () => now,
		});
		const window = sealedWindow("window-retention-phase-two", 1);
		const requestId = "worker-request-retention-phase-two";
		store.initializeBaseline([], activityOwner);
		store.enqueue(window, requestId, now, activityOwner);
		const sourceEvent = window.events[0];
		if (sourceEvent === undefined) {
			throw new Error(
				"Expected the retention test window to contain an event.",
			);
		}
		const response = workerResponse(requestId, sourceEvent.cursor, 1);
		store.apply(window.windowId, response, 1, now + 1);
		const ready = store.nextActivityAnalysisJob(1, "account-a", now + 2);
		if (ready.kind !== "ready") {
			throw new Error("Expected a ready retention recovery job.");
		}
		const runId = "activity-run-retention-phase-two";
		const claimed = store.claimActivityAnalysisJob(
			ready.job.jobId,
			"account-a",
			runId,
			now + 3,
		);
		await repository.setProactiveFeedbackPolicy(
			"account-a",
			{ enabled: true, retention: 7 },
			0,
		);
		for (const analysis of claimed.analyses) {
			await repository.archiveProactiveFeedbackEventStream({
				accountId: "account-a",
				id: analysis.request_id,
				sourceWindowId: window.windowId,
				windowStartedAtMs: window.startedAtMs,
				windowEndedAtMs: window.endedAtMs,
				analysis,
				archivedAtMs: now,
				consumedAtMs: null,
				consumedRunId: null,
			});
		}
		const feedback = {
			id: `proactive-feedback-${runId}`,
			generatedAtMs: now + 4,
			message: "主题：恢复验证。反馈已完成，等待本地第二阶段消费。",
		};
		await repository.completeProactiveFeedbackRun({
			run: {
				accountId: "account-a",
				id: runId,
				conversationId: null,
				workflowId: claimed.jobId,
				status: "completed",
				input: {
					kind: "activity-analysis",
					jobId: claimed.jobId,
					requestId: claimed.originatingRequestId,
					consumedScore: claimed.consumedScore,
					analyses: structuredClone(claimed.analyses),
				},
				output: {
					kind: "activity-analysis",
					result: feedback.message,
				},
				error: null,
				createdAtMs: now,
				updatedAtMs: feedback.generatedAtMs,
				completedAtMs: feedback.generatedAtMs,
			},
			sourceStreamIds: claimed.analyses.map((analysis) => analysis.request_id),
			feedback,
		});

		now += 8 * 24 * 60 * 60 * 1_000;
		const completePhaseTwo = store.completeActivityAnalysisJob.bind(store);
		let phaseTwoCalls = 0;
		let allowPhaseTwo = false;
		store.completeActivityAnalysisJob = (...args) => {
			phaseTwoCalls += 1;
			if (!allowPhaseTwo) throw new Error("phase two remains unavailable");
			return completePhaseTwo(...args);
		};
		const providerStarts: StartActivityAnalysisRun[] = [];
		const errors: string[] = [];
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator: {
				startActivityAnalysis: async (input) => {
					providerStarts.push(structuredClone(input));
				},
				reconcileOrphanedActivityRun: async () => "completed" as const,
			},
			repository,
			retryDelaysMs: [5],
			nowMs: () => now,
			onError: (error) =>
				errors.push(error instanceof Error ? error.message : String(error)),
		});
		try {
			dispatcher.start();
			await eventually(() => phaseTwoCalls >= 2);
			const protectedRunIds = store.phaseTwoPendingRunIds("account-a");
			expect(protectedRunIds).toEqual([runId]);
			await expect(
				repository.cleanupProactiveFeedback("account-a", now, protectedRunIds),
			).resolves.toEqual({
				deletedEventStreamCount: 0,
				deletedHistoryCount: 0,
			});
			await expect(
				repository.verifyCompletedProactiveFeedbackRun({
					accountId: "account-a",
					runId,
					jobId: claimed.jobId,
					originatingRequestId: claimed.originatingRequestId,
					consumedScore: claimed.consumedScore,
					analyses: claimed.analyses,
				}),
			).resolves.toBeTrue();
			expect(providerStarts).toEqual([]);

			allowPhaseTwo = true;
			await eventually(
				() =>
					store.phaseTwoPendingRunIds("account-a").length === 0 &&
					store.getStatus(1).accumulatedScore === 0,
			);
			expect(providerStarts).toEqual([]);
			expect(errors.length).toBeGreaterThanOrEqual(2);
			await expect(
				repository.cleanupProactiveFeedback("account-a", now, []),
			).resolves.toEqual({
				deletedEventStreamCount: 1,
				deletedHistoryCount: 1,
			});
			await expect(
				repository.verifyCompletedProactiveFeedbackRun({
					accountId: "account-a",
					runId,
					jobId: claimed.jobId,
					originatingRequestId: claimed.originatingRequestId,
					consumedScore: claimed.consumedScore,
					analyses: claimed.analyses,
				}),
			).resolves.toBeFalse();
		} finally {
			await dispatcher.stop();
			repository.close();
			store.close();
		}
	});

	test("reuses a semantic request after transient failure and stops after three invalid outputs", async () => {
		const directory = temporaryDirectory();
		const source = new MutableWindowSource([]);
		const store = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const starts: StartActivityAnalysisRun[] = [];
		const dispatcher = new ActivityAnalysisDispatcher({
			store,
			scoreThreshold: 1,
			auth: authenticatedTestSession("account-a"),
			coordinator: {
				startActivityAnalysis: async (input) => {
					starts.push(structuredClone(input));
				},
			},
			retryDelaysMs: [1],
		});
		const service = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer: new RecordingAnalyzer([1, 1]),
			store,
			scoreThreshold: 1,
			onAgentTriggerRequired: () => dispatcher.wake(),
		});
		try {
			dispatcher.start();
			await service.start();
			const window = sealedWindow("window-semantic-attempts", 1);
			source.windows.push(window);
			await service.enqueueWindow(window);
			await service.whenIdle();
			await eventually(() => starts.length === 1);
			const first = starts[0]!;
			await dispatcher.onActivityRunTerminal({
				jobId: first.jobId,
				runId: first.runId,
				accountId: "account-a",
				status: "failed",
				failure: new Error("temporary network failure"),
				failureClass: "transient",
			});
			await eventually(() => starts.length === 2);
			expect(starts[1]?.requestId).toBe(first.requestId);

			for (let semanticFailure = 0; semanticFailure < 3; semanticFailure += 1) {
				const current = starts.at(-1)!;
				await dispatcher.onActivityRunTerminal({
					jobId: current.jobId,
					runId: current.runId,
					accountId: "account-a",
					status: "failed",
					failure: new Error("invalid activity output"),
					failureClass: "invalid-output",
				});
				if (semanticFailure < 2) {
					await eventually(() => starts.length === semanticFailure + 3);
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(starts).toHaveLength(4);
			expect(
				new Set(starts.slice(1).map((start) => start.requestId)).size,
			).toBe(3);
			expect(store.nextActivityAnalysisJob(1, "account-a", Date.now())).toEqual(
				{
					kind: "none",
				},
			);
			expect(store.getStatus(1)).toMatchObject({
				accumulatedScore: 1,
				agentTriggerPending: true,
			});
			const laterWindow = sealedWindow("window-after-terminal-output", 1);
			source.windows.push(laterWindow);
			await service.enqueueWindow(laterWindow);
			await service.whenIdle();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(starts).toHaveLength(4);
			expect(store.getStatus(1)).toMatchObject({
				accumulatedScore: 2,
				agentTriggerPending: true,
			});
		} finally {
			await service.stop();
			await dispatcher.stop();
			store.close();
		}
	});

	test("persists transport backoff across restart and resets it for a new semantic attempt", async () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "activity-window-worker.sqlite3");
		let now = 1_000;
		let store: ActivityWindowDeliveryStore | null =
			new ActivityWindowDeliveryStore(databasePath);
		seedActivityAnalysisJob(store, "durable-transport-backoff", now);
		const starts: StartActivityAnalysisRun[] = [];
		let dispatcher: ActivityAnalysisDispatcher | null = null;
		const startDispatcher = () => {
			if (store === null) throw new Error("Expected an open Worker store.");
			const next = new ActivityAnalysisDispatcher({
				store,
				scoreThreshold: 1,
				auth: authenticatedTestSession("account-a"),
				coordinator: {
					startActivityAnalysis: async (input) => {
						starts.push(structuredClone(input));
					},
				},
				retryDelaysMs: [5_000, 30_000, 120_000, 600_000],
				nowMs: () => now,
			});
			dispatcher = next;
			next.start();
			return next;
		};
		const stopDispatcher = async () => {
			const active = dispatcher;
			if (active !== null) await active.stop();
			dispatcher = null;
		};
		const stopAndReopenAt = async (reopenAtMs: number) => {
			await stopDispatcher();
			if (store === null) throw new Error("Expected an open Worker store.");
			store.close();
			now = reopenAtMs;
			store = new ActivityWindowDeliveryStore(databasePath);
		};
		try {
			let currentDispatcher = startDispatcher();
			await eventually(() => starts.length === 1);
			const first = starts[0];
			if (first === undefined) throw new Error("Expected the first Agent run.");
			await currentDispatcher.onActivityRunTerminal({
				jobId: first.jobId,
				runId: first.runId,
				accountId: "account-a",
				status: "failed",
				failure: new Error("first transient failure"),
				failureClass: "transient",
			});
			await stopAndReopenAt(5_999);
			expect(store.nextActivityAnalysisJob(1, "account-a", now)).toEqual({
				kind: "not_due",
				nextAttemptAtMs: 6_000,
			});

			await stopAndReopenAt(6_000);
			const afterFirstTransient = store.nextActivityAnalysisJob(
				1,
				"account-a",
				now,
			);
			if (afterFirstTransient.kind !== "ready") {
				throw new Error("Expected the first durable transport retry.");
			}
			expect(afterFirstTransient.job).toMatchObject({
				attempt: 0,
				transportAttempt: 1,
				originatingRequestId: first.requestId,
			});
			currentDispatcher = startDispatcher();
			await eventually(() => starts.length === 2);
			const second = starts[1];
			if (second === undefined)
				throw new Error("Expected the second Agent run.");
			expect(second.requestId).toBe(first.requestId);
			await currentDispatcher.onActivityRunTerminal({
				jobId: second.jobId,
				runId: second.runId,
				accountId: "account-a",
				status: "failed",
				failure: new Error("second transient failure"),
				failureClass: "transient",
			});
			await stopAndReopenAt(35_999);
			expect(store.nextActivityAnalysisJob(1, "account-a", now)).toEqual({
				kind: "not_due",
				nextAttemptAtMs: 36_000,
			});

			await stopAndReopenAt(36_000);
			const afterSecondTransient = store.nextActivityAnalysisJob(
				1,
				"account-a",
				now,
			);
			if (afterSecondTransient.kind !== "ready") {
				throw new Error("Expected the second durable transport retry.");
			}
			expect(afterSecondTransient.job).toMatchObject({
				attempt: 0,
				transportAttempt: 2,
				originatingRequestId: first.requestId,
			});
			currentDispatcher = startDispatcher();
			await eventually(() => starts.length === 3);
			const third = starts[2];
			if (third === undefined) throw new Error("Expected the third Agent run.");
			expect(third.requestId).toBe(first.requestId);
			await currentDispatcher.onActivityRunTerminal({
				jobId: third.jobId,
				runId: third.runId,
				accountId: "account-a",
				status: "failed",
				failure: new Error("third transient failure"),
				failureClass: "transient",
			});
			await stopAndReopenAt(155_999);
			expect(store.nextActivityAnalysisJob(1, "account-a", now)).toEqual({
				kind: "not_due",
				nextAttemptAtMs: 156_000,
			});

			await stopAndReopenAt(156_000);
			const afterThirdTransient = store.nextActivityAnalysisJob(
				1,
				"account-a",
				now,
			);
			if (afterThirdTransient.kind !== "ready") {
				throw new Error("Expected the third durable transport retry.");
			}
			expect(afterThirdTransient.job).toMatchObject({
				attempt: 0,
				transportAttempt: 3,
				originatingRequestId: first.requestId,
			});
			currentDispatcher = startDispatcher();
			await eventually(() => starts.length === 4);
			const fourth = starts[3];
			if (fourth === undefined)
				throw new Error("Expected the fourth Agent run.");
			expect(fourth.requestId).toBe(first.requestId);
			await currentDispatcher.onActivityRunTerminal({
				jobId: fourth.jobId,
				runId: fourth.runId,
				accountId: "account-a",
				status: "failed",
				failure: new Error("fourth transient failure"),
				failureClass: "transient",
			});
			await stopAndReopenAt(755_999);
			expect(store.nextActivityAnalysisJob(1, "account-a", now)).toEqual({
				kind: "not_due",
				nextAttemptAtMs: 756_000,
			});

			await stopAndReopenAt(756_000);
			const afterFourthTransient = store.nextActivityAnalysisJob(
				1,
				"account-a",
				now,
			);
			if (afterFourthTransient.kind !== "ready") {
				throw new Error("Expected the fourth durable transport retry.");
			}
			expect(afterFourthTransient.job).toMatchObject({
				attempt: 0,
				transportAttempt: 4,
				originatingRequestId: first.requestId,
			});
			currentDispatcher = startDispatcher();
			await eventually(() => starts.length === 5);
			const fifth = starts[4];
			if (fifth === undefined) throw new Error("Expected the fifth Agent run.");
			expect(fifth.requestId).toBe(first.requestId);
			await currentDispatcher.onActivityRunTerminal({
				jobId: fifth.jobId,
				runId: fifth.runId,
				accountId: "account-a",
				status: "failed",
				failure: new Error("invalid model output"),
				failureClass: "invalid-output",
			});
			await stopAndReopenAt(760_999);
			expect(store.nextActivityAnalysisJob(1, "account-a", now)).toEqual({
				kind: "not_due",
				nextAttemptAtMs: 761_000,
			});

			await stopAndReopenAt(761_000);
			const newSemanticAttempt = store.nextActivityAnalysisJob(
				1,
				"account-a",
				now,
			);
			if (newSemanticAttempt.kind !== "ready") {
				throw new Error(
					"Expected a new semantic attempt after invalid output.",
				);
			}
			expect(newSemanticAttempt.job).toMatchObject({
				attempt: 1,
				transportAttempt: 0,
			});
			expect(newSemanticAttempt.job.originatingRequestId).not.toBe(
				first.requestId,
			);
			currentDispatcher = startDispatcher();
			await eventually(() => starts.length === 6);
			expect(starts[5]?.requestId).toBe(
				newSemanticAttempt.job.originatingRequestId,
			);
		} finally {
			await stopDispatcher();
			if (store !== null) store.close();
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

	test("never assigns globally discovered windows to a later login", async () => {
		const directory = temporaryDirectory();
		const legacy = sealedWindow("window-before-cutover", 2);
		const newWindow = sealedWindow("window-after-cutover", 2);
		const source = new MutableWindowSource([legacy]);

		const firstStore = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const firstService = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer: new RecordingAnalyzer([0.8]),
			store: firstStore,
		});
		await firstService.start();
		await firstService.whenIdle();
		expect(firstService.getStatus().acceptedAnalysisCount).toBe(0);
		await firstService.stop();
		firstStore.close();

		// This window has no durable account owner. A later login must not claim it.
		source.windows.push(newWindow);
		const analyzer = new RecordingAnalyzer([0.8]);
		const recoveredStore = new ActivityWindowDeliveryStore(
			join(directory, "activity-window-worker.sqlite3"),
		);
		const recovered = new ActivityWindowDeliveryService({
			...ownerBoundary(),
			source,
			analyzer,
			store: recoveredStore,
		});
		try {
			await recovered.start();
			await recovered.whenIdle();
			expect(analyzer.requests).toHaveLength(0);
			expect(recovered.getStatus()).toMatchObject({
				acceptedAnalysisCount: 0,
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
			...ownerBoundary(),
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
			store.initializeBaseline([], activityOwner);
			for (let index = 0; index < receiptCount; index += 1) {
				const window = sealedWindow(`window-backlog-${index}`, 1);
				const requestId = `request-backlog-${index}`;
				store.enqueue(window, requestId, index, activityOwner);
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
					"account-a",
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
					"account-a",
					runId,
					receiptCount * 3 + completedJobs,
				);
				store.completeActivityAnalysisJob(
					next.job.jobId,
					"account-a",
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
			store.initializeBaseline([], activityOwner);
			for (let index = 0; index < zeroScoreReceiptCount + 1; index += 1) {
				const window = sealedWindow(`window-zero-score-${index}`, 1);
				const requestId = `request-zero-score-${index}`;
				const score = index === zeroScoreReceiptCount ? 1 : 0;
				store.enqueue(window, requestId, index, activityOwner);
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
					"account-a",
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
					"account-a",
					runId,
					zeroScoreReceiptCount * 3 + completedJobs,
				);
				store.completeActivityAnalysisJob(
					next.job.jobId,
					"account-a",
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
