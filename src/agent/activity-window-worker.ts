import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	isActivityAnalysisWorkerResult,
	MAXIMUM_ACTIVITY_ANALYSIS_PROMPT_CHARACTERS,
	MAXIMUM_ACTIVITY_ANALYSIS_RESULT_CHARACTERS,
	MAXIMUM_ACTIVITY_ANALYSIS_RESULTS,
	type ActivityAnalysisWorkerResult as SharedActivityAnalysisWorkerResult,
	serializedActivityAnalysisLength,
} from "../shared/activity-analysis-contract";
import type { AuthSessionIdentity } from "../shared/session-identity";
import {
	ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION,
	ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION,
	type ActivityEventAnalyzer,
	ActivityEventWorkerClientError,
	type ActivityEventWorkerRequest,
	type ActivityEventWorkerResponse,
	type ActivityScoreStatus,
	validateActivityEventWorkerResponse,
} from "./activity-event-worker";
import type { EventWindowV1 } from "./reflection/types";

export const DEFAULT_ACTIVITY_WINDOW_SCORE_THRESHOLD = 1;

const MAXIMUM_REQUEST_ID_LENGTH = 128;
const MAXIMUM_WINDOW_ID_LENGTH = 200;
const MAXIMUM_ACTIVITY_ANALYSIS_JOB_ID_LENGTH = 160;
const MAXIMUM_ACCOUNT_ID_LENGTH = 256;
const MAXIMUM_RUN_ID_LENGTH = 256;
const SCORE_EPSILON = 1e-9;
const MAXIMUM_ACTIVITY_WINDOW_SEMANTIC_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [
	1_000, 5_000, 15_000, 60_000, 300_000,
] as const;

type ActivityWindowStateRow = {
	accumulated_score: number;
	trigger_pending: number;
	baseline_initialized: number;
	owner_account_id: string | null;
};

export type ActivityWindowLegacyPolicyCutoverStatus = {
	state: "pending" | "complete";
	accountId: string | null;
};

export type ActivityWindowLegacyPolicyCutoverClearResult = {
	outboxCount: number;
	receiptCount: number;
	jobCount: number;
};

type ActivityWindowLegacyPolicyCutoverRow = {
	state: "pending" | "complete";
	account_id: string | null;
	updated_at_ms: number;
};

type ActivityWindowReceiptRow = {
	request_id: string;
	source_window_id: string;
	response_json: string;
};

export type ActivityAnalysisJobState =
	| "pending"
	| "running"
	| "retry_wait"
	| "completed";

type ActivityAnalysisJobRow = {
	job_id: string;
	account_id: string | null;
	run_id: string | null;
	status: ActivityAnalysisJobState;
	analyses_json: string;
	consumed_score: number;
	/** Completed invalid-output attempts for the current durable job. */
	attempt: number;
	/** Consecutive transient deferrals for the current semantic attempt. */
	transport_attempt: number;
	originating_request_id: string | null;
	terminal_failure: number;
	next_attempt_at_ms: number;
	created_at_ms: number;
	updated_at_ms: number;
	last_error: string | null;
};

type ActivityWindowOutboxRow = {
	window_id: string;
	request_id: string;
	semantic_request_json: string | null;
	semantic_attempt: number;
	window_json: string;
	owner_account_id: string | null;
	owner_session_id: string | null;
	owner_generation: number | null;
	queued_at_ms: number;
	attempt: number;
	next_attempt_at_ms: number;
	terminal: number;
	last_error: string | null;
};

type QueuedActivityWindow = {
	window: EventWindowV1;
	requestId: string;
	request: ActivityEventWorkerRequest;
	semanticAttempt: number;
	owner: AuthSessionIdentity;
	attempt: number;
	nextAttemptAtMs: number;
};

/**
 * The only input the automatic Agent is permitted to consume. It is derived
 * from the Worker response after the raw sealed window has already left the
 * delivery path; it deliberately contains neither `raw_event` nor a local
 * window payload.
 */
export type ActivityAnalysisWorkerResult = SharedActivityAnalysisWorkerResult;

export type ActivityAnalysisJob = {
	jobId: string;
	accountId: string | null;
	runId: string | null;
	state: ActivityAnalysisJobState;
	analyses: readonly ActivityAnalysisWorkerResult[];
	consumedScore: number;
	/** Completed invalid-output attempts; three semantic attempts are allowed. */
	attempt: number;
	/** Consecutive transient deferrals used only for durable transport backoff. */
	transportAttempt: number;
	originatingRequestId: string;
	terminalFailure: boolean;
	nextAttemptAtMs: number;
	createdAtMs: number;
	updatedAtMs: number;
	lastError: string | null;
};

export type ActivityAnalysisJobNext =
	| { kind: "none" }
	| { kind: "not_due"; nextAttemptAtMs: number }
	| { kind: "account_mismatch" }
	| { kind: "running"; job: ActivityAnalysisJob }
	| { kind: "ready"; job: ActivityAnalysisJob };

export interface ActivityWindowSource {
	/** Returns only immutable windows durably attributed to this account. */
	listWindowsForAccount(accountId: string): Promise<readonly EventWindowV1[]>;
}

export type ActivityWindowDeliveryState =
	| "starting"
	| "ready"
	| "retry_wait"
	| "stopped";

export type ActivityWindowDeliveryStatus = ActivityScoreStatus & {
	state: ActivityWindowDeliveryState;
	lastError:
		| "invalid_request"
		| "request_timeout"
		| "transport_error"
		| "http_error"
		| "invalid_response"
		| "unknown"
		| null;
	pendingWindowCount: number;
	terminalWindowCount: number;
};

export type AcceptedActivityWindowAnalysis = {
	sourceWindowId: string;
	response: ActivityEventWorkerResponse;
	status: ActivityScoreStatus;
};

export type ArchiveActivityWindowAnalysis = {
	owner: AuthSessionIdentity;
	sourceWindow: EventWindowV1;
	requestId: string;
	analysis: ActivityAnalysisWorkerResult;
	archivedAtMs: number;
};

export type AcknowledgeActivityWindowSource = {
	owner: AuthSessionIdentity;
	sourceWindowId: string;
	requestId: string;
};

export type ArchivedActivityWindowRecovery =
	| { kind: "pending"; analysis: ActivityAnalysisWorkerResult }
	| { kind: "consumed" }
	| { kind: "invalid" };

export type ActivityWindowDeliveryServiceOptions = {
	source: ActivityWindowSource;
	analyzer: ActivityEventAnalyzer;
	store: ActivityWindowDeliveryStore;
	scoreThreshold?: number;
	retryDelaysMs?: readonly number[];
	nowMs?: () => number;
	onAcceptedAnalysis?: (
		result: AcceptedActivityWindowAnalysis,
	) => void | Promise<void>;
	/** Must durably archive the normalized response before the receipt ledger advances. */
	archiveAnalysisBeforeReceipt?: (
		result: ArchiveActivityWindowAnalysis,
	) => void | Promise<void>;
	/** Restores an archive committed before a crash that preceded Worker receipt. */
	recoverArchivedAnalysis?: (input: {
		owner: AuthSessionIdentity;
		sourceWindow: EventWindowV1;
		requestId: string;
	}) =>
		| ArchivedActivityWindowRecovery
		| null
		| Promise<ArchivedActivityWindowRecovery | null>;
	/** Releases the Reflection cloud owner only after the Worker receipt commits. */
	acknowledgeSourceAfterReceipt?: (
		result: AcknowledgeActivityWindowSource,
	) => void | Promise<void>;
	onAgentTriggerRequired?: (
		status: ActivityScoreStatus,
	) => void | Promise<void>;
	onError?: (error: unknown) => void;
	/** Captures and revalidates the exact Bun-authenticated owner. */
	currentSession?: () => AuthSessionIdentity | null;
	isCurrentSession?: (identity: AuthSessionIdentity) => boolean;
};

/**
 * A dedicated owner-only ledger for cloud analysis of sealed reflection
 * windows. It intentionally has no EventJournal consumer: the Reflection
 * collector is the single authority deciding when raw activity is mature
 * enough to leave the device.
 */
export class ActivityWindowDeliveryStore {
	private readonly database: Database;

	constructor(databasePath: string) {
		const directory = dirname(databasePath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		hardenPath(directory, 0o700);
		this.database = new Database(databasePath, { create: true, strict: true });
		this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		const legacyLedgerExisted = [
			"activity_window_worker_state",
			"activity_window_worker_outbox",
			"activity_window_worker_receipts",
			"activity_window_worker_agent_jobs",
		].some((table) => this.tableExists(table));
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS activity_window_worker_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				owner_account_id TEXT,
				accumulated_score REAL NOT NULL,
				trigger_pending INTEGER NOT NULL CHECK (trigger_pending IN (0, 1)),
				baseline_initialized INTEGER NOT NULL CHECK (baseline_initialized IN (0, 1)),
				updated_at_ms INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS activity_window_worker_baseline (
				window_id TEXT PRIMARY KEY
			);
			CREATE TABLE IF NOT EXISTS activity_window_worker_receipts (
				request_id TEXT PRIMARY KEY,
				source_window_id TEXT NOT NULL UNIQUE,
				response_json TEXT NOT NULL,
				received_at_ms INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS activity_window_worker_outbox (
				window_id TEXT PRIMARY KEY,
				request_id TEXT NOT NULL UNIQUE,
				semantic_request_json TEXT,
				semantic_attempt INTEGER NOT NULL DEFAULT 0 CHECK (semantic_attempt >= 0),
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
			CREATE INDEX IF NOT EXISTS activity_window_worker_outbox_order
				ON activity_window_worker_outbox (terminal, queued_at_ms, window_id);
			CREATE TABLE IF NOT EXISTS activity_window_worker_agent_jobs (
				job_id TEXT PRIMARY KEY,
				account_id TEXT,
				run_id TEXT,
				status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retry_wait', 'completed')),
				analyses_json TEXT NOT NULL,
				consumed_score REAL NOT NULL CHECK (consumed_score >= 0),
				attempt INTEGER NOT NULL CHECK (attempt >= 0),
				transport_attempt INTEGER NOT NULL DEFAULT 0 CHECK (transport_attempt >= 0),
				originating_request_id TEXT,
				terminal_failure INTEGER NOT NULL DEFAULT 0 CHECK (terminal_failure IN (0, 1)),
				next_attempt_at_ms INTEGER NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				last_error TEXT
			);
			CREATE UNIQUE INDEX IF NOT EXISTS activity_window_worker_one_active_agent_job
				ON activity_window_worker_agent_jobs ((1))
				WHERE status IN ('pending', 'running', 'retry_wait');
			CREATE TABLE IF NOT EXISTS activity_window_worker_agent_job_receipts (
				job_id TEXT NOT NULL REFERENCES activity_window_worker_agent_jobs(job_id),
				request_id TEXT NOT NULL REFERENCES activity_window_worker_receipts(request_id),
				PRIMARY KEY (job_id, request_id),
				UNIQUE (request_id)
			);
			CREATE TABLE IF NOT EXISTS activity_window_worker_policy_cutover (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
				account_id TEXT,
				updated_at_ms INTEGER NOT NULL
			);
		`);
		this.ensureStateOwnerColumn();
		this.ensureOutboxOwnerColumns();
		this.ensureOutboxSemanticColumns();
		this.ensureAgentJobRecoveryColumns();
		this.database
			.query(
				`INSERT OR IGNORE INTO activity_window_worker_state
				 (id, accumulated_score, trigger_pending, baseline_initialized, updated_at_ms)
				 VALUES (1, 0, 0, 0, ?)`,
			)
			.run(Date.now());
		this.database
			.query(
				`INSERT OR IGNORE INTO activity_window_worker_policy_cutover
				 (id, state, account_id, updated_at_ms)
				 VALUES (1, ?, NULL, ?)`,
			)
			.run(legacyLedgerExisted ? "pending" : "complete", Date.now());
		hardenPath(databasePath, 0o600);
		hardenPath(`${databasePath}-wal`, 0o600);
		hardenPath(`${databasePath}-shm`, 0o600);
	}

	close(): void {
		this.database.close();
	}

	getLegacyPolicyCutoverStatus(
		accountId: string,
	): ActivityWindowLegacyPolicyCutoverStatus {
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		const row = this.legacyPolicyCutoverRow();
		this.assertLegacyPolicyCutoverAccount(account, row);
		return { state: row.state, accountId: row.account_id };
	}

	/**
	 * First phase of the upgrade cutover. It removes every pre-policy Worker
	 * copy while keeping the marker pending so Reflection handoff cleanup can be
	 * retried before the caller commits the final phase.
	 */
	clearLegacyPolicyCutoverWorkerData(
		accountId: string,
		updatedAtMs = Date.now(),
	): ActivityWindowLegacyPolicyCutoverClearResult {
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		const updatedAt = nonNegativeSafeInteger(updatedAtMs, "updatedAtMs");
		const clear = this.database.transaction(() => {
			const marker = this.legacyPolicyCutoverRow();
			this.assertLegacyPolicyCutoverAccount(account, marker);
			if (marker.state === "complete") {
				return { outboxCount: 0, receiptCount: 0, jobCount: 0 };
			}
			this.database
				.query("DELETE FROM activity_window_worker_agent_job_receipts")
				.run();
			const jobCount = this.database
				.query("DELETE FROM activity_window_worker_agent_jobs")
				.run().changes;
			const receiptCount = this.database
				.query("DELETE FROM activity_window_worker_receipts")
				.run().changes;
			const outboxCount = this.database
				.query("DELETE FROM activity_window_worker_outbox")
				.run().changes;
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET owner_account_id = COALESCE(owner_account_id, ?),
					     accumulated_score = 0, trigger_pending = 0, updated_at_ms = ?
					 WHERE id = 1`,
				)
				.run(account, updatedAt);
			this.database
				.query(
					`UPDATE activity_window_worker_policy_cutover
					 SET account_id = COALESCE(account_id, ?), updated_at_ms = ?
					 WHERE id = 1 AND state = 'pending'`,
				)
				.run(account, updatedAt);
			return { outboxCount, receiptCount, jobCount };
		});
		return clear.immediate();
	}

	/** Final phase, called only after the account's Reflection handoffs clear. */
	markLegacyPolicyCutoverComplete(
		accountId: string,
		updatedAtMs = Date.now(),
	): boolean {
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		const updatedAt = nonNegativeSafeInteger(updatedAtMs, "updatedAtMs");
		const complete = this.database.transaction(() => {
			const marker = this.legacyPolicyCutoverRow();
			this.assertLegacyPolicyCutoverAccount(account, marker);
			if (marker.state === "complete") return false;
			const pending = this.database
				.query(
					`SELECT
					   (SELECT COUNT(*) FROM activity_window_worker_outbox) +
					   (SELECT COUNT(*) FROM activity_window_worker_receipts) +
					   (SELECT COUNT(*) FROM activity_window_worker_agent_jobs) +
					   (SELECT COUNT(*) FROM activity_window_worker_agent_job_receipts)
					 AS count`,
				)
				.get() as { count: number };
			const state = this.stateRow();
			if (
				pending.count !== 0 ||
				state.accumulated_score !== 0 ||
				state.trigger_pending !== 0
			) {
				throw new Error(
					"Activity legacy policy cutover still has Worker pending data.",
				);
			}
			const result = this.database
				.query(
					`UPDATE activity_window_worker_policy_cutover
					 SET state = 'complete', account_id = COALESCE(account_id, ?),
					     updated_at_ms = ?
					 WHERE id = 1 AND state = 'pending'`,
				)
				.run(account, updatedAt);
			return result.changes === 1;
		});
		return complete.immediate();
	}

	/**
	 * The first activation establishes a local cutover before Reflection starts.
	 * Earlier sealed windows remain on-device and are never backfilled to cloud.
	 */
	initializeBaseline(
		windows: readonly EventWindowV1[],
		owner: AuthSessionIdentity,
	): boolean {
		const normalized = uniqueWindows(windows);
		const normalizedOwner = validateSessionIdentity(owner);
		this.assertLegacyPolicyCutoverComplete(normalizedOwner.accountId);
		const transaction = this.database.transaction(() => {
			const state = this.stateRow();
			if (state.baseline_initialized === 1) {
				if (state.owner_account_id !== normalizedOwner.accountId) {
					throw new Error("Activity window ledger belongs to another account.");
				}
				return false;
			}
			if (
				state.owner_account_id !== null &&
				state.owner_account_id !== normalizedOwner.accountId
			) {
				throw new Error("Activity window ledger belongs to another account.");
			}
			for (const window of normalized) {
				this.database
					.query(
						"INSERT OR IGNORE INTO activity_window_worker_baseline (window_id) VALUES (?)",
					)
					.run(window.windowId);
			}
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET baseline_initialized = 1, owner_account_id = ?, updated_at_ms = ?
					 WHERE id = 1`,
				)
				.run(normalizedOwner.accountId, Date.now());
			return true;
		});
		return transaction.immediate();
	}

	enqueue(
		window: EventWindowV1,
		requestId: string,
		queuedAtMs: number,
		owner: AuthSessionIdentity,
	): boolean {
		const normalized = validateWindow(window);
		const id = boundedString(requestId, "requestId", MAXIMUM_REQUEST_ID_LENGTH);
		const queuedAt = nonNegativeSafeInteger(queuedAtMs, "queuedAtMs");
		const serialized = serializeWindow(normalized);
		const semanticRequest = activityWindowSemanticRequest(normalized, id);
		const serializedSemanticRequest = serializeSemanticRequest(
			semanticRequest,
			normalized,
			id,
		);
		const normalizedOwner = validateSessionIdentity(owner);
		const transaction = this.database.transaction(() => {
			const state = this.stateRow();
			if (state.baseline_initialized !== 1) {
				throw new Error(
					"Activity window delivery baseline is not initialized.",
				);
			}
			if (state.owner_account_id !== normalizedOwner.accountId) {
				throw new Error("Activity window ledger belongs to another account.");
			}
			if (this.isBaselineWindow(normalized.windowId)) return false;
			const receipt = this.receiptByWindowId(normalized.windowId);
			if (receipt !== null) {
				if (
					!isActivityWindowSemanticRequestId(normalized, receipt.request_id)
				) {
					throw new Error("Activity window request id collision.");
				}
				return false;
			}
			const existing = this.outboxByWindowId(normalized.windowId);
			if (existing !== null) {
				if (
					existing.window_json !== serialized ||
					existing.owner_account_id !== normalizedOwner.accountId ||
					!isActivityWindowSemanticRequestId(normalized, existing.request_id)
				) {
					throw new Error("Activity window outbox collision.");
				}
				const semanticAttempt = activityWindowSemanticAttempt(
					existing.semantic_attempt,
				);
				if (
					activityWindowRequestId(normalized, semanticAttempt) !==
					existing.request_id
				) {
					throw new Error("Activity window outbox semantic identity mismatch.");
				}
				if (existing.semantic_request_json !== null) {
					parseStoredSemanticRequest(
						existing.semantic_request_json,
						normalized,
						existing.request_id,
					);
				}
				return false;
			}
			this.database
				.query(
					`INSERT INTO activity_window_worker_outbox
					 (window_id, request_id, semantic_request_json, semantic_attempt,
					  window_json, owner_account_id,
					  owner_session_id, owner_generation, queued_at_ms, attempt,
					  next_attempt_at_ms, terminal, last_error)
					 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, 0, NULL)`,
				)
				.run(
					normalized.windowId,
					id,
					serializedSemanticRequest,
					serialized,
					normalizedOwner.accountId,
					normalizedOwner.sessionId,
					normalizedOwner.generation,
					queuedAt,
					queuedAt,
				);
			return true;
		});
		return transaction.immediate();
	}

	nextWindow(
		nowMs: number,
		owner: AuthSessionIdentity,
	):
		| { kind: "none" }
		| { kind: "not_due"; nextAttemptAtMs: number }
		| { kind: "ready"; queued: QueuedActivityWindow } {
		const now = nonNegativeSafeInteger(nowMs, "nowMs");
		const normalizedOwner = validateSessionIdentity(owner);
		if (this.stateRow().owner_account_id !== normalizedOwner.accountId) {
			throw new Error("Activity window ledger belongs to another account.");
		}
		const row = this.database
			.query(
				`SELECT window_id, request_id, semantic_request_json, semantic_attempt,
				 window_json, owner_account_id,
				 owner_session_id, owner_generation, queued_at_ms, attempt,
				 next_attempt_at_ms, terminal, last_error
				 FROM activity_window_worker_outbox
				 WHERE terminal = 0 AND owner_account_id = ?
				 ORDER BY queued_at_ms, window_id
				 LIMIT 1`,
			)
			.get(normalizedOwner.accountId) as ActivityWindowOutboxRow | null;
		if (row === null) return { kind: "none" };
		const applied = this.receiptByWindowId(row.window_id);
		if (applied !== null && applied.request_id !== row.request_id) {
			throw new Error("Activity window acknowledgement identity mismatch.");
		}
		if (applied === null && row.next_attempt_at_ms > now) {
			return { kind: "not_due", nextAttemptAtMs: row.next_attempt_at_ms };
		}
		const window = parseStoredWindow(row.window_json, row.window_id);
		const semanticAttempt = activityWindowSemanticAttempt(row.semantic_attempt);
		const request =
			row.semantic_request_json === null
				? this.materializeLegacySemanticRequest(window, row.request_id)
				: parseStoredSemanticRequest(
						row.semantic_request_json,
						window,
						row.request_id,
					);
		return {
			kind: "ready",
			queued: {
				window,
				requestId: row.request_id,
				request,
				semanticAttempt,
				owner: normalizedOwner,
				attempt: row.attempt,
				nextAttemptAtMs: row.next_attempt_at_ms,
			},
		};
	}

	defer(windowId: string, nextAttemptAtMs: number, errorCode: string): void {
		const id = boundedString(windowId, "windowId", MAXIMUM_WINDOW_ID_LENGTH);
		const next = nonNegativeSafeInteger(nextAttemptAtMs, "nextAttemptAtMs");
		const error = boundedString(errorCode, "errorCode", 80);
		const result = this.database
			.query(
				`UPDATE activity_window_worker_outbox
				 SET attempt = attempt + 1, next_attempt_at_ms = ?, last_error = ?
				 WHERE window_id = ? AND terminal = 0`,
			)
			.run(next, error, id);
		if (result.changes !== 1)
			throw new Error("Unknown activity window outbox record.");
	}

	advanceSemanticAttempt(
		windowId: string,
		currentRequestId: string,
		nextAttemptAtMs: number,
		errorCode: string,
		next: { requestId: string; request: ActivityEventWorkerRequest } | null,
	): { terminal: boolean; semanticAttempt: number } {
		const id = boundedString(windowId, "windowId", MAXIMUM_WINDOW_ID_LENGTH);
		const currentRequest = boundedString(
			currentRequestId,
			"currentRequestId",
			MAXIMUM_REQUEST_ID_LENGTH,
		);
		const nextAttemptAt = nonNegativeSafeInteger(
			nextAttemptAtMs,
			"nextAttemptAtMs",
		);
		const error = boundedString(errorCode, "errorCode", 80);
		const transaction = this.database.transaction(() => {
			const row = this.outboxByWindowId(id);
			if (
				row === null ||
				row.terminal !== 0 ||
				row.request_id !== currentRequest
			) {
				throw new Error("Activity window semantic attempt identity mismatch.");
			}
			const currentSemanticAttempt = activityWindowSemanticAttempt(
				row.semantic_attempt,
			);
			const nextSemanticAttempt = currentSemanticAttempt + 1;
			if (nextSemanticAttempt >= MAXIMUM_ACTIVITY_WINDOW_SEMANTIC_ATTEMPTS) {
				if (next !== null) {
					throw new Error(
						"Terminal semantic attempt cannot carry a new request.",
					);
				}
				const result = this.database
					.query(
						`UPDATE activity_window_worker_outbox
						 SET attempt = attempt + 1, terminal = 1, last_error = ?
						 WHERE window_id = ? AND request_id = ? AND semantic_attempt = ?
						   AND terminal = 0`,
					)
					.run(error, id, currentRequest, currentSemanticAttempt);
				if (result.changes !== 1) {
					throw new Error(
						"Activity window semantic attempt changed concurrently.",
					);
				}
				return {
					terminal: true,
					semanticAttempt: currentSemanticAttempt,
				};
			}
			if (next === null) {
				throw new Error("A retryable semantic attempt requires a new request.");
			}
			const nextRequestId = boundedString(
				next.requestId,
				"nextRequestId",
				MAXIMUM_REQUEST_ID_LENGTH,
			);
			if (nextRequestId === currentRequest) {
				throw new Error("A semantic retry must use a new request id.");
			}
			const window = parseStoredWindow(row.window_json, row.window_id);
			const serializedRequest = serializeSemanticRequest(
				next.request,
				window,
				nextRequestId,
			);
			const result = this.database
				.query(
					`UPDATE activity_window_worker_outbox
					 SET request_id = ?, semantic_request_json = ?, semantic_attempt = ?,
					     attempt = attempt + 1, next_attempt_at_ms = ?, last_error = ?
					 WHERE window_id = ? AND request_id = ? AND semantic_attempt = ?
					   AND terminal = 0`,
				)
				.run(
					nextRequestId,
					serializedRequest,
					nextSemanticAttempt,
					nextAttemptAt,
					error,
					id,
					currentRequest,
					currentSemanticAttempt,
				);
			if (result.changes !== 1) {
				throw new Error(
					"Activity window semantic attempt changed concurrently.",
				);
			}
			return { terminal: false, semanticAttempt: nextSemanticAttempt };
		});
		return transaction.immediate();
	}

	markTerminal(windowId: string, errorCode: string): void {
		const id = boundedString(windowId, "windowId", MAXIMUM_WINDOW_ID_LENGTH);
		const error = boundedString(errorCode, "errorCode", 80);
		const result = this.database
			.query(
				`UPDATE activity_window_worker_outbox
				 SET attempt = attempt + 1, terminal = 1, last_error = ?
				 WHERE window_id = ? AND terminal = 0`,
			)
			.run(error, id);
		if (result.changes !== 1)
			throw new Error("Unknown activity window outbox record.");
	}

	apply(
		windowId: string,
		response: ActivityEventWorkerResponse,
		scoreThreshold: number,
		receivedAtMs: number,
		retainOutboxForSourceAcknowledgement = false,
	): {
		accepted: boolean;
		response: ActivityEventWorkerResponse;
		status: ActivityScoreStatus;
		triggerBecamePending: boolean;
	} {
		const id = boundedString(windowId, "windowId", MAXIMUM_WINDOW_ID_LENGTH);
		const normalized = validateResponse(response, response.request_id);
		const threshold = validScoreThreshold(scoreThreshold);
		const receivedAt = nonNegativeSafeInteger(receivedAtMs, "receivedAtMs");
		if (typeof retainOutboxForSourceAcknowledgement !== "boolean") {
			throw new Error("Activity window acknowledgement mode is invalid.");
		}
		const transaction = this.database.transaction(() => {
			const outbox = this.outboxByWindowId(id);
			if (outbox === null || outbox.request_id !== normalized.request_id) {
				throw new Error(
					"Activity window receipt has no matching outbox record.",
				);
			}
			const existing = this.receiptByRequestId(normalized.request_id);
			const state = this.stateRow();
			const count = this.receiptCount();
			if (existing !== null) {
				if (existing.source_window_id !== id) {
					throw new Error("Activity window request id collision.");
				}
				if (!retainOutboxForSourceAcknowledgement) this.deleteOutbox(id);
				return {
					accepted: false,
					response: parseStoredResponse(
						existing.response_json,
						normalized.request_id,
					),
					status: statusFromRow(state, threshold, count),
					triggerBecamePending: false,
				};
			}
			const priorWindow = this.receiptByWindowId(id);
			if (priorWindow !== null) {
				throw new Error("Activity window was associated with another request.");
			}
			const accumulatedScore = state.accumulated_score + normalized.score;
			if (!Number.isFinite(accumulatedScore) || accumulatedScore < 0) {
				throw new Error("Activity window score accumulator is invalid.");
			}
			this.database
				.query(
					`INSERT INTO activity_window_worker_receipts
					 (request_id, source_window_id, response_json, received_at_ms)
					 VALUES (?, ?, ?, ?)`,
				)
				.run(normalized.request_id, id, JSON.stringify(normalized), receivedAt);
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET accumulated_score = ?, updated_at_ms = ?
					 WHERE id = 1`,
				)
				.run(accumulatedScore, receivedAt);
			const triggerBecamePending = this.materializeActivityAnalysisJob(
				threshold,
				receivedAt,
			);
			const nextState = this.stateRow();
			if (!retainOutboxForSourceAcknowledgement) this.deleteOutbox(id);
			return {
				accepted: true,
				response: structuredClone(normalized),
				status: {
					accumulatedScore: nextState.accumulated_score,
					scoreThreshold: threshold,
					agentTriggerPending: nextState.trigger_pending === 1,
					acceptedAnalysisCount: count + 1,
				},
				triggerBecamePending,
			};
		});
		return transaction.immediate();
	}

	getAppliedAnalysis(
		windowId: string,
		requestId: string,
	): ActivityEventWorkerResponse | null {
		const id = boundedString(windowId, "windowId", MAXIMUM_WINDOW_ID_LENGTH);
		const request = boundedString(
			requestId,
			"requestId",
			MAXIMUM_REQUEST_ID_LENGTH,
		);
		const receipt = this.receiptByWindowId(id);
		if (!receipt) return null;
		if (receipt.request_id !== request) {
			throw new Error("Activity window request id collision.");
		}
		return parseStoredResponse(receipt.response_json, request);
	}

	acknowledgeAppliedWindow(windowId: string, requestId: string): void {
		const id = boundedString(windowId, "windowId", MAXIMUM_WINDOW_ID_LENGTH);
		const request = boundedString(
			requestId,
			"requestId",
			MAXIMUM_REQUEST_ID_LENGTH,
		);
		const transaction = this.database.transaction(() => {
			const receipt = this.receiptByWindowId(id);
			if (!receipt || receipt.request_id !== request) {
				throw new Error(
					"Activity window receipt is missing during acknowledgement.",
				);
			}
			const outbox = this.outboxByWindowId(id);
			if (!outbox) return;
			if (outbox.request_id !== request) {
				throw new Error("Activity window acknowledgement identity mismatch.");
			}
			this.deleteOutbox(id);
		});
		transaction.immediate();
	}

	acknowledgeConsumedWindow(windowId: string, requestId: string): void {
		const id = boundedString(windowId, "windowId", MAXIMUM_WINDOW_ID_LENGTH);
		const request = boundedString(
			requestId,
			"requestId",
			MAXIMUM_REQUEST_ID_LENGTH,
		);
		const outbox = this.outboxByWindowId(id);
		if (!outbox) return;
		if (outbox.request_id !== request) {
			throw new Error("Consumed activity window identity mismatch.");
		}
		if (this.receiptByWindowId(id) !== null) {
			throw new Error("Consumed activity window still has a Worker receipt.");
		}
		this.deleteOutbox(id);
	}

	getStatus(scoreThreshold: number): ActivityScoreStatus & {
		pendingWindowCount: number;
		terminalWindowCount: number;
	} {
		const threshold = validScoreThreshold(scoreThreshold);
		const state = this.stateRow();
		const count = this.receiptCount();
		const outbox = this.database
			.query(
				`SELECT
					SUM(CASE WHEN terminal = 0 AND owner_account_id IS NOT NULL THEN 1 ELSE 0 END) AS pending_count,
					SUM(CASE WHEN terminal = 1 THEN 1 ELSE 0 END) AS terminal_count
				 FROM activity_window_worker_outbox`,
			)
			.get() as { pending_count: number | null; terminal_count: number | null };
		return {
			...statusFromRow(state, threshold, count),
			pendingWindowCount: outbox.pending_count ?? 0,
			terminalWindowCount: outbox.terminal_count ?? 0,
		};
	}

	/**
	 * Recovers an interrupted background run and materializes a pending job for
	 * ledgers created before the job table existed. The job payload is built from
	 * Worker receipts only, never from `activity_window_worker_outbox.window_json`.
	 */
	recoverActivityAnalysisJobs(
		scoreThreshold: number,
		nowMs = Date.now(),
	): boolean {
		this.assertLegacyPolicyCutoverComplete();
		const threshold = validScoreThreshold(scoreThreshold);
		const now = nonNegativeSafeInteger(nowMs, "nowMs");
		const transaction = this.database.transaction(() => {
			// A running row retains its exact run/request identity. The dispatcher
			// first reconciles it against the encrypted completed run and only then
			// decides whether any provider call is necessary.
			return this.materializeActivityAnalysisJob(threshold, now);
		});
		return transaction.immediate();
	}

	nextActivityAnalysisJob(
		scoreThreshold: number,
		accountId: string,
		nowMs = Date.now(),
	): ActivityAnalysisJobNext {
		validScoreThreshold(scoreThreshold);
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		this.assertLegacyPolicyCutoverComplete();
		if (this.stateRow().owner_account_id !== account) {
			return { kind: "account_mismatch" };
		}
		const now = nonNegativeSafeInteger(nowMs, "nowMs");
		if (this.hasPendingSourceAcknowledgement(account)) {
			return { kind: "none" };
		}
		const row = this.activeActivityAnalysisJob();
		if (row === null) return { kind: "none" };
		if (row.account_id !== null && row.account_id !== account) {
			return { kind: "account_mismatch" };
		}
		if (row.status === "retry_wait" && row.next_attempt_at_ms > now) {
			return { kind: "not_due", nextAttemptAtMs: row.next_attempt_at_ms };
		}
		if (row.status === "running") {
			return { kind: "running", job: activityAnalysisJobFromRow(row) };
		}
		return { kind: "ready", job: activityAnalysisJobFromRow(row) };
	}

	/**
	 * Returns completed Agent run identities whose Worker phase-two consumption
	 * is still pending. Retention must preserve their encrypted completion proof
	 * until completeActivityAnalysisJob durably removes the running job.
	 */
	phaseTwoPendingRunIds(accountId: string): readonly string[] {
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		const cutover = this.legacyPolicyCutoverRow();
		this.assertLegacyPolicyCutoverAccount(account, cutover);
		if (cutover.state === "pending") return [];
		const ledgerOwner = this.stateRow().owner_account_id;
		if (ledgerOwner !== null && ledgerOwner !== account) {
			throw new Error("Activity window ledger belongs to another account.");
		}
		return (
			this.database
				.query(
					`SELECT run_id FROM activity_window_worker_agent_jobs
					 WHERE account_id = ? AND status = 'running' AND run_id IS NOT NULL
					 ORDER BY run_id`,
				)
				.all(account) as Array<{ run_id: string }>
		).map((row) => boundedString(row.run_id, "runId", MAXIMUM_RUN_ID_LENGTH));
	}

	claimActivityAnalysisJob(
		jobId: string,
		accountId: string,
		runId: string,
		claimedAtMs = Date.now(),
	): ActivityAnalysisJob {
		const id = boundedString(
			jobId,
			"jobId",
			MAXIMUM_ACTIVITY_ANALYSIS_JOB_ID_LENGTH,
		);
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		this.assertLegacyPolicyCutoverComplete(account);
		if (this.stateRow().owner_account_id !== account) {
			throw new Error("Activity analysis job belongs to another account.");
		}
		const run = boundedString(runId, "runId", MAXIMUM_RUN_ID_LENGTH);
		const claimedAt = nonNegativeSafeInteger(claimedAtMs, "claimedAtMs");
		const transaction = this.database.transaction(() => {
			const row = this.activityAnalysisJobById(id);
			if (
				row === null ||
				(row.status !== "pending" && row.status !== "retry_wait") ||
				(row.account_id !== null && row.account_id !== account) ||
				(row.status === "retry_wait" && row.next_attempt_at_ms > claimedAt)
			) {
				throw new Error("Activity analysis job cannot be claimed.");
			}
			this.database
				.query(
					`UPDATE activity_window_worker_agent_jobs
					 SET account_id = COALESCE(account_id, ?), run_id = ?, status = 'running',
					     originating_request_id = COALESCE(originating_request_id, ?),
					     updated_at_ms = ?, last_error = NULL
					 WHERE job_id = ?`,
				)
				.run(
					account,
					run,
					`activity-request-${id}-${row.attempt + 1}`,
					claimedAt,
					id,
				);
			const claimed = this.activityAnalysisJobById(id);
			if (claimed === null)
				throw new Error("Activity analysis job is missing.");
			return activityAnalysisJobFromRow(claimed);
		});
		return transaction.immediate();
	}

	completeActivityAnalysisJob(
		jobId: string,
		accountId: string,
		runId: string,
		scoreThreshold: number,
		completedAtMs = Date.now(),
	): void {
		const id = boundedString(
			jobId,
			"jobId",
			MAXIMUM_ACTIVITY_ANALYSIS_JOB_ID_LENGTH,
		);
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		if (this.stateRow().owner_account_id !== account) {
			throw new Error("Activity analysis job belongs to another account.");
		}
		const run = boundedString(runId, "runId", MAXIMUM_RUN_ID_LENGTH);
		const threshold = validScoreThreshold(scoreThreshold);
		const completedAt = nonNegativeSafeInteger(completedAtMs, "completedAtMs");
		const transaction = this.database.transaction(() => {
			const job = this.activityAnalysisJobById(id);
			if (
				job === null ||
				job.status !== "running" ||
				job.account_id !== account ||
				job.run_id !== run
			) {
				throw new Error("Activity analysis job cannot be completed.");
			}
			const state = this.stateRow();
			const remaining = state.accumulated_score - job.consumed_score;
			if (!Number.isFinite(remaining) || remaining < -SCORE_EPSILON) {
				throw new Error("Activity analysis job score ledger is corrupt.");
			}
			const normalizedRemaining = remaining <= SCORE_EPSILON ? 0 : remaining;
			const receiptRows = this.database
				.query(
					`SELECT request_id FROM activity_window_worker_agent_job_receipts
					 WHERE job_id = ?`,
				)
				.all(id) as Array<{ request_id: string }>;
			this.database
				.query(
					`UPDATE activity_window_worker_agent_jobs
					 SET status = 'completed', updated_at_ms = ?, last_error = NULL
					 WHERE job_id = ?`,
				)
				.run(completedAt, id);
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET accumulated_score = ?, trigger_pending = 0, updated_at_ms = ?
					 WHERE id = 1`,
				)
				.run(normalizedRemaining, completedAt);
			this.database
				.query(
					"DELETE FROM activity_window_worker_agent_job_receipts WHERE job_id = ?",
				)
				.run(id);
			const deleteReceipt = this.database.query(
				"DELETE FROM activity_window_worker_receipts WHERE request_id = ?",
			);
			for (const receipt of receiptRows) deleteReceipt.run(receipt.request_id);
			this.database
				.query("DELETE FROM activity_window_worker_agent_jobs WHERE job_id = ?")
				.run(id);
			this.materializeActivityAnalysisJob(threshold, completedAt);
		});
		transaction.immediate();
	}

	deferActivityAnalysisJob(
		jobId: string,
		accountId: string,
		runId: string,
		nextAttemptAtMs: number,
		errorCode: string,
		updatedAtMs = Date.now(),
		advanceSemanticAttempt = true,
	): void {
		const id = boundedString(
			jobId,
			"jobId",
			MAXIMUM_ACTIVITY_ANALYSIS_JOB_ID_LENGTH,
		);
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		if (this.stateRow().owner_account_id !== account) {
			throw new Error("Activity analysis job belongs to another account.");
		}
		const run = boundedString(runId, "runId", MAXIMUM_RUN_ID_LENGTH);
		const next = nonNegativeSafeInteger(nextAttemptAtMs, "nextAttemptAtMs");
		const updatedAt = nonNegativeSafeInteger(updatedAtMs, "updatedAtMs");
		const error = boundedString(errorCode, "errorCode", 80);
		if (typeof advanceSemanticAttempt !== "boolean") {
			throw new Error("Activity analysis retry mode is invalid.");
		}
		const result = this.database
			.query(
				`UPDATE activity_window_worker_agent_jobs
				 SET status = 'retry_wait', run_id = NULL,
				     attempt = attempt + CASE WHEN ? THEN 1 ELSE 0 END,
				     transport_attempt = CASE WHEN ? THEN 0 ELSE transport_attempt + 1 END,
				     originating_request_id = CASE WHEN ? THEN NULL ELSE originating_request_id END,
				     next_attempt_at_ms = ?, updated_at_ms = ?, last_error = ?
				 WHERE job_id = ? AND status = 'running' AND account_id = ? AND run_id = ?`,
			)
			.run(
				advanceSemanticAttempt ? 1 : 0,
				advanceSemanticAttempt ? 1 : 0,
				advanceSemanticAttempt ? 1 : 0,
				next,
				updatedAt,
				error,
				id,
				account,
				run,
			);
		if (result.changes !== 1)
			throw new Error("Activity analysis job cannot be deferred.");
	}

	markActivityAnalysisJobTerminalFailure(
		jobId: string,
		accountId: string,
		runId: string | null,
		errorCode: string,
		updatedAtMs = Date.now(),
	): void {
		const id = boundedString(
			jobId,
			"jobId",
			MAXIMUM_ACTIVITY_ANALYSIS_JOB_ID_LENGTH,
		);
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		const run =
			runId === null
				? null
				: boundedString(runId, "runId", MAXIMUM_RUN_ID_LENGTH);
		const error = boundedString(errorCode, "errorCode", 80);
		const updatedAt = nonNegativeSafeInteger(updatedAtMs, "updatedAtMs");
		const result = this.database
			.query(
				`UPDATE activity_window_worker_agent_jobs
				 SET status = 'retry_wait', terminal_failure = 1,
				     updated_at_ms = ?, last_error = ?
				 WHERE job_id = ? AND status = 'running' AND account_id = ? AND run_id IS ?`,
			)
			.run(updatedAt, error, id, account, run);
		if (result.changes !== 1) {
			throw new Error("Activity analysis job cannot be failed terminally.");
		}
	}

	clearPendingActivityAnalysisData(
		accountId: string,
		updatedAtMs = Date.now(),
	): { outboxCount: number; receiptCount: number; jobCount: number } {
		const account = boundedString(
			accountId,
			"accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		);
		const updatedAt = nonNegativeSafeInteger(updatedAtMs, "updatedAtMs");
		const cutover = this.legacyPolicyCutoverRow();
		this.assertLegacyPolicyCutoverAccount(account, cutover);
		if (cutover.state === "pending") {
			// Pre-policy rows have no trustworthy owner and can contain raw window
			// JSON. Disable/clear must erase every such copy while intentionally
			// leaving the cutover marker pending until Reflection handoffs also clear.
			return this.clearLegacyPolicyCutoverWorkerData(account, updatedAt);
		}
		const ledgerOwner = this.stateRow().owner_account_id;
		if (ledgerOwner !== null && ledgerOwner !== account) {
			throw new Error("Activity window ledger belongs to another account.");
		}
		if (ledgerOwner === null) {
			const foreign = this.database
				.query(
					`SELECT 1 AS present FROM activity_window_worker_outbox
					 WHERE owner_account_id IS NOT NULL AND owner_account_id != ?
					 UNION ALL
					 SELECT 1 AS present FROM activity_window_worker_agent_jobs
					 WHERE account_id IS NOT NULL AND account_id != ?
					 LIMIT 1`,
				)
				.get(account, account);
			if (foreign !== null) {
				throw new Error("Activity window ledger contains another account.");
			}
		}
		const clear = this.database.transaction(() => {
			const outboxCount = this.database
				.query(
					"DELETE FROM activity_window_worker_outbox WHERE owner_account_id = ?",
				)
				.run(account).changes;
			const activeJobs = this.database
				.query(
					`SELECT job_id FROM activity_window_worker_agent_jobs
					 WHERE account_id = ? AND status != 'completed'`,
				)
				.all(account) as Array<{ job_id: string }>;
			const deleteAssignments = this.database.query(
				"DELETE FROM activity_window_worker_agent_job_receipts WHERE job_id = ?",
			);
			for (const job of activeJobs) deleteAssignments.run(job.job_id);
			let jobCount = 0;
			const deleteJob = this.database.query(
				"DELETE FROM activity_window_worker_agent_jobs WHERE job_id = ?",
			);
			for (const job of activeJobs)
				jobCount += deleteJob.run(job.job_id).changes;
			const receiptCount = this.database
				.query("DELETE FROM activity_window_worker_receipts")
				.run().changes;
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET accumulated_score = 0, trigger_pending = 0, updated_at_ms = ?
					 WHERE id = 1`,
				)
				.run(updatedAt);
			return { outboxCount, receiptCount, jobCount };
		});
		return clear.immediate();
	}

	private materializeActivityAnalysisJob(
		scoreThreshold: number,
		nowMs: number,
	): boolean {
		if (this.hasTerminalActivityAnalysisFailure()) {
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET trigger_pending = 1, updated_at_ms = ? WHERE id = 1`,
				)
				.run(nowMs);
			return false;
		}
		const active = this.activeActivityAnalysisJob();
		if (active !== null) {
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET trigger_pending = 1, updated_at_ms = ? WHERE id = 1`,
				)
				.run(nowMs);
			return false;
		}
		const state = this.stateRow();
		// Scores are persisted as SQLite REAL values. Treat a sum within the same
		// epsilon used by phase-two subtraction as having reached the mathematical
		// threshold (for example ten durable 0.1 receipts).
		if (state.accumulated_score + SCORE_EPSILON < scoreThreshold) {
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET trigger_pending = 0, updated_at_ms = ? WHERE id = 1`,
				)
				.run(nowMs);
			return false;
		}
		const receipts = this.database
			.query(
				`SELECT r.request_id, r.response_json
				 FROM activity_window_worker_receipts AS r
				 LEFT JOIN activity_window_worker_agent_job_receipts AS assigned
				   ON assigned.request_id = r.request_id
				 WHERE assigned.request_id IS NULL
				 ORDER BY r.received_at_ms, r.request_id
				 LIMIT ?`,
			)
			.all(MAXIMUM_ACTIVITY_ANALYSIS_RESULTS) as Array<{
			request_id: string;
			response_json: string;
		}>;
		if (receipts.length === 0) {
			throw new Error(
				"Activity analysis score has no unprocessed Worker receipts.",
			);
		}
		const analyses: ActivityAnalysisWorkerResult[] = [];
		const selectedReceipts: Array<{ request_id: string }> = [];
		let serializedLength = 2;
		for (const receipt of receipts) {
			const analysis = workerResultFromResponse(
				parseStoredResponse(receipt.response_json, receipt.request_id),
			);
			const analysisLength = serializedActivityAnalysisLength([analysis]);
			if (analysisLength > MAXIMUM_ACTIVITY_ANALYSIS_RESULT_CHARACTERS) {
				throw new Error(
					"Activity Worker result exceeds the Agent payload limit.",
				);
			}
			const nextLength =
				serializedLength + analysisLength + (analyses.length === 0 ? 0 : 1);
			if (nextLength > MAXIMUM_ACTIVITY_ANALYSIS_PROMPT_CHARACTERS) break;
			analyses.push(analysis);
			selectedReceipts.push(receipt);
			serializedLength = nextLength;
		}
		if (analyses.length === 0) {
			throw new Error("Activity analysis payload has no prompt-safe receipts.");
		}
		const consumedScore = analyses.reduce(
			(total, analysis) => total + analysis.score,
			0,
		);
		if (!Number.isFinite(consumedScore) || consumedScore < 0) {
			throw new Error("Activity analysis job score is invalid.");
		}
		const jobId = `activity_analysis_${crypto.randomUUID()}`;
		const serialized = JSON.stringify(analyses);
		this.database
			.query(
				`INSERT INTO activity_window_worker_agent_jobs
				 (job_id, account_id, run_id, status, analyses_json, consumed_score,
				  attempt, transport_attempt, originating_request_id, terminal_failure,
				  next_attempt_at_ms, created_at_ms, updated_at_ms, last_error)
				 VALUES (?, ?, NULL, 'pending', ?, ?, 0, 0, ?, 0, ?, ?, ?, NULL)`,
			)
			.run(
				jobId,
				this.requireLedgerAccount(),
				serialized,
				consumedScore,
				`activity-request-${jobId}-1`,
				nowMs,
				nowMs,
				nowMs,
			);
		const assign = this.database.query(
			`INSERT INTO activity_window_worker_agent_job_receipts (job_id, request_id)
			 VALUES (?, ?)`,
		);
		for (const receipt of selectedReceipts)
			assign.run(jobId, receipt.request_id);
		this.database
			.query(
				`UPDATE activity_window_worker_state
				 SET trigger_pending = 1, updated_at_ms = ? WHERE id = 1`,
			)
			.run(nowMs);
		return true;
	}

	private activeActivityAnalysisJob(): ActivityAnalysisJobRow | null {
		return this.database
			.query(
				`SELECT job_id, account_id, run_id, status, analyses_json, consumed_score,
				        attempt, transport_attempt, originating_request_id, terminal_failure,
				        next_attempt_at_ms, created_at_ms, updated_at_ms, last_error
				 FROM activity_window_worker_agent_jobs
				 WHERE status IN ('pending', 'running', 'retry_wait') AND terminal_failure = 0
				 ORDER BY created_at_ms, job_id
				 LIMIT 1`,
			)
			.get() as ActivityAnalysisJobRow | null;
	}

	private hasTerminalActivityAnalysisFailure(): boolean {
		return (
			this.database
				.query(
					`SELECT 1 AS present FROM activity_window_worker_agent_jobs
					 WHERE terminal_failure = 1 LIMIT 1`,
				)
				.get() !== null
		);
	}

	private activityAnalysisJobById(
		jobId: string,
	): ActivityAnalysisJobRow | null {
		return this.database
			.query(
				`SELECT job_id, account_id, run_id, status, analyses_json, consumed_score,
				        attempt, transport_attempt, originating_request_id, terminal_failure,
				        next_attempt_at_ms, created_at_ms, updated_at_ms, last_error
				 FROM activity_window_worker_agent_jobs WHERE job_id = ?`,
			)
			.get(jobId) as ActivityAnalysisJobRow | null;
	}

	private stateRow(): ActivityWindowStateRow {
		const row = this.database
			.query(
				`SELECT accumulated_score, trigger_pending, baseline_initialized,
				        owner_account_id
				 FROM activity_window_worker_state WHERE id = 1`,
			)
			.get() as ActivityWindowStateRow | null;
		if (
			row === null ||
			!Number.isFinite(row.accumulated_score) ||
			row.accumulated_score < 0 ||
			(row.trigger_pending !== 0 && row.trigger_pending !== 1) ||
			(row.baseline_initialized !== 0 && row.baseline_initialized !== 1)
		) {
			throw new Error("Activity window score state is corrupt.");
		}
		return row;
	}

	private legacyPolicyCutoverRow(): ActivityWindowLegacyPolicyCutoverRow {
		const row = this.database
			.query(
				`SELECT state, account_id, updated_at_ms
				 FROM activity_window_worker_policy_cutover WHERE id = 1`,
			)
			.get() as ActivityWindowLegacyPolicyCutoverRow | null;
		if (
			row === null ||
			(row.state !== "pending" && row.state !== "complete") ||
			!Number.isSafeInteger(row.updated_at_ms) ||
			row.updated_at_ms < 0
		) {
			throw new Error("Activity legacy policy cutover state is corrupt.");
		}
		return row;
	}

	private assertLegacyPolicyCutoverAccount(
		accountId: string,
		marker: ActivityWindowLegacyPolicyCutoverRow,
	): void {
		if (marker.account_id !== null && marker.account_id !== accountId) {
			throw new Error(
				"Activity legacy policy cutover belongs to another account.",
			);
		}
		const stateOwner = this.stateRow().owner_account_id;
		if (stateOwner !== null && stateOwner !== accountId) {
			throw new Error("Activity window ledger belongs to another account.");
		}
		const foreignOwner = this.database
			.query(
				`SELECT 1 AS present FROM activity_window_worker_outbox
				 WHERE owner_account_id IS NOT NULL AND owner_account_id != ?
				 UNION ALL
				 SELECT 1 AS present FROM activity_window_worker_agent_jobs
				 WHERE account_id IS NOT NULL AND account_id != ?
				 LIMIT 1`,
			)
			.get(accountId, accountId);
		if (foreignOwner !== null) {
			throw new Error("Activity window ledger contains another account.");
		}
	}

	private assertLegacyPolicyCutoverComplete(accountId?: string): void {
		const marker = this.legacyPolicyCutoverRow();
		if (accountId !== undefined) {
			this.assertLegacyPolicyCutoverAccount(accountId, marker);
		}
		if (marker.state !== "complete") {
			throw new Error("Activity legacy policy cutover is pending.");
		}
	}

	private tableExists(table: string): boolean {
		return (
			this.database
				.query(
					`SELECT 1 AS present FROM sqlite_master
					 WHERE type = 'table' AND name = ?`,
				)
				.get(table) !== null
		);
	}

	private requireLedgerAccount(): string {
		const account = this.stateRow().owner_account_id;
		if (account === null) {
			throw new Error("Activity window ledger has no authenticated owner.");
		}
		return account;
	}

	private receiptByRequestId(
		requestId: string,
	): ActivityWindowReceiptRow | null {
		return this.database
			.query(
				`SELECT request_id, source_window_id, response_json
				 FROM activity_window_worker_receipts WHERE request_id = ?`,
			)
			.get(requestId) as ActivityWindowReceiptRow | null;
	}

	private receiptByWindowId(windowId: string): ActivityWindowReceiptRow | null {
		return this.database
			.query(
				`SELECT request_id, source_window_id, response_json
				 FROM activity_window_worker_receipts WHERE source_window_id = ?`,
			)
			.get(windowId) as ActivityWindowReceiptRow | null;
	}

	private outboxByWindowId(windowId: string): ActivityWindowOutboxRow | null {
		return this.database
			.query(
				`SELECT window_id, request_id, semantic_request_json, semantic_attempt,
				 window_json, owner_account_id,
				 owner_session_id, owner_generation, queued_at_ms, attempt,
				 next_attempt_at_ms, terminal, last_error
				 FROM activity_window_worker_outbox WHERE window_id = ?`,
			)
			.get(windowId) as ActivityWindowOutboxRow | null;
	}

	private materializeLegacySemanticRequest(
		window: EventWindowV1,
		requestId: string,
	): ActivityEventWorkerRequest {
		const request = activityWindowSemanticRequest(window, requestId);
		const serialized = serializeSemanticRequest(request, window, requestId);
		const result = this.database
			.query(
				`UPDATE activity_window_worker_outbox
				 SET semantic_request_json = ?
				 WHERE window_id = ? AND request_id = ?
				   AND semantic_request_json IS NULL AND terminal = 0`,
			)
			.run(serialized, window.windowId, requestId);
		if (result.changes !== 1) {
			throw new Error("Activity window semantic request changed concurrently.");
		}
		return request;
	}

	private ensureOutboxOwnerColumns(): void {
		const columns = this.database
			.query("PRAGMA table_info(activity_window_worker_outbox)")
			.all() as Array<{ name: string }>;
		const names = new Set(columns.map((column) => column.name));
		for (const [name, type] of [
			["owner_account_id", "TEXT"],
			["owner_session_id", "TEXT"],
			["owner_generation", "INTEGER"],
		] as const) {
			if (!names.has(name)) {
				this.database.exec(
					`ALTER TABLE activity_window_worker_outbox ADD COLUMN ${name} ${type}`,
				);
			}
		}
		// Legacy unowned raw windows deliberately remain durable but can never be
		// auto-claimed by a later login.
	}

	private ensureOutboxSemanticColumns(): void {
		const columns = this.database
			.query("PRAGMA table_info(activity_window_worker_outbox)")
			.all() as Array<{ name: string }>;
		const names = new Set(columns.map((column) => column.name));
		if (!names.has("semantic_request_json")) {
			this.database.exec(
				"ALTER TABLE activity_window_worker_outbox ADD COLUMN semantic_request_json TEXT",
			);
		}
		if (!names.has("semantic_attempt")) {
			this.database.exec(
				"ALTER TABLE activity_window_worker_outbox ADD COLUMN semantic_attempt INTEGER NOT NULL DEFAULT 0 CHECK (semantic_attempt >= 0)",
			);
		}
	}

	private ensureStateOwnerColumn(): void {
		const columns = this.database
			.query("PRAGMA table_info(activity_window_worker_state)")
			.all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "owner_account_id")) {
			this.database.exec(
				"ALTER TABLE activity_window_worker_state ADD COLUMN owner_account_id TEXT",
			);
		}
	}

	private ensureAgentJobRecoveryColumns(): void {
		const columns = this.database
			.query("PRAGMA table_info(activity_window_worker_agent_jobs)")
			.all() as Array<{ name: string }>;
		const names = new Set(columns.map((column) => column.name));
		if (!names.has("originating_request_id")) {
			this.database.exec(
				"ALTER TABLE activity_window_worker_agent_jobs ADD COLUMN originating_request_id TEXT",
			);
		}
		if (!names.has("transport_attempt")) {
			this.database.exec(
				"ALTER TABLE activity_window_worker_agent_jobs ADD COLUMN transport_attempt INTEGER NOT NULL DEFAULT 0 CHECK (transport_attempt >= 0)",
			);
		}
		if (!names.has("terminal_failure")) {
			this.database.exec(
				"ALTER TABLE activity_window_worker_agent_jobs ADD COLUMN terminal_failure INTEGER NOT NULL DEFAULT 0 CHECK (terminal_failure IN (0, 1))",
			);
		}
	}

	private isBaselineWindow(windowId: string): boolean {
		return (
			this.database
				.query(
					"SELECT 1 AS present FROM activity_window_worker_baseline WHERE window_id = ?",
				)
				.get(windowId) !== null
		);
	}

	private receiptCount(): number {
		const row = this.database
			.query("SELECT COUNT(*) AS count FROM activity_window_worker_receipts")
			.get() as { count: number };
		return row.count;
	}

	private hasPendingSourceAcknowledgement(accountId: string): boolean {
		return (
			this.database
				.query(
					`SELECT 1 AS present
					 FROM activity_window_worker_outbox AS o
					 JOIN activity_window_worker_receipts AS r
					   ON r.source_window_id = o.window_id
					  AND r.request_id = o.request_id
					 WHERE o.owner_account_id = ?
					 LIMIT 1`,
				)
				.get(accountId) !== null
		);
	}

	private deleteOutbox(windowId: string): void {
		const result = this.database
			.query("DELETE FROM activity_window_worker_outbox WHERE window_id = ?")
			.run(windowId);
		if (result.changes !== 1)
			throw new Error("Unknown activity window outbox record.");
	}
}

function validateSessionIdentity(
	identity: AuthSessionIdentity,
): AuthSessionIdentity {
	return {
		accountId: boundedString(
			identity.accountId,
			"owner.accountId",
			MAXIMUM_ACCOUNT_ID_LENGTH,
		),
		sessionId: boundedString(identity.sessionId, "owner.sessionId", 256),
		generation: nonNegativeSafeInteger(identity.generation, "owner.generation"),
	};
}

/**
 * Sends one request per sealed reflection window. New windows are first
 * committed to the local outbox, so transient cloud errors never block the
 * reflection cursor or turn an individual raw event into a cloud request.
 */
export class ActivityWindowDeliveryService {
	private readonly source: ActivityWindowSource;
	private readonly analyzer: ActivityEventAnalyzer;
	private readonly store: ActivityWindowDeliveryStore;
	private readonly scoreThreshold: number;
	private readonly retryDelaysMs: readonly number[];
	private readonly nowMs: () => number;
	private readonly onAcceptedAnalysis: (
		result: AcceptedActivityWindowAnalysis,
	) => void | Promise<void>;
	private readonly archiveAnalysisBeforeReceipt: (
		result: ArchiveActivityWindowAnalysis,
	) => void | Promise<void>;
	private readonly acknowledgeSourceAfterReceipt: (
		result: AcknowledgeActivityWindowSource,
	) => void | Promise<void>;
	private readonly recoverArchivedAnalysis: NonNullable<
		ActivityWindowDeliveryServiceOptions["recoverArchivedAnalysis"]
	>;
	private readonly onAgentTriggerRequired: (
		status: ActivityScoreStatus,
	) => void | Promise<void>;
	private readonly onError: (error: unknown) => void;
	private readonly currentSession: () => AuthSessionIdentity | null;
	private readonly isCurrentSession: (identity: AuthSessionIdentity) => boolean;

	private started = false;
	private state: ActivityWindowDeliveryState = "stopped";
	private lastError: ActivityWindowDeliveryStatus["lastError"] = null;
	private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
	private retryAtMs: number | null = null;
	private drainScheduled = false;
	private operationTail: Promise<void> = Promise.resolve();
	private activationPromise: Promise<void> | null = null;

	constructor(options: ActivityWindowDeliveryServiceOptions) {
		this.source = options.source;
		this.analyzer = options.analyzer;
		this.store = options.store;
		this.scoreThreshold = validScoreThreshold(
			options.scoreThreshold ?? DEFAULT_ACTIVITY_WINDOW_SCORE_THRESHOLD,
		);
		this.retryDelaysMs = validateRetryDelays(
			options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
		);
		this.nowMs = options.nowMs ?? Date.now;
		this.onAcceptedAnalysis = options.onAcceptedAnalysis ?? (() => {});
		this.archiveAnalysisBeforeReceipt =
			options.archiveAnalysisBeforeReceipt ?? (() => {});
		this.acknowledgeSourceAfterReceipt =
			options.acknowledgeSourceAfterReceipt ?? (() => {});
		this.recoverArchivedAnalysis =
			options.recoverArchivedAnalysis ?? (() => null);
		this.onAgentTriggerRequired = options.onAgentTriggerRequired ?? (() => {});
		this.onError = options.onError ?? (() => {});
		this.currentSession = options.currentSession ?? (() => null);
		this.isCurrentSession = options.isCurrentSession ?? (() => false);
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.state = "starting";
		const activation = (async () => {
			const requestedOwner = this.currentSession();
			if (requestedOwner === null) {
				throw new Error(
					"Activity window delivery requires an authenticated account.",
				);
			}
			const windows = await this.source.listWindowsForAccount(
				requestedOwner.accountId,
			);
			if (!this.started) return;
			if (!this.isCurrentSession(requestedOwner)) {
				throw new Error(
					"Activity window delivery session changed during activation.",
				);
			}
			this.store.initializeBaseline([], requestedOwner);
			// Reconcile only the windows attributed in Reflection's seal transaction.
			// This closes a crash gap between that database and this account outbox
			// without claiming windows from another account or from logged-out time.
			for (const window of windows) {
				await this.persistWindow(window, requestedOwner);
			}
			const recoveredJob = this.store.recoverActivityAnalysisJobs(
				this.scoreThreshold,
				this.nowMs(),
			);
			this.state = "ready";
			this.lastError = null;
			if (recoveredJob) {
				await this.invokeSafely(() =>
					this.onAgentTriggerRequired(
						this.store.getStatus(this.scoreThreshold),
					),
				);
			}
			this.kickDrain();
		})();
		this.activationPromise = activation;
		try {
			await activation;
		} catch (error) {
			this.started = false;
			this.state = "stopped";
			throw error;
		} finally {
			if (this.activationPromise === activation) {
				this.activationPromise = null;
			}
		}
	}

	async stop(): Promise<void> {
		this.started = false;
		this.state = "stopped";
		if (this.retryTimer !== null) {
			globalThis.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		this.retryAtMs = null;
		await this.activationPromise?.catch(() => {});
		await this.operationTail;
	}

	/** Persist a new sealed window before any network activity begins. */
	async enqueueWindow(window: EventWindowV1): Promise<void> {
		await this.activationPromise;
		await this.enqueue(async () => {
			if (!this.started) {
				throw new Error("Activity window delivery is not started.");
			}
			const owner = this.currentSession();
			if (owner === null) return;
			await this.persistWindow(window, owner);
		});
		this.kickDrain();
	}

	async whenIdle(): Promise<void> {
		await this.operationTail;
	}

	getStatus(): ActivityWindowDeliveryStatus {
		return {
			...this.store.getStatus(this.scoreThreshold),
			state: this.state,
			lastError: this.lastError,
		};
	}

	/** Re-evaluates durable Agent work after a local restart. */
	recoverActivityAnalysisJobs(): boolean {
		return this.store.recoverActivityAnalysisJobs(
			this.scoreThreshold,
			this.nowMs(),
		);
	}

	private async persistWindow(
		window: EventWindowV1,
		owner: AuthSessionIdentity,
	): Promise<void> {
		const requestId = await activityWindowRequestId(window, 0);
		this.store.enqueue(window, requestId, this.nowMs(), owner);
	}

	private kickDrain(): void {
		if (!this.started || this.drainScheduled) return;
		this.drainScheduled = true;
		void this.enqueue(async () => {
			try {
				await this.drain();
			} finally {
				this.drainScheduled = false;
			}
		}).catch((error) => this.handleUnexpectedFailure(error));
	}

	private async drain(): Promise<void> {
		while (this.started) {
			const owner = this.currentSession();
			if (owner === null) {
				this.state = "ready";
				return;
			}
			const next = this.store.nextWindow(this.nowMs(), owner);
			if (next.kind === "none") {
				this.state = "ready";
				return;
			}
			if (next.kind === "not_due") {
				this.state = "retry_wait";
				this.armRetry(next.nextAttemptAtMs);
				return;
			}
			const shouldContinue = await this.deliver(next.queued);
			if (!shouldContinue) return;
		}
	}

	private async deliver(queued: QueuedActivityWindow): Promise<boolean> {
		try {
			if (!this.isCurrentSession(queued.owner)) return false;
			const recoveredResponse = this.store.getAppliedAnalysis(
				queued.window.windowId,
				queued.requestId,
			);
			if (recoveredResponse !== null) {
				await this.acknowledgeSourceAfterReceipt({
					owner: structuredClone(queued.owner),
					sourceWindowId: queued.window.windowId,
					requestId: queued.requestId,
				});
				if (!this.isCurrentSession(queued.owner)) return false;
				this.store.acknowledgeAppliedWindow(
					queued.window.windowId,
					queued.requestId,
				);
				this.lastError = null;
				const status = this.store.getStatus(this.scoreThreshold);
				if (status.agentTriggerPending) {
					await this.invokeSafely(() => this.onAgentTriggerRequired(status));
				}
				return true;
			}
			const recoveredArchive = await this.recoverArchivedAnalysis({
				owner: structuredClone(queued.owner),
				sourceWindow: structuredClone(queued.window),
				requestId: queued.requestId,
			});
			if (recoveredArchive?.kind === "invalid") {
				throw new ActivityWindowArchiveIdentityError();
			}
			if (recoveredArchive?.kind === "consumed") {
				await this.acknowledgeSourceAfterReceipt({
					owner: structuredClone(queued.owner),
					sourceWindowId: queued.window.windowId,
					requestId: queued.requestId,
				});
				if (!this.isCurrentSession(queued.owner)) return false;
				this.store.acknowledgeConsumedWindow(
					queued.window.windowId,
					queued.requestId,
				);
				this.lastError = null;
				return true;
			}
			const recoveredAnalysis =
				recoveredArchive?.kind === "pending" ? recoveredArchive.analysis : null;
			// Recovery may await encrypted storage. Re-check the exact lifecycle
			// owner before the first-stage analyzer can issue a remote model call.
			if (!this.isCurrentSession(queued.owner)) return false;
			if (
				recoveredAnalysis !== null &&
				(!isActivityAnalysisWorkerResult(recoveredAnalysis) ||
					recoveredAnalysis.request_id !== queued.requestId)
			) {
				throw new ActivityWindowArchiveIdentityError();
			}
			let response: ActivityEventWorkerResponse;
			if (recoveredAnalysis !== null) {
				try {
					response = workerResponseFromResult(recoveredAnalysis);
				} catch {
					throw new ActivityWindowArchiveIdentityError();
				}
			} else {
				try {
					response = validateActivityEventWorkerResponse(
						await this.analyzer.analyze(structuredClone(queued.request)),
						queued.requestId,
					);
				} catch (error) {
					if (isRawSemanticOutputFailure(error)) {
						throw new ActivityWindowSemanticOutputError(error);
					}
					throw error;
				}
			}
			if (!this.isCurrentSession(queued.owner)) return false;
			let normalizedResponse: ReturnType<typeof normalizeResponseReferences>;
			try {
				normalizedResponse = normalizeResponseReferences(
					response,
					queued.window,
				);
			} catch (error) {
				if (recoveredAnalysis !== null) {
					throw new ActivityWindowArchiveIdentityError();
				}
				if (isRawSemanticOutputFailure(error)) {
					throw new ActivityWindowSemanticOutputError(error);
				}
				throw error;
			}
			if (
				recoveredAnalysis !== null &&
				normalizedResponse.replacedSourceIds > 0
			) {
				throw new ActivityWindowArchiveIdentityError();
			}
			if (normalizedResponse.replacedSourceIds > 0) {
				this.report(
					new ActivityWindowDeliveryAttemptError(
						new ActivityWindowResponseValidationError("source_ids"),
						queued.window.triggerReason,
						queued.window.eventCount,
					),
				);
			}
			const archivedAtMs = this.nowMs();
			if (recoveredAnalysis === null) {
				await this.archiveAnalysisBeforeReceipt({
					owner: structuredClone(queued.owner),
					sourceWindow: structuredClone(queued.window),
					requestId: queued.requestId,
					analysis: workerResultFromResponse(normalizedResponse.response),
					archivedAtMs,
				});
			}
			if (!this.isCurrentSession(queued.owner)) return false;
			const applied = this.store.apply(
				queued.window.windowId,
				normalizedResponse.response,
				this.scoreThreshold,
				archivedAtMs,
				true,
			);
			await this.acknowledgeSourceAfterReceipt({
				owner: structuredClone(queued.owner),
				sourceWindowId: queued.window.windowId,
				requestId: queued.requestId,
			});
			if (!this.isCurrentSession(queued.owner)) return false;
			this.store.acknowledgeAppliedWindow(
				queued.window.windowId,
				queued.requestId,
			);
			this.lastError = null;
			if (!applied.accepted) return true;
			await this.invokeSafely(() =>
				this.onAcceptedAnalysis({
					sourceWindowId: queued.window.windowId,
					response: applied.response,
					status: applied.status,
				}),
			);
			if (applied.triggerBecamePending) {
				await this.invokeSafely(() =>
					this.onAgentTriggerRequired(applied.status),
				);
			}
			return true;
		} catch (error) {
			const wrapped = new ActivityWindowDeliveryAttemptError(
				error,
				queued.window.triggerReason,
				queued.window.eventCount,
			);
			const diagnostic = activityWindowWorkerDiagnostic(wrapped);
			const code = diagnostic.code;
			const storedError = diagnostic.validationStage
				? `${code}:${diagnostic.validationStage}`
				: code;
			this.lastError = code;
			if (error instanceof ActivityWindowSemanticOutputError) {
				const delayIndex = Math.min(
					queued.attempt,
					this.retryDelaysMs.length - 1,
				);
				const delayMs = this.retryDelaysMs[delayIndex] ?? 300_000;
				const nextAttemptAtMs = this.nowMs() + delayMs;
				const nextSemanticAttempt = queued.semanticAttempt + 1;
				const terminal =
					nextSemanticAttempt >= MAXIMUM_ACTIVITY_WINDOW_SEMANTIC_ATTEMPTS;
				const nextRequestId = terminal
					? null
					: await activityWindowRequestId(queued.window, nextSemanticAttempt);
				const outcome = this.store.advanceSemanticAttempt(
					queued.window.windowId,
					queued.requestId,
					nextAttemptAtMs,
					storedError,
					nextRequestId === null
						? null
						: {
								requestId: nextRequestId,
								request: activityWindowSemanticRequest(
									queued.window,
									nextRequestId,
								),
							},
				);
				this.report(wrapped);
				if (outcome.terminal) return true;
				this.state = "retry_wait";
				this.armRetry(nextAttemptAtMs);
				return false;
			}
			if (isPermanentlyUndeliverable(error)) {
				this.store.markTerminal(queued.window.windowId, storedError);
				this.report(wrapped);
				return true;
			}
			const delayIndex = Math.min(
				queued.attempt,
				this.retryDelaysMs.length - 1,
			);
			const delayMs = this.retryDelaysMs[delayIndex] ?? 300_000;
			const nextAttemptAtMs = this.nowMs() + delayMs;
			this.store.defer(queued.window.windowId, nextAttemptAtMs, storedError);
			this.state = "retry_wait";
			this.report(wrapped);
			this.armRetry(nextAttemptAtMs);
			return false;
		}
	}

	private armRetry(nextAttemptAtMs: number): void {
		if (!this.started) return;
		if (
			this.retryTimer !== null &&
			this.retryAtMs !== null &&
			this.retryAtMs <= nextAttemptAtMs
		) {
			return;
		}
		if (this.retryTimer !== null) globalThis.clearTimeout(this.retryTimer);
		const delayMs = Math.max(0, nextAttemptAtMs - this.nowMs());
		this.retryAtMs = nextAttemptAtMs;
		this.retryTimer = globalThis.setTimeout(() => {
			this.retryTimer = null;
			this.retryAtMs = null;
			this.kickDrain();
		}, delayMs);
	}

	private async invokeSafely(
		callback: () => void | Promise<void>,
	): Promise<void> {
		try {
			await callback();
		} catch (error) {
			this.report(error);
		}
	}

	private handleUnexpectedFailure(error: unknown): void {
		if (!this.started) return;
		this.state = "retry_wait";
		this.lastError = "unknown";
		this.report(error);
		this.armRetry(this.nowMs() + (this.retryDelaysMs[0] ?? 1_000));
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private report(error: unknown): void {
		try {
			this.onError(error);
		} catch {
			// Reporting must not stop delivery of later sealed windows.
		}
	}
}

class ActivityWindowDeliveryAttemptError extends Error {
	constructor(
		readonly underlying: unknown,
		readonly triggerReason: EventWindowV1["triggerReason"],
		readonly eventCount: number,
	) {
		super("Activity window delivery attempt failed.");
		this.name = "ActivityWindowDeliveryAttemptError";
	}
}

class ActivityWindowResponseValidationError extends Error {
	constructor(readonly stage: "source_ids" | "timestamps") {
		super("Activity window response is outside the submitted window scope.");
		this.name = "ActivityWindowResponseValidationError";
	}
}

class ActivityWindowArchiveIdentityError extends Error {
	constructor() {
		super("Activity window archive does not match its semantic request.");
		this.name = "ActivityWindowArchiveIdentityError";
	}
}

class ActivityWindowSemanticOutputError extends Error {
	constructor(readonly underlying: unknown) {
		super("Activity window model output failed deterministic validation.");
		this.name = "ActivityWindowSemanticOutputError";
	}
}

export function activityWindowWorkerDiagnostic(error: unknown): {
	code: ActivityWindowDeliveryStatus["lastError"] extends infer T
		? Exclude<T, null>
		: never;
	retryable: boolean;
	httpStatus: number | null;
	requestBytes: number | null;
	responseServer: string | null;
	triggerReason: EventWindowV1["triggerReason"] | null;
	eventCount: number | null;
	validationStage: "source_ids" | "timestamps" | null;
} {
	const triggerReason =
		error instanceof ActivityWindowDeliveryAttemptError
			? error.triggerReason
			: null;
	const eventCount =
		error instanceof ActivityWindowDeliveryAttemptError
			? error.eventCount
			: null;
	const attemptUnderlying =
		error instanceof ActivityWindowDeliveryAttemptError
			? error.underlying
			: error;
	const underlying =
		attemptUnderlying instanceof ActivityWindowSemanticOutputError
			? attemptUnderlying.underlying
			: attemptUnderlying;
	if (underlying instanceof ActivityWindowArchiveIdentityError) {
		return {
			code: "invalid_response",
			retryable: false,
			httpStatus: null,
			requestBytes: null,
			responseServer: null,
			triggerReason,
			eventCount,
			validationStage: null,
		};
	}
	if (underlying instanceof ActivityWindowResponseValidationError) {
		return {
			code: "invalid_response",
			retryable: true,
			httpStatus: null,
			requestBytes: null,
			responseServer: null,
			triggerReason,
			eventCount,
			validationStage: underlying.stage,
		};
	}
	if (underlying instanceof ActivityEventWorkerClientError) {
		return {
			code: underlying.code,
			retryable: underlying.retryable,
			httpStatus: underlying.httpStatus,
			requestBytes: underlying.requestBytes,
			responseServer: underlying.responseServer,
			triggerReason,
			eventCount,
			validationStage: null,
		};
	}
	return {
		code: "unknown",
		retryable: true,
		httpStatus: null,
		requestBytes: null,
		responseServer: null,
		triggerReason,
		eventCount,
		validationStage: null,
	};
}

function activityWindowRequestId(
	window: EventWindowV1,
	semanticAttempt = 0,
): string {
	const attempt = activityWindowSemanticAttempt(semanticAttempt);
	const semanticIdentity =
		attempt === 0
			? `${ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION}:${window.windowId}`
			: `${ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION}:${window.windowId}:${attempt}`;
	const hex = createHash("sha256")
		.update(semanticIdentity, "utf8")
		.digest("hex");
	return `activity_window_${hex}`;
}

function isActivityWindowSemanticRequestId(
	window: EventWindowV1,
	requestId: string,
): boolean {
	for (
		let attempt = 0;
		attempt < MAXIMUM_ACTIVITY_WINDOW_SEMANTIC_ATTEMPTS;
		attempt += 1
	) {
		if (activityWindowRequestId(window, attempt) === requestId) return true;
	}
	return false;
}

function activityWindowSemanticRequest(
	window: EventWindowV1,
	requestId: string,
): ActivityEventWorkerRequest {
	return {
		schema_version: ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION,
		request_id: requestId,
		raw_event: structuredClone(window),
		context: responseContextFor(window, requestId),
	};
}

function responseContextFor(
	window: EventWindowV1,
	requestId: string,
	timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): Record<string, unknown> {
	return {
		goal: window.goal === null ? null : structuredClone(window.goal),
		response_contract: {
			response_schema_version: ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION,
			request_id: requestId,
			analysis_unit: "sealed_reflection_window",
			source_window_id: window.windowId,
			// A compact 1.7B model can reliably copy one stable, window-scoped
			// anchor. The complete cursor/eventId mapping remains in raw_event for
			// evidence, but is not made a brittle response-copying requirement.
			source_event_ids: [window.windowId],
			source_event_cursor_ids: window.events.map((event) => event.cursor),
			window_trigger_reason: window.triggerReason,
			window_started_at_ms: window.startedAtMs,
			window_ended_at_ms: window.endedAtMs,
			// The client owns human-readable review time. It is included in the
			// local prompt/context, never delegated to the remote relay.
			time_zone: timeZone,
		},
	};
}

function normalizeResponseReferences(
	response: ActivityEventWorkerResponse,
	window: EventWindowV1,
): { response: ActivityEventWorkerResponse; replacedSourceIds: number } {
	const allowed = new Set<string>([
		window.windowId,
		...window.events.map((event) => event.eventId),
		...window.events.map((event) => event.cursor),
	]);
	let replacedSourceIds = 0;
	const events = response.events.map((event) => {
		const inScopeSourceIds = event.source_event_ids.filter((sourceId) =>
			allowed.has(sourceId),
		);
		if (inScopeSourceIds.length !== event.source_event_ids.length) {
			replacedSourceIds +=
				event.source_event_ids.length - inScopeSourceIds.length;
		}
		if (
			(event.started_at_ms !== null &&
				(event.started_at_ms < window.startedAtMs ||
					event.started_at_ms > window.endedAtMs)) ||
			(event.ended_at_ms !== null &&
				(event.ended_at_ms < window.startedAtMs ||
					event.ended_at_ms > window.endedAtMs)) ||
			(event.started_at_ms !== null &&
				event.ended_at_ms !== null &&
				event.started_at_ms > event.ended_at_ms)
		) {
			throw new ActivityWindowResponseValidationError("timestamps");
		}
		return {
			...event,
			// Qwen has seen only this immutable raw window. If it fabricates a
			// sub-event identifier, keep the useful classification but bind it to
			// the one durable source we can prove: this exact window. This avoids a
			// brittle copy-the-cursor requirement for a compact CPU model while
			// still preventing any cross-window reference from escaping locally.
			source_event_ids:
				inScopeSourceIds.length > 0 ? inScopeSourceIds : [window.windowId],
		};
	});
	return { response: { ...response, events }, replacedSourceIds };
}

function validateWindow(value: EventWindowV1): EventWindowV1 {
	if (
		value.schemaVersion !== "event-window.v1" ||
		!isBoundedString(value.windowId, MAXIMUM_WINDOW_ID_LENGTH) ||
		!Array.isArray(value.events) ||
		value.events.length < 1 ||
		!Number.isSafeInteger(value.eventCount) ||
		value.eventCount < 1 ||
		!Number.isSafeInteger(value.startedAtMs) ||
		value.startedAtMs < 0 ||
		!Number.isSafeInteger(value.endedAtMs) ||
		value.endedAtMs < value.startedAtMs
	) {
		throw new Error("Activity window is invalid.");
	}
	return structuredClone(value);
}

function uniqueWindows(windows: readonly EventWindowV1[]): EventWindowV1[] {
	const byId = new Map<string, EventWindowV1>();
	for (const window of windows) {
		const normalized = validateWindow(window);
		const previous = byId.get(normalized.windowId);
		if (
			previous !== undefined &&
			JSON.stringify(previous) !== JSON.stringify(normalized)
		) {
			throw new Error(
				"Activity window source returned conflicting window ids.",
			);
		}
		byId.set(normalized.windowId, normalized);
	}
	return [...byId.values()];
}

function serializeWindow(window: EventWindowV1): string {
	try {
		return JSON.stringify(window);
	} catch {
		throw new Error("Activity window cannot be serialized.");
	}
}

function activityWindowSemanticAttempt(value: number): number {
	if (
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value >= MAXIMUM_ACTIVITY_WINDOW_SEMANTIC_ATTEMPTS
	) {
		throw new Error("Activity window semantic attempt is corrupt.");
	}
	return value;
}

function validateSemanticRequest(
	value: unknown,
	window: EventWindowV1,
	requestId: string,
): ActivityEventWorkerRequest {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schema_version",
			"request_id",
			"raw_event",
			"context",
		]) ||
		value.schema_version !== ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION ||
		value.request_id !== requestId ||
		!isRecord(value.raw_event) ||
		!isRecord(value.context)
	) {
		throw new Error("Activity window semantic request is invalid.");
	}
	const rawWindow = validateWindow(value.raw_event as EventWindowV1);
	if (serializeWindow(rawWindow) !== serializeWindow(window)) {
		throw new Error("Activity window semantic request raw event mismatch.");
	}
	const responseContract = value.context.response_contract;
	if (
		!isRecord(responseContract) ||
		!isBoundedString(responseContract.time_zone, 256)
	) {
		throw new Error("Activity window semantic request context is invalid.");
	}
	const expectedContext = responseContextFor(
		window,
		requestId,
		responseContract.time_zone,
	);
	if (JSON.stringify(value.context) !== JSON.stringify(expectedContext)) {
		throw new Error("Activity window semantic request context mismatch.");
	}
	return {
		schema_version: ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION,
		request_id: requestId,
		raw_event: structuredClone(rawWindow),
		context: structuredClone(value.context),
	};
}

function serializeSemanticRequest(
	request: ActivityEventWorkerRequest,
	window: EventWindowV1,
	requestId: string,
): string {
	return JSON.stringify(validateSemanticRequest(request, window, requestId));
}

function parseStoredSemanticRequest(
	value: string,
	window: EventWindowV1,
	requestId: string,
): ActivityEventWorkerRequest {
	try {
		return validateSemanticRequest(JSON.parse(value), window, requestId);
	} catch {
		throw new Error("Activity window semantic request is corrupt.");
	}
}

function parseStoredWindow(value: string, windowId: string): EventWindowV1 {
	try {
		const parsed = JSON.parse(value) as EventWindowV1;
		const window = validateWindow(parsed);
		if (window.windowId !== windowId) throw new Error("Window id mismatch.");
		return window;
	} catch {
		throw new Error("Activity window outbox is corrupt.");
	}
}

function validateResponse(
	value: unknown,
	requestId: string,
): ActivityEventWorkerResponse {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schema_version",
			"request_id",
			"events",
			"score",
			"score_reason",
		]) ||
		value.schema_version !== ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION ||
		value.request_id !== requestId
	) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	const result = {
		request_id: value.request_id,
		events: value.events,
		score: value.score,
		score_reason: value.score_reason,
	};
	if (
		!isActivityAnalysisWorkerResult(result) ||
		serializedActivityAnalysisLength([result]) >
			MAXIMUM_ACTIVITY_ANALYSIS_RESULT_CHARACTERS
	) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	return {
		schema_version: ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION,
		...structuredClone(result),
	};
}

function parseStoredResponse(
	value: string,
	requestId: string,
): ActivityEventWorkerResponse {
	try {
		return validateResponse(JSON.parse(value), requestId);
	} catch {
		throw new Error("Activity window worker receipt is corrupt.");
	}
}

function workerResultFromResponse(
	response: ActivityEventWorkerResponse,
): ActivityAnalysisWorkerResult {
	return {
		request_id: response.request_id,
		events: structuredClone(response.events),
		score: response.score,
		score_reason: response.score_reason,
	};
}

function workerResponseFromResult(
	result: ActivityAnalysisWorkerResult,
): ActivityEventWorkerResponse {
	return validateResponse(
		{
			schema_version: ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION,
			request_id: result.request_id,
			events: structuredClone(result.events),
			score: result.score,
			score_reason: result.score_reason,
		},
		result.request_id,
	);
}

function activityAnalysisJobFromRow(
	row: ActivityAnalysisJobRow,
): ActivityAnalysisJob {
	if (
		(row.status !== "pending" &&
			row.status !== "running" &&
			row.status !== "retry_wait" &&
			row.status !== "completed") ||
		!Number.isFinite(row.consumed_score) ||
		row.consumed_score < 0 ||
		!Number.isSafeInteger(row.attempt) ||
		row.attempt < 0 ||
		!Number.isSafeInteger(row.transport_attempt) ||
		row.transport_attempt < 0 ||
		!Number.isSafeInteger(row.next_attempt_at_ms) ||
		row.next_attempt_at_ms < 0 ||
		!Number.isSafeInteger(row.created_at_ms) ||
		row.created_at_ms < 0 ||
		!Number.isSafeInteger(row.updated_at_ms) ||
		row.updated_at_ms < 0 ||
		(row.account_id !== null &&
			!isBoundedString(row.account_id, MAXIMUM_ACCOUNT_ID_LENGTH)) ||
		(row.run_id !== null &&
			!isBoundedString(row.run_id, MAXIMUM_RUN_ID_LENGTH)) ||
		(row.originating_request_id !== null &&
			!isBoundedString(
				row.originating_request_id,
				MAXIMUM_REQUEST_ID_LENGTH,
			)) ||
		(row.terminal_failure !== 0 && row.terminal_failure !== 1) ||
		(row.last_error !== null && !isBoundedString(row.last_error, 80))
	) {
		throw new Error("Activity analysis job is corrupt.");
	}
	let analyses: ActivityAnalysisWorkerResult[];
	try {
		const parsed = JSON.parse(row.analyses_json);
		if (
			!Array.isArray(parsed) ||
			parsed.length === 0 ||
			parsed.length > MAXIMUM_ACTIVITY_ANALYSIS_RESULTS
		) {
			throw new Error("invalid analysis payload");
		}
		analyses = parsed.map((analysis) => {
			if (!isActivityAnalysisWorkerResult(analysis)) {
				throw new Error("invalid analysis payload");
			}
			return structuredClone(analysis);
		});
		if (
			serializedActivityAnalysisLength(analyses) >
			MAXIMUM_ACTIVITY_ANALYSIS_PROMPT_CHARACTERS
		) {
			throw new Error("invalid analysis payload");
		}
	} catch {
		throw new Error("Activity analysis job payload is corrupt.");
	}
	return {
		jobId: boundedString(
			row.job_id,
			"jobId",
			MAXIMUM_ACTIVITY_ANALYSIS_JOB_ID_LENGTH,
		),
		accountId: row.account_id,
		runId: row.run_id,
		state: row.status,
		analyses,
		consumedScore: row.consumed_score,
		attempt: row.attempt,
		transportAttempt: row.transport_attempt,
		originatingRequestId:
			row.originating_request_id ??
			`activity-request-${row.job_id}-${row.attempt + 1}`,
		terminalFailure: row.terminal_failure === 1,
		nextAttemptAtMs: row.next_attempt_at_ms,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
		lastError: row.last_error,
	};
}

function statusFromRow(
	row: ActivityWindowStateRow,
	scoreThreshold: number,
	acceptedAnalysisCount: number,
): ActivityScoreStatus {
	return {
		accumulatedScore: row.accumulated_score,
		scoreThreshold,
		agentTriggerPending: row.trigger_pending === 1,
		acceptedAnalysisCount,
	};
}

function isPermanentlyUndeliverable(error: unknown): boolean {
	return (
		error instanceof ActivityWindowArchiveIdentityError ||
		(error instanceof ActivityEventWorkerClientError && !error.retryable)
	);
}

function isRawSemanticOutputFailure(error: unknown): boolean {
	return (
		error instanceof ActivityWindowResponseValidationError ||
		(error instanceof ActivityEventWorkerClientError &&
			error.code === "invalid_response")
	);
}

function validScoreThreshold(value: number): number {
	if (!Number.isFinite(value) || value <= 0 || value > 10_000) {
		throw new Error(
			"Activity window scoreThreshold must be between 0 and 10000.",
		);
	}
	return value;
}

function validateRetryDelays(delays: readonly number[]): readonly number[] {
	if (
		delays.length === 0 ||
		delays.some((delay) => !Number.isSafeInteger(delay) || delay <= 0)
	) {
		throw new Error(
			"Activity window retry delays must be positive safe integers.",
		);
	}
	return [...delays];
}

function boundedString(value: unknown, name: string, maximum: number): string {
	if (!isBoundedString(value, maximum)) {
		throw new Error(`${name} must contain 1 to ${maximum} characters.`);
	}
	return value;
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maximum
	);
}

function nonNegativeSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative safe integer.`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function hardenPath(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Some test/virtual filesystems have no POSIX mode support.
	}
}
