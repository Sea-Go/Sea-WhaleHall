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
} from "../src/agent/timeline";

const RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	if (process.platform === "win32") Bun.gc(true);
	for (const directory of temporaryDirectories.splice(0)) {
		await removeTemporaryDirectory(directory);
	}
});

async function removeTemporaryDirectory(directory: string): Promise<void> {
	const maxRetries = process.platform === "win32" ? 20 : 0;
	for (let attempt = 0; ; attempt += 1) {
		try {
			rmSync(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!isWindowsBusyError(error) || attempt >= maxRetries) throw error;
			Bun.gc(true);
			await Bun.sleep(25);
		}
	}
}

function isWindowsBusyError(error: unknown): error is NodeJS.ErrnoException {
	return (
		process.platform === "win32" &&
		error instanceof Error &&
		(error as NodeJS.ErrnoException).code === "EBUSY"
	);
}

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





});
