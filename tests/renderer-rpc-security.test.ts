import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

describe("renderer RPC capability boundary", () => {
	test("does not expose the generic local tool host or its content-bearing events", async () => {
		const [contracts, rendererRpc] = await Promise.all([
			readFile(join(repositoryRoot, "src/shared/contracts.ts"), "utf8"),
			readFile(join(repositoryRoot, "src/views/client/rpc.ts"), "utf8"),
		]);

		for (const forbiddenCapability of [
			"listLocalTools",
			"callLocalTool",
			"cancelLocalTool",
			"localToolEvent",
		]) {
			expect(contracts).not.toContain(forbiddenCapability);
			expect(rendererRpc).not.toContain(forbiddenCapability);
		}
	});

	test("production view templates allow only the encrypted Electrobun localhost socket", async () => {
		const templates = await Promise.all(
			[
				"src/views/client/index.html",
				"src/views/pet/index.html",
				"src/views/pet/demo.html",
			].map((path) => readFile(join(repositoryRoot, path), "utf8")),
		);
		for (const template of templates) {
			expect(template).not.toContain("http://127.0.0.1:5173");
			expect(template).not.toContain("ws://127.0.0.1:5173");
			expect(template).not.toContain("http://localhost:");
			expect(template).toContain("ws://localhost:*");
			expect(template).toContain("__WHALEHALL_DEV_CONNECT__");
		}
	});
});
