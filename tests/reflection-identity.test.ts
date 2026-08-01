import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateReflectionIdentity } from "../src/agent/reflection/identity";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("loadOrCreateReflectionIdentity", () => {
	test("persists stable non-secret ids with owner-only permissions", () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-identity-"));
		directories.push(directory);
		const path = join(directory, "nested", "identity.json");
		const first = loadOrCreateReflectionIdentity(path);
		const second = loadOrCreateReflectionIdentity(path);
		expect(second).toEqual(first);
		expect(first.collectorId).toStartWith("collector_");
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject(first);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	test("rejects a corrupt identity instead of silently changing window identity", () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-identity-"));
		directories.push(directory);
		const path = join(directory, "identity.json");
		writeFileSync(path, "{}");
		expect(() => loadOrCreateReflectionIdentity(path)).toThrow("Invalid WhaleHall");
	});
});
