import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NODE_RUNTIME_MANIFEST,
	NODE_RUNTIME_VERSION,
	downloadNodeArchive,
	nodeRuntimeTarget,
	repositoryTargetName,
} from "../scripts/node-runtime-manifest";

describe("pinned Node runtime manifest", () => {
	test("pins official Node 22.18.0 archives for every supported target", () => {
		expect(Object.keys(NODE_RUNTIME_MANIFEST).sort()).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"win-arm64",
			"win-x64",
		]);
		for (const release of Object.values(NODE_RUNTIME_MANIFEST)) {
			expect(release.version).toBe("22.18.0");
			expect(new URL(release.url).origin).toBe("https://nodejs.org");
			expect(release.url).toContain(`/dist/v${NODE_RUNTIME_VERSION}/`);
			expect(release.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(nodeRuntimeTarget("macos", "arm64")).toBe("darwin-arm64");
		expect(repositoryTargetName("darwin-x64")).toBe("macos-x64");
	});

	test("fails closed when a cached archive does not match the pinned digest", async () => {
		const temporaryDirectory = await mkdtemp(
			join(tmpdir(), "whalehall-node-runtime-test-"),
		);
		const archivePath = join(
			temporaryDirectory,
			NODE_RUNTIME_MANIFEST["win-x64"].filename,
		);
		let fetched = false;
		try {
			await Bun.write(archivePath, "tampered archive");
			await expect(
				downloadNodeArchive(
					NODE_RUNTIME_MANIFEST["win-x64"],
					archivePath,
					{
						fetchImpl: (async () => {
							fetched = true;
							return new Response("unexpected");
						}) as unknown as typeof fetch,
					},
				),
			).rejects.toThrow("checksum mismatch");
			expect(fetched).toBe(false);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
