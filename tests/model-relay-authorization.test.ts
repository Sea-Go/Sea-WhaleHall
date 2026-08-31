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

	test.each([
		[
			"a conversation",
			"agent",
			planningProvider,
			false,
			MODEL_AGENT_IDS.conversation,
		],
		[
			"an activity run",
			"activity",
			planningProvider,
			false,
			MODEL_AGENT_IDS.activitySupportSupervisor,
		],
		[
			"a task Planning run",
			"planning",
			agentProvider,
			false,
			MODEL_AGENT_IDS.planning,
		],
		[
			"a pending Dynamic Planning invocation",
			null,
			agentProvider,
			true,
			MODEL_AGENT_IDS.planningAnalysis,
		],
	] as const)(
		"rejects %s attempting to select the wrong provider",
		(_description, runPurpose, provider, dynamicPlanningPending, agentId) => {
			expect(() =>
				authorizeRunBoundModelRelay({
					provider,
					agentProvider,
					planningProvider,
					agentId,
					runPurpose,
					dynamicPlanningPending,
				}),
			).toThrow();
		},
	);

	test.each([
		[
			"a conversation using an activity Agent",
			"agent",
			MODEL_AGENT_IDS.activitySupportSupervisor,
		],
		[
			"task Planning using the Dynamic Planning Agent",
			"planning",
			MODEL_AGENT_IDS.planningAnalysis,
		],
		[
			"Dynamic Planning using the task Planning Agent",
			null,
			MODEL_AGENT_IDS.planning,
		],
	] as const)("rejects %s", (_description, runPurpose, agentId) => {
		expect(() =>
			authorizeRunBoundModelRelay({
				provider: planningProvider,
				agentProvider,
				planningProvider,
				agentId,
				runPurpose,
				dynamicPlanningPending: runPurpose === null,
			}),
		).toThrow();
	});

	test("rejects an unknown Agent identity", () => {
		expect(() =>
			authorizeRunBoundModelRelay({
				provider: agentProvider,
				agentProvider,
				planningProvider,
				agentId: "whalehall-forged-agent",
				runPurpose: "agent",
				dynamicPlanningPending: false,
			}),
		).toThrow("not approved");
	});
});
