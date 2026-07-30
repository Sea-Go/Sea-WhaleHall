import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
	TimelineCollectorRevisionConflictError,
	type AgentInputQuery,
	type AgentInputQueryResult,
	type PersistTimelineResult,
	type TimelineAuditRangeResult,
	type TimelineSealResult,
	type TimelineV2Repository,
} from "./repository";
import {
	ACTIVITY_EPISODE_SCHEMA_VERSION,
	AGENT_INPUT_SCHEMA_VERSION,
	EVIDENCE_FACT_SCHEMA_VERSION,
	TIMELINE_COLLECTOR_SCHEMA_VERSION,
	TIMELINE_JOB_SCHEMA_VERSION,
	TIMELINE_SUMMARY_SCHEMA_VERSION,
	TIMELINE_WINDOW_SCHEMA_VERSION,
	type ActivityEpisodeV2,
	type AgentInputEnvelopeV1,
	type AgentInputState,
	type AgentInputV1,
	type EvidenceFactV2,
	type TimelineCollectorSnapshotV2,
	type TimelineJobState,
	type TimelineJobV2,
	type TimelineSummaryV2,
	type TimelineWindowV2,
} from "./types";
import {
	openTimelineJson,
	sealTimelineJson,
	type TimelineVault,
	type TimelineVaultPurpose,
} from "./vault";

const SQLITE_SCHEMA_VERSION = 2;
const RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DERIVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type CollectorRow = {
	collector_id: string;
	revision: number;
	updated_at_ms: number;
	sealed_payload: string;
};

type WindowRow = {
	window_id: string;
	collector_id: string;
	device_id: string;
	session_id: string;
	input_hash: string;
	started_at_ms: number;
	ended_at_ms: number;
	event_count: number;
	sealed_payload: string;
};

type JobRow = {
	window_id: string;
	state: TimelineJobState;
	attempt: number;
	created_at_ms: number;
	updated_at_ms: number;
	next_attempt_at_ms: number | null;
	lease_expires_at_ms: number | null;
	first_attempt_at_ms: number | null;
	failure_code: string | null;
	failure_message: string | null;
};

type FactRow = {
	fact_id: string;
	window_id: string;
	sealed_payload: string;
};

type EpisodeRow = {
	revision_id: string;
	episode_id: string;
	revision: number;
	window_id: string;
	device_id: string;
	session_id: string;
	started_at_ms: number;
	ended_at_ms: number;
	sealed_payload: string;
};

type SummaryRow = {
	timeline_id: string;
	window_id: string;
	payload_hash: string;
	sealed_payload: string;
};

type OutboxRow = {
	agent_input_id: string;
	window_id: string;
	state: AgentInputState;
	created_at_ms: number;
	payload_hash: string;
	lease_token: string | null;
	acked_lease_token_hash: string | null;
	lease_expires_at_ms: number | null;
	attempt: number;
	acked_at_ms: number | null;
	sealed_payload: string;
};

export class SqliteTimelineV2Repository implements TimelineV2Repository {
	private readonly database: Database;
	private lastCleanupAtMs = 0;

	constructor(
		databasePath: string,
		private readonly vault: TimelineVault,
		private readonly nowMs: () => number = Date.now,
	) {
		const directory = dirname(databasePath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		hardenPath(directory, 0o700);
		this.database = new Database(databasePath, { create: true, strict: true });
		this.configure();
		this.migrate();
		this.cleanupExpiredIndexRowsIfDue(this.nowMs(), true);
		hardenPath(databasePath, 0o600);
		hardenPath(`${databasePath}-wal`, 0o600);
		hardenPath(`${databasePath}-shm`, 0o600);
	}

	close(): void {
		this.database.close();
	}

	async loadCollector(
		collectorId: string,
	): Promise<TimelineCollectorSnapshotV2 | null> {
		const row = this.collectorRow(collectorId);
		if (!row) return null;
		if (row.updated_at_ms <= this.nowMs() - RAW_RETENTION_MS) {
			// The encrypted collector may contain raw event context and expires
			// with the seven-day raw retention boundary. Returning null lets
			// recovery create a clean collector while the Rust semantic
			// consumer cursor prevents replay of already committed events.
			return null;
		}
		return openTimelineJson<TimelineCollectorSnapshotV2>(
			this.vault,
			openRequest(
				"timeline.collector.v2",
				collectorVaultRecordId(row.collector_id, row.revision),
				TIMELINE_COLLECTOR_SCHEMA_VERSION,
				row.sealed_payload,
				{ collectorId: row.collector_id, revision: row.revision },
			),
		);
	}

	async saveCollector(
		snapshot: TimelineCollectorSnapshotV2,
		expectedRevision: number | null,
	): Promise<TimelineCollectorSnapshotV2> {
		const expiredResetRow =
			expectedRevision === null
				? this.collectorRow(snapshot.collectorId)
				: null;
		const resetsExpiredCollector =
			expiredResetRow !== null &&
			expiredResetRow.updated_at_ms <=
				this.nowMs() - RAW_RETENTION_MS;
		const persistedSnapshot = resetsExpiredCollector
			? {
					...structuredClone(snapshot),
					revision: expiredResetRow!.revision + 1,
				}
			: snapshot;
		if (!resetsExpiredCollector) {
			assertNextRevision(snapshot.revision, expectedRevision);
		}
		const sealed = await sealTimelineJson(
			this.vault,
			sealRequest(
				"timeline.collector.v2",
				collectorVaultRecordId(
					persistedSnapshot.collectorId,
					persistedSnapshot.revision,
				),
				TIMELINE_COLLECTOR_SCHEMA_VERSION,
				{
					collectorId: persistedSnapshot.collectorId,
					revision: persistedSnapshot.revision,
				},
				this.nowMs() + RAW_RETENTION_MS,
			),
			persistedSnapshot,
		);
		const transaction = this.database.transaction(() => {
			const current = this.collectorRow(persistedSnapshot.collectorId);
			if (
				current &&
				resetsExpiredCollector &&
				current.revision === expiredResetRow!.revision &&
				current.updated_at_ms <= this.nowMs() - RAW_RETENTION_MS
			) {
				this.database
					.query(
						`UPDATE timeline_collectors
						 SET revision = ?, sealed_payload = ?, updated_at_ms = ?
						 WHERE collector_id = ?`,
					)
					.run(
						persistedSnapshot.revision,
						sealed,
						persistedSnapshot.updatedAtMs,
						persistedSnapshot.collectorId,
					);
				return;
			}
			assertExpectedRevision(current?.revision ?? null, expectedRevision);
			if (current) {
				const result = this.database
					.query(
						`UPDATE timeline_collectors
						 SET revision = ?, sealed_payload = ?, updated_at_ms = ?
						 WHERE collector_id = ? AND revision = ?`,
					)
					.run(
					 snapshot.revision,
					 sealed,
					 snapshot.updatedAtMs,
					 snapshot.collectorId,
						expectedRevision,
					);
				if (result.changes !== 1) {
					throw new TimelineCollectorRevisionConflictError();
				}
			} else {
				this.database
					.query(
						`INSERT INTO timeline_collectors
						 (collector_id, revision, updated_at_ms, sealed_payload)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(
						snapshot.collectorId,
						snapshot.revision,
						snapshot.updatedAtMs,
						sealed,
					);
			}
		});
		transaction.immediate();
		return structuredClone(persistedSnapshot);
	}

	async sealWindow(
		window: TimelineWindowV2,
		nextSnapshot: TimelineCollectorSnapshotV2,
		expectedRevision: number,
	): Promise<TimelineSealResult> {
		this.cleanupExpiredIndexRowsIfDue(this.nowMs());
		assertNextRevision(nextSnapshot.revision, expectedRevision);
		const [sealedWindow, sealedSnapshot] = await Promise.all([
			sealTimelineJson(
				this.vault,
				sealRequest(
					"timeline.window.v2",
					window.windowId,
					TIMELINE_WINDOW_SCHEMA_VERSION,
					windowAad(window),
					this.nowMs() + RAW_RETENTION_MS,
				),
				window,
			),
			sealTimelineJson(
				this.vault,
				sealRequest(
					"timeline.collector.v2",
					collectorVaultRecordId(
						nextSnapshot.collectorId,
						nextSnapshot.revision,
					),
					TIMELINE_COLLECTOR_SCHEMA_VERSION,
					{
						collectorId: nextSnapshot.collectorId,
						revision: nextSnapshot.revision,
					},
					this.nowMs() + RAW_RETENTION_MS,
				),
				nextSnapshot,
			),
		]);
		const transaction = this.database.transaction(() => {
			const existingWindow = this.windowRow(window.windowId);
			const existingJob = this.jobRow(window.windowId);
			if (existingWindow || existingJob) {
				if (
					!existingWindow ||
					!existingJob ||
					existingWindow.input_hash !== window.inputHash
				) {
					throw new Error(`Timeline window collision for ${window.windowId}.`);
				}
				return { existingWindow, existingJob };
			}
			const collector = this.collectorRow(nextSnapshot.collectorId);
			assertExpectedRevision(collector?.revision ?? null, expectedRevision);
			if (!collector) {
				throw new Error(`Unknown timeline collector ${nextSnapshot.collectorId}.`);
			}
			this.database
				.query(
					`INSERT INTO timeline_windows (
					 window_id, collector_id, device_id, session_id, input_hash,
					 trigger_reason, started_at_ms, ended_at_ms, event_count,
					 first_cursor, last_cursor, sealed_payload
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					window.windowId,
					window.collectorId,
					window.deviceId,
					window.sessionId,
					window.inputHash,
					window.triggerReason,
					window.startedAtMs,
					window.endedAtMs,
					window.eventCount,
					window.firstCursor,
					window.lastCursor,
					sealedWindow,
				);
			const job = newTimelineJob(window);
			this.insertJob(job);
			const updated = this.database
				.query(
					`UPDATE timeline_collectors
					 SET revision = ?, updated_at_ms = ?, sealed_payload = ?
					 WHERE collector_id = ? AND revision = ?`,
				)
				.run(
					nextSnapshot.revision,
					nextSnapshot.updatedAtMs,
					sealedSnapshot,
					nextSnapshot.collectorId,
					expectedRevision,
				);
			if (updated.changes !== 1) {
				throw new TimelineCollectorRevisionConflictError();
			}
			return { existingWindow: null, existingJob: null };
		});
		const result = transaction.immediate();
		if (result.existingWindow && result.existingJob) {
			const [storedWindow, snapshot] = await Promise.all([
				this.openWindowRow(result.existingWindow),
				this.loadCollector(nextSnapshot.collectorId),
			]);
			if (!snapshot) throw new Error("Idempotent seal lost its collector.");
			return {
				inserted: false,
				window: storedWindow,
				snapshot,
				job: jobFromRow(result.existingJob),
			};
		}
		return {
			inserted: true,
			window: structuredClone(window),
			snapshot: structuredClone(nextSnapshot),
			job: newTimelineJob(window),
		};
	}

	async getWindow(windowId: string): Promise<TimelineWindowV2 | null> {
		const row = this.windowRow(windowId);
		return row ? this.openWindowRow(row) : null;
	}

	async getJob(windowId: string): Promise<TimelineJobV2 | null> {
		const row = this.jobRow(windowId);
		return row ? jobFromRow(row) : null;
	}

	async claimNextWindow(
		nowMs: number,
		leaseDurationMs: number,
	): Promise<TimelineJobV2 | null> {
		this.cleanupExpiredIndexRowsIfDue(nowMs);
		assertPositiveSafeInteger(leaseDurationMs, "leaseDurationMs");
		const transaction = this.database.transaction(() => {
			const row = this.database
				.query(
					`SELECT * FROM timeline_jobs
					 WHERE
					  (state IN ('READY', 'RETRY_WAIT')
					   AND COALESCE(next_attempt_at_ms, created_at_ms) <= ?)
					  OR (state = 'RUNNING' AND lease_expires_at_ms <= ?)
					  OR state IN ('RESULT_PERSISTED', 'COMMITTING')
					 ORDER BY COALESCE(next_attempt_at_ms, created_at_ms),
					          created_at_ms, window_id
					 LIMIT 1`,
				)
				.get(nowMs, nowMs) as JobRow | null;
			if (!row) return null;
			if (
				row.state === "RESULT_PERSISTED" ||
				row.state === "COMMITTING"
			) {
				return jobFromRow(row);
			}
			const job: TimelineJobV2 = {
				...jobFromRow(row),
				state: "RUNNING",
				attempt: row.attempt + 1,
				updatedAtMs: nowMs,
				nextAttemptAtMs: null,
				leaseExpiresAtMs: nowMs + leaseDurationMs,
				firstAttemptAtMs: row.first_attempt_at_ms ?? nowMs,
				failureCode: null,
				failureMessage: null,
			};
			this.updateJob(job);
			return job;
		});
		const claimed = transaction.immediate();
		return claimed ? structuredClone(claimed) : null;
	}

	async completeWindow(
		result: PersistTimelineResult,
		nowMs: number,
	): Promise<TimelineJobV2> {
		const window = this.windowRow(result.windowId);
		if (!window) throw new Error(`Unknown timeline window ${result.windowId}.`);
		const [sealedFacts, sealedEpisodes, sealedSummary, sealedAgentInput] =
			await Promise.all([
				Promise.all(
					result.facts.map(async (fact) => ({
						fact,
						sealed: await sealTimelineJson(
							this.vault,
							sealRequest(
								"timeline.fact.v2",
								fact.factId,
								EVIDENCE_FACT_SCHEMA_VERSION,
								{
									factId: fact.factId,
									windowId: result.windowId,
									startedAtMs: fact.startedAtMs,
								},
								this.nowMs() + DERIVED_RETENTION_MS,
							),
							fact,
						),
					})),
				),
				Promise.all(
					result.episodes.map(async (episode) => ({
						episode,
						sealed: await sealTimelineJson(
							this.vault,
							sealRequest(
								"timeline.episode.v2",
								episode.revisionId,
								ACTIVITY_EPISODE_SCHEMA_VERSION,
								{
									revisionId: episode.revisionId,
									episodeId: episode.episodeId,
									revision: episode.revision,
								},
								this.nowMs() + DERIVED_RETENTION_MS,
							),
							episode,
						),
					})),
				),
				sealTimelineJson(
					this.vault,
					sealRequest(
						"timeline.summary.v2",
						result.summary.timelineId,
						TIMELINE_SUMMARY_SCHEMA_VERSION,
						{
							timelineId: result.summary.timelineId,
							windowId: result.windowId,
							revision: result.summary.revision,
						},
						this.nowMs() + DERIVED_RETENTION_MS,
					),
					result.summary,
				),
				sealTimelineJson(
					this.vault,
					sealRequest(
						"timeline.agent-input.v1",
						result.agentInput.agentInputId,
						AGENT_INPUT_SCHEMA_VERSION,
						{
							agentInputId: result.agentInput.agentInputId,
							windowId: result.windowId,
							payloadHash: result.agentInput.payloadHash,
						},
						this.nowMs() + DERIVED_RETENTION_MS,
					),
					result.agentInput,
				),
			]);

		const transaction = this.database.transaction(() => {
			const current = this.requireJob(result.windowId);
			const existing = this.summaryRowByWindow(result.windowId);
			if (existing) {
				if (
					existing.timeline_id !== result.summary.timelineId ||
					existing.payload_hash !== result.agentInput.payloadHash
				) {
					throw new Error(
						`A different timeline result already exists for ${result.windowId}.`,
					);
				}
				if (current.state === "COMMITTED") return current;
				if (
					current.state !== "RUNNING" &&
					current.state !== "RESULT_PERSISTED" &&
					current.state !== "COMMITTING"
				) {
					throw new Error(
						`Cannot recover persisted timeline result ${result.windowId} from ${current.state}.`,
					);
				}
				if (
					current.state === "RESULT_PERSISTED" ||
					current.state === "COMMITTING"
				) {
					return current;
				}
				const resultPersisted: TimelineJobV2 = {
					...current,
					state: "RESULT_PERSISTED",
					updatedAtMs: nowMs,
					nextAttemptAtMs: null,
					leaseExpiresAtMs: null,
				};
				this.updateJob(resultPersisted);
				return resultPersisted;
			}
			if (current.state !== "RUNNING") {
				throw new Error(
					`Cannot complete timeline job ${result.windowId} from ${current.state}.`,
				);
			}
			for (const { fact, sealed } of sealedFacts) {
				this.database
					.query(
						`INSERT INTO timeline_facts
						 (fact_id, window_id, started_at_ms, ended_at_ms, sealed_payload)
						 VALUES (?, ?, ?, ?, ?)`,
					)
					.run(
						fact.factId,
						result.windowId,
						fact.startedAtMs,
						fact.endedAtMs,
						sealed,
					);
			}
			for (const { episode, sealed } of sealedEpisodes) {
				this.database
					.query(
						`INSERT INTO timeline_episode_revisions (
						  revision_id, episode_id, revision, window_id, device_id,
						  session_id, started_at_ms, ended_at_ms, sealed_payload
						 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						episode.revisionId,
						episode.episodeId,
						episode.revision,
						result.windowId,
						window.device_id,
						window.session_id,
						episode.startedAtMs,
						episode.endedAtMs,
						sealed,
					);
			}
			this.database
				.query(
					`INSERT INTO timeline_summaries (
					  timeline_id, window_id, revision, started_at_ms, ended_at_ms,
					  payload_hash, sealed_payload
					 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					result.summary.timelineId,
					result.windowId,
					result.summary.revision,
					result.summary.period.startedAtMs,
					result.summary.period.endedAtMs,
					result.agentInput.payloadHash,
					sealedSummary,
				);
			this.database
				.query(
					`INSERT INTO agent_input_outbox (
					  agent_input_id, window_id, state, created_at_ms, payload_hash,
					  lease_token, lease_expires_at_ms, attempt, acked_at_ms,
					  sealed_payload
					 ) VALUES (?, ?, 'HELD_LOCAL', ?, ?, NULL, NULL, 0, NULL, ?)`,
				)
				.run(
					result.agentInput.agentInputId,
					result.windowId,
					result.agentInput.createdAtMs,
					result.agentInput.payloadHash,
					sealedAgentInput,
				);
			const resultPersisted: TimelineJobV2 = {
				...current,
				state: "RESULT_PERSISTED",
				updatedAtMs: nowMs,
				nextAttemptAtMs: null,
				leaseExpiresAtMs: null,
			};
			this.updateJob(resultPersisted);
			return resultPersisted;
		});
		const persisted = transaction.immediate();
		if (persisted.state === "COMMITTED") {
			return structuredClone(persisted);
		}
		return this.finalizeWindowCommit(result.windowId, nowMs);
	}

	async finalizeWindowCommit(
		windowId: string,
		nowMs: number,
	): Promise<TimelineJobV2> {
		const beginCommit = this.database.transaction(() => {
			const current = this.requireJob(windowId);
			if (current.state === "COMMITTED") return current;
			if (
				current.state !== "RESULT_PERSISTED" &&
				current.state !== "COMMITTING"
			) {
				throw new Error(
					`Cannot finalize timeline job ${windowId} from ${current.state}.`,
				);
			}
			if (current.state === "COMMITTING") return current;
			const committing: TimelineJobV2 = {
				...current,
				state: "COMMITTING",
				updatedAtMs: nowMs,
				nextAttemptAtMs: null,
				leaseExpiresAtMs: null,
			};
			this.updateJob(committing);
			return committing;
		});
		const committing = beginCommit.immediate();
		if (committing.state === "COMMITTED") {
			return structuredClone(committing);
		}
		const finishCommit = this.database.transaction(() => {
			const current = this.requireJob(windowId);
			if (current.state === "COMMITTED") return current;
			if (current.state !== "COMMITTING") {
				throw new Error(
					`Timeline job ${windowId} lost COMMITTING state.`,
				);
			}
			const committed: TimelineJobV2 = {
				...current,
				state: "COMMITTED",
				updatedAtMs: nowMs,
				nextAttemptAtMs: null,
				leaseExpiresAtMs: null,
			};
			this.updateJob(committed);
			return committed;
		});
		return structuredClone(finishCommit.immediate());
	}

	async recordWindowFailure(
		windowId: string,
		options: {
			nowMs: number;
			code: string;
			message: string;
			nextAttemptAtMs: number | null;
			terminal: boolean;
		},
	): Promise<TimelineJobV2> {
		const transaction = this.database.transaction(() => {
			const current = this.requireJob(windowId);
			if (current.state !== "RUNNING") {
				throw new Error(
					`Cannot record timeline failure ${windowId} from ${current.state}.`,
				);
			}
			const next: TimelineJobV2 = {
				...current,
				state: options.terminal ? "TERMINAL_FAILED" : "RETRY_WAIT",
				updatedAtMs: options.nowMs,
				nextAttemptAtMs: options.terminal ? null : options.nextAttemptAtMs,
				leaseExpiresAtMs: null,
				failureCode: sanitizeFailure(options.code, 128),
				failureMessage: sanitizeFailure(options.message, 512),
			};
			this.updateJob(next);
			return next;
		});
		return structuredClone(transaction.immediate());
	}

	async findLatestEpisode(
		deviceId: string,
		sessionId: string,
		beforeOrAtMs: number,
	): Promise<ActivityEpisodeV2 | null> {
		const row = this.database
			.query(
				`SELECT * FROM timeline_episode_revisions
				 WHERE device_id = ? AND session_id = ? AND ended_at_ms <= ?
				 ORDER BY ended_at_ms DESC, revision DESC, revision_id DESC
				 LIMIT 1`,
			)
			.get(deviceId, sessionId, beforeOrAtMs) as EpisodeRow | null;
		return row ? this.openEpisodeRow(row) : null;
	}

	async getTimelineResult(
		windowId: string,
	): Promise<PersistTimelineResult | null> {
		const summaryRow = this.summaryRowByWindow(windowId);
		if (!summaryRow) return null;
		const [facts, episodes, summary, agentInput] = await Promise.all([
			this.openFacts(windowId),
			this.openEpisodes(windowId),
			this.openSummaryRow(summaryRow),
			this.openAgentInputByWindow(windowId),
		]);
		if (!agentInput) {
			throw new Error(`Timeline ${windowId} lost its AgentInput.`);
		}
		return { windowId, facts, episodes, summary, agentInput };
	}

	async releaseAgentInputs(
		agentInputIds: readonly string[] | null,
		_nowMs: number,
	): Promise<number> {
		const transaction = this.database.transaction(() => {
			if (agentInputIds === null) {
				return this.database
					.query(
						"UPDATE agent_input_outbox SET state = 'READY' WHERE state = 'HELD_LOCAL'",
					)
					.run().changes;
			}
			let changed = 0;
			for (const id of new Set(agentInputIds)) {
				changed += this.database
					.query(
						`UPDATE agent_input_outbox SET state = 'READY'
						 WHERE agent_input_id = ? AND state = 'HELD_LOCAL'`,
					)
					.run(id).changes;
			}
			return changed;
		});
		return transaction.immediate();
	}

	async queryAgentInputs(query: AgentInputQuery): Promise<AgentInputQueryResult> {
		this.cleanupExpiredIndexRowsIfDue(query.nowMs);
		const limit = boundedInteger(query.limit ?? 32, 1, 100, "limit");
		const leaseDurationMs = query.leaseDurationMs ?? 30_000;
		assertPositiveSafeInteger(leaseDurationMs, "leaseDurationMs");
		const transaction = this.database.transaction(() => {
			const rows = this.database
				.query(
					`SELECT * FROM agent_input_outbox
					 WHERE state = 'READY'
					    OR (state = 'LEASED' AND lease_expires_at_ms <= ?)
					    OR (? = 1 AND state = 'HELD_LOCAL')
					 ORDER BY created_at_ms, agent_input_id
					 LIMIT ?`,
				)
				.all(query.nowMs, query.includeHeldLocal === true ? 1 : 0, limit) as OutboxRow[];
			return rows.map((row) => {
				if (row.state === "HELD_LOCAL") return row;
				const leaseToken = crypto.randomUUID();
				const result = this.database
					.query(
						`UPDATE agent_input_outbox
						 SET state = 'LEASED', lease_token = ?,
						     lease_expires_at_ms = ?, attempt = attempt + 1
						 WHERE agent_input_id = ?
						   AND (
						     state = 'READY'
						     OR (state = 'LEASED' AND lease_expires_at_ms <= ?)
						   )`,
					)
					.run(
						leaseToken,
						query.nowMs + leaseDurationMs,
						row.agent_input_id,
						query.nowMs,
					);
				if (result.changes !== 1) {
					throw new Error(`AgentInput lease raced for ${row.agent_input_id}.`);
				}
				return {
					...row,
					state: "LEASED" as const,
					lease_token: leaseToken,
					lease_expires_at_ms: query.nowMs + leaseDurationMs,
					attempt: row.attempt + 1,
				};
			});
		});
		const rows = transaction.immediate();
		return {
			inputs: await Promise.all(rows.map((row) => this.openOutboxEnvelope(row))),
		};
	}

	async commitAgentInput(
		agentInputId: string,
		leaseToken: string,
		nowMs: number,
	): Promise<AgentInputEnvelopeV1> {
		const leaseTokenHash = await opaqueLeaseTokenHash(leaseToken);
		const transaction = this.database.transaction(() => {
			const row = this.outboxRow(agentInputId);
			if (!row) throw new Error(`Unknown AgentInput: ${agentInputId}.`);
			if (row.state === "ACKED") {
				if (row.acked_lease_token_hash !== leaseTokenHash) {
					throw new Error("AgentInput ACK lease token does not match.");
				}
				return row;
			}
			if (
				row.state !== "LEASED" ||
				row.lease_token !== leaseToken ||
				row.lease_expires_at_ms === null ||
				row.lease_expires_at_ms < nowMs
			) {
				throw new Error("AgentInput lease is missing, expired, or does not match.");
			}
			const updated = this.database
				.query(
					`UPDATE agent_input_outbox
					 SET state = 'ACKED', lease_token = NULL,
					     acked_lease_token_hash = ?,
					     lease_expires_at_ms = NULL, acked_at_ms = ?
					 WHERE agent_input_id = ? AND state = 'LEASED'
					   AND lease_token = ?`,
				)
				.run(leaseTokenHash, nowMs, agentInputId, leaseToken);
			if (updated.changes !== 1) {
				throw new Error(`AgentInput commit raced for ${agentInputId}.`);
			}
			return {
				...row,
				state: "ACKED" as const,
				lease_token: null,
				acked_lease_token_hash: leaseTokenHash,
				lease_expires_at_ms: null,
				acked_at_ms: nowMs,
			};
		});
		return this.openOutboxEnvelope(transaction.immediate());
	}

	async readAuditRange(
		fromMs: number,
		toMs: number,
	): Promise<TimelineAuditRangeResult> {
		this.cleanupExpiredIndexRowsIfDue(this.nowMs());
		if (
			!Number.isSafeInteger(fromMs) ||
			!Number.isSafeInteger(toMs) ||
			fromMs < 0 ||
			toMs <= fromMs
		) {
			throw new Error("Audit range must be a non-empty safe millisecond interval.");
		}
		const windowRows = this.database
			.query(
				`SELECT * FROM timeline_windows
				 WHERE ended_at_ms >= ? AND started_at_ms < ?
				 ORDER BY started_at_ms, window_id`,
			)
			.all(fromMs, toMs) as WindowRow[];
		const rawWindowCutoffMs = this.nowMs() - RAW_RETENTION_MS;
		const windows = await Promise.all(
			windowRows
				.filter((row) => row.ended_at_ms > rawWindowCutoffMs)
				.map((row) => this.openWindowRow(row)),
		);
		// Audit does not need the seven-day raw window envelope in order to
		// inspect 30-day derived records. Open each derived payload directly so
		// a legitimately expired window cannot make a 7–30 day audit fail.
		const derived = await Promise.all(
			windowRows.map(async (row) => {
				const summaryRow = this.summaryRowByWindow(row.window_id);
				if (!summaryRow) {
					return {
						facts: [] as EvidenceFactV2[],
						episodes: [] as ActivityEpisodeV2[],
						summary: null as TimelineSummaryV2 | null,
					};
				}
				const [facts, episodes, summary] = await Promise.all([
					this.openFacts(row.window_id),
					this.openEpisodes(row.window_id),
					this.openSummaryRow(summaryRow),
				]);
				return { facts, episodes, summary };
			}),
		);
		return {
			windows,
			facts: derived.flatMap((result) => result.facts),
			episodes: derived.flatMap((result) => result.episodes),
			summaries: derived.flatMap((result) =>
				result.summary ? [result.summary] : [],
			),
		};
	}

	private configure(): void {
		this.database.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = FULL;
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 5000;
			PRAGMA secure_delete = ON;
			PRAGMA trusted_schema = OFF;
		`);
	}

	private cleanupExpiredIndexRowsIfDue(nowMs: number, force = false): void {
		const oneHourMs = 60 * 60 * 1000;
		if (!force && nowMs - this.lastCleanupAtMs < oneHourMs) return;
		const cutoffMs = nowMs - DERIVED_RETENTION_MS;
		const transaction = this.database.transaction(() => {
			const expiredWindows = this.database
				.query(
					"SELECT window_id FROM timeline_windows WHERE ended_at_ms <= ?",
				)
				.all(cutoffMs) as Array<{ window_id: string }>;
			for (const { window_id } of expiredWindows) {
				this.database
					.query("DELETE FROM agent_input_outbox WHERE window_id = ?")
					.run(window_id);
				this.database
					.query("DELETE FROM timeline_summaries WHERE window_id = ?")
					.run(window_id);
				this.database
					.query(
						"DELETE FROM timeline_episode_revisions WHERE window_id = ?",
					)
					.run(window_id);
				this.database
					.query("DELETE FROM timeline_facts WHERE window_id = ?")
					.run(window_id);
				this.database
					.query("DELETE FROM timeline_jobs WHERE window_id = ?")
					.run(window_id);
				this.database
					.query("DELETE FROM timeline_windows WHERE window_id = ?")
					.run(window_id);
			}
		});
		transaction.immediate();
		this.lastCleanupAtMs = nowMs;
		if (force || cutoffMs >= 0) {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
		}
	}

	private migrate(): void {
		const migration = this.database.transaction(() => {
			this.database.exec(`
				CREATE TABLE IF NOT EXISTS timeline_schema (
				 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				 version INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS timeline_collectors (
				 collector_id TEXT PRIMARY KEY,
				 revision INTEGER NOT NULL CHECK (revision >= 0),
				 updated_at_ms INTEGER NOT NULL,
				 sealed_payload TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS timeline_windows (
				 window_id TEXT PRIMARY KEY,
				 collector_id TEXT NOT NULL,
				 device_id TEXT NOT NULL,
				 session_id TEXT NOT NULL,
				 input_hash TEXT NOT NULL,
				 trigger_reason TEXT NOT NULL,
				 started_at_ms INTEGER NOT NULL,
				 ended_at_ms INTEGER NOT NULL,
				 event_count INTEGER NOT NULL CHECK (event_count > 0),
				 first_cursor TEXT NOT NULL,
				 last_cursor TEXT NOT NULL,
				 sealed_payload TEXT NOT NULL,
				 FOREIGN KEY (collector_id) REFERENCES timeline_collectors(collector_id)
				);
				CREATE TABLE IF NOT EXISTS timeline_jobs (
				 window_id TEXT PRIMARY KEY,
				 state TEXT NOT NULL,
				 attempt INTEGER NOT NULL,
				 created_at_ms INTEGER NOT NULL,
				 updated_at_ms INTEGER NOT NULL,
				 next_attempt_at_ms INTEGER,
				 lease_expires_at_ms INTEGER,
				 first_attempt_at_ms INTEGER,
				 failure_code TEXT,
				 failure_message TEXT,
				 FOREIGN KEY (window_id) REFERENCES timeline_windows(window_id)
				);
				CREATE INDEX IF NOT EXISTS timeline_jobs_runnable
				 ON timeline_jobs(state, next_attempt_at_ms, lease_expires_at_ms);
				CREATE TABLE IF NOT EXISTS timeline_facts (
				 fact_id TEXT PRIMARY KEY,
				 window_id TEXT NOT NULL,
				 started_at_ms INTEGER NOT NULL,
				 ended_at_ms INTEGER NOT NULL,
				 sealed_payload TEXT NOT NULL,
				 FOREIGN KEY (window_id) REFERENCES timeline_windows(window_id)
				);
				CREATE INDEX IF NOT EXISTS timeline_facts_period
				 ON timeline_facts(started_at_ms, ended_at_ms);
				CREATE TABLE IF NOT EXISTS timeline_episode_revisions (
				 revision_id TEXT PRIMARY KEY,
				 episode_id TEXT NOT NULL,
				 revision INTEGER NOT NULL,
				 window_id TEXT NOT NULL,
				 device_id TEXT NOT NULL,
				 session_id TEXT NOT NULL,
				 started_at_ms INTEGER NOT NULL,
				 ended_at_ms INTEGER NOT NULL,
				 sealed_payload TEXT NOT NULL,
				 FOREIGN KEY (window_id) REFERENCES timeline_windows(window_id)
				);
				CREATE UNIQUE INDEX IF NOT EXISTS timeline_episode_revision
				 ON timeline_episode_revisions(episode_id, revision);
				CREATE INDEX IF NOT EXISTS timeline_episode_latest
				 ON timeline_episode_revisions(device_id, session_id, ended_at_ms DESC);
				CREATE TABLE IF NOT EXISTS timeline_summaries (
				 timeline_id TEXT PRIMARY KEY,
				 window_id TEXT UNIQUE NOT NULL,
				 revision INTEGER NOT NULL,
				 started_at_ms INTEGER NOT NULL,
				 ended_at_ms INTEGER NOT NULL,
				 payload_hash TEXT NOT NULL,
				 sealed_payload TEXT NOT NULL,
				 FOREIGN KEY (window_id) REFERENCES timeline_windows(window_id)
				);
				CREATE TABLE IF NOT EXISTS agent_input_outbox (
				 agent_input_id TEXT PRIMARY KEY,
				 window_id TEXT UNIQUE NOT NULL,
				 state TEXT NOT NULL,
				 created_at_ms INTEGER NOT NULL,
				 payload_hash TEXT NOT NULL,
				 lease_token TEXT,
				 acked_lease_token_hash TEXT,
				 lease_expires_at_ms INTEGER,
				 attempt INTEGER NOT NULL,
				 acked_at_ms INTEGER,
				 sealed_payload TEXT NOT NULL,
				 FOREIGN KEY (window_id) REFERENCES timeline_windows(window_id)
				);
				CREATE INDEX IF NOT EXISTS agent_input_outbox_ready
				 ON agent_input_outbox(state, lease_expires_at_ms, created_at_ms);
			`);
			const row = this.database
				.query("SELECT version FROM timeline_schema WHERE singleton = 1")
				.get() as { version: number } | null;
			if (
				row !== null &&
				row.version !== 1 &&
				row.version !== SQLITE_SCHEMA_VERSION
			) {
				throw new Error(
					`Unsupported timeline SQLite schema ${row.version}; expected 1 or ${SQLITE_SCHEMA_VERSION}.`,
				);
			}
			const outboxColumns = this.database
				.query("PRAGMA table_info(agent_input_outbox)")
				.all() as Array<{ name: string }>;
			if (
				!outboxColumns.some(
					(column) => column.name === "acked_lease_token_hash",
				)
			) {
				this.database.exec(
					"ALTER TABLE agent_input_outbox ADD COLUMN acked_lease_token_hash TEXT",
				);
			}
			if (!row) {
				this.database
					.query(
						"INSERT INTO timeline_schema(singleton, version) VALUES (1, ?)",
					)
					.run(SQLITE_SCHEMA_VERSION);
			} else if (row.version === 1) {
				this.database
					.query(
						"UPDATE timeline_schema SET version = ? WHERE singleton = 1",
					)
					.run(SQLITE_SCHEMA_VERSION);
			}
		});
		migration.immediate();
	}

	private collectorRow(collectorId: string): CollectorRow | null {
		return this.database
			.query("SELECT * FROM timeline_collectors WHERE collector_id = ?")
			.get(collectorId) as CollectorRow | null;
	}

	private windowRow(windowId: string): WindowRow | null {
		return this.database
			.query("SELECT * FROM timeline_windows WHERE window_id = ?")
			.get(windowId) as WindowRow | null;
	}

	private jobRow(windowId: string): JobRow | null {
		return this.database
			.query("SELECT * FROM timeline_jobs WHERE window_id = ?")
			.get(windowId) as JobRow | null;
	}

	private requireJob(windowId: string): TimelineJobV2 {
		const row = this.jobRow(windowId);
		if (!row) throw new Error(`Unknown timeline job: ${windowId}.`);
		return jobFromRow(row);
	}

	private summaryRowByWindow(windowId: string): SummaryRow | null {
		return this.database
			.query("SELECT * FROM timeline_summaries WHERE window_id = ?")
			.get(windowId) as SummaryRow | null;
	}

	private outboxRow(agentInputId: string): OutboxRow | null {
		return this.database
			.query("SELECT * FROM agent_input_outbox WHERE agent_input_id = ?")
			.get(agentInputId) as OutboxRow | null;
	}

	private async openWindowRow(row: WindowRow): Promise<TimelineWindowV2> {
		return openTimelineJson<TimelineWindowV2>(
			this.vault,
			openRequest(
				"timeline.window.v2",
				row.window_id,
				TIMELINE_WINDOW_SCHEMA_VERSION,
				row.sealed_payload,
				{
					windowId: row.window_id,
					inputHash: row.input_hash,
					startedAtMs: row.started_at_ms,
					endedAtMs: row.ended_at_ms,
				},
			),
		);
	}

	private async openEpisodeRow(row: EpisodeRow): Promise<ActivityEpisodeV2> {
		return openTimelineJson<ActivityEpisodeV2>(
			this.vault,
			openRequest(
				"timeline.episode.v2",
				row.revision_id,
				ACTIVITY_EPISODE_SCHEMA_VERSION,
				row.sealed_payload,
				{
					revisionId: row.revision_id,
					episodeId: row.episode_id,
					revision: row.revision,
				},
			),
		);
	}

	private async openFacts(windowId: string): Promise<EvidenceFactV2[]> {
		const rows = this.database
			.query(
				"SELECT * FROM timeline_facts WHERE window_id = ? ORDER BY started_at_ms, fact_id",
			)
			.all(windowId) as FactRow[];
		return Promise.all(
			rows.map((row) =>
				openTimelineJson<EvidenceFactV2>(
					this.vault,
					openRequest(
						"timeline.fact.v2",
						row.fact_id,
						EVIDENCE_FACT_SCHEMA_VERSION,
						row.sealed_payload,
						{
							factId: row.fact_id,
							windowId,
							startedAtMs: (
								this.database
									.query(
										"SELECT started_at_ms FROM timeline_facts WHERE fact_id = ?",
									)
									.get(row.fact_id) as { started_at_ms: number }
							).started_at_ms,
						},
					),
				),
			),
		);
	}

	private async openEpisodes(windowId: string): Promise<ActivityEpisodeV2[]> {
		const rows = this.database
			.query(
				`SELECT * FROM timeline_episode_revisions
				 WHERE window_id = ? ORDER BY started_at_ms, revision_id`,
			)
			.all(windowId) as EpisodeRow[];
		return Promise.all(rows.map((row) => this.openEpisodeRow(row)));
	}

	private async openSummaryRow(row: SummaryRow): Promise<TimelineSummaryV2> {
		const metadata = this.database
			.query(
				"SELECT revision FROM timeline_summaries WHERE timeline_id = ?",
			)
			.get(row.timeline_id) as { revision: number };
		return openTimelineJson<TimelineSummaryV2>(
			this.vault,
			openRequest(
				"timeline.summary.v2",
				row.timeline_id,
				TIMELINE_SUMMARY_SCHEMA_VERSION,
				row.sealed_payload,
				{
					timelineId: row.timeline_id,
					windowId: row.window_id,
					revision: metadata.revision,
				},
			),
		);
	}

	private async openAgentInputByWindow(
		windowId: string,
	): Promise<AgentInputV1 | null> {
		const row = this.database
			.query("SELECT * FROM agent_input_outbox WHERE window_id = ?")
			.get(windowId) as OutboxRow | null;
		if (!row) return null;
		return this.openAgentInputRow(row);
	}

	private async openAgentInputRow(row: OutboxRow): Promise<AgentInputV1> {
		return openTimelineJson<AgentInputV1>(
			this.vault,
			openRequest(
				"timeline.agent-input.v1",
				row.agent_input_id,
				AGENT_INPUT_SCHEMA_VERSION,
				row.sealed_payload,
				{
					agentInputId: row.agent_input_id,
					windowId: row.window_id,
					payloadHash: row.payload_hash,
				},
			),
		);
	}

	private async openOutboxEnvelope(
		row: OutboxRow,
	): Promise<AgentInputEnvelopeV1> {
		return {
			input: await this.openAgentInputRow(row),
			state: row.state,
			leaseToken: row.lease_token,
			leaseExpiresAtMs: row.lease_expires_at_ms,
			attempt: row.attempt,
			ackedAtMs: row.acked_at_ms,
		};
	}

	private insertJob(job: TimelineJobV2): void {
		this.database
			.query(
				`INSERT INTO timeline_jobs (
				  window_id, state, attempt, created_at_ms, updated_at_ms,
				  next_attempt_at_ms, lease_expires_at_ms, first_attempt_at_ms,
				  failure_code, failure_message
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(...jobParameters(job));
	}

	private updateJob(job: TimelineJobV2): void {
		const result = this.database
			.query(
				`UPDATE timeline_jobs SET
				  state = ?, attempt = ?, created_at_ms = ?, updated_at_ms = ?,
				  next_attempt_at_ms = ?, lease_expires_at_ms = ?,
				  first_attempt_at_ms = ?, failure_code = ?, failure_message = ?
				 WHERE window_id = ?`,
			)
			.run(
				job.state,
				job.attempt,
				job.createdAtMs,
				job.updatedAtMs,
				job.nextAttemptAtMs,
				job.leaseExpiresAtMs,
				job.firstAttemptAtMs,
				job.failureCode,
				job.failureMessage,
				job.windowId,
			);
		if (result.changes !== 1) {
			throw new Error(`Unknown timeline job: ${job.windowId}.`);
		}
	}
}

function sealRequest(
	purpose: TimelineVaultPurpose,
	recordId: string,
	schemaVersion: string,
	aad: Record<string, string | number | null>,
	expiresAtMs?: number | null,
) {
	return { purpose, recordId, schemaVersion, aad, expiresAtMs };
}

function openRequest(
	purpose: TimelineVaultPurpose,
	recordId: string,
	schemaVersion: string,
	sealedPayload: string,
	aad: Record<string, string | number | null>,
) {
	return { purpose, recordId, schemaVersion, sealedPayload, aad };
}

function windowAad(
	window: Pick<
		TimelineWindowV2,
		"windowId" | "inputHash" | "startedAtMs" | "endedAtMs"
	>,
): Record<string, string | number | null> {
	return {
		windowId: window.windowId,
		inputHash: window.inputHash,
		startedAtMs: window.startedAtMs,
		endedAtMs: window.endedAtMs,
	};
}

function collectorVaultRecordId(
	collectorId: string,
	revision: number,
): string {
	return `${collectorId}.r${revision}`;
}

function newTimelineJob(window: TimelineWindowV2): TimelineJobV2 {
	return {
		schemaVersion: TIMELINE_JOB_SCHEMA_VERSION,
		windowId: window.windowId,
		state: "READY",
		attempt: 0,
		createdAtMs: window.endedAtMs,
		updatedAtMs: window.endedAtMs,
		nextAttemptAtMs: window.endedAtMs,
		leaseExpiresAtMs: null,
		firstAttemptAtMs: null,
		failureCode: null,
		failureMessage: null,
	};
}

function jobFromRow(row: JobRow): TimelineJobV2 {
	return {
		schemaVersion: TIMELINE_JOB_SCHEMA_VERSION,
		windowId: row.window_id,
		state: row.state,
		attempt: row.attempt,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
		nextAttemptAtMs: row.next_attempt_at_ms,
		leaseExpiresAtMs: row.lease_expires_at_ms,
		firstAttemptAtMs: row.first_attempt_at_ms,
		failureCode: row.failure_code,
		failureMessage: row.failure_message,
	};
}

function jobParameters(job: TimelineJobV2): [
	string,
	TimelineJobState,
	number,
	number,
	number,
	number | null,
	number | null,
	number | null,
	string | null,
	string | null,
] {
	return [
		job.windowId,
		job.state,
		job.attempt,
		job.createdAtMs,
		job.updatedAtMs,
		job.nextAttemptAtMs,
		job.leaseExpiresAtMs,
		job.firstAttemptAtMs,
		job.failureCode,
		job.failureMessage,
	];
}

function assertExpectedRevision(
	actual: number | null,
	expected: number | null,
): void {
	if (actual !== expected) throw new TimelineCollectorRevisionConflictError();
}

function assertNextRevision(next: number, expected: number | null): void {
	const required = expected === null ? 0 : expected + 1;
	if (next !== required) {
		throw new Error(
			`Timeline collector revision must advance to ${required}; received ${next}.`,
		);
	}
}

function sanitizeFailure(value: string, maximum: number): string {
	return (
		value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, maximum) ||
		"unknown"
	);
}

function boundedInteger(
	value: number,
	minimum: number,
	maximum: number,
	field: string,
): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
	}
	return value;
}

function assertPositiveSafeInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${field} must be a positive safe integer.`);
	}
}

function hardenPath(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// POSIX mode hardening is unavailable on some test and Windows filesystems.
	}
}

async function opaqueLeaseTokenHash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
