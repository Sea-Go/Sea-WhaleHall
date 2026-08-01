import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];
const workerPath = resolve(import.meta.dir, "fixtures/installation-id-worker.ts");

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) =>
			rm(path, { recursive: true, force: true }),
		),
	);
});

describe("loadOrCreateInstallationId", () => {
	test("publishes one complete ID across concurrent processes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "whalehall-installation-id-"));
		temporaryDirectories.push(directory);

		const children = Array.from({ length: 24 }, () =>
			Bun.spawn({
				cmd: [process.execPath, workerPath, directory],
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const results = await Promise.all(
			children.map(async (child) => {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				return { stdout, stderr, exitCode };
			}),
		);

		for (const result of results) {
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
		}
		const ids = results.map((result) => result.stdout.trim());
		expect(new Set(ids).size).toBe(1);
		const first = ids[0];
		if (!first) throw new Error("No installation ID was returned.");
		expect(first).toMatch(
			/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
		);
		expect((await readFile(join(directory, "installation-id"), "utf8")).trim()).toBe(
			first,
		);
	});
});
