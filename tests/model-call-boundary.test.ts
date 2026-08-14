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
		const relayTransport =
			sources.get("src/bun/model-relay-transport.ts") ?? "";
		expect(relayTransport).toContain('"/v1/chat/completions"');
		expect(relayTransport).toContain('"agent" | "activity"');
		expect(relayTransport).not.toContain('"/v1/activity/completions"');
		expect(relayTransport).not.toContain("ACTIVITY_REFLECTION_SYSTEM_PROMPT");
	});

	test("requires explicit local annotations for audited legacy inference", async () => {
		const sources = await sourceFiles();
		const directOllamaConstructors = findContaining(
			sources,
			"new OllamaJsonClient(",
		);
		expect(directOllamaConstructors).toEqual([
			"src/agent/timeline-v2/runtime.ts",
			"src/bun/planning-runtime.ts",
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

		const planningRuntime = sources.get("src/bun/planning-runtime.ts") ?? "";
		const verifiedPlanningModel = planningRuntime.slice(
			planningRuntime.indexOf("class VerifiedQwenPlanningModel"),
		);
		expect(verifiedPlanningModel).toContain(
			"@whalehall-model-boundary-exception planning-local-model-lock",
		);
		const lockVerification = verifiedPlanningModel.indexOf(
			"await verifyOllamaModelLock(WHALEHALL_TEACHER_MODEL_LOCK)",
		);
		const clientConstruction = verifiedPlanningModel.indexOf(
			"new OllamaJsonClient(",
		);
		expect(lockVerification).toBeGreaterThanOrEqual(0);
		expect(clientConstruction).toBeGreaterThan(lockVerification);
	});

	test("keeps the legacy model origin isolated from the authenticated desktop path", async () => {
		const fragment = await readFile(
			join(repositoryRoot, "deploy/home-cloud/model-relay/Caddyfile.fragment"),
			"utf8",
		);
		expect(fragment).toMatch(
			/@whalehall_retired_activity_completion \{\s+path \/v1\/activity\/completions\s+\}/,
		);
		expect(fragment).toContain(
			"respond @whalehall_retired_activity_completion 410",
		);
		expect(fragment).not.toContain("reverse_proxy 127.0.0.1:8787");
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

	test("keeps the retired activity path out of desktop release inputs", async () => {
		const sources = await sourceFiles();
		for (const path of [
			"config.template.yaml",
			"electrobun.config.ts",
			"scripts/pre-build.ts",
			"scripts/build-agent-host.ts",
		]) {
			sources.set(path, await readFile(join(repositoryRoot, path), "utf8"));
		}
		expect(findContaining(sources, "/v1/activity/completions")).toEqual([]);
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
