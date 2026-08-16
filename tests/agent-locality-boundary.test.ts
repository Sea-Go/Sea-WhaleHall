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
		expect(clientConfiguration).toContain(
			"WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL",
		);
		expect(clientConfiguration).toContain(
			'"https://data.sea-ridethewindbreakthewaves.xyz"',
		);
		expect(clientConfiguration).not.toContain("data-staging");
		expect(bunComposition).toContain(
			"baseUrl: WHALEHALL_DATA_CENTER_PRODUCTION_BASE_URL",
		);
		expect(bunComposition).not.toContain("configuration.agent.baseurl");
		expect(clientConfiguration).not.toContain("/v1/activity/analyze");
		expect(activityPrompt).toContain("ACTIVITY_REFLECTION_SYSTEM_PROMPT");
		expect(activityPrompt).toContain("COMPRESSED_ACTIVITY_EVENTS_JSON");
		expect(activityPrompt).toContain("time、tools、message");
		expect(activityPrompt).not.toContain("RAW_EVENT_JSON");
		expect(
			existsSync(join(repositoryRoot, "src/agent/activity-event-worker.ts")),
		).toBeTrue();
		expect(
			existsSync(join(repositoryRoot, "src/agent/activity-window-worker.ts")),
		).toBeTrue();
		expect(dispatcher).not.toContain("raw_event");
		expect(dispatcher).not.toContain("EventWindowV1");
		expect(activityAgent).not.toContain('id: "whalehall-activity-analysis"');
		expect(activityAgent).toContain('id: "whalehall-conversation"');
		expect(activityAgent).toContain(
			"skills: activityReflectionNativeSkillPaths",
		);
		expect(activityAgent).toContain("activityReflectionSkillCatalog");
		expect(activityRuntime).toContain(
			"loadActivityReflectionNativeSkillContext",
		);
		expect(activityRuntime).toContain('toolChoice: "none"');
		expect(activityRuntime).toContain("不得要求、猜测或复述原始桌面内容");
		expect(activityRuntime).toContain("agents.conversation.stream(");
		expect(activityRuntime).not.toContain("agents.activity.stream(");
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
			"/v1/chat/completions",
		]);
		expect(relayServer).not.toContain("ACTIVITY_REFLECTION_SYSTEM_PROMPT");
		expect(relayServer).not.toContain("COMPRESSED_ACTIVITY_EVENTS_JSON");
		expect(relayServer).not.toContain(
			"activityReflectionOutputToWorkerResponse",
		);
	});

	test("registers every client RPC as a concrete guarded BrowserView handler", () => {
		const bunComposition = source("src/bun/index.ts");

		expect(bunComposition).toContain(
			"const guardedClientRequestHandlers = Object.fromEntries(",
		);
		expect(bunComposition).toContain("Object.keys(clientRequestHandlers)");
		expect(bunComposition).toContain("dispatchClientRequest(method, input)");
		expect(bunComposition).toContain("requests: guardedClientRequestHandlers");
		expect(bunComposition).not.toContain(
			"requests: (method, input) => dispatchClientRequest(method, input)",
		);
	});

	test("quiesces activity reflection before stopping its Sidecar process owner", () => {
		const bunComposition = source("src/bun/index.ts");
		const shutdownStart = bunComposition.indexOf(
			"function shutdown(): Promise<void>",
		);
		const nativeStartupLatch = bunComposition.indexOf(
			"agent.beginShutdown();",
			shutdownStart,
		);
		const deferredReflectionLatch = bunComposition.indexOf(
			"deferredReflectionOperations.close();",
			shutdownStart,
		);
		const shutdownSteps = bunComposition.indexOf(
			"const steps = [",
			shutdownStart,
		);
		const activityStep = bunComposition.indexOf(
			'name: "activity-window-delivery"',
			shutdownSteps,
		);
		const sidecarStep = bunComposition.indexOf(
			'name: "sensor-sidecar"',
			shutdownSteps,
		);
		const localToolStep = bunComposition.indexOf(
			'name: "local-tool-host"',
			shutdownSteps,
		);
		const nonCriticalTail = bunComposition.indexOf(
			'name: "audit-capture"',
			shutdownSteps,
		);

		expect(shutdownStart).toBeGreaterThanOrEqual(0);
		expect(nativeStartupLatch).toBeGreaterThan(shutdownStart);
		expect(deferredReflectionLatch).toBeGreaterThan(shutdownStart);
		expect(deferredReflectionLatch).toBeLessThan(nativeStartupLatch);
		expect(shutdownSteps).toBeGreaterThan(nativeStartupLatch);
		expect(activityStep).toBeGreaterThanOrEqual(0);
		expect(sidecarStep).toBeGreaterThan(activityStep);
		expect(localToolStep).toBeGreaterThan(sidecarStep);
		expect(nonCriticalTail).toBeGreaterThan(localToolStep);
		expect(bunComposition).toContain(
			"overallTimeoutMs: OVERALL_SHUTDOWN_TIMEOUT_MS",
		);
		expect(bunComposition).toContain("sidecar.beginShutdown();");
		expect(bunComposition).toContain(
			"activityReflectionRelayBridge?.abortAll();",
		);
		expect(bunComposition).toContain("stopActivityWindowDeliveryResources(");
	});
});
