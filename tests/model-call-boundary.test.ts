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

		const activityBridge =
			sources.get("src/bun/mastra-activity-reflection.ts") ?? "";
		expect(activityBridge).toContain('"reflection.analyze"');
		expect(activityBridge).not.toContain("fetch(");
		const planningBridge =
			sources.get("src/bun/mastra-planning-model.ts") ?? "";
		expect(planningBridge).toContain('"planning.analyze"');
		expect(planningBridge).toContain("assertPlanningModelOutputForRequest");
		expect(planningBridge).not.toContain("fetch(");

		const protocol = sources.get("src/agent/mastra-host/protocol.ts") ?? "";
		expect(protocol).toContain("interface PlanningAnalyzeParams");
		expect(protocol).toContain('"planning.analyze"');
		const agents = sources.get("src/agent/mastra-host/agents.ts") ?? "";
		expect(agents).toContain('id: "whalehall-planning-analysis"');
		expect(agents).not.toMatch(/agents:\s*\{[^}]*planningAnalysis/s);
	});

	test("uses an independent code-owned Planning audit purpose", async () => {
		const sources = await sourceFiles();
		const relayTransport =
			sources.get("src/bun/model-relay-transport.ts") ?? "";
		expect(relayTransport).toContain('"agent" | "activity" | "planning"');
		expect(relayTransport).toContain('"/v1/chat/completions"');
		expect(relayTransport).not.toContain('"/v1/activity/completions"');

		const main = sources.get("src/bun/index.ts") ?? "";
		expect(main).toContain('purpose: "planning"');
		expect(main).toContain("planningRelayBridge.open");
		expect(main).toContain("hasPendingInvocation(ownerRunId)");
		expect(
			main.match(/dynamicPlanningModel\?\.cancelPending\(\)/gu),
		).toHaveLength(2);
		const auth = sources.get("src/bun/remote-auth-session.ts") ?? "";
		expect(auth).toContain('purpose !== "planning"');
		expect(auth).toContain('headers.set("x-whalehall-model-purpose", purpose)');
	});

	test("has no desktop local-model client, lock, probe, or loopback dependency", async () => {
		const sources = await sourceFiles();
		for (const token of [
			"OllamaJsonClient",
			"ollama-json-client",
			"verifyOllamaModelLock",
			"ollama-model-lock",
			"WHALEHALL_TEACHER_MODEL_LOCK",
			"ModernBertHttpClient",
			"ModernBertEpisodeClassifier",
			"timeline-modernbert-config",
			"127.0.0.1:11434",
			"127.0.0.1:8765",
		]) {
			expect(findContaining(sources, token), token).toEqual([]);
		}

		const timeline = sources.get("src/agent/timeline-v2/runtime.ts") ?? "";
		expect(timeline).toContain("new HeuristicTimelineEpisodeClassifier()");
		expect(timeline).toContain(
			"new DeterministicTimelineHypothesisGenerator()",
		);
		const reflection = sources.get("src/bun/reflection-runtime.ts") ?? "";
		expect(reflection).toContain("new DeterministicReflectionInference()");
	});

	test("keeps the retired activity path isolated from desktop release inputs", async () => {
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

	test("keeps bearer as the sole desktop model credential", async () => {
		const sources = await productionSourceFiles();
		expect(
			findContaining(sources, "data-staging.sea-ridethewindbreakthewaves.xyz"),
		).toEqual([]);
		const forbiddenSendPatterns = [
			/headers\.(?:set|append)\(\s*["']x-whalehall-agent-key["']/iu,
			/["']x-whalehall-agent-key["']\s*:/iu,
			/\bagentKey\s*:/u,
			/\brequireAgentKey\b/u,
			/\bauthenticateAgentKey\b/u,
			/\bpersonalRelayKey\b/u,
		];
		for (const [path, source] of sources) {
			for (const pattern of forbiddenSendPatterns) {
				expect(
					source,
					`${path} must not restore retired key authentication`,
				).not.toMatch(pattern);
			}
		}

		const remoteAuth = sources.get("src/bun/remote-auth-session.ts") ?? "";
		expect(remoteAuth).toContain('headers.delete("x-whalehall-agent-key")');
		const provisioner = sources.get("scripts/provision-relay-owner.ts") ?? "";
		expect(provisioner).not.toContain("agentKeyHash");
		expect(provisioner).not.toContain("randomBytes");

		for (const path of ["config.template.yaml", "config.example.yaml"]) {
			const configuration = await readFile(join(repositoryRoot, path), "utf8");
			expect(configuration).not.toMatch(/^\s*(?:apikey|baseurl):/imu);
		}
	});
});

async function sourceFiles(): Promise<Map<string, string>> {
	const paths = await listSourceFiles(join(repositoryRoot, "src"));
	const files = await Promise.all(
		paths.map(
			async (path) =>
				[relative(repositoryRoot, path), await readFile(path, "utf8")] as const,
		),
	);
	return new Map(files);
}

async function productionSourceFiles(): Promise<Map<string, string>> {
	const paths = (
		await Promise.all(
			["src", "services", "scripts"].map((path) =>
				listProductionSourceFiles(join(repositoryRoot, path)),
			),
		)
	).flat();
	const files = await Promise.all(
		paths.map(
			async (path) =>
				[relative(repositoryRoot, path), await readFile(path, "utf8")] as const,
		),
	);
	return new Map(files);
}

async function listSourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return listSourceFiles(path);
			return entry.isFile() && /\.(?:ts|tsx)$/u.test(path) ? [path] : [];
		}),
	);
	return nested.flat();
}

async function listProductionSourceFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return listProductionSourceFiles(path);
			return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/u.test(path) ? [path] : [];
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
