import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	SqliteTimelineV2Repository,
	TimelineCollectorRevisionConflictError,
	type TimelineCollectorSnapshotV2,
	type TimelineVault,
	type TimelineVaultDeleteRequest,
	type TimelineVaultOpenRequest,
	type TimelineVaultSealRequest,
} from "../src/agent/timeline-v2";

const RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

class ExactMemoryVault implements TimelineVault {
	readonly seals: TimelineVaultSealRequest[] = [];
	readonly deletes: TimelineVaultDeleteRequest[] = [];
	private nextRef = 1;
	private readonly records = new Map<
		string,
		{ ref: string; request: TimelineVaultSealRequest }
	>();
	private readonly byRef = new Map<string, TimelineVaultSealRequest>();

	async seal(request: TimelineVaultSealRequest): Promise<string> {
		this.seals.push(structuredClone(request));
		const key = this.key(request.purpose, request.recordId);
		const existing = this.records.get(key);
		if (existing) {
			if (
				existing.request.plaintext !== request.plaintext ||
				existing.request.schemaVersion !== request.schemaVersion ||
				existing.request.expiresAtMs !== request.expiresAtMs ||
				JSON.stringify(existing.request.aad) !== JSON.stringify(request.aad)
			) {
				throw new Error("vault record id reused with different content");
			}
			return existing.ref;
		}
		const ref = `vaultref_${this.nextRef++}`;
		const copy = structuredClone(request);
		this.records.set(key, { ref, request: copy });
		this.byRef.set(ref, copy);
		return ref;
	}

	async open(request: TimelineVaultOpenRequest): Promise<string> {
		const sealed = this.byRef.get(request.sealedPayload);
		if (
			!sealed ||
			sealed.purpose !== request.purpose ||
			sealed.recordId !== request.recordId ||
			sealed.schemaVersion !== request.schemaVersion ||
			JSON.stringify(sealed.aad) !== JSON.stringify(request.aad)
		) {
			throw new Error("vault AAD mismatch");
		}
		return sealed.plaintext;
	}

	async deleteRecords(request: TimelineVaultDeleteRequest): Promise<void> {
		this.deletes.push(structuredClone(request));
		for (const recordId of request.recordIds) {
			const key = this.key(request.purpose, recordId);
			const existing = this.records.get(key);
			if (!existing) continue;
			this.records.delete(key);
			this.byRef.delete(existing.ref);
		}
	}

	retainedRecordIds(purpose: TimelineVaultDeleteRequest["purpose"]): string[] {
		return [...this.records.values()]
			.map((entry) => entry.request)
			.filter((request) => request.purpose === purpose)
			.map((request) => request.recordId)
			.sort();
	}

	retainedPlaintextBytes(
		purpose: TimelineVaultDeleteRequest["purpose"],
	): number {
		return [...this.records.values()]
			.map((entry) => entry.request)
			.filter((request) => request.purpose === purpose)
			.reduce(
				(total, request) =>
					total + new TextEncoder().encode(request.plaintext).length,
				0,
			);
	}

	private key(purpose: string, recordId: string): string {
		return `${purpose}:${recordId}`;
	}
}

class FailFirstConcurrentCandidateVault extends ExactMemoryVault {
	private failed = false;

	override async seal(request: TimelineVaultSealRequest): Promise<string> {
		if (
			!this.failed &&
			request.purpose === "timeline.collector.v2" &&
			(
				JSON.parse(request.plaintext) as TimelineCollectorSnapshotV2
			).materializedCursor === "same-concurrent-candidate"
		) {
			this.failed = true;
			// Keep the first preparation live long enough for the identical caller to
			// observe and wait on it. The failed owner must not retire/delete the
			// second owner's later preparation.
			await Bun.sleep(10);
			throw new Error("simulated first collector seal failure");
		}
		return super.seal(request);
	}
}

function snapshot(
	revision: number,
	updatedAtMs: number,
	marker = `cursor-${revision}`,
): TimelineCollectorSnapshotV2 {
	return {
		schemaVersion: "timeline-collector-snapshot.v2",
		collectorId: "collector.vault-gc",
		deviceId: "device-1",
		sessionId: "session-1",
		state: "ACTIVE_EMPTY",
		activeGoal: null,
		openWindow: null,
		contextCandidates: [],
		recentEventIds: Array.from(
			{ length: Math.min(256, revision + 1) },
			(_, index) => `${marker}-${index}-${"x".repeat(128)}`,
		),
		materializedCursor: marker,
		revision,
		updatedAtMs,
	};
}

function setup(nowMs = 400_000): {
	directory: string;
	path: string;
	vault: ExactMemoryVault;
	repository: SqliteTimelineV2Repository;
} {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-collector-gc-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "timeline-v2.sqlite3");
	const vault = new ExactMemoryVault();
	return {
		directory,
		path,
		vault,
		repository: new SqliteTimelineV2Repository(path, vault, () => nowMs),
	};
}

describe("Timeline v2 collector vault garbage collection", () => {
	test("retains only the current snapshot across high-frequency revisions", async () => {
		const { path, vault, repository } = setup();
		let current = snapshot(0, 400_000);
		await repository.saveCollector(current, null);
		for (let revision = 1; revision <= 128; revision += 1) {
			const next = snapshot(revision, 400_000 + revision);
			await repository.saveCollector(next, current.revision);
			current = next;
		}

		expect(vault.retainedRecordIds("timeline.collector.v2")).toHaveLength(1);
		expect(vault.retainedPlaintextBytes("timeline.collector.v2")).toBeLessThan(
			40 * 1024,
		);
		expect(
			vault.seals
				.filter((request) => request.purpose === "timeline.collector.v2")
				.reduce(
					(total, request) =>
						total + new TextEncoder().encode(request.plaintext).length,
					0,
				),
		).toBeGreaterThan(1024 * 1024);
		expect(await repository.loadCollector(current.collectorId)).toEqual(current);

		const database = new Database(path, { readonly: true });
		expect(
			(
				database
					.query("SELECT COUNT(*) AS count FROM timeline_collector_vault_gc")
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				database
					.query(
						"SELECT COUNT(*) AS count FROM timeline_collector_vault_gc_ranges",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		database.close();
		repository.close();
	});

	test("uses stable expiry for an identical retry at a later wall clock", async () => {
		let nowMs = 400_000;
		const directory = mkdtempSync(join(tmpdir(), "whalehall-collector-gc-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "timeline-v2.sqlite3");
		const vault = new ExactMemoryVault();
		const repository = new SqliteTimelineV2Repository(path, vault, () => nowMs);
		await repository.saveCollector(snapshot(0, 400_000), null);
		const candidate = snapshot(1, 400_100, "stable-retry");
		await repository.saveCollector(candidate, 0);
		nowMs = 450_000;

		await expect(repository.saveCollector(candidate, 0)).rejects.toBeInstanceOf(
			TimelineCollectorRevisionConflictError,
		);
		const attempts = vault.seals.filter((request) => {
			if (request.purpose !== "timeline.collector.v2") return false;
			const persisted = JSON.parse(
				request.plaintext,
			) as TimelineCollectorSnapshotV2;
			return persisted.materializedCursor === candidate.materializedCursor;
		});
		expect(attempts).toHaveLength(2);
		expect(attempts.map((request) => request.recordId)).toEqual([
			attempts[0]!.recordId,
			attempts[0]!.recordId,
		]);
		expect(attempts.map((request) => request.expiresAtMs)).toEqual([
			candidate.updatedAtMs + RAW_RETENTION_MS,
			candidate.updatedAtMs + RAW_RETENTION_MS,
		]);
		expect(await repository.loadCollector(candidate.collectorId)).toEqual(
			candidate,
		);
		expect(vault.retainedRecordIds("timeline.collector.v2")).toEqual([
			attempts[0]!.recordId,
		]);
		repository.close();
	});

	test("an identical concurrent retry survives when the first seal fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-collector-gc-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "timeline-v2.sqlite3");
		const vault = new FailFirstConcurrentCandidateVault();
		const repository = new SqliteTimelineV2Repository(path, vault, () => 400_000);
		await repository.saveCollector(snapshot(0, 400_000), null);
		const candidate = snapshot(
			1,
			400_100,
			"same-concurrent-candidate",
		);

		const results = await Promise.allSettled([
			repository.saveCollector(candidate, 0),
			repository.saveCollector(candidate, 0),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
			1,
		);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(
			1,
		);
		expect(await repository.loadCollector(candidate.collectorId)).toEqual(
			candidate,
		);
		expect(vault.retainedRecordIds("timeline.collector.v2")).toHaveLength(1);

		const database = new Database(path, { readonly: true });
		expect(
			(
				database
					.query("SELECT COUNT(*) AS count FROM timeline_collector_vault_gc")
					.get() as { count: number }
			).count,
		).toBe(0);
		database.close();
		repository.close();
	});

	test("does not treat another owner's live preparation lease as abandoned", async () => {
		let nowMs = 400_000;
		const directory = mkdtempSync(join(tmpdir(), "whalehall-collector-gc-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "timeline-v2.sqlite3");
		const vault = new ExactMemoryVault();
		const repository = new SqliteTimelineV2Repository(path, vault, () => nowMs);
		const active = snapshot(0, nowMs);
		await repository.saveCollector(active, null);

		const database = new Database(path, { strict: true });
		database
			.query(
				`INSERT INTO timeline_collector_vault_gc (
				 collector_id, revision, record_id, enqueued_at_ms, state,
				 owner_token, lease_expires_at_ms
				 ) VALUES (?, ?, ?, ?, 'PREPARING', ?, ?)`,
			)
			.run(
				active.collectorId,
				1,
				"live-foreign-preparation",
				nowMs,
				"another-live-owner",
				nowMs + 30_000,
			);
		database.close();

		expect(await repository.loadCollector(active.collectorId)).toEqual(active);
		const beforeExpiry = new Database(path, { readonly: true });
		expect(
			(
				beforeExpiry
					.query(
						`SELECT state FROM timeline_collector_vault_gc
						 WHERE record_id = 'live-foreign-preparation'`,
					)
					.get() as { state: string }
			).state,
		).toBe("PREPARING");
		beforeExpiry.close();

		nowMs += 30_001;
		expect(await repository.loadCollector(active.collectorId)).toEqual(active);
		const afterExpiry = new Database(path, { readonly: true });
		expect(
			(
				afterExpiry
					.query(
						`SELECT COUNT(*) AS count FROM timeline_collector_vault_gc
						 WHERE record_id = 'live-foreign-preparation'`,
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		afterExpiry.close();
		repository.close();
	});

	test("upgrades an existing schema v3 GC queue to leased deletion claims", async () => {
		const { path, vault, repository } = setup();
		const active = snapshot(0, 400_000);
		await repository.saveCollector(active, null);
		repository.close();

		const legacy = new Database(path, { strict: true });
		legacy.exec(`
			DROP INDEX timeline_collector_vault_gc_queue;
			DROP TABLE timeline_collector_vault_gc;
			CREATE TABLE timeline_collector_vault_gc (
			 record_id TEXT PRIMARY KEY,
			 collector_id TEXT NOT NULL,
			 revision INTEGER NOT NULL CHECK (revision >= 0),
			 enqueued_at_ms INTEGER NOT NULL,
			 state TEXT NOT NULL CHECK (state IN ('PREPARING', 'RETIRED')),
			 owner_token TEXT NOT NULL
			);
			CREATE INDEX timeline_collector_vault_gc_queue
			 ON timeline_collector_vault_gc(state, enqueued_at_ms, record_id);
		`);
		legacy
			.query(
				`INSERT INTO timeline_collector_vault_gc (
				 collector_id, revision, record_id, enqueued_at_ms, state, owner_token
				 ) VALUES (?, 1, 'stale-v3-preparation', ?, 'PREPARING', 'old-owner')`,
			)
			.run(active.collectorId, 399_000);
		legacy.close();

		const migrated = new SqliteTimelineV2Repository(path, vault, () => 400_100);
		expect(await migrated.loadCollector(active.collectorId)).toEqual(active);
		migrated.close();

		const verified = new Database(path, { readonly: true });
		expect(
			(
				verified.query("PRAGMA table_info(timeline_collector_vault_gc)").all() as Array<{
					name: string;
				}>
			).some((column) => column.name === "lease_expires_at_ms"),
		).toBeTrue();
		expect(
			(
				verified
					.query(
						`SELECT sql FROM sqlite_master
						 WHERE type = 'table' AND name = 'timeline_collector_vault_gc'`,
					)
					.get() as { sql: string }
			).sql,
		).toContain("'DELETING'");
		expect(
			(
				verified
					.query("SELECT COUNT(*) AS count FROM timeline_collector_vault_gc")
					.get() as { count: number }
			).count,
		).toBe(0);
		verified.close();
	});

	test("a losing concurrent candidate cannot delete the winning snapshot", async () => {
		const { vault, repository } = setup();
		await repository.saveCollector(snapshot(0, 400_000), null);
		const left = snapshot(1, 400_100, "candidate-left");
		const right = snapshot(1, 400_100, "candidate-right");
		const results = await Promise.allSettled([
			repository.saveCollector(left, 0),
			repository.saveCollector(right, 0),
		]);
		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<TimelineCollectorSnapshotV2> =>
				result.status === "fulfilled",
		);
		const rejected = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]!.reason).toBeInstanceOf(
			TimelineCollectorRevisionConflictError,
		);

		const winner = fulfilled[0]!.value;
		expect(await repository.loadCollector(winner.collectorId)).toEqual(winner);
		const winningSeal = vault.seals.find((request) => {
			if (request.purpose !== "timeline.collector.v2") return false;
			const persisted = JSON.parse(
				request.plaintext,
			) as TimelineCollectorSnapshotV2;
			return persisted.materializedCursor === winner.materializedCursor;
		});
		expect(winningSeal).toBeDefined();
		expect(vault.retainedRecordIds("timeline.collector.v2")).toEqual([
			winningSeal!.recordId,
		]);
		repository.close();
	});

	test("migrates schema v2, drains only old legacy revisions, and keeps the active one", async () => {
		const { path, vault, repository } = setup();
		let current = snapshot(0, 400_000);
		await repository.saveCollector(current, null);
		for (let revision = 1; revision <= 5; revision += 1) {
			const next = snapshot(revision, 400_000 + revision);
			await repository.saveCollector(next, current.revision);
			current = next;
		}
		const collectorSeals = vault.seals.filter(
			(request) => request.purpose === "timeline.collector.v2",
		);
		const legacyRefs = new Map<number, string>();
		for (const request of collectorSeals) {
			const persisted = JSON.parse(
				request.plaintext,
			) as TimelineCollectorSnapshotV2;
			legacyRefs.set(
				persisted.revision,
				await vault.seal({
					...request,
					recordId: `${persisted.collectorId}.r${persisted.revision}`,
				}),
			);
		}
		repository.close();

		const legacy = new Database(path, { strict: true });
		legacy
			.query(
				"UPDATE timeline_collectors SET sealed_payload = ? WHERE collector_id = ?",
			)
			.run(legacyRefs.get(current.revision)!, current.collectorId);
		legacy.exec("DROP TABLE timeline_collector_vault_gc;");
		legacy.exec("DROP TABLE timeline_collector_vault_gc_ranges;");
		legacy.exec("ALTER TABLE timeline_collectors DROP COLUMN vault_record_id;");
		legacy
			.query("UPDATE timeline_schema SET version = 2 WHERE singleton = 1")
			.run();
		legacy.close();

		const migrated = new SqliteTimelineV2Repository(path, vault, () => 400_100);
		expect(await migrated.loadCollector(current.collectorId)).toEqual(current);
		const retained = vault.retainedRecordIds("timeline.collector.v2");
		expect(retained).toContain(`${current.collectorId}.r${current.revision}`);
		for (let revision = 0; revision < current.revision; revision += 1) {
			expect(retained).not.toContain(`${current.collectorId}.r${revision}`);
		}
		migrated.close();

		const verified = new Database(path, { readonly: true });
		expect(
			(
				verified
					.query("SELECT version FROM timeline_schema WHERE singleton = 1")
					.get() as { version: number }
			).version,
		).toBe(3);
		expect(
			(
				verified.query("PRAGMA table_info(timeline_collectors)").all() as Array<{
					name: string;
				}>
			).some((column) => column.name === "vault_record_id"),
		).toBeTrue();
		expect(
			(
				verified
					.query(
						"SELECT COUNT(*) AS count FROM timeline_collector_vault_gc_ranges",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		verified.close();
	});
});
