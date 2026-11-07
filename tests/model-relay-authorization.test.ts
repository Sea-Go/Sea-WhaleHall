import { describe, expect, test } from "bun:test";
import { MODEL_AGENT_IDS } from "../src/agent/mastra-host/model-agent-catalog";
import { authorizeRunBoundModelRelay } from "../src/bun/model-relay-authorization";

const agentProvider = "whalehall-relay";
const planningProvider = "whalehall-planning";

describe("authorizeRunBoundModelRelay", () => {
	test.each([
		["agent", agentProvider, "agent", MODEL_AGENT_IDS.conversation],
		[
			"activity",
			agentProvider,
			"activity",
			MODEL_AGENT_IDS.activitySupportSupervisor,
		],
		["planning", planningProvider, "planning", MODEL_AGENT_IDS.planning],
	] as const)(
		"routes a %s run through its approved provider",
		(runPurpose, provider, expectedBridge, agentId) => {
			expect(
				authorizeRunBoundModelRelay({
					provider,
					agentProvider,
					planningProvider,
					agentId,
					runPurpose,
					dynamicPlanningPending: false,
				}),
			).toBe(expectedBridge);
		},
	);

	test("routes a pending Dynamic Planning invocation through Planning", () => {
		expect(
			authorizeRunBoundModelRelay({
				provider: planningProvider,
				agentProvider,
				planningProvider,
				agentId: MODEL_AGENT_IDS.planningAnalysis,
				runPurpose: null,
				dynamicPlanningPending: true,
			}),
		).toBe("planning");
	});



});
