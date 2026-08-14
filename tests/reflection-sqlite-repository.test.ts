import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SqliteReflectionRepository } from "../src/agent/reflection/sqlite-repository";
import {
	COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
	EVENT_WINDOW_SCHEMA_VERSION,
	type EventWindowV1,
	REFLECTION_SCHEMA_VERSION,
	type ReflectionCollectorSnapshotV1,
	type ReflectionV1,
} from "../src/agent/reflection/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("SqliteReflectionRepository", () => {
	test("atomically seals a window and recovers it after reopening", async () => {
		const { path, repository } = createRepository();
		const initial = collectorSnapshot(0, null);
		await repository.saveCollector(initial, null);
		const window = eventWindow();
		const next = collectorSnapshot(1, "cursor-1");
		const sealed = await repository.sealWindow(window, next, 0, null);
		expect(sealed.inserted).toBe(true);
		expect(await repository.getQueueStats()).toEqual({
			pendingJobs: 1,
			pendingEvents: 1,
		});
		repository.close();

		const reopened = new SqliteReflectionRepository(path);
		expect(await reopened.loadCollector("collector-1")).toEqual(next);
		expect(await reopened.getWindow(window.windowId)).toEqual(window);
		expect((await reopened.getJob(window.windowId))?.state).toBe("READY");
		reopened.close();
	});

	test("persists cloud account attribution with the sealed window", async () => {
		const { path, repository } = createRepository();
		await repository.saveCollector(collectorSnapshot(0, null), null);
		const accountA = eventWindow("window-account-a", "cursor-a", 1_100);
		await repository.sealWindow(
			accountA,
			collectorSnapshot(1, "cursor-a"),
			0,
			"account-a",
		);
		const unowned = eventWindow("window-unowned", "cursor-b", 1_200);
		await repository.sealWindow(
			unowned,
			collectorSnapshot(2, "cursor-b"),
			1,
			null,
		);
		repository.close();

		const reopened = new SqliteReflectionRepository(path);
		expect(await reopened.listWindowsForAccount("account-a")).toEqual([
			accountA,
		]);
		expect(await reopened.listWindowsForAccount("account-b")).toEqual([]);
		expect(
			await reopened.acknowledgeWindowForAccount(
				"account-b",
				accountA.windowId,
			),
		).toBe(false);
		expect(
			await reopened.acknowledgeWindowForAccount(
				"account-a",
				accountA.windowId,
			),
		).toBe(true);
		expect(
			await reopened.acknowledgeWindowForAccount(
				"account-a",
				accountA.windowId,
			),
		).toBe(true);
		expect(await reopened.listWindowsForAccount("account-a")).toEqual([]);
		reopened.close();
	});

	test("clears only the requested account cloud handoffs", async () => {
		const { repository } = createRepository();
		await repository.saveCollector(collectorSnapshot(0, null), null);
		const accountA = eventWindow("window-account-a", "cursor-a", 1_100);
		await repository.sealWindow(
			accountA,
			collectorSnapshot(1, "cursor-a"),
			0,
			"account-a",
		);
		const accountB = eventWindow("window-account-b", "cursor-b", 1_200);
		await repository.sealWindow(
			accountB,
			collectorSnapshot(2, "cursor-b"),
			1,
			"account-b",
		);

		expect(await repository.clearWindowsForAccount("account-a")).toBe(1);
		expect(await repository.listWindowsForAccount("account-a")).toEqual([]);
		expect(await repository.listWindowsForAccount("account-b")).toEqual([
			accountB,
		]);
		repository.close();
	});

	test("journals one reflection per deterministic window and resumes commit", async () => {
		const { repository } = createRepository();
		await repository.saveCollector(collectorSnapshot(0, null), null);
		const window = eventWindow();
		await repository.sealWindow(
			window,
			collectorSnapshot(1, "cursor-1"),
			0,
			null,
		);
		expect((await repository.claimNextRunnable(1_100, 30_000))?.state).toBe(
			"RUNNING",
		);

		const reflection = reflectionFor(window);
		expect(
			(await repository.persistResult(window.windowId, reflection, 1_200))
				.state,
		).toBe("RESULT_PERSISTED");
		expect((await repository.claimNextRunnable(1_201, 30_000))?.state).toBe(
			"COMMITTING",
		);
		expect((await repository.markCommitted(window.windowId, 1_202)).state).toBe(
			"COMMITTED",
		);
		expect(await repository.listReflections()).toEqual([
			{ windowId: window.windowId, persistedAtMs: 1_200, reflection },
		]);
		expect(await repository.getQueueStats()).toEqual({
			pendingJobs: 0,
			pendingEvents: 0,
		});
		await expect(
			repository.persistResult(
				window.windowId,
				{ ...reflection, confidence: 0.1 },
				1_300,
			),
		).rejects.toThrow("different reflection");
		repository.close();
	});

	test("reclaims expired inference leases without duplicating a job", async () => {
		const { repository } = createRepository();
		await repository.saveCollector(collectorSnapshot(0, null), null);
		const window = eventWindow();
		await repository.sealWindow(
			window,
			collectorSnapshot(1, "cursor-1"),
			0,
			null,
		);
		expect((await repository.claimNextRunnable(1_100, 100))?.attempt).toBe(1);
		expect(await repository.claimNextRunnable(1_199, 100)).toBeNull();
		const reclaimed = await repository.claimNextRunnable(1_200, 100);
		expect(reclaimed).toMatchObject({ state: "RUNNING", attempt: 2 });
		repository.close();
	});

	test("abandons a claim without consuming its attempt or failure budget", async () => {
		const { repository } = createRepository();
		await repository.saveCollector(collectorSnapshot(0, null), null);
		const window = eventWindow();
		await repository.sealWindow(
			window,
			collectorSnapshot(1, "cursor-1"),
			0,
			null,
		);
		expect(await repository.claimNextRunnable(1_100, 30_000)).toMatchObject({
			state: "RUNNING",
			attempt: 1,
			firstAttemptAtMs: 1_100,
		});

		expect(await repository.abandonClaim(window.windowId, 1_101)).toMatchObject(
			{
				state: "READY",
				attempt: 0,
				firstAttemptAtMs: null,
				lastFailure: null,
				leaseExpiresAtMs: null,
			},
		);
		expect(await repository.claimNextRunnable(1_101, 30_000)).toMatchObject({
			state: "RUNNING",
			attempt: 1,
			firstAttemptAtMs: 1_101,
		});
		const reflection = reflectionFor(window);
		await repository.persistResult(window.windowId, reflection, 1_102);
		await repository.beginCommit(window.windowId, 1_103, 30_000);
		expect(await repository.abandonClaim(window.windowId, 1_104)).toMatchObject({
			state: "RESULT_PERSISTED",
			attempt: 0,
			firstAttemptAtMs: null,
			reflection,
			leaseExpiresAtMs: null,
		});
		expect(await repository.claimNextRunnable(1_104, 30_000)).toMatchObject({
			state: "COMMITTING",
			attempt: 1,
			reflection,
		});
		repository.close();
	});

	test("persists reminder deduplication receipts across restarts", async () => {
		const { path, repository } = createRepository();
		await repository.saveCollector(collectorSnapshot(0, null), null);
		const firstWindow = eventWindow();
		await repository.sealWindow(
			firstWindow,
			collectorSnapshot(1, "cursor-1"),
			0,
			null,
		);
		await repository.claimNextRunnable(1_100, 30_000);
		const firstReflection = {
			...reflectionFor(firstWindow),
			feedbackCode: "encourage" as const,
		};
		await repository.persistResult(
			firstWindow.windowId,
			firstReflection,
			1_200,
		);
		expect(
			await repository.claimReminder(firstReflection, 1_200, 600_000),
		).toMatchObject({ windowId: firstWindow.windowId, notifiedAtMs: 1_200 });
		expect(
			await repository.claimReminder(firstReflection, 1_201, 600_000),
		).toBeNull();
		await repository.claimNextRunnable(1_202, 30_000);
		await repository.markCommitted(firstWindow.windowId, 1_203);

		const secondWindow = eventWindow("window-2", "cursor-2", 1_300);
		await repository.sealWindow(
			secondWindow,
			collectorSnapshot(2, "cursor-2"),
			1,
			null,
		);
		await repository.claimNextRunnable(1_300, 30_000);
		const secondReflection = {
			...reflectionFor(secondWindow),
			feedbackCode: "encourage" as const,
		};
		await repository.persistResult(
			secondWindow.windowId,
			secondReflection,
			1_301,
		);
		expect(
			await repository.claimReminder(secondReflection, 601_199, 600_000),
		).toBeNull();
		repository.close();

		const reopened = new SqliteReflectionRepository(path);
		expect(
			await reopened.claimReminder(secondReflection, 601_200, 600_000),
		).toMatchObject({ windowId: secondWindow.windowId, notifiedAtMs: 601_200 });
		reopened.close();
	});

	test("rejects stale collector writes", async () => {
		const { repository } = createRepository();
		await repository.saveCollector(collectorSnapshot(0, null), null);
		await expect(
			repository.saveCollector(collectorSnapshot(1, "cursor-1"), null),
		).rejects.toThrow("changed concurrently");
		repository.close();
	});

	test("upgrades the v1 journal schema without discarding state", () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-reflection-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "reflection.sqlite3");
		const legacy = new Database(path, { create: true });
		legacy.exec(`
			CREATE TABLE reflection_schema (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO reflection_schema(singleton, version) VALUES (1, 1);
		`);
		legacy.close();

		const repository = new SqliteReflectionRepository(path);
		repository.close();
		const verified = new Database(path);
		expect(
			verified
				.query("SELECT version FROM reflection_schema WHERE singleton = 1")
				.get(),
		).toEqual({ version: 3 });
		expect(
			verified
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reflection_notifications'",
				)
				.get(),
		).toEqual({ name: "reflection_notifications" });
		verified.close();
	});

	test("reenters a partial v0 initialization in one immediate migration", () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-reflection-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "reflection.sqlite3");
		const partial = new Database(path, { create: true });
		partial.exec(`
			CREATE TABLE reflection_schema (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO reflection_schema(singleton, version) VALUES (1, 0);
			CREATE TABLE reflection_collectors (
				collector_id TEXT PRIMARY KEY,
				revision INTEGER NOT NULL CHECK (revision >= 0),
				snapshot_json TEXT NOT NULL,
				updated_at_ms INTEGER NOT NULL
			);
		`);
		partial.close();

		const repository = new SqliteReflectionRepository(path);
		repository.close();
		const verified = new Database(path);
		expect(
			verified
				.query("SELECT version FROM reflection_schema WHERE singleton = 1")
				.get(),
		).toEqual({ version: 3 });
		expect(
			verified
				.query(
					"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('reflection_collectors', 'reflection_windows', 'reflection_jobs', 'reflection_journal', 'reflection_notifications')",
				)
				.get(),
		).toEqual({ count: 5 });
		verified.close();
	});

	test("keeps reflection content and SQLite sidecars private on POSIX", async () => {
		if (process.platform === "win32") return;
		const { path, repository } = createRepository();
		await repository.saveCollector(collectorSnapshot(0, null), null);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
		for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
			expect(existsSync(sidecar)).toBe(true);
			expect(statSync(sidecar).mode & 0o777).toBe(0o600);
		}
		repository.close();
	});
});

function createRepository(): {
	path: string;
	repository: SqliteReflectionRepository;
} {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-reflection-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "reflection.sqlite3");
	return { path, repository: new SqliteReflectionRepository(path) };
}

function collectorSnapshot(
	revision: number,
	materializedCursor: string | null,
): ReflectionCollectorSnapshotV1 {
	return {
		schemaVersion: COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
		state: "ACTIVE_EMPTY",
		activeGoal: null,
		goalRevision: 0,
		cloudOwnerEpoch: { epoch: 0, accountId: null },
		openWindow: null,
		contextCandidates: [],
		recentEventIds: [],
		revokedPermissions: [],
		materializedCursor,
		revision,
		updatedAtMs: 1_000 + revision,
	};
}

function eventWindow(
	windowId = "window-1",
	cursor = "cursor-1",
	endedAtMs = 1_100,
): EventWindowV1 {
	return {
		schemaVersion: EVENT_WINDOW_SCHEMA_VERSION,
		windowId,
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
		triggerReason: "event_count",
		goal: null,
		goalVersion: null,
		startedAtMs: 1_000,
		endedAtMs,
		deadlineAtMs: 301_000,
		eventCount: 1,
		firstCursor: cursor,
		lastCursor: cursor,
		events: [],
		contextOnly: [],
		modelInput: "input",
		inputHash: `hash-${windowId}`,
	};
}

function reflectionFor(window: EventWindowV1): ReflectionV1 {
	return {
		schemaVersion: REFLECTION_SCHEMA_VERSION,
		windowId: window.windowId,
		triggerReason: window.triggerReason,
		eventCount: window.eventCount,
		durationMs: window.endedAtMs - window.startedAtMs,
		goalVersion: null,
		activity: {
			label: "development",
			probabilities: {
				development: 0.89,
				writing: 0.01,
				research: 0.01,
				communication: 0.01,
				planning: 0.01,
				data_work: 0.01,
				media: 0.01,
				gaming: 0.01,
				system_file_ops: 0.01,
				commerce: 0.01,
				idle_transition: 0.01,
				other_unknown: 0.01,
			},
		},
		goalRelevance: null,
		embedding: [1, 0],
		confidence: 0.93,
		entropy: 0.12,
		abstain: false,
		evidenceEventIds: [],
		feedbackCode: "silent",
		modelVersion: "test",
		taxonomyVersion: "activity.v1",
	};
}
