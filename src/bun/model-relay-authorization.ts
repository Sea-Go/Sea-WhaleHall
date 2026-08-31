import {
	isModelAgentId,
	MODEL_AGENT_IDS,
	modelAgentPurpose,
} from "../agent/mastra-host/model-agent-catalog";

/** A model relay bridge selected only after the host run's role is verified. */
export type AuthorizedModelRelayBridge = "agent" | "activity" | "planning";

export type AuthorizeRunBoundModelRelayInput = {
	provider: string;
	agentProvider: string;
	planningProvider: string;
	agentId: unknown;
	runPurpose: AuthorizedModelRelayBridge | null;
	dynamicPlanningPending: boolean;
};

/**
 * Keeps a Sidecar-selected provider from changing the model role owned by a
 * trusted desktop run. Dynamic Planning has no coordinator run, so its pending
 * invocation is the capability that authorizes the Planning bridge instead.
 */
export function authorizeRunBoundModelRelay(
	input: AuthorizeRunBoundModelRelayInput,
): AuthorizedModelRelayBridge {
	if (!isModelAgentId(input.agentId)) {
		throw new Error("Model relay Agent identity is not approved.");
	}
	if (input.dynamicPlanningPending) {
		if (
			input.agentId !== MODEL_AGENT_IDS.planningAnalysis ||
			input.provider !== input.planningProvider
		) {
			throw new Error(
				"Dynamic Planning model relay must use its fixed Agent and Planning provider.",
			);
		}
		return "planning";
	}
	if (input.runPurpose === null) {
		throw new Error("Model relay call is not bound to an active Agent run.");
	}
	if (modelAgentPurpose(input.agentId) !== input.runPurpose) {
		throw new Error("Model relay Agent does not match the owning run purpose.");
	}
	if (
		(input.runPurpose === "agent" &&
			input.agentId !== MODEL_AGENT_IDS.conversation) ||
		(input.runPurpose === "planning" &&
			input.agentId !== MODEL_AGENT_IDS.planning)
	) {
		throw new Error("Model relay Agent does not match the owning run kind.");
	}
	if (input.provider === input.planningProvider) {
		if (input.runPurpose !== "planning") {
			throw new Error("Only task Planning runs may use the Planning provider.");
		}
		return "planning";
	}
	if (input.provider === input.agentProvider) {
		if (input.runPurpose === "planning") {
			throw new Error("Task Planning runs must use the Planning provider.");
		}
		return input.runPurpose;
	}
	throw new Error("Model relay provider is not approved.");
}
