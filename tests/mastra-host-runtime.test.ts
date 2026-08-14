import { describe, expect, test } from "bun:test";
import {
	AGENT_HOST_PROTOCOL_VERSION,
	type AgentRunEventFrame,
	type ProtocolMessage,
} from "../src/agent/mastra-host/protocol";
import { AgentHostRuntime } from "../src/agent/mastra-host/runtime";
import type {
	HostRequestPeer,
	ProtocolWriter,
} from "../src/agent/mastra-host/transport";

const oversizedActivitySummary = "甲".repeat(64 * 1024 + 1);

describe("AgentHostRuntime activity analysis", () => {
	test("rejects an oversized final-text fallback when no deltas were emitted", async () => {
		const messages: ProtocolMessage[] = [];
		const peer: HostRequestPeer = {
			async requestHost<TResult = unknown>(): Promise<TResult> {
				throw new Error("The fallback test must not issue host calls.");
			},
			subscribeRelay: () => () => {},
		};
		const writer: ProtocolWriter = {
			async write(message) {
				messages.push(message);
			},
		};
		const runtime = new AgentHostRuntime(peer, writer, { now: () => 1_000 });
		await runtime.dispatch({
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "request",
			requestId: "initialize",
			method: "runtime.initialize",
			params: {
				protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
				model: { provider: "test", modelId: "test-model" },
				reflectionModel: {
					provider: "test-reflection",
					modelId: "test-reflection-model",
				},
			},
		});
		Reflect.set(runtime, "agents", {
			conversation: {
				stream: async () => ({
					fullStream: emptyAsyncIterable(),
					finishReason: Promise.resolve("stop"),
					status: "completed",
					text: Promise.resolve(oversizedActivitySummary),
				}),
			},
		});
		Reflect.set(runtime, "relay", {
			runInContext: async <TResult>(
				_context: unknown,
				operation: () => Promise<TResult>,
			): Promise<TResult> => operation(),
		});

		await runtime.dispatch({
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "request",
			requestId: "activity-request",
			method: "activity.start",
			params: {
				runId: "activity-run",
				activityJobId: "activity-job",
				consumedScore: 0.75,
				analyses: [
					{
						request_id: "worker-request",
						events: [
							{
								source_event_ids: ["sealed-window"],
								activity: "development",
								goal_relevance: "direct",
								confidence: 0.9,
								reason_codes: ["worker"],
								evidence: ["bounded worker evidence"],
								started_at_ms: 1,
								ended_at_ms: 2,
							},
						],
						score: 0.75,
						score_reason: "goal-relevant activity",
					},
				],
			},
		});

		const terminal = await waitForTerminal(messages, "activity-run");
		expect(terminal.event).toEqual({
			kind: "run.failed",
			error: {
				code: "ACTIVITY_OUTPUT_INVALID",
				message: "Activity analysis response is too large.",
				retryable: false,
			},
		});
	});
});

async function* emptyAsyncIterable(): AsyncGenerator<never, void, unknown> {}

async function waitForTerminal(
	messages: readonly ProtocolMessage[],
	runId: string,
): Promise<AgentRunEventFrame> {
	const deadline = Date.now() + 2_000;
	for (;;) {
		const terminal = messages.find(
			(message): message is AgentRunEventFrame =>
				message.type === "event" &&
				message.runId === runId &&
				message.terminalState !== null,
		);
		if (terminal) return terminal;
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for terminal run ${runId}.`);
		}
		await Bun.sleep(1);
	}
}
