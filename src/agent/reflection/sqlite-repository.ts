import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
	CollectorRevisionConflictError,
	InvalidReflectionJobTransitionError,
	type ReflectionRepository,
	type SealWindowResult,
} from "./repository";
import {
	REFLECTION_JOB_SCHEMA_VERSION,
	type EventWindowV1,
	type ReflectionCollectorSnapshotV1,
	type ReflectionJobFailureV1,
	type ReflectionJobState,
	type ReflectionJobV1,
	type ReflectionQueueStats,
	type ReflectionV1,
} from "./types";

const SQLITE_SCHEMA_VERSION = 2;

type CollectorRow = {
	revision: number;
	snapshot_json: string;
};

type WindowRow = {
	input_hash: string;
	window_json: string;
};

type JobRow = {
	window_id: string;
	state: ReflectionJobState;
	attempt: number;
	replay_count: number;
	created_at_ms: number;
	first_attempt_at_ms: number | null;
	updated_at_ms: number;
	next_attempt_at_ms: number | null;
	lease_expires_at_ms: number | null;
	last_failure_json: string | null;
	reflection_json: string | null;
	terminal_cursor_released_at_ms: number | null;
};

export type ReflectionJournalEntry = {
	windowId: string;
	persistedAtMs: number;
	reflection: ReflectionV1;
};

export type ReflectionReminderClaim = {
	windowId: string;
	notificationKey: string;
	notifiedAtMs: number;
};

/**
 * Durable production repository for the collector and reflection worker.
 *
 * One SQLite transaction atomically persists the immutable window, its READY
 * job, and the advanced collector snapshot. Reflection results are journaled
 * under the deterministic window id before they can be committed downstream.
 */
export class SqliteReflectionRepository implements ReflectionRepository {
	private readonly database: Database;

	constructor(databasePath: string) {
		const directory = dirname(databasePath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		hardenPath(directory, 0o700);
		this.database = new Database(databasePath, { create: true, strict: true });
		this.configure();
		this.migrate();
		hardenPath(databasePath, 0o600);
		hardenPath(`${databasePath}-wal`, 0o600);
		hardenPath(`${databasePath}-shm`, 0o600);
	}

	close(): void {
		this.database.close();
	}

	async loadCollector(
		collectorId: string,
	): Promise<ReflectionCollectorSnapshotV1 | null> {
		const row = this.database
			.query("SELECT revision, snapshot_json FROM reflection_collectors WHERE collector_id = ?")
			.get(collectorId) as CollectorRow | null;
		return row ? parseJson<ReflectionCollectorSnapshotV1>(row.snapshot_json) : null;
	}

	async saveCollector(
		snapshot: ReflectionCollectorSnapshotV1,
		expectedRevision: number | null,
	): Promise<ReflectionCollectorSnapshotV1> {
		const transaction = this.database.transaction(() => {
			const current = this.collectorRow(snapshot.collectorId);
			assertExpectedRevision(current?.revision ?? null, expectedRevision);
			assertNextRevision(snapshot.revision, expectedRevision);

			if (current) {
				const result = this.database
					.query(
						`UPDATE reflection_collectors
						 SET revision = ?, snapshot_json = ?, updated_at_ms = ?
						 WHERE collector_id = ? AND revision = ?`,
					)
					.run(
						snapshot.revision,
						JSON.stringify(snapshot),
						snapshot.updatedAtMs,
						snapshot.collectorId,
						expectedRevision,
					);
				if (result.changes !== 1) throw new CollectorRevisionConflictError();
			} else {
				this.database
					.query(
						`INSERT INTO reflection_collectors
						 (collector_id, revision, snapshot_json, updated_at_ms)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(
						snapshot.collectorId,
						snapshot.revision,
						JSON.stringify(snapshot),
						snapshot.updatedAtMs,
					);
			}
		});
		transaction.immediate();
		return structuredClone(snapshot);
	}

	async sealWindow(
		window: EventWindowV1,
		nextSnapshot: ReflectionCollectorSnapshotV1,
		expectedRevision: number,
	): Promise<SealWindowResult> {
		const transaction = this.database.transaction((): SealWindowResult => {
			const existingWindow = this.windowRow(window.windowId);
			const existingJob = this.jobRow(window.windowId);
			if (existingWindow || existingJob) {
				if (!existingWindow || !existingJob) {
					throw new Error(`Corrupt reflection seal for ${window.windowId}.`);
				}
				if (existingWindow.input_hash !== window.inputHash) {
					throw new Error(
						`Deterministic window id collision for ${window.windowId}.`,
					);
				}
				const snapshot = this.requireCollector(nextSnapshot.collectorId);
				return {
					inserted: false,
					window: parseJson<EventWindowV1>(existingWindow.window_json),
					snapshot: parseJson<ReflectionCollectorSnapshotV1>(snapshot.snapshot_json),
					job: jobFromRow(existingJob),
				};
			}

			const current = this.requireCollector(nextSnapshot.collectorId);
			if (current.revision !== expectedRevision) {
				throw new CollectorRevisionConflictError();
			}
			assertNextRevision(nextSnapshot.revision, expectedRevision);

			const createdAtMs = window.endedAtMs;
			const job: ReflectionJobV1 = {
				schemaVersion: REFLECTION_JOB_SCHEMA_VERSION,
				windowId: window.windowId,
				state: "READY",
				attempt: 0,
				replayCount: 0,
				createdAtMs,
				firstAttemptAtMs: null,
				updatedAtMs: createdAtMs,
				nextAttemptAtMs: createdAtMs,
				leaseExpiresAtMs: null,
				lastFailure: null,
				reflection: null,
				terminalCursorReleasedAtMs: null,
			};

			this.database
				.query(
					`INSERT INTO reflection_windows
					 (window_id, collector_id, input_hash, event_count, created_at_ms, window_json)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					window.windowId,
					window.collectorId,
					window.inputHash,
					window.eventCount,
					createdAtMs,
					JSON.stringify(window),
				);
			this.insertJob(job);
			const result = this.database
				.query(
					`UPDATE reflection_collectors
					 SET revision = ?, snapshot_json = ?, updated_at_ms = ?
					 WHERE collector_id = ? AND revision = ?`,
				)
				.run(
					nextSnapshot.revision,
					JSON.stringify(nextSnapshot),
					nextSnapshot.updatedAtMs,
					nextSnapshot.collectorId,
					expectedRevision,
				);
			if (result.changes !== 1) throw new CollectorRevisionConflictError();
			return {
				inserted: true,
				window: structuredClone(window),
				snapshot: structuredClone(nextSnapshot),
				job: structuredClone(job),
			};
		});
		return transaction.immediate();
	}

	async getWindow(windowId: string): Promise<EventWindowV1 | null> {
		const row = this.windowRow(windowId);
		return row ? parseJson<EventWindowV1>(row.window_json) : null;
	}

	/**
	 * Immutable sealed-window index for local downstream outboxes. The caller
	 * receives full copies; it cannot mutate Reflection's persisted record.
	 */
	async listWindows(): Promise<EventWindowV1[]> {
		const rows = this.database
			.query(
				`SELECT window_json FROM reflection_windows
				 ORDER BY created_at_ms, window_id`,
			)
			.all() as Array<{ window_json: string }>;
		return rows.map((row) => parseJson<EventWindowV1>(row.window_json));
	}

	async getJob(windowId: string): Promise<ReflectionJobV1 | null> {
		const row = this.jobRow(windowId);
		return row ? jobFromRow(row) : null;
	}

	async getQueueStats(): Promise<ReflectionQueueStats> {
		const row = this.database
			.query(
				`SELECT COUNT(*) AS pending_jobs, COALESCE(SUM(w.event_count), 0) AS pending_events
				 FROM reflection_jobs AS j
				 JOIN reflection_windows AS w ON w.window_id = j.window_id
				 WHERE j.state NOT IN ('COMMITTED', 'TERMINAL_FAILED')`,
			)
			.get() as { pending_jobs: number; pending_events: number };
		return {
			pendingJobs: row.pending_jobs,
			pendingEvents: row.pending_events,
		};
	}

	async claimNextRunnable(
		nowMs: number,
		leaseDurationMs: number,
	): Promise<ReflectionJobV1 | null> {
		if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
			throw new Error("leaseDurationMs must be positive.");
		}
		const transaction = this.database.transaction(() => {
			const candidate = this.database
				.query(
					`SELECT *
					 FROM reflection_jobs
					 WHERE
					   (state = 'READY' AND COALESCE(next_attempt_at_ms, created_at_ms) <= ?)
					   OR (state = 'RETRY_WAIT' AND next_attempt_at_ms <= ?)
					   OR (
					     state IN ('RUNNING', 'COMMITTING')
					     AND lease_expires_at_ms IS NOT NULL
					     AND lease_expires_at_ms <= ?
					   )
					   OR state = 'RESULT_PERSISTED'
					 ORDER BY COALESCE(next_attempt_at_ms, created_at_ms), created_at_ms, window_id
					 LIMIT 1`,
				)
				.get(nowMs, nowMs, nowMs) as JobRow | null;
			if (!candidate) return null;

			const nextState: ReflectionJobState = candidate.reflection_json
				? "COMMITTING"
				: "RUNNING";
			const next: ReflectionJobV1 = {
				...jobFromRow(candidate),
				state: nextState,
				attempt: candidate.attempt + 1,
				firstAttemptAtMs: candidate.first_attempt_at_ms ?? nowMs,
				updatedAtMs: nowMs,
				nextAttemptAtMs: null,
				leaseExpiresAtMs: nowMs + leaseDurationMs,
			};
			this.updateJob(next);
			return next;
		});
		const claimed = transaction.immediate();
		return claimed ? structuredClone(claimed) : null;
	}

	async persistResult(
		windowId: string,
		reflection: ReflectionV1,
		nowMs: number,
	): Promise<ReflectionJobV1> {
		const transaction = this.database.transaction(() => {
			const current = this.requireJob(windowId);
			if (current.reflection) {
				if (!sameJson(current.reflection, reflection)) {
					throw new Error(`A different reflection is already persisted for ${windowId}.`);
				}
				return current;
			}
			if (current.state !== "RUNNING") {
				throw new InvalidReflectionJobTransitionError(
					current.state,
					"persist result for",
				);
			}
			if (reflection.windowId !== windowId) {
				throw new Error("Reflection result does not match its window.");
			}
			const next: ReflectionJobV1 = {
				...current,
				state: "RESULT_PERSISTED",
				reflection: structuredClone(reflection),
				updatedAtMs: nowMs,
				leaseExpiresAtMs: null,
			};
			this.database
				.query(
					`INSERT INTO reflection_journal
					 (window_id, persisted_at_ms, reflection_json)
					 VALUES (?, ?, ?)
					 ON CONFLICT(window_id) DO NOTHING`,
				)
				.run(windowId, nowMs, JSON.stringify(reflection));
			const journal = this.database
				.query("SELECT reflection_json FROM reflection_journal WHERE window_id = ?")
				.get(windowId) as { reflection_json: string };
			if (!sameJson(parseJson<ReflectionV1>(journal.reflection_json), reflection)) {
				throw new Error(`Reflection journal collision for ${windowId}.`);
			}
			this.updateJob(next);
			return next;
		});
		return structuredClone(transaction.immediate());
	}

	async beginCommit(
		windowId: string,
		nowMs: number,
		leaseDurationMs: number,
	): Promise<ReflectionJobV1> {
		if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
			throw new Error("leaseDurationMs must be positive.");
		}
		const transaction = this.database.transaction(() => {
			const current = this.requireJob(windowId);
			if (current.state === "COMMITTING" && current.leaseExpiresAtMs !== null) {
				return current;
			}
			if (current.state !== "RESULT_PERSISTED") {
				throw new InvalidReflectionJobTransitionError(
					current.state,
					"begin commit for",
				);
			}
			const next: ReflectionJobV1 = {
				...current,
				state: "COMMITTING",
				updatedAtMs: nowMs,
				leaseExpiresAtMs: nowMs + leaseDurationMs,
			};
			this.updateJob(next);
			return next;
		});
		return structuredClone(transaction.immediate());
	}

	async recordFailure(
		windowId: string,
		failure: ReflectionJobFailureV1,
		nextAttemptAtMs: number | null,
		terminal: boolean,
	): Promise<ReflectionJobV1> {
		const transaction = this.database.transaction(() => {
			const current = this.requireJob(windowId);
			if (current.state !== "RUNNING" && current.state !== "COMMITTING") {
				throw new InvalidReflectionJobTransitionError(
					current.state,
					"record failure for",
				);
			}
			const next: ReflectionJobV1 = {
				...current,
				state: terminal ? "TERMINAL_FAILED" : "RETRY_WAIT",
				updatedAtMs: failure.failedAtMs,
				nextAttemptAtMs: terminal ? null : nextAttemptAtMs,
				leaseExpiresAtMs: null,
				lastFailure: structuredClone(failure),
				terminalCursorReleasedAtMs: terminal ? failure.failedAtMs : null,
			};
			this.updateJob(next);
			return next;
		});
		return structuredClone(transaction.immediate());
	}

	async markCommitted(windowId: string, nowMs: number): Promise<ReflectionJobV1> {
		const transaction = this.database.transaction(() => {
			const current = this.requireJob(windowId);
			if (current.state === "COMMITTED") return current;
			if (current.state !== "COMMITTING") {
				throw new InvalidReflectionJobTransitionError(current.state, "commit");
			}
			const next: ReflectionJobV1 = {
				...current,
				state: "COMMITTED",
				updatedAtMs: nowMs,
				leaseExpiresAtMs: null,
				nextAttemptAtMs: null,
			};
			this.updateJob(next);
			return next;
		});
		return structuredClone(transaction.immediate());
	}

	async replayTerminal(windowId: string, nowMs: number): Promise<ReflectionJobV1> {
		const transaction = this.database.transaction(() => {
			const current = this.requireJob(windowId);
			if (current.state !== "TERMINAL_FAILED") {
				throw new InvalidReflectionJobTransitionError(current.state, "replay");
			}
			const next: ReflectionJobV1 = {
				...current,
				state: "READY",
				attempt: 0,
				replayCount: current.replayCount + 1,
				createdAtMs: nowMs,
				firstAttemptAtMs: null,
				updatedAtMs: nowMs,
				nextAttemptAtMs: nowMs,
				leaseExpiresAtMs: null,
				lastFailure: null,
				terminalCursorReleasedAtMs: null,
			};
			this.updateJob(next);
			return next;
		});
		return structuredClone(transaction.immediate());
	}

	async listReflections(limit = 100): Promise<ReflectionJournalEntry[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error("Reflection journal limit must be between 1 and 1000.");
		}
		const rows = this.database
			.query(
				`SELECT window_id, persisted_at_ms, reflection_json
				 FROM reflection_journal
				 ORDER BY persisted_at_ms DESC, window_id DESC
				 LIMIT ?`,
			)
			.all(limit) as Array<{
			window_id: string;
			persisted_at_ms: number;
			reflection_json: string;
		}>;
		return rows.map((row) => ({
			windowId: row.window_id,
			persistedAtMs: row.persisted_at_ms,
			reflection: parseJson<ReflectionV1>(row.reflection_json),
		}));
	}

	/**
	 * Atomically claims one active reminder after its ReflectionV1 has already
	 * been journaled. The durable receipt favors a missed reminder over a
	 * duplicate if the process crashes between this claim and presentation.
	 */
	async claimReminder(
		reflection: ReflectionV1,
		nowMs: number,
		deduplicationMs: number,
	): Promise<ReflectionReminderClaim | null> {
		if (reflection.feedbackCode === "silent") return null;
		if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
			throw new Error("Reminder timestamp must be a non-negative safe integer.");
		}
		if (!Number.isSafeInteger(deduplicationMs) || deduplicationMs < 1) {
			throw new Error("Reminder deduplication window must be positive.");
		}
		const notificationKey = [
			reflection.activity.label,
			reflection.goalRelevance?.label ?? "no_goal",
			reflection.feedbackCode,
		].join("\u0000");
		const transaction = this.database.transaction(() => {
			const journal = this.database
				.query("SELECT 1 AS present FROM reflection_journal WHERE window_id = ?")
				.get(reflection.windowId) as { present: number } | null;
			if (!journal) {
				throw new Error("A reminder can only be claimed for a persisted reflection.");
			}
			const sameWindow = this.database
				.query("SELECT 1 AS present FROM reflection_notifications WHERE window_id = ?")
				.get(reflection.windowId) as { present: number } | null;
			if (sameWindow) return null;
			const cutoffAtMs = Math.max(0, nowMs - deduplicationMs);
			const recent = this.database
				.query(
					`SELECT 1 AS present
					 FROM reflection_notifications
					 WHERE notification_key = ? AND notified_at_ms > ?
					 LIMIT 1`,
				)
				.get(notificationKey, cutoffAtMs) as { present: number } | null;
			if (recent) return null;
			this.database
				.query(
					`INSERT INTO reflection_notifications
					 (window_id, notification_key, notified_at_ms)
					 VALUES (?, ?, ?)`,
				)
				.run(reflection.windowId, notificationKey, nowMs);
			return {
				windowId: reflection.windowId,
				notificationKey,
				notifiedAtMs: nowMs,
			};
		});
		return transaction.immediate();
	}

	private configure(): void {
		this.database.exec("PRAGMA journal_mode = WAL;");
		this.database.exec("PRAGMA synchronous = FULL;");
		this.database.exec("PRAGMA foreign_keys = ON;");
		this.database.exec("PRAGMA busy_timeout = 5000;");
	}

	private migrate(): void {
		const migrate = this.database.transaction(() => {
			this.database.exec(`
				CREATE TABLE IF NOT EXISTS reflection_schema (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					version INTEGER NOT NULL
				);
			`);
			const existing = this.database
				.query("SELECT version FROM reflection_schema WHERE singleton = 1")
				.get() as { version: number } | null;
			if (
				existing !== null &&
				(existing.version < 0 || existing.version > SQLITE_SCHEMA_VERSION)
			) {
				throw new Error(
					`Unsupported reflection SQLite schema ${existing.version}; expected ${SQLITE_SCHEMA_VERSION}.`,
				);
			}

			this.database.exec(`
				CREATE TABLE IF NOT EXISTS reflection_collectors (
					collector_id TEXT PRIMARY KEY,
					revision INTEGER NOT NULL CHECK (revision >= 0),
					snapshot_json TEXT NOT NULL,
					updated_at_ms INTEGER NOT NULL
				);

				CREATE TABLE IF NOT EXISTS reflection_windows (
					window_id TEXT PRIMARY KEY,
					collector_id TEXT NOT NULL,
					input_hash TEXT NOT NULL,
					event_count INTEGER NOT NULL CHECK (event_count > 0),
					created_at_ms INTEGER NOT NULL,
					window_json TEXT NOT NULL,
					FOREIGN KEY (collector_id) REFERENCES reflection_collectors(collector_id)
				);

				CREATE TABLE IF NOT EXISTS reflection_jobs (
					window_id TEXT PRIMARY KEY,
					state TEXT NOT NULL,
					attempt INTEGER NOT NULL,
					replay_count INTEGER NOT NULL,
					created_at_ms INTEGER NOT NULL,
					first_attempt_at_ms INTEGER,
					updated_at_ms INTEGER NOT NULL,
					next_attempt_at_ms INTEGER,
					lease_expires_at_ms INTEGER,
					last_failure_json TEXT,
					reflection_json TEXT,
					terminal_cursor_released_at_ms INTEGER,
					FOREIGN KEY (window_id) REFERENCES reflection_windows(window_id)
				);
				CREATE INDEX IF NOT EXISTS reflection_jobs_runnable
				ON reflection_jobs(state, next_attempt_at_ms, lease_expires_at_ms, created_at_ms);

				CREATE TABLE IF NOT EXISTS reflection_journal (
					window_id TEXT PRIMARY KEY,
					persisted_at_ms INTEGER NOT NULL,
					reflection_json TEXT NOT NULL,
					FOREIGN KEY (window_id) REFERENCES reflection_windows(window_id)
				);

				CREATE TABLE IF NOT EXISTS reflection_notifications (
					window_id TEXT PRIMARY KEY,
					notification_key TEXT NOT NULL,
					notified_at_ms INTEGER NOT NULL,
					FOREIGN KEY (window_id) REFERENCES reflection_journal(window_id)
				);
				CREATE INDEX IF NOT EXISTS reflection_notifications_recent
				ON reflection_notifications(notification_key, notified_at_ms DESC);
			`);
			if (existing === null) {
				this.database
					.query(
						"INSERT INTO reflection_schema(singleton, version) VALUES (1, ?)",
					)
					.run(SQLITE_SCHEMA_VERSION);
			} else if (existing.version !== SQLITE_SCHEMA_VERSION) {
				this.database
					.query("UPDATE reflection_schema SET version = ? WHERE singleton = 1")
					.run(SQLITE_SCHEMA_VERSION);
			}
		});
		migrate.immediate();
	}

	private collectorRow(collectorId: string): CollectorRow | null {
		return this.database
			.query("SELECT revision, snapshot_json FROM reflection_collectors WHERE collector_id = ?")
			.get(collectorId) as CollectorRow | null;
	}

	private requireCollector(collectorId: string): CollectorRow {
		const row = this.collectorRow(collectorId);
		if (!row) throw new Error(`Unknown reflection collector: ${collectorId}`);
		return row;
	}

	private windowRow(windowId: string): WindowRow | null {
		return this.database
			.query(
				"SELECT input_hash, window_json FROM reflection_windows WHERE window_id = ?",
			)
			.get(windowId) as WindowRow | null;
	}

	private jobRow(windowId: string): JobRow | null {
		return this.database
			.query("SELECT * FROM reflection_jobs WHERE window_id = ?")
			.get(windowId) as JobRow | null;
	}

	private requireJob(windowId: string): ReflectionJobV1 {
		const row = this.jobRow(windowId);
		if (!row) throw new Error(`Unknown reflection job: ${windowId}`);
		return jobFromRow(row);
	}

	private insertJob(job: ReflectionJobV1): void {
		this.database
			.query(
				`INSERT INTO reflection_jobs (
					window_id, state, attempt, replay_count, created_at_ms,
					first_attempt_at_ms, updated_at_ms, next_attempt_at_ms,
					lease_expires_at_ms, last_failure_json, reflection_json,
					terminal_cursor_released_at_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(...jobParameters(job));
	}

	private updateJob(job: ReflectionJobV1): void {
		const result = this.database
			.query(
				`UPDATE reflection_jobs SET
					state = ?, attempt = ?, replay_count = ?, created_at_ms = ?,
					first_attempt_at_ms = ?, updated_at_ms = ?, next_attempt_at_ms = ?,
					lease_expires_at_ms = ?, last_failure_json = ?, reflection_json = ?,
					terminal_cursor_released_at_ms = ?
				 WHERE window_id = ?`,
			)
			.run(
				job.state,
				job.attempt,
				job.replayCount,
				job.createdAtMs,
				job.firstAttemptAtMs,
				job.updatedAtMs,
				job.nextAttemptAtMs,
				job.leaseExpiresAtMs,
				job.lastFailure ? JSON.stringify(job.lastFailure) : null,
				job.reflection ? JSON.stringify(job.reflection) : null,
				job.terminalCursorReleasedAtMs,
				job.windowId,
			);
		if (result.changes !== 1) throw new Error(`Unknown reflection job: ${job.windowId}`);
	}
}

function hardenPath(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Some platforms and virtual/test filesystems do not expose POSIX
		// permissions; the application data directory remains the outer guard.
	}
}

function jobParameters(job: ReflectionJobV1): [
	string,
	ReflectionJobState,
	number,
	number,
	number,
	number | null,
	number,
	number | null,
	number | null,
	string | null,
	string | null,
	number | null,
] {
	return [
		job.windowId,
		job.state,
		job.attempt,
		job.replayCount,
		job.createdAtMs,
		job.firstAttemptAtMs,
		job.updatedAtMs,
		job.nextAttemptAtMs,
		job.leaseExpiresAtMs,
		job.lastFailure ? JSON.stringify(job.lastFailure) : null,
		job.reflection ? JSON.stringify(job.reflection) : null,
		job.terminalCursorReleasedAtMs,
	];
}

function jobFromRow(row: JobRow): ReflectionJobV1 {
	return {
		schemaVersion: REFLECTION_JOB_SCHEMA_VERSION,
		windowId: row.window_id,
		state: row.state,
		attempt: row.attempt,
		replayCount: row.replay_count,
		createdAtMs: row.created_at_ms,
		firstAttemptAtMs: row.first_attempt_at_ms,
		updatedAtMs: row.updated_at_ms,
		nextAttemptAtMs: row.next_attempt_at_ms,
		leaseExpiresAtMs: row.lease_expires_at_ms,
		lastFailure: row.last_failure_json
			? parseJson<ReflectionJobFailureV1>(row.last_failure_json)
			: null,
		reflection: row.reflection_json
			? parseJson<ReflectionV1>(row.reflection_json)
			: null,
		terminalCursorReleasedAtMs: row.terminal_cursor_released_at_ms,
	};
}

function assertExpectedRevision(
	actualRevision: number | null,
	expectedRevision: number | null,
): void {
	if (actualRevision !== expectedRevision) throw new CollectorRevisionConflictError();
}

function assertNextRevision(
	nextRevision: number,
	expectedRevision: number | null,
): void {
	const required = expectedRevision === null ? 0 : expectedRevision + 1;
	if (nextRevision !== required) {
		throw new Error(
			`Collector revision must advance to ${required}; received ${nextRevision}.`,
		);
	}
}

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
