import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asError } from "../src/agent/mastra-host/runtime";
import {
	AgentHostRuntimeError,
	HostCallError,
	protocolError,
	relayedProtocolError,
} from "../src/agent/mastra-host/transport";

const RELAY_UNAVAILABLE = {
	code: "MODEL_RELAY_UNAVAILABLE",
	message: "认证服务暂时不可用。",
	retryable: true,
} as const;

type CopyPayload = { code?: unknown; message?: unknown; retryable?: unknown };

// Mastra 1.82 hands a failed Workflow step back with exactly these own keys.
function workflowCopy(name: string, payload: CopyPayload = RELAY_UNAVAILABLE) {
	return { message: payload.message, name, payload };
}

describe("relayedProtocolError", () => {
	test("rebuilds the host-call failure a Workflow re-threw as a plain copy", () => {
		const rebuilt = relayedProtocolError(workflowCopy("HostCallError"));

		expect(rebuilt).toBeInstanceOf(HostCallError);
		expect(protocolError(rebuilt)).toEqual(RELAY_UNAVAILABLE);
	});

	test("rebuilds a runtime failure copy and keeps its code", () => {
		const rebuilt = relayedProtocolError(
			workflowCopy("AgentHostRuntimeError", {
				code: "ACTIVITY_OUTPUT_INVALID",
				message: "Activity reflection output failed its semantic contract.",
				retryable: false,
			}),
		);

		expect(rebuilt).toBeInstanceOf(AgentHostRuntimeError);
		expect(protocolError(rebuilt)).toEqual({
			code: "ACTIVITY_OUTPUT_INVALID",
			message: "Activity reflection output failed its semantic contract.",
			retryable: false,
		});
	});

	test("keeps model, provider and runtime failures opaque", () => {
		const provider = new Error("provider echoed a private prompt");
		provider.name = "AI_APICallError";

		expect(relayedProtocolError(provider)).toBeNull();
		expect(
			relayedProtocolError({
				message: "provider echoed a private prompt",
				name: "AI_APICallError",
				payload: RELAY_UNAVAILABLE,
			}),
		).toBeNull();
		expect(
			relayedProtocolError({
				message: "认证服务暂时不可用。",
				name: "HostCallError",
			}),
		).toBeNull();
		expect(relayedProtocolError("HostCallError")).toBeNull();
		expect(relayedProtocolError(null)).toBeNull();
	});

	test("refuses copies that could carry foreign text or an unknown code", () => {
		for (const payload of [
			{ ...RELAY_UNAVAILABLE, code: "MADE_UP_CODE" },
			{ ...RELAY_UNAVAILABLE, code: 7 },
			{ ...RELAY_UNAVAILABLE, retryable: "yes" },
			{ ...RELAY_UNAVAILABLE, message: "" },
			{ ...RELAY_UNAVAILABLE, message: "a".repeat(201) },
			{ ...RELAY_UNAVAILABLE, message: "line one\nline two" },
			{ ...RELAY_UNAVAILABLE, message: "del\u007fete" },
			{ ...RELAY_UNAVAILABLE, message: 42 },
		]) {
			expect(
				relayedProtocolError(workflowCopy("HostCallError", payload)),
			).toBeNull();
		}
	});
});

describe("asError", () => {
	const home = process.env.HOME;
	const scratch: string[] = [];

	afterEach(() => {
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		for (const directory of scratch.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	// The diagnostic sink resolves below HOME; point it at an empty directory
	// so the test never appends to the developer's real sidecar-diag.log.
	function isolateHome(): void {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-as-error-"));
		scratch.push(directory);
		process.env.HOME = directory;
	}

	test("returns a relayed failure with its Bun-written message, code and retry flag", () => {
		isolateHome();

		const error = asError(workflowCopy("HostCallError"));

		expect(error).toBeInstanceOf(HostCallError);
		expect(protocolError(error)).toEqual(RELAY_UNAVAILABLE);
	});

	test("keeps every other Workflow failure generic", () => {
		isolateHome();
		const provider = new Error("provider echoed a private prompt");
		provider.name = "AI_APICallError";

		expect(asError(provider).message).toBe("Agent runtime operation failed.");
		expect(
			asError({
				message: "provider echoed a private prompt",
				name: "AI_APICallError",
			}).message,
		).toBe("Agent runtime operation failed.");
		expect(
			asError(workflowCopy("HostCallError", { code: "MADE_UP_CODE" })).message,
		).toBe("Agent runtime operation failed.");
	});
});
