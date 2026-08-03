import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function source(path: string): string {
	return readFileSync(join(repositoryRoot, path), "utf8");
}

describe("local Agent production boundary", () => {
	test("does not assemble a separate cloud activity analyzer", () => {
		const bunComposition = source("src/bun/index.ts");
		const clientConfiguration = source("src/bun/client-config.ts");

		for (const removedCapability of [
			"ActivityEventWorkerClient",
			"ActivityWindowDeliveryService",
			"ActivityWindowDeliveryStore",
			"WHALEHALL_ACTIVITY_WORKER_TOKEN",
			"activityEventWorker",
		]) {
			expect(bunComposition).not.toContain(removedCapability);
			expect(clientConfiguration).not.toContain(removedCapability);
		}
		expect(
			existsSync(join(repositoryRoot, "src/agent/activity-event-worker.ts")),
		).toBeFalse();
		expect(
			existsSync(join(repositoryRoot, "src/agent/activity-window-worker.ts")),
		).toBeFalse();
	});

	test("keeps the remote service surface limited to identity and model relay", () => {
		const relayServer = source("services/model-relay/server.ts");
		const routes = [...relayServer.matchAll(/url\.pathname === "(\/v1\/[^"]+)"/gu)]
			.map((match) => match[1]);

		expect(routes).toEqual([
			"/v1/auth/sessions",
			"/v1/auth/sessions/refresh",
			"/v1/auth/sessions/current",
			"/v1/auth/me",
			"/v1/chat/completions",
		]);
		expect(relayServer).not.toContain("activityEventWorker");
		expect(relayServer).not.toContain("/v1/activity/");
	});
});
