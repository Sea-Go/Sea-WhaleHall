import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

describe("desktop model-call boundary", () => {
	test("keeps configurable model clients behind the Mastra boundary", async () => {
		const sources = await sourceFiles();
		expect(findContaining(sources, "new ActivityEventWorkerClient(")).toEqual(
			[],
		);
		expect(findContaining(sources, "createOpenAICompatible(")).toEqual([
			"src/agent/mastra-host/agents.ts",
		]);

		const bridge = sources.get("src/bun/mastra-activity-reflection.ts") ?? "";
		expect(bridge).toContain('"reflection.analyze"');
		expect(bridge).toContain("createActivityReflectionPrompt");
		expect(bridge).toContain("activityReflectionOutputToWorkerResponse");
		expect(bridge).not.toContain("fetch(");
		const protocol = sources.get("src/agent/mastra-host/protocol.ts") ?? "";
		expect(protocol).toContain("interface ActivityReflectionAnalyzeParams");
		expect(protocol).toContain("userPrompt: string");
		expect(protocol).not.toContain("ActivityEventWorkerRequest");
		const relayAuthorization =
			sources.get("src/bun/reflection-model-relay-authorization.ts") ?? "";
		expect(relayAuthorization).toContain('"/v1/activity/completions"');
		expect(relayAuthorization).not.toContain(
			"ACTIVITY_REFLECTION_SYSTEM_PROMPT",
		);
	});

	test("requires explicit local annotations for audited legacy inference", async () => {
		const sources = await sourceFiles();
		const directOllamaConstructors = findContaining(
			sources,
			"new OllamaJsonClient(",
		);
		expect(directOllamaConstructors).toEqual([
			"src/agent/timeline-v2/runtime.ts",
			"src/bun/reflection-runtime.ts",
		]);
		for (const path of directOllamaConstructors) {
			expect(sources.get(path)).toContain(
				"@whalehall-model-boundary-exception",
			);
		}
		expect(sources.get("src/agent/reflection/inference.ts")).toContain(
			"@whalehall-model-boundary-exception verified-classifier",
		);
	});

	test("routes only reflection completions through the production model origin", async () => {
		const fragment = await readFile(
			join(
				repositoryRoot,
				"deploy/home-cloud/model-relay/Caddyfile.fragment",
			),
			"utf8",
		);
		const matcher = fragment
			.split("\n")
			.find((line) => line.startsWith("@whalehall_model_relay path "));
		expect(matcher).toBe(
			"@whalehall_model_relay path /v1/activity/completions",
		);
		expect(matcher).not.toContain("/v1/auth/");
		expect(matcher).not.toContain("/v1/chat/completions");
		expect(matcher).not.toContain("/v1/agent/");
		expect(matcher).not.toContain("/api/v1/agent/");
	});
});

async function sourceFiles(): Promise<Map<string, string>> {
	const paths = await listTypeScriptFiles(join(repositoryRoot, "src"));
	const files = await Promise.all(
		paths.map(
			async (path) =>
				[relative(repositoryRoot, path), await readFile(path, "utf8")] as const,
		),
	);
	return new Map(files);
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return listTypeScriptFiles(path);
			return entry.isFile() && path.endsWith(".ts") ? [path] : [];
		}),
	);
	return nested.flat();
}

function findContaining(
	sources: ReadonlyMap<string, string>,
	token: string,
): string[] {
	return [...sources]
		.filter(([, source]) => source.includes(token))
		.map(([path]) => path)
		.sort();
}
