import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
	ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION,
	ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION,
	ActivityEventWorkerClientError,
	type ActivityAgentTriggerClaim,
	type ActivityEventAnalyzer,
	type ActivityEventWorkerEvent,
	type ActivityEventWorkerResponse,
	type ActivityScoreStatus,
} from "./activity-event-worker";
import type { EventWindowV1 } from "./reflection/types";

export const DEFAULT_ACTIVITY_WINDOW_SCORE_THRESHOLD = 1;

const MAXIMUM_REQUEST_ID_LENGTH = 128;
const MAXIMUM_WINDOW_ID_LENGTH = 200;
const DEFAULT_RETRY_DELAYS_MS = [
	1_000,
	5_000,
	15_000,
	60_000,
	300_000,
] as const;

type ActivityWindowStateRow = {
	accumulated_score: number;
	trigger_pending: number;
	baseline_initialized: number;
};

type ActivityWindowReceiptRow = {
	request_id: string;
	source_window_id: string;
	response_json: string;
};

type ActivityWindowOutboxRow = {
	window_id: string;
	request_id: string;
	window_json: string;
	queued_at_ms: number;
	attempt: number;
	next_attempt_at_ms: number;
	terminal: number;
	last_error: string | null;
};

type QueuedActivityWindow = {
	window: EventWindowV1;
	requestId: string;
	attempt: number;
	nextAttemptAtMs: number;
};

export interface ActivityWindowSource {
	/** Returns the immutable windows already sealed by the reflection collector. */
	listWindows(): Promise<readonly EventWindowV1[]>;
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
	onAgentTriggerRequired?: (status: ActivityScoreStatus) => void | Promise<void>;
	onError?: (error: unknown) => void;
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
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS activity_window_worker_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
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
				window_json TEXT NOT NULL,
				queued_at_ms INTEGER NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt >= 0),
				next_attempt_at_ms INTEGER NOT NULL,
				terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
				last_error TEXT
			);
			CREATE INDEX IF NOT EXISTS activity_window_worker_outbox_order
				ON activity_window_worker_outbox (terminal, queued_at_ms, window_id);
		`);
		this.database
			.query(
				`INSERT OR IGNORE INTO activity_window_worker_state
				 (id, accumulated_score, trigger_pending, baseline_initialized, updated_at_ms)
				 VALUES (1, 0, 0, 0, ?)`,
			)
			.run(Date.now());
		hardenPath(databasePath, 0o600);
		hardenPath(`${databasePath}-wal`, 0o600);
		hardenPath(`${databasePath}-shm`, 0o600);
	}

	close(): void {
		this.database.close();
	}

	/**
	 * The first activation establishes a local cutover before Reflection starts.
	 * Earlier sealed windows remain on-device and are never backfilled to cloud.
	 */
	initializeBaseline(windows: readonly EventWindowV1[]): boolean {
		const normalized = uniqueWindows(windows);
		const transaction = this.database.transaction(() => {
			const state = this.stateRow();
			if (state.baseline_initialized === 1) return false;
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
					 SET baseline_initialized = 1, updated_at_ms = ? WHERE id = 1`,
				)
				.run(Date.now());
			return true;
		});
		return transaction.immediate();
	}

	enqueue(window: EventWindowV1, requestId: string, queuedAtMs: number): boolean {
		const normalized = validateWindow(window);
		const id = boundedString(requestId, "requestId", MAXIMUM_REQUEST_ID_LENGTH);
		const queuedAt = nonNegativeSafeInteger(queuedAtMs, "queuedAtMs");
		const serialized = serializeWindow(normalized);
		const transaction = this.database.transaction(() => {
			const state = this.stateRow();
			if (state.baseline_initialized !== 1) {
				throw new Error("Activity window delivery baseline is not initialized.");
			}
			if (this.isBaselineWindow(normalized.windowId)) return false;
			const receipt = this.receiptByWindowId(normalized.windowId);
			if (receipt !== null) {
				if (receipt.request_id !== id) {
					throw new Error("Activity window request id collision.");
				}
				return false;
			}
			const existing = this.outboxByWindowId(normalized.windowId);
			if (existing !== null) {
				if (existing.request_id !== id || existing.window_json !== serialized) {
					throw new Error("Activity window outbox collision.");
				}
				return false;
			}
			this.database
				.query(
					`INSERT INTO activity_window_worker_outbox
					 (window_id, request_id, window_json, queued_at_ms, attempt,
					  next_attempt_at_ms, terminal, last_error)
					 VALUES (?, ?, ?, ?, 0, ?, 0, NULL)`,
				)
				.run(
					normalized.windowId,
					id,
					serialized,
					queuedAt,
					queuedAt,
				);
			return true;
		});
		return transaction.immediate();
	}

	nextWindow(nowMs: number):
		| { kind: "none" }
		| { kind: "not_due"; nextAttemptAtMs: number }
		| { kind: "ready"; queued: QueuedActivityWindow } {
		const now = nonNegativeSafeInteger(nowMs, "nowMs");
		const row = this.database
			.query(
				`SELECT window_id, request_id, window_json, queued_at_ms, attempt,
				 next_attempt_at_ms, terminal, last_error
				 FROM activity_window_worker_outbox
				 WHERE terminal = 0
				 ORDER BY queued_at_ms, window_id
				 LIMIT 1`,
			)
			.get() as ActivityWindowOutboxRow | null;
		if (row === null) return { kind: "none" };
		if (row.next_attempt_at_ms > now) {
			return { kind: "not_due", nextAttemptAtMs: row.next_attempt_at_ms };
		}
		return {
			kind: "ready",
			queued: {
				window: parseStoredWindow(row.window_json, row.window_id),
				requestId: row.request_id,
				attempt: row.attempt,
				nextAttemptAtMs: row.next_attempt_at_ms,
			},
		};
	}

	defer(
		windowId: string,
		nextAttemptAtMs: number,
		errorCode: string,
	): void {
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
		if (result.changes !== 1) throw new Error("Unknown activity window outbox record.");
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
		if (result.changes !== 1) throw new Error("Unknown activity window outbox record.");
	}

	apply(
		windowId: string,
		response: ActivityEventWorkerResponse,
		scoreThreshold: number,
		receivedAtMs: number,
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
		const transaction = this.database.transaction(() => {
			const outbox = this.outboxByWindowId(id);
			if (outbox === null || outbox.request_id !== normalized.request_id) {
				throw new Error("Activity window receipt has no matching outbox record.");
			}
			const existing = this.receiptByRequestId(normalized.request_id);
			const state = this.stateRow();
			const count = this.receiptCount();
			if (existing !== null) {
				if (existing.source_window_id !== id) {
					throw new Error("Activity window request id collision.");
				}
				this.deleteOutbox(id);
				return {
					accepted: false,
					response: parseStoredResponse(existing.response_json, normalized.request_id),
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
			const triggerBecamePending =
				state.trigger_pending === 0 && accumulatedScore >= threshold;
			const triggerPending =
				state.trigger_pending === 1 || accumulatedScore >= threshold;
			this.database
				.query(
					`INSERT INTO activity_window_worker_receipts
					 (request_id, source_window_id, response_json, received_at_ms)
					 VALUES (?, ?, ?, ?)`,
				)
				.run(
					normalized.request_id,
					id,
					JSON.stringify(normalized),
					receivedAt,
				);
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET accumulated_score = ?, trigger_pending = ?, updated_at_ms = ?
					 WHERE id = 1`,
				)
				.run(accumulatedScore, triggerPending ? 1 : 0, receivedAt);
			this.deleteOutbox(id);
			return {
				accepted: true,
				response: structuredClone(normalized),
				status: {
					accumulatedScore,
					scoreThreshold: threshold,
					agentTriggerPending: triggerPending,
					acceptedAnalysisCount: count + 1,
				},
				triggerBecamePending,
			};
		});
		return transaction.immediate();
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
					SUM(CASE WHEN terminal = 0 THEN 1 ELSE 0 END) AS pending_count,
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

	claimAgentTrigger(
		scoreThreshold: number,
		claimedAtMs = Date.now(),
	): ActivityAgentTriggerClaim {
		const threshold = validScoreThreshold(scoreThreshold);
		const claimedAt = nonNegativeSafeInteger(claimedAtMs, "claimedAtMs");
		const transaction = this.database.transaction((): ActivityAgentTriggerClaim => {
			const state = this.stateRow();
			const count = this.receiptCount();
			if (state.trigger_pending === 0) {
				return { claimed: false, status: statusFromRow(state, threshold, count) };
			}
			const accumulatedScore = Math.max(0, state.accumulated_score - threshold);
			const triggerPending = accumulatedScore >= threshold;
			this.database
				.query(
					`UPDATE activity_window_worker_state
					 SET accumulated_score = ?, trigger_pending = ?, updated_at_ms = ?
					 WHERE id = 1`,
				)
				.run(accumulatedScore, triggerPending ? 1 : 0, claimedAt);
			return {
				claimed: true,
				status: {
					accumulatedScore,
					scoreThreshold: threshold,
					agentTriggerPending: triggerPending,
					acceptedAnalysisCount: count,
				},
			};
		});
		return transaction.immediate();
	}

	private stateRow(): ActivityWindowStateRow {
		const row = this.database
			.query(
				`SELECT accumulated_score, trigger_pending, baseline_initialized
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

	private receiptByRequestId(requestId: string): ActivityWindowReceiptRow | null {
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
				`SELECT window_id, request_id, window_json, queued_at_ms, attempt,
				 next_attempt_at_ms, terminal, last_error
				 FROM activity_window_worker_outbox WHERE window_id = ?`,
			)
			.get(windowId) as ActivityWindowOutboxRow | null;
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

	private deleteOutbox(windowId: string): void {
		const result = this.database
			.query("DELETE FROM activity_window_worker_outbox WHERE window_id = ?")
			.run(windowId);
		if (result.changes !== 1) throw new Error("Unknown activity window outbox record.");
	}
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
	private readonly onAgentTriggerRequired: (
		status: ActivityScoreStatus,
	) => void | Promise<void>;
	private readonly onError: (error: unknown) => void;

	private started = false;
	private state: ActivityWindowDeliveryState = "stopped";
	private lastError: ActivityWindowDeliveryStatus["lastError"] = null;
	private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
	private drainScheduled = false;
	private operationTail: Promise<void> = Promise.resolve();

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
		this.onAgentTriggerRequired = options.onAgentTriggerRequired ?? (() => {});
		this.onError = options.onError ?? (() => {});
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.state = "starting";
		try {
			const windows = await this.source.listWindows();
			const isFirstActivation = this.store.initializeBaseline(windows);
			if (!isFirstActivation) {
				for (const window of windows) await this.persistWindow(window);
			}
			this.state = "ready";
			this.lastError = null;
			this.kickDrain();
		} catch (error) {
			this.started = false;
			this.state = "stopped";
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.started = false;
		this.state = "stopped";
		if (this.retryTimer !== null) {
			globalThis.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		await this.operationTail;
	}

	/** Persist a new sealed window before any network activity begins. */
	async enqueueWindow(window: EventWindowV1): Promise<void> {
		await this.enqueue(async () => {
			if (!this.started) {
				throw new Error("Activity window delivery is not started.");
			}
			await this.persistWindow(window);
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

	claimAgentTrigger(): ActivityAgentTriggerClaim {
		return this.store.claimAgentTrigger(this.scoreThreshold, this.nowMs());
	}

	private async persistWindow(window: EventWindowV1): Promise<void> {
		const requestId = await activityWindowRequestId(window);
		this.store.enqueue(window, requestId, this.nowMs());
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
			const next = this.store.nextWindow(this.nowMs());
			if (next.kind === "none") {
				this.state = "ready";
				return;
			}
			if (next.kind === "not_due") {
				this.state = "retry_wait";
				this.armRetry(next.nextAttemptAtMs);
				return;
			}
			await this.deliver(next.queued);
		}
	}

	private async deliver(queued: QueuedActivityWindow): Promise<void> {
		try {
			const response = await this.analyzer.analyze({
				schema_version: ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION,
				request_id: queued.requestId,
				raw_event: structuredClone(queued.window),
				context: responseContextFor(queued.window, queued.requestId),
			});
			const scopedResponse = normalizeResponseReferences(response, queued.window);
			const applied = this.store.apply(
				queued.window.windowId,
				scopedResponse,
				this.scoreThreshold,
				this.nowMs(),
			);
			this.lastError = null;
			if (!applied.accepted) return;
			await this.invokeSafely(() =>
				this.onAcceptedAnalysis({
					sourceWindowId: queued.window.windowId,
					response: applied.response,
					status: applied.status,
				}),
			);
			if (applied.triggerBecamePending) {
				await this.invokeSafely(() => this.onAgentTriggerRequired(applied.status));
			}
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
			if (isPermanentlyUndeliverable(error)) {
				this.store.markTerminal(queued.window.windowId, storedError);
				this.report(wrapped);
				return;
			}
			const delayIndex = Math.min(queued.attempt, this.retryDelaysMs.length - 1);
			const delayMs = this.retryDelaysMs[delayIndex] ?? 300_000;
			const nextAttemptAtMs = this.nowMs() + delayMs;
			this.store.defer(queued.window.windowId, nextAttemptAtMs, storedError);
			this.state = "retry_wait";
			this.report(wrapped);
			this.armRetry(nextAttemptAtMs);
		}
	}

	private armRetry(nextAttemptAtMs: number): void {
		if (!this.started || this.retryTimer !== null) return;
		const delayMs = Math.max(0, nextAttemptAtMs - this.nowMs());
		this.retryTimer = globalThis.setTimeout(() => {
			this.retryTimer = null;
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
		error instanceof ActivityWindowDeliveryAttemptError ? error.triggerReason : null;
	const eventCount =
		error instanceof ActivityWindowDeliveryAttemptError ? error.eventCount : null;
	const underlying =
		error instanceof ActivityWindowDeliveryAttemptError ? error.underlying : error;
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

async function activityWindowRequestId(window: EventWindowV1): Promise<string> {
	const encoded = new TextEncoder().encode(
		`${ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION}:${window.windowId}`,
	);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
	const hex = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(
		"",
	);
	return `activity_window_${hex}`;
}

function responseContextFor(
	window: EventWindowV1,
	requestId: string,
): Record<string, unknown> {
	return {
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
		},
	};
}

function normalizeResponseReferences(
	response: ActivityEventWorkerResponse,
	window: EventWindowV1,
): ActivityEventWorkerResponse {
	const allowed = new Set<string>([
		window.windowId,
		...window.events.map((event) => event.eventId),
		...window.events.map((event) => event.cursor),
	]);
	const events = response.events.map((event) => {
		const inScopeSourceIds = event.source_event_ids.filter((sourceId) =>
			allowed.has(sourceId),
		);
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
	return { ...response, events };
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
		if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(normalized)) {
			throw new Error("Activity window source returned conflicting window ids.");
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
		value.request_id !== requestId ||
		!Array.isArray(value.events) ||
		value.events.length > 64 ||
		!isScore(value.score) ||
		!isResponseReason(value.score_reason)
	) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	const events = value.events.map((event) => validateResponseEvent(event));
	if (events.length === 0 && value.score !== 0) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	return {
		schema_version: ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION,
		request_id: requestId,
		events,
		score: value.score,
		score_reason: value.score_reason,
	};
}

function validateResponseEvent(value: unknown): ActivityEventWorkerEvent {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"source_event_ids",
			"activity",
			"goal_relevance",
			"confidence",
			"reason_codes",
			"evidence",
			"started_at_ms",
			"ended_at_ms",
		]) ||
		!Array.isArray(value.source_event_ids) ||
		value.source_event_ids.length < 1 ||
		value.source_event_ids.length > 32 ||
		!value.source_event_ids.every((sourceId) => isBoundedString(sourceId, 160)) ||
		!isBoundedString(value.activity, 80) ||
		!isBoundedString(value.goal_relevance, 80) ||
		!isScore(value.confidence) ||
		!Array.isArray(value.reason_codes) ||
		value.reason_codes.length < 1 ||
		value.reason_codes.length > 4 ||
		!value.reason_codes.every((code) => isBoundedString(code, 80)) ||
		!Array.isArray(value.evidence) ||
		value.evidence.length > 8 ||
		!value.evidence.every((evidence) => typeof evidence === "string" && evidence.length <= 240) ||
		!isNullableTimestamp(value.started_at_ms) ||
		!isNullableTimestamp(value.ended_at_ms)
	) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	return {
		source_event_ids: [...value.source_event_ids],
		activity: value.activity,
		goal_relevance: value.goal_relevance,
		confidence: value.confidence,
		reason_codes: [...value.reason_codes],
		evidence: [...value.evidence],
		started_at_ms: value.started_at_ms,
		ended_at_ms: value.ended_at_ms,
	};
}

function parseStoredResponse(value: string, requestId: string): ActivityEventWorkerResponse {
	try {
		return validateResponse(JSON.parse(value), requestId);
	} catch {
		throw new Error("Activity window worker receipt is corrupt.");
	}
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
	return error instanceof ActivityEventWorkerClientError && !error.retryable;
}

function validScoreThreshold(value: number): number {
	if (!Number.isFinite(value) || value <= 0 || value > 10_000) {
		throw new Error("Activity window scoreThreshold must be between 0 and 10000.");
	}
	return value;
}

function validateRetryDelays(delays: readonly number[]): readonly number[] {
	if (
		delays.length === 0 ||
		delays.some((delay) => !Number.isSafeInteger(delay) || delay <= 0)
	) {
		throw new Error("Activity window retry delays must be positive safe integers.");
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
	return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isResponseReason(value: unknown): value is string {
	return typeof value === "string" && value.length <= 400;
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function isScore(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNullableTimestamp(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
	);
}

function hardenPath(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Some test/virtual filesystems have no POSIX mode support.
	}
}
