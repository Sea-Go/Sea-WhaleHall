import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "../src/agent/agent-runtime";
import {
	createTimelineV2Runtime,
	type TimelineV2Runtime,
} from "../src/agent/timeline-v2";

const directories: string[] = [];
const runtimes: TimelineV2Runtime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0))
		await runtime.close().catch(() => {});
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function dataDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-timeline-runtime-"));
	directories.push(directory);
	return directory;
}

async function runtime(): Promise<TimelineV2Runtime> {
	const created = await createTimelineV2Runtime({
		agent: {} as AgentRuntime,
		dataDirectory: dataDirectory(),
	});
	runtimes.push(created);
	return created;
}

describe("Timeline v2 deterministic production runtime", () => {
	test("reports a fixed zero-model status and refreshes without probing", async () => {
		const created = await runtime();

		expect(created.episodeClassifier).toEqual({
			configured: false,
			artifactVerified: false,
			activeClassifier: "deterministic-cold-start",
			modelVersion: "deterministic-cold-start.v2",
			code: "disabled",
		});
		expect(created.modelLockVerified).toBeFalse();
		expect(created.teacherVerified).toBeFalse();
		expect(created.inferenceReady).toBeFalse();
		expect(created.diagnostics).toEqual([]);
		await expect(created.refreshEpisodeClassifier()).resolves.toEqual(
			created.episodeClassifier,
		);
	});

	test("does not close its repository before blocked service shutdown settles", async () => {
		const created = await runtime();
		let releaseStop = (): void => {
			throw new Error("stop gate was not initialized");
		};
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		created.service.stop = () => stopGate;
		const originalClose = created.repository.close.bind(created.repository);
		let repositoryCloseCount = 0;
		created.repository.close = () => {
			repositoryCloseCount += 1;
			originalClose();
		};

		const closing = created.close();
		expect(created.close()).toBe(closing);
		await Promise.resolve();
		expect(repositoryCloseCount).toBe(0);
		releaseStop();
		await closing;
		expect(repositoryCloseCount).toBe(1);
	});

	test("closes its repository when asynchronous service shutdown rejects", async () => {
		const created = await runtime();
		const failure = new Error("synthetic Timeline stop failure");
		created.service.stop = () => Promise.reject(failure);
		const originalClose = created.repository.close.bind(created.repository);
		let repositoryCloseCount = 0;
		created.repository.close = () => {
			repositoryCloseCount += 1;
			originalClose();
		};

		await expect(created.close()).rejects.toBe(failure);
		expect(repositoryCloseCount).toBe(1);
	});

	test("closes its repository when synchronous shutdown sealing throws", async () => {
		const created = await runtime();
		const failure = new Error("synthetic Timeline shutdown failure");
		created.service.beginShutdown = () => {
			throw failure;
		};
		const originalClose = created.repository.close.bind(created.repository);
		let repositoryCloseCount = 0;
		created.repository.close = () => {
			repositoryCloseCount += 1;
			originalClose();
		};

		await expect(created.close()).rejects.toBe(failure);
		expect(repositoryCloseCount).toBe(1);
	});
});
