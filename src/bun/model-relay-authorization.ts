/** A model relay bridge selected only after the host run's role is verified. */
export type AuthorizedModelRelayBridge = "agent" | "activity" | "planning";

export type AuthorizeRunBoundModelRelayInput = {
	provider: string;
	agentProvider: string;
	planningProvider: string;
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
	if (input.dynamicPlanningPending) {
		if (input.provider !== input.planningProvider) {
			throw new Error(
				"Dynamic Planning model relay must use the Planning provider.",
			);
		}
		return "planning";
	}
	if (input.runPurpose === null) {
		throw new Error("Model relay call is not bound to an active Agent run.");
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
