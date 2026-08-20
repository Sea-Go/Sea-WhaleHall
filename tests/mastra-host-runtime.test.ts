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
				planningModel: {
					provider: "test-planning",
					modelId: "test-planning-model",
				},
				reflectionModel: {
					provider: "test-reflection",
					modelId: "test-reflection-model",
				},
			},
		});
		Reflect.set(runtime, "agents", {
			activitySupportSupervisor: {
				generate: async () => ({
					object: {
						route: "momentum",
						certainty: "medium",
						situation: "近期有目标相关推进",
						userNeed: "保护当前推进节奏",
					},
				}),
			},
			activitySupportSpecialists: {
				momentumCoach: {
					generate: async () => ({
						object: {
							acknowledgement: "你似乎正在向目标靠近",
							suggestion: "可以先完成眼前最小的一步",
							question: null,
						},
					}),
				},
			},
			activitySupportVoice: {
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
				supportContext: {
					schemaVersion: "activity-support-context.v1",
					activeGoal: "完成当前功能",
					recentApproaches: [],
					observations: [
						{
							activity: "development",
							goalRelation: "direct",
							evidenceStrength: "strong",
							signals: ["goal_progress"],
						},
					],
				},
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

	test("downgrades an unsupported blocker claim and replaces unsafe voice text", async () => {
		const messages: ProtocolMessage[] = [];
		const peer: HostRequestPeer = {
			async requestHost<TResult = unknown>(): Promise<TResult> {
				throw new Error("The support fallback test must not issue host calls.");
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
			requestId: "initialize-fallback",
			method: "runtime.initialize",
			params: {
				protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
				model: { provider: "test", modelId: "test-model" },
				planningModel: {
					provider: "test-planning",
					modelId: "test-planning-model",
				},
				reflectionModel: {
					provider: "test-reflection",
					modelId: "test-reflection-model",
				},
			},
		});
		let checkInCalls = 0;
		Reflect.set(runtime, "agents", {
			activitySupportSupervisor: {
				generate: async () => ({
					object: {
						route: "possible_blocker",
						certainty: "high",
						situation: "模型武断地声称用户卡住",
						userNeed: "模型建议拆解卡点",
					},
				}),
			},
			activitySupportSpecialists: {
				checkInCompanion: {
					generate: async () => {
						checkInCalls += 1;
						return {
							object: {
								acknowledgement: "我还不能确定你此刻的状态",
								suggestion: "可以按自己的节奏选择下一步",
								question: "你想继续、拆小问题，还是先休息？",
							},
						};
					},
				},
			},
			activitySupportVoice: {
				stream: async () => ({
					fullStream: emptyAsyncIterable(),
					finishReason: Promise.resolve("stop"),
					status: "completed",
					text: Promise.resolve("你的得分是 0.9，继续加油。"),
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
			requestId: "activity-request-fallback",
			method: "activity.start",
			params: {
				runId: "activity-run-fallback",
				activityJobId: "activity-job-fallback",
				supportContext: {
					schemaVersion: "activity-support-context.v1",
					activeGoal: "完成当前功能",
					recentApproaches: [],
					observations: [
						{
							activity: "development",
							goalRelation: "direct",
							evidenceStrength: "strong",
							signals: ["goal_progress"],
						},
					],
				},
			},
		});

		const terminal = await waitForTerminal(messages, "activity-run-fallback");
		expect(checkInCalls).toBe(1);
		expect(terminal.event).toEqual({
			kind: "run.completed",
			result: {
				activityJobId: "activity-job-fallback",
				summary:
					"我还不太确定你现在更需要哪种帮助。你可以按自己的节奏选择继续、拆小问题或先休息。你更想从哪一种开始？",
			},
		});
		expect(JSON.stringify(terminal.event)).not.toMatch(
			/(?:分数|评分|得分|0\.9)/u,
		);
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
			planningModel: {
				provider: "test-planning",
				modelId: "test-planning-model",
			},
			reflectionModel: {
				provider: "test-reflection",
				modelId: "test-reflection-model",
			},
		},
	});
	Reflect.set(runtime, "agents", { planningAnalysis: { generate } });
	Reflect.set(runtime, "planningRelay", {
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
