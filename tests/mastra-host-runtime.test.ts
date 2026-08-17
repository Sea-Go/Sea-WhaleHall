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

describe("AgentHostRuntime dynamic Planning analysis", () => {
	test("maps only its own deadline to a retryable relay error", async () => {
		const deadlineSignals: AbortSignal[] = [];
		const runtime = await planningRuntime(async (_prompt, options) => {
			deadlineSignals.push(options.abortSignal);
			return new Promise<never>(() => {});
		}, 20);

		await expect(planningAnalyze(runtime)).rejects.toMatchObject({
			payload: {
				code: "MODEL_RELAY_UNAVAILABLE",
				message: "Dynamic Planning analysis timed out.",
				retryable: true,
			},
		});
		expect(deadlineSignals[0]?.aborted).toBeTrue();
	});

	test("preserves caller aborts and unrelated model errors", async () => {
		for (const original of [
			new DOMException("caller cancelled", "AbortError"),
			new Error("unrelated provider failure"),
		]) {
			const runtime = await planningRuntime(async () => {
				throw original;
			});
			let caught: unknown;
			try {
				await planningAnalyze(runtime);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBe(original);
		}
	});
});

async function* emptyAsyncIterable(): AsyncGenerator<never, void, unknown> {}

async function planningRuntime(
	generate: (
		prompt: string,
		options: { abortSignal: AbortSignal },
	) => Promise<unknown>,
	timeoutMs = 1_000,
): Promise<AgentHostRuntime> {
	const peer: HostRequestPeer = {
		async requestHost<TResult = unknown>(): Promise<TResult> {
			throw new Error("The Planning analysis test must not issue host calls.");
		},
		subscribeRelay: () => () => {},
	};
	const writer: ProtocolWriter = { async write() {} };
	const runtime = new AgentHostRuntime(peer, writer, {
		now: () => 1_000,
		dynamicPlanningAnalysisTimeoutMs: timeoutMs,
	});
	await runtime.dispatch({
		protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
		type: "request",
		requestId: "initialize-planning-analysis",
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
	Reflect.set(runtime, "agents", { planningAnalysis: { generate } });
	Reflect.set(runtime, "relay", {
		runInContext: async <TResult>(
			_context: unknown,
			operation: () => Promise<TResult>,
		): Promise<TResult> => operation(),
	});
	return runtime;
}

function planningAnalyze(runtime: AgentHostRuntime): Promise<unknown> {
	return runtime.dispatch({
		protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
		type: "request",
		requestId: "planning-analysis-request",
		method: "planning.analyze",
		params: {
			invocationId: "planning-analysis-invocation",
			requestId: "planning-analysis-operation",
			analysis: {
				planId: "plan-1",
				analysisMode: "manual-proposal",
				currentGoal: "验证一个长期收入方向",
				currentType: null,
				trigger: "initial-analysis",
				effectiveWindow: {
					startDate: "2026-08-14",
					endDateExclusive: "2026-08-21",
					timeZone: "Asia/Shanghai",
				},
				messages: [],
				currentTasks: [],
				currentEstimate: null,
				currentSchedulingPreferences: null,
				observationEvidence: [],
				calendarEvents: [],
			},
		},
	});
}

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
