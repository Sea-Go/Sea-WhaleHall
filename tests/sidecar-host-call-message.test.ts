import { describe, expect, test } from "bun:test";
import {
	AgentHostRuntimeError,
	HostCallError,
	relayedHostCallMessage,
} from "../src/agent/mastra-host/transport";

describe("relayedHostCallMessage", () => {
	test("reads back the message of a host-call failure a Workflow re-threw", () => {
		const failure = new HostCallError({
			code: "MODEL_RELAY_UNAVAILABLE",
			message: "认证服务暂时不可用。",
			retryable: true,
		});

		// Error#message is non-enumerable, so a Workflow's plain copy is built
		// from the serialized fields rather than from spreading the instance.
		expect(
			relayedHostCallMessage({
				name: failure.name,
				message: failure.message,
				data: "",
			}),
		).toBe("认证服务暂时不可用。");
		expect(relayedHostCallMessage(failure)).toBe("认证服务暂时不可用。");
	});

	test("keeps model, provider and runtime failures opaque", () => {
		const provider = new Error("provider echoed a private prompt");
		provider.name = "AI_APICallError";

		expect(relayedHostCallMessage(provider)).toBeNull();
		expect(
			relayedHostCallMessage({
				name: "AI_APICallError",
				message: "provider echoed a private prompt",
			}),
		).toBeNull();
		expect(
			relayedHostCallMessage(
				new AgentHostRuntimeError({
					code: "ACTIVITY_OUTPUT_INVALID",
					message: "Activity reflection output failed its semantic contract.",
					retryable: false,
				}),
			),
		).toBeNull();
		expect(relayedHostCallMessage("HostCallError")).toBeNull();
		expect(relayedHostCallMessage(null)).toBeNull();
	});

	test("refuses host-call messages that could carry foreign text", () => {
		for (const message of [
			"",
			"a".repeat(201),
			"line one\nline two",
			"tab\there",
		]) {
			expect(
				relayedHostCallMessage({ name: "HostCallError", message }),
			).toBeNull();
		}
	});
});
