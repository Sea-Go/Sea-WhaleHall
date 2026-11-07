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
