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
			join(repositoryRoot, "deploy/home-cloud/model-relay/Caddyfile.fragment"),
			"utf8",
		);
		expect(fragment).toMatch(
			/@whalehall_model_relay \{\s+method POST\s+path \/v1\/activity\/completions\s+\}/,
		);
		expect(fragment).toMatch(
			/@whalehall_model_relay_invalid_method \{\s+not method POST\s+path \/v1\/activity\/completions\s+\}/,
		);
		expect(fragment).toContain(
			"respond @whalehall_model_relay_invalid_method 405",
		);
		const dataCenterDenyMatcher = fragment.match(
			/@whalehall_datacenter_paths \{([\s\S]*?)\n\}/,
		)?.[1];
		expect(dataCenterDenyMatcher).toBeDefined();
		for (const path of [
			"/v1/auth/*",
			"/v1/chat/*",
			"/v1/agent/*",
			"/v1/devices/*",
			"/api/v1/agent/*",
		]) {
			expect(dataCenterDenyMatcher).toContain(path);
		}
		expect(fragment).toContain("respond @whalehall_datacenter_paths 404");
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
