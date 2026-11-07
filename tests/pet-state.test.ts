import { describe, expect, test } from "bun:test";
import {
	PetStateArbiter,
	petStateForInteraction,
	petStateForPresentationEvent,
	petStateForRuntime,
	petStateForToolEvent,
	petStateHoldForInteraction,
	petStateHoldForPresentationEvent,
	petStateHoldForToolEvent,
} from "../src/bun/pet-state";
import type { LocalRuntimeStatus, LocalToolEvent } from "../src/agent/local-protocol";
import type { PetState } from "../src/shared/contracts";

function status(overrides: Partial<LocalRuntimeStatus>): LocalRuntimeStatus {
	return { state: "ready", pid: 42, activeCalls: 0, lastError: null, ...overrides };
}

function event(kind: LocalToolEvent["event"]): LocalToolEvent {
	return { event: kind, callId: "call-1", data: { name: "demo.wait" } };
}

describe("production pet state mapping", () => {
	test("maps runtime lifecycle to explicit semantic actions", () => {
		expect(petStateForRuntime(status({ state: "starting" })).action).toBe("searching");
		expect(petStateForRuntime(status({ state: "ready" })).action).toBe("idle");
		expect(petStateForRuntime(status({ activeCalls: 2 })).action).toBe("loading");
		expect(petStateForRuntime(status({ state: "degraded" })).action).toBe(
			"networkDisconnected",
		);
	});

	test("maps tool progress, result, failure, and cancellation actions", () => {
		expect(petStateForToolEvent(event("tool.started")).action).toBe("searching");
		expect(petStateForToolEvent(event("tool.progress")).action).toBe("loading");
		expect(petStateForToolEvent(event("tool.completed")).action).toBe("taskComplete");
		expect(petStateForToolEvent(event("tool.failed")).action).toBe("operationFailed");
		expect(petStateForToolEvent(event("tool.cancelled")).action).toBe("wronged");
	});







});
