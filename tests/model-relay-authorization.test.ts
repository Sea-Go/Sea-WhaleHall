import { describe, expect, test } from "bun:test";
import { authorizeRunBoundModelRelay } from "../src/bun/model-relay-authorization";

const agentProvider = "whalehall-relay";
const planningProvider = "whalehall-planning";

describe("authorizeRunBoundModelRelay", () => {
	test.each([
		["agent", agentProvider, "agent"],
		["activity", agentProvider, "activity"],
		["planning", planningProvider, "planning"],
	] as const)(
		"routes a %s run through its approved provider",
		(runPurpose, provider, expectedBridge) => {
			expect(
				authorizeRunBoundModelRelay({
					provider,
					agentProvider,
					planningProvider,
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
				runPurpose: null,
				dynamicPlanningPending: true,
			}),
		).toBe("planning");
	});

	test.each([
		["a conversation", "agent", planningProvider, false],
		["an activity run", "activity", planningProvider, false],
		["a task Planning run", "planning", agentProvider, false],
		["a pending Dynamic Planning invocation", null, agentProvider, true],
	] as const)(
		"rejects %s attempting to select the wrong provider",
		(_description, runPurpose, provider, dynamicPlanningPending) => {
			expect(() =>
				authorizeRunBoundModelRelay({
					provider,
					agentProvider,
					planningProvider,
					runPurpose,
					dynamicPlanningPending,
				}),
			).toThrow();
		},
	);
});
