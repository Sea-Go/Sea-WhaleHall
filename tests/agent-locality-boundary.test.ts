import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function source(path: string): string {
	return readFileSync(join(repositoryRoot, path), "utf8");
}

describe("local Agent production boundary", () => {
	test("keeps raw activity prompt/output policy on the desktop and internal Agent jobs normalized", () => {
		const bunComposition = source("src/bun/index.ts");
		const clientConfiguration = source("src/bun/client-config.ts");
		const activityPrompt = source("src/agent/activity-reflection-prompt.ts");
		const dispatcher = source("src/bun/activity-analysis-dispatcher.ts");
		const activityAgent = source("src/agent/mastra-host/agents.ts");
		const activityRuntime = source("src/agent/mastra-host/runtime.ts");

		expect(bunComposition).toContain("ActivityWindowDeliveryService");
		expect(clientConfiguration).toContain("REFLECTION_RELAY_COMPLETIONS_PATH");
		expect(clientConfiguration).not.toContain("/v1/activity/analyze");
		expect(activityPrompt).toContain("ACTIVITY_REFLECTION_SYSTEM_PROMPT");
		expect(activityPrompt).toContain("RAW_EVENT_JSON");
		expect(
			existsSync(join(repositoryRoot, "src/agent/activity-event-worker.ts")),
		).toBeTrue();
		expect(
			existsSync(join(repositoryRoot, "src/agent/activity-window-worker.ts")),
		).toBeTrue();
		expect(dispatcher).not.toContain("raw_event");
		expect(dispatcher).not.toContain("EventWindowV1");
		expect(activityAgent).toContain("tools: {}");
		expect(activityAgent).toContain(
			"skills: activityReflectionNativeSkillPaths",
		);
		expect(activityAgent).toContain("activityReflectionSkillCatalog");
		expect(activityRuntime).toContain(
			"loadActivityReflectionNativeSkillContext",
		);
		expect(activityRuntime).toContain('toolChoice: "none"');
		expect(activityAgent).toContain("绝不请求、推断或复述原始活动窗口");
	});

	test("keeps the remote service surface limited to identity and opaque model relay", () => {
		const relayServer = source("services/model-relay/server.ts");
		const routes = [
			...relayServer.matchAll(/url\.pathname === "(\/v1\/[^"]+)"/gu),
		].map((match) => match[1]);

		expect(routes).toEqual([
			"/v1/auth/sessions",
			"/v1/auth/sessions/refresh",
			"/v1/auth/sessions/current",
			"/v1/auth/me",
			"/v1/activity/completions",
			"/v1/chat/completions",
		]);
		expect(relayServer).not.toContain("ACTIVITY_REFLECTION_SYSTEM_PROMPT");
		expect(relayServer).not.toContain("RAW_EVENT_JSON");
		expect(relayServer).not.toContain(
			"activityReflectionOutputToWorkerResponse",
		);
	});
});
