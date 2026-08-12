import { AsyncLocalStorage } from "node:async_hooks";
import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import type { MastraModelOutput } from "@mastra/core/stream";
import {
	isActivityAnalysisWorkerResult,
	MAXIMUM_ACTIVITY_ANALYSIS_PROMPT_CHARACTERS,
	MAXIMUM_ACTIVITY_ANALYSIS_RESULTS,
	serializedActivityAnalysisLength,
} from "../../shared/activity-analysis-contract";
import {
	activityReflectionModelOutputSchema,
	createActivityReflectionRuntimeOutputSchema,
	MAX_ACTIVITY_REFLECTION_PROMPT_CHARACTERS,
} from "../activity-reflection-prompt";
import { loadActivityReflectionNativeSkillContext } from "./activity-reflection-skills";
import {
	type ActivityReflectionWorkflowDriverInput,
	activityReflectionWorkflowInputSchema,
	activityReflectionWorkflowOutcomeSchema,
} from "./activity-reflection-workflow";
import { createMastraAgentSet, type MastraAgentSet } from "./agents";
import {
	type CalendarSnapshot,
	HostStateAdapters,
	type HostToolProposal,
	type PlanningValidationIssue,
} from "./host-adapters";
import {
	type ConversationMemoryExecutionContext,
	HostMastraStorage,
} from "./mastra-storage";
import { ModelRelay } from "./model-relay";
import {
	type PlanningWorkflowClarification,
	type PlanningWorkflowCompletion,
	type PlanningWorkflowDriverInput,
	type PlanningWorkflowOutcome,
	type PlanningWorkflowResume,
	planningWorkflowClarificationSchema,
	planningWorkflowCompletionSchema,
	planningWorkflowResumeLabel,
	planningWorkflowStepId,
} from "./planning-workflow";
import {
	type ActivityAnalysisStartParams,
	type ActivityAnalysisWorkerResult,
	type ActivityReflectionAnalyzeParams,
	AGENT_HOST_METHODS,
	AGENT_HOST_PROTOCOL_VERSION,
	AGENT_HOST_SERVICE,
	type AgentHostErrorPayload,
	type AgentHostRequest,
	type AgentRunEventFrame,
	type AgentRunEventPayload,
	type AgentRunSnapshot,
	type ConversationInputMessage,
	type ConversationStartParams,
	type HostPlanningState,
	isRecord,
	type PlanningAnswerParams,
	type PlanningStartParams,
	type RunAcceptedResult,
	type RuntimeInitializeParams,
	type RuntimeInitializeResult,
	SIDECAR_HOST_METHODS,
	type SidecarHostMethod,
	type TaskPlanningAnswer,
	type TaskPlanningInput,
} from "./protocol";
import {
	type TaskPlanningDraft,
	type TaskPlanningResult,
	taskPlanningQuestionKeySchema,
	taskPlanningResultSchema,
} from "./schemas";
import {
	type AgentToolExecutionInput,
	canonicalToolName,
	isApprovalRequiredToolName,
} from "./tools";
import {
	AgentHostRuntimeError,
	type HostRequestOptions,
	type HostRequestPeer,
	type ProtocolWriter,
	protocolError,
} from "./transport";

const defaultRelayBaseUrl = "https://model-relay.whalehall.invalid/v1";
const defaultReflectionRelayBaseUrl =
	"https://activity-relay.whalehall.invalid/v1";
const maxConversationCharacters = 64 * 1024;
const maxRetainedRuns = 256;
const maxClarificationRounds = 3;
/** Must finish before the Bun-side 210-second reflection deadline. */
export const DEFAULT_ACTIVITY_REFLECTION_WORKFLOW_TIMEOUT_MS = 195_000;
interface ConversationRunContext {
	conversationId: string;
	resourceId: string;
	message: string;
	history: readonly ConversationInputMessage[];
	expectedVersion?: number;
}

interface PlanningRunContext {
	state: HostPlanningState;
	operation: "start" | "answer";
}

interface ActivityAnalysisRunContext {
	activityJobId: string;
	consumedScore: number;
	analyses: readonly ActivityAnalysisWorkerResult[];
}

interface RunRecord {
	snapshot: AgentRunSnapshot;
	controller: AbortController;
	cancelReason: string | null;
	conversation?: ConversationRunContext;
	planning?: PlanningRunContext;
	activity?: ActivityAnalysisRunContext;
	toolProposals: Map<string, HostToolProposal>;
}

export interface AgentHostRuntimeOptions {
	now?: () => number;
	onShutdownRequested?: () => void;
	onBackgroundError?: (error: Error) => void;
}

export class AgentHostRuntime {
	private readonly now: () => number;
	private readonly adapters: HostStateAdapters;
	private readonly hostRunContext = new AsyncLocalStorage<string>();
	private readonly runBoundPeer: HostRequestPeer;
	private readonly runs = new Map<string, RunRecord>();
	private readonly onShutdownRequested: () => void;
	private readonly onBackgroundError: (error: Error) => void;
	private relay: ModelRelay | null = null;
	private reflectionRelay: ModelRelay | null = null;
	private storage: HostMastraStorage | null = null;
	private agents: MastraAgentSet | null = null;
	private initialized: RuntimeInitializeResult | null = null;
	private initializationKey: string | null = null;
	private shuttingDown = false;

	constructor(
		peer: HostRequestPeer,
		private readonly writer: ProtocolWriter,
		options: AgentHostRuntimeOptions = {},
	) {
		this.now = options.now ?? Date.now;
		const hostRunContext = this.hostRunContext;
		this.runBoundPeer = {
			requestHost<TResult = unknown>(
				method: SidecarHostMethod,
				params: Record<string, unknown>,
				requestOptions?: HostRequestOptions,
			): Promise<TResult> {
				const contextualOwnerRunId = hostRunContext.getStore();
				const ownerRunId = requestOptions?.ownerRunId ?? contextualOwnerRunId;
				if (!ownerRunId) {
					return Promise.reject(
						new Error("Sidecar host call is not bound to an Agent run."),
					);
				}
				if (
					contextualOwnerRunId &&
					requestOptions?.ownerRunId &&
					requestOptions.ownerRunId !== contextualOwnerRunId
				) {
					return Promise.reject(
						new Error("Sidecar host-call run binding changed."),
					);
				}
				return peer.requestHost<TResult>(
					method,
					{ ...params, ownerRunId },
					requestOptions
						? {
								requestId: requestOptions.requestId,
								signal: requestOptions.signal,
							}
						: undefined,
				);
			},
			subscribeRelay: (relayId, listener) =>
				peer.subscribeRelay(relayId, listener),
		};
		this.adapters = new HostStateAdapters(this.runBoundPeer);
		this.onShutdownRequested = options.onShutdownRequested ?? (() => undefined);
		this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
	}

	async dispatch(request: AgentHostRequest): Promise<unknown> {
		switch (request.method) {
			case "runtime.initialize":
				return this.initialize(request.params);
			case "runtime.shutdown":
				return this.shutdown();
			case "conversation.start":
				return this.startConversation(request.requestId, request.params);
			case "planning.start":
				return this.startPlanning(request.requestId, request.params);
			case "activity.start":
				return this.startActivityAnalysis(request.requestId, request.params);
			case "reflection.analyze":
				return this.analyzeActivityReflection(request.params);
			case "planning.answer":
				return this.answerPlanning(request.params);
			case "run.cancel":
				return this.cancelRun(request.params.runId, request.params.reason);
			case "run.resume":
				return this.resumeRun(
					request.params.originatingRequestId,
					request.params.runId,
					request.params.resumeData,
					request.params.toolCallId,
					"resume",
				);
			case "agent.approveTool":
				return this.resumeRun(
					request.params.originatingRequestId,
					request.params.runId,
					request.params.resumeData,
					request.params.toolCallId,
					"approve",
				);
			case "agent.declineTool":
				return this.resumeRun(
					request.params.originatingRequestId,
					request.params.runId,
					{
						...(isRecord(request.params.resumeData)
							? request.params.resumeData
							: {}),
						approved: false,
						reason: request.params.reason,
					},
					request.params.toolCallId,
					"decline",
				);
			case "run.snapshot":
				return this.snapshot(request.params.runId);
			default:
				throw runtimeError(
					"UNSUPPORTED_METHOD",
					`Unsupported Agent host method: ${(request as { method: string }).method}`,
				);
		}
	}

	private initialize(params: RuntimeInitializeParams): RuntimeInitializeResult {
		if (params.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
			throw runtimeError(
				"INVALID_REQUEST",
				`Protocol version ${params.protocolVersion} is not supported.`,
			);
		}
		const provider = requiredString(params.model?.provider, "model.provider");
		const modelId = requiredString(params.model?.modelId, "model.modelId");
		const baseUrl = params.model.baseUrl ?? defaultRelayBaseUrl;
		const supportsStructuredOutputs =
			params.model.supportsStructuredOutputs ?? true;
		const reflectionProvider = requiredString(
			params.reflectionModel?.provider,
			"reflectionModel.provider",
		);
		const reflectionModelId = requiredString(
			params.reflectionModel?.modelId,
			"reflectionModel.modelId",
		);
		const reflectionBaseUrl =
			params.reflectionModel.baseUrl ?? defaultReflectionRelayBaseUrl;
		const reflectionSupportsStructuredOutputs =
			params.reflectionModel.supportsStructuredOutputs ?? true;
		const initializationKey = JSON.stringify({
			provider,
			modelId,
			baseUrl,
			supportsStructuredOutputs,
			reflectionProvider,
			reflectionModelId,
			reflectionBaseUrl,
			reflectionSupportsStructuredOutputs,
		});
		if (this.initialized) {
			if (this.initializationKey !== initializationKey) {
				throw runtimeError(
					"ALREADY_INITIALIZED",
					"Agent host is already initialized with different model settings.",
				);
			}
			return this.initialized;
		}

		this.relay = new ModelRelay(this.runBoundPeer, provider, modelId);
		this.reflectionRelay = new ModelRelay(
			this.runBoundPeer,
			reflectionProvider,
			reflectionModelId,
		);
		this.storage = new HostMastraStorage(this.runBoundPeer);
		this.agents = createMastraAgentSet({
			provider,
			modelId,
			baseUrl,
			supportsStructuredOutputs,
			reflectionProvider,
			reflectionModelId,
			reflectionBaseUrl,
			reflectionSupportsStructuredOutputs,
			storage: this.storage,
			relay: this.relay,
			reflectionRelay: this.reflectionRelay,
			executeTool: (input) => this.executeTool(input),
			executePlanningWorkflow: (input) =>
				this.executePlanningWorkflowCycle(input),
			executeActivityReflectionWorkflow: (input) =>
				this.executeActivityReflectionWorkflow(input),
		});
		this.initialized = {
			service: AGENT_HOST_SERVICE,
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			initializedAtMs: this.now(),
			capabilities: {
				methods: AGENT_HOST_METHODS,
				hostCalls: SIDECAR_HOST_METHODS,
				streaming: true,
				structuredPlanning: true,
				listensOnNetwork: false,
			},
		};
		this.initializationKey = initializationKey;
		return this.initialized;
	}

	private async shutdown(): Promise<{
		accepted: true;
		cancelledRunIds: string[];
	}> {
		if (this.shuttingDown) return { accepted: true, cancelledRunIds: [] };
		this.shuttingDown = true;
		const cancelledRunIds: string[] = [];
		for (const record of this.runs.values()) {
			if (record.snapshot.terminalState) continue;
			cancelledRunIds.push(record.snapshot.runId);
			await this.cancelRecord(record, "Agent host shutdown");
		}
		setImmediate(this.onShutdownRequested);
		return { accepted: true, cancelledRunIds };
	}

	private startConversation(
		requestId: string,
		params: ConversationStartParams,
	): RunAcceptedResult {
		this.ensureReady();
		const runId = requiredString(params.runId, "runId");
		const conversationId = requiredString(
			params.conversationId,
			"conversationId",
		);
		const message = requiredString(
			params.message,
			"message",
			maxConversationCharacters,
		);
		const resourceId = optionalString(params.resourceId) ?? "whalehall.desktop";
		const history = (params.history ?? []).map(validateConversationMessage);
		const record = this.createRun(requestId, runId, "conversation", {
			conversationId,
			resourceId,
			message,
			history,
			expectedVersion: optionalVersion(params.expectedVersion),
		});
		this.schedule(record, () => this.executeConversation(record, "start"));
		return accepted(record);
	}

	private startPlanning(
		requestId: string,
		params: PlanningStartParams,
	): RunAcceptedResult {
		this.ensureReady();
		const runId = requiredString(params.runId, "runId");
		const sessionId = requiredString(params.sessionId, "sessionId");
		const input = validatePlanningInput(params.input);
		const record = this.createRun(requestId, runId, "planning");
		record.planning = {
			operation: "start",
			state: {
				sessionId,
				runId,
				input,
				answers: [],
				clarificationRounds: 0,
				workflowRunId: "",
				version: optionalVersion(params.expectedVersion) ?? 0,
			},
		};
		record.snapshot.sessionId = sessionId;
		this.schedule(record, () => this.executePlanningStart(record));
		return accepted(record);
	}

	private startActivityAnalysis(
		requestId: string,
		params: ActivityAnalysisStartParams,
	): RunAcceptedResult {
		this.ensureReady();
		const runId = requiredString(params.runId, "runId");
		const activityJobId = requiredString(params.activityJobId, "activityJobId");
		const consumedScore = requiredNonNegativeFiniteNumber(
			params.consumedScore,
			"consumedScore",
		);
		const analyses = validateActivityAnalysisWorkerResults(params.analyses);
		const record = this.createRun(requestId, runId, "activity");
		record.activity = {
			activityJobId,
			consumedScore,
			analyses,
		};
		record.snapshot.activityJobId = activityJobId;
		this.schedule(record, () => this.executeActivityAnalysis(record));
		return accepted(record);
	}

	/**
	 * Runs one client-owned reflection prompt through a no-persistence Mastra
	 * workflow. It intentionally creates no Agent run or durable snapshot.
	 */
	private async analyzeActivityReflection(
		params: ActivityReflectionAnalyzeParams,
	): Promise<unknown> {
		this.ensureReady();
		const invocationId = requiredString(params.invocationId, "invocationId");
		const requestId = requiredString(params.requestId, "requestId");
		const userPrompt = requiredString(
			params.userPrompt,
			"userPrompt",
			MAX_ACTIVITY_REFLECTION_PROMPT_CHARACTERS,
		);
		const workflowInput = activityReflectionWorkflowInputSchema.parse({
			invocationId,
			requestId,
			userPrompt,
			signalSegmentIds: params.signalSegmentIds,
			candidateActivities: params.candidateActivities,
		});
		const workflow = this.requireAgents().activityReflectionWorkflow;
		// Deliberately omit `runId`: in Mastra 1.55 a caller-supplied run ID
		// asks storage to look for a durable snapshot even when persistence is
		// disabled. This live privacy boundary must remain entirely in-memory.
		const run = await workflow.createRun({ disableScorers: true });
		let result: Awaited<ReturnType<typeof run.start>>;
		try {
			result = await runActivityReflectionWithDeadline(
				() =>
					this.hostRunContext.run(invocationId, () =>
						run.start({
							inputData: workflowInput,
							requestContext: new RequestContext(),
						}),
					),
				() => run.cancel(),
				DEFAULT_ACTIVITY_REFLECTION_WORKFLOW_TIMEOUT_MS,
				(error) => this.onBackgroundError(asError(error)),
			);
		} catch (error) {
			if (error instanceof ActivityReflectionWorkflowDeadlineError) {
				throw runtimeError(
					"MODEL_RELAY_UNAVAILABLE",
					"Activity reflection timed out.",
					true,
				);
			}
			throw error;
		}
		if (result.status === "success") {
			return activityReflectionWorkflowOutcomeSchema.parse(result.result)
				.modelOutput;
		}
		if (result.status === "failed") throw asError(result.error);
		throw runtimeError(
			"INTERNAL_ERROR",
			`Activity reflection Workflow stopped with unsupported status ${result.status}.`,
		);
	}

	private answerPlanning(params: PlanningAnswerParams): RunAcceptedResult {
		this.ensureReady();
		const runId = requiredString(params.runId, "runId");
		const sessionId = requiredString(params.sessionId, "sessionId");
		const originatingRequestId = requiredString(
			params.originatingRequestId,
			"originatingRequestId",
		);
		const answers = validatePlanningAnswers(params.answers);
		const expectedVersion = optionalVersion(params.expectedVersion);
		const record = this.runs.get(runId);
		if (!record) {
			const rehydrating = this.createRun(
				originatingRequestId,
				runId,
				"planning",
			);
			rehydrating.snapshot.sessionId = sessionId;
			this.schedule(rehydrating, () =>
				this.executeRehydratedPlanningAnswer(
					rehydrating,
					sessionId,
					answers,
					expectedVersion,
				),
			);
			return accepted(rehydrating);
		}
		const planning = record.planning;
		if (
			record.snapshot.kind !== "planning" ||
			!planning ||
			record.snapshot.sessionId !== sessionId ||
			planning.state.sessionId !== sessionId
		) {
			throw runtimeError(
				"SESSION_NOT_FOUND",
				`Planning run ${runId} does not own session ${sessionId}.`,
			);
		}
		if (record.snapshot.requestId !== originatingRequestId) {
			throw conflictError(
				"Planning run originating request identity changed during resume.",
				{ runId },
			);
		}
		if (record.snapshot.status !== "suspended") {
			throw runtimeError("RUN_NOT_RESUMABLE", `Run ${runId} is not suspended.`);
		}
		if (
			expectedVersion !== undefined &&
			planning.state.version !== expectedVersion
		) {
			throw conflictError(
				"Planning session version changed before answers were applied.",
				{
					expectedVersion,
					actualVersion: planning.state.version,
				},
			);
		}
		record.snapshot.status = "running";
		record.snapshot.suspendPayload = undefined;
		record.snapshot.updatedAtMs = this.now();
		record.controller = new AbortController();
		this.schedule(record, () =>
			this.executePlanningAnswer(record, sessionId, answers, expectedVersion),
		);
		return accepted(record);
	}

	private async executeRehydratedPlanningAnswer(
		record: RunRecord,
		sessionId: string,
		answers: readonly TaskPlanningAnswer[],
		expectedVersion: number | undefined,
	): Promise<void> {
		try {
			await this.rehydratePlanningRun(record, sessionId);
			if (this.isTerminal(record)) return;
			const planning = record.planning;
			if (!planning)
				throw new Error("Planning run context is missing after recovery.");
			if (
				expectedVersion !== undefined &&
				planning.state.version !== expectedVersion
			) {
				throw conflictError(
					"Planning session version changed before answers were applied.",
					{
						expectedVersion,
						actualVersion: planning.state.version,
					},
				);
			}
			record.snapshot.status = "running";
			record.snapshot.suspendPayload = undefined;
			record.snapshot.updatedAtMs = this.now();
			await this.executePlanningAnswer(
				record,
				sessionId,
				answers,
				expectedVersion,
			);
		} catch (error) {
			await this.failUnlessTerminal(record, error);
		}
	}

	private async rehydratePlanningRun(
		record: RunRecord,
		sessionId: string,
	): Promise<void> {
		const runId = record.snapshot.runId;
		const state = await this.adapters.loadPlanning(sessionId);
		if (state.runId !== runId) {
			throw runtimeError(
				"SESSION_NOT_FOUND",
				`Planning session ${sessionId} does not belong to run ${runId}.`,
			);
		}
		const workflowSnapshot =
			await this.requireStorage().workflows.loadWorkflowSnapshot({
				workflowName: "task-planning",
				runId: state.workflowRunId,
			});
		const clarification =
			planningClarificationFromWorkflowSnapshot(workflowSnapshot);
		if (!clarification) {
			throw runtimeError(
				"RUN_NOT_RESUMABLE",
				`Planning Workflow ${state.workflowRunId} is not suspended for clarification.`,
			);
		}
		if (
			clarification.sessionId !== sessionId ||
			clarification.version !== state.version ||
			clarification.clarificationRounds !== state.clarificationRounds
		) {
			throw conflictError(
				"Planning state and Workflow snapshot changed independently.",
				{
					sessionId,
					planningVersion: state.version,
					workflowVersion: clarification.version,
				},
			);
		}
		if (this.isTerminal(record)) return;
		record.snapshot.status = "suspended";
		record.snapshot.sessionId = sessionId;
		record.snapshot.result = clarification;
		record.snapshot.suspendPayload = clarification;
		record.planning = { operation: "start", state };
	}

	private async executeConversation(
		record: RunRecord,
		operation: "start" | "resume" | "approve" | "decline",
		resumeData?: unknown,
		toolCallId?: string,
	): Promise<void> {
		const context = record.conversation;
		if (!context) throw new Error("Conversation run context is missing.");
		try {
			if (operation === "start")
				await this.emit(record, {
					kind: "run.started",
					runKind: "conversation",
				});
			else
				await this.emit(record, { kind: "run.resumed", decision: operation });
			const agents = this.requireAgents();
			const relay = this.requireRelay();
			const memoryExecution: ConversationMemoryExecutionContext = {
				runId: record.snapshot.runId,
				requestId: record.snapshot.requestId,
				threadId: context.conversationId,
				resourceId: context.resourceId,
				expectedVersion: context.expectedVersion,
				versionChecked: false,
			};
			await this.requireStorage().runConversation(memoryExecution, () =>
				relay.runInContext(
					{
						runId: record.snapshot.runId,
						originatingRequestId: record.snapshot.requestId,
					},
					async () => {
						const requestContext = this.createRequestContext(record);
						const stream =
							operation === "start"
								? await agents.conversation.stream(context.message, {
										runId: record.snapshot.runId,
										abortSignal: record.controller.signal,
										requestContext,
										memory: {
											thread: context.conversationId,
											resource: context.resourceId,
										},
									})
								: await resumeAgentStream(
										agents.conversation,
										operation,
										record.snapshot.runId,
										record.controller.signal,
										resumeData,
										toolCallId,
										requestContext,
										context.conversationId,
										context.resourceId,
									);
						let text = record.snapshot.text ?? "";
						let receivedTextDelta = false;
						for await (const chunk of stream.fullStream) {
							if (this.isTerminal(record)) return;
							if (chunk.type === "text-delta") {
								const delta = chunk.payload.text;
								receivedTextDelta = true;
								text += delta;
								record.snapshot.text = text;
								await this.emit(record, {
									kind: "conversation.text.delta",
									delta,
									text,
								});
								continue;
							}
							if (chunk.type === "tool-call") {
								const toolName = requireCanonicalToolName(
									chunk.payload.toolName,
								);
								await this.emit(record, {
									kind: "agent.tool.call",
									toolCallId: chunk.payload.toolCallId,
									toolName,
								});
								continue;
							}
							if (chunk.type === "tool-call-approval") {
								memoryExecution.suspendedForApproval = true;
								const toolName = requireCanonicalToolName(
									chunk.payload.toolName,
								);
								const argumentsValue = toolArguments(chunk.payload.args);
								let proposal = record.toolProposals.get(
									chunk.payload.toolCallId,
								);
								if (!proposal) {
									proposal = await this.adapters.proposeTool({
										runId: record.snapshot.runId,
										toolCallId: chunk.payload.toolCallId,
										name: toolName,
										arguments: argumentsValue,
									});
									record.toolProposals.set(chunk.payload.toolCallId, proposal);
								}
								await this.emit(record, {
									kind: "agent.tool.approval.required",
									toolCallId: chunk.payload.toolCallId,
									toolName,
									approval: publicToolApproval(proposal),
									runVersion: proposal.runVersion,
								});
								continue;
							}
							if (chunk.type === "tool-result") {
								const toolName = requireCanonicalToolName(
									chunk.payload.toolName,
								);
								await this.emit(record, {
									kind: "agent.tool.result",
									toolCallId: chunk.payload.toolCallId,
									toolName,
									isError: chunk.payload.isError === true,
								});
							}
						}
						if (this.isTerminal(record)) return;
						const finishReason = await stream.finishReason;
						if (finishReason === "suspended" || stream.status === "suspended") {
							const proposal = [...record.toolProposals.values()].at(-1);
							await this.suspend(
								record,
								proposal
									? {
											kind: "tool-approval",
											toolCallId: proposal.toolCallId,
											toolName: proposal.name,
											approval: publicToolApproval(proposal),
											runVersion: proposal.runVersion,
										}
									: { kind: "agent-suspended" },
							);
							return;
						}
						const finalText = await stream.text;
						if (!receivedTextDelta && finalText) {
							text += finalText;
							record.snapshot.text = text;
						}
						const memoryVersion = memoryExecution.persistedVersion;
						if (memoryVersion === undefined) {
							throw runtimeError(
								"INTERNAL_ERROR",
								"Mastra Memory did not persist the completed conversation turn.",
							);
						}
						await this.complete(record, {
							conversationId: context.conversationId,
							message: { role: "assistant", content: text },
							memoryVersion,
						});
					},
				),
			);
		} catch (error) {
			await this.failUnlessTerminal(record, error);
		}
	}

	private async executeActivityAnalysis(record: RunRecord): Promise<void> {
		const activity = record.activity;
		if (!activity || record.snapshot.kind !== "activity") {
			throw new Error("Activity analysis run context is missing.");
		}
		try {
			await this.emit(record, { kind: "run.started", runKind: "activity" });
			const agents = this.requireAgents();
			const relay = this.requireRelay();
			await relay.runInContext(
				{
					runId: record.snapshot.runId,
					originatingRequestId: record.snapshot.requestId,
				},
				async () => {
					const stream = await agents.activity.stream(
						activityAnalysisPrompt(activity),
						{
							runId: record.snapshot.runId,
							abortSignal: record.controller.signal,
							requestContext: this.createRequestContext(record),
						},
					);
					let text = "";
					for await (const chunk of stream.fullStream) {
						if (this.isTerminal(record)) return;
						if (chunk.type === "text-delta") {
							text += chunk.payload.text;
							if (text.length > maxConversationCharacters) {
								throw runtimeError(
									"INVALID_REQUEST",
									"Activity analysis response is too large.",
								);
							}
							continue;
						}
						if (
							chunk.type === "tool-call" ||
							chunk.type === "tool-call-approval" ||
							chunk.type === "tool-result"
						) {
							throw runtimeError(
								"INTERNAL_ERROR",
								"Activity analysis Agent attempted to use a forbidden Tool.",
							);
						}
					}
					if (this.isTerminal(record)) return;
					const finishReason = await stream.finishReason;
					if (finishReason === "suspended" || stream.status === "suspended") {
						throw runtimeError(
							"INTERNAL_ERROR",
							"Activity analysis Agent suspended unexpectedly.",
						);
					}
					const finalText = await stream.text;
					if (!text && finalText) text = finalText;
					if (!text.trim()) {
						throw runtimeError(
							"INTERNAL_ERROR",
							"Activity analysis Agent returned an empty summary.",
						);
					}
					await this.complete(record, {
						activityJobId: activity.activityJobId,
						summary: text,
					});
				},
			);
		} catch (error) {
			await this.failUnlessTerminal(record, error);
		}
	}

	private async executeTool(input: AgentToolExecutionInput): Promise<unknown> {
		const record = this.requireRun(input.runId);
		if (record.snapshot.status !== "running" || this.isTerminal(record)) {
			throw runtimeError(
				"RUN_NOT_RESUMABLE",
				`Run ${input.runId} cannot execute a Tool.`,
			);
		}
		const proposal = record.toolProposals.get(input.toolCallId) ?? null;
		if (isApprovalRequiredToolName(input.name) && !proposal) {
			throw runtimeError(
				"INVALID_REQUEST",
				`Write Tool ${input.name} has no persisted approval proposal.`,
			);
		}
		if (proposal && proposal.name !== input.name) {
			throw runtimeError(
				"RUN_CONFLICT",
				"Approved Tool name changed before execution.",
			);
		}
		return this.adapters.callTool(proposal, input);
	}

	private createRequestContext(record: RunRecord): RequestContext {
		return new RequestContext([
			["runId", record.snapshot.runId],
			["requestId", record.snapshot.requestId],
		]);
	}

	private async executePlanningStart(record: RunRecord): Promise<void> {
		const planning = record.planning;
		if (!planning) throw new Error("Planning run context is missing.");
		try {
			await this.emit(record, { kind: "run.started", runKind: "planning" });
			planning.state.workflowRunId = await this.adapters.startPlanningWorkflow({
				sessionId: planning.state.sessionId,
				runId: record.snapshot.runId,
				planningInput: planning.state.input,
			});
			if (this.isTerminal(record)) return;
			await this.runPlanningWorkflow(record, "start");
		} catch (error) {
			await this.failUnlessTerminal(record, error);
		}
	}

	private async executePlanningAnswer(
		record: RunRecord,
		sessionId: string,
		answers: readonly TaskPlanningAnswer[],
		expectedVersion: number | undefined,
	): Promise<void> {
		try {
			await this.emit(record, { kind: "run.resumed", decision: "resume" });
			const state = await this.adapters.loadPlanning(sessionId);
			if (this.isTerminal(record)) return;
			const current = record.planning?.state;
			if (!current || state.workflowRunId !== current.workflowRunId) {
				throw conflictError(
					"Planning workflow identity changed before answers were applied.",
					{
						sessionId,
					},
				);
			}
			if (state.version !== current.version) {
				throw conflictError(
					"Planning session changed while clarification was suspended.",
					{
						expectedVersion: current.version,
						actualVersion: state.version,
					},
				);
			}
			if (expectedVersion !== undefined && state.version !== expectedVersion) {
				throw conflictError(
					"Planning session version changed before answers were applied.",
					{
						expectedVersion,
						actualVersion: state.version,
					},
				);
			}
			await this.adapters.resumePlanningWorkflow({
				workflowRunId: state.workflowRunId,
				sessionId,
				runId: record.snapshot.runId,
				answers,
			});
			if (this.isTerminal(record)) return;
			record.planning = {
				operation: "answer",
				state: { ...state, answers: [...state.answers, ...answers] },
			};
			await this.runPlanningWorkflow(record, "answer", {
				sessionId,
				answers: [...answers],
				expectedVersion,
			});
		} catch (error) {
			await this.failUnlessTerminal(record, error);
		}
	}

	private async runPlanningWorkflow(
		record: RunRecord,
		operation: "start" | "answer",
		resumeData?: PlanningWorkflowResume,
	): Promise<void> {
		const planning = record.planning;
		if (!planning) throw new Error("Planning run context is missing.");
		if (this.isTerminal(record)) return;
		const run = await this.requireAgents().planningWorkflow.createRun({
			runId: planning.state.workflowRunId,
		});
		const cancelWorkflow = () => {
			void run
				.cancel()
				.catch((error) => this.onBackgroundError(asError(error)));
		};
		record.controller.signal.addEventListener("abort", cancelWorkflow, {
			once: true,
		});
		try {
			const requestContext = this.createRequestContext(record);
			const result =
				operation === "start"
					? await run.start({
							inputData: {
								sidecarRunId: record.snapshot.runId,
								sessionId: planning.state.sessionId,
							},
							requestContext,
						})
					: await run.resume({
							label: planningWorkflowResumeLabel,
							resumeData,
							requestContext,
						});

			if (this.isTerminal(record) || record.controller.signal.aborted) return;
			if (result.status === "suspended") {
				const suspendedStep = result.steps[planningWorkflowStepId];
				const clarification = planningWorkflowClarificationSchema.parse(
					suspendedStep?.suspendPayload ?? result.suspendPayload,
				);
				record.snapshot.result = clarification;
				await this.suspend(record, clarification);
				return;
			}
			if (result.status === "success") {
				const completion = planningWorkflowCompletionSchema.parse(
					result.result,
				);
				record.snapshot.result = completion;
				await this.complete(record, completion);
				return;
			}
			if (result.status === "failed") throw result.error;
			throw runtimeError(
				"INTERNAL_ERROR",
				`Planning Workflow stopped with unsupported status ${result.status}.`,
			);
		} finally {
			record.controller.signal.removeEventListener("abort", cancelWorkflow);
		}
	}

	private async executePlanningWorkflowCycle({
		input,
		resumeData,
		abortSignal,
	}: PlanningWorkflowDriverInput): Promise<PlanningWorkflowOutcome> {
		const record = this.requireRun(input.sidecarRunId);
		const planning = record.planning;
		if (
			record.snapshot.kind !== "planning" ||
			!planning ||
			record.snapshot.sessionId !== input.sessionId ||
			planning.state.sessionId !== input.sessionId
		) {
			throw conflictError(
				"Planning Workflow does not match the active planning run.",
				{
					runId: input.sidecarRunId,
					sessionId: input.sessionId,
				},
			);
		}
		if (this.isTerminal(record)) {
			throw runtimeError(
				"RUN_NOT_RESUMABLE",
				`Run ${input.sidecarRunId} is terminal.`,
			);
		}
		if (resumeData) {
			if (
				planning.operation !== "answer" ||
				resumeData.sessionId !== planning.state.sessionId ||
				(resumeData.expectedVersion !== undefined &&
					resumeData.expectedVersion !== planning.state.version) ||
				!answersMatchTail(planning.state.answers, resumeData.answers)
			) {
				throw conflictError(
					"Planning Workflow resume data does not match persisted answers.",
					{
						runId: input.sidecarRunId,
						sessionId: input.sessionId,
					},
				);
			}
		} else if (planning.operation !== "start") {
			throw conflictError(
				"Planning Workflow is missing its clarification resume data.",
				{
					runId: input.sidecarRunId,
					sessionId: input.sessionId,
				},
			);
		}
		const calendar = await this.adapters.queryCalendar(planning.state.input);
		return this.executePlanningModel(record, calendar, abortSignal);
	}

	private async executeActivityReflectionWorkflow({
		invocationId,
		requestId,
		userPrompt,
		signalSegmentIds,
		candidateActivities,
		abortSignal,
	}: ActivityReflectionWorkflowDriverInput) {
		const agents = this.requireAgents();
		const relay = this.requireReflectionRelay();
		return relay.runInContext(
			{ runId: invocationId, originatingRequestId: requestId },
			async () => {
				const runtimeOutputSchema = createActivityReflectionRuntimeOutputSchema(
					signalSegmentIds,
					candidateActivities,
				);
				const nativeSkillContext =
					await loadActivityReflectionNativeSkillContext(
						agents.activityReflectionSkillCatalog,
					);
				const result = await agents.activityReflection.generate(userPrompt, {
					runId: invocationId,
					abortSignal,
					requestContext: new RequestContext(),
					// Qwen's CPU Ollama endpoint does not honor the native Skill tool
					// calls reliably. The rules above were already loaded locally via
					// Mastra's `getSkill()` API, so make exactly one no-Tool model call.
					maxSteps: 1,
					toolChoice: "none",
					// Reflection is a deterministic classification/aggregation task.
					// Keep CPU Qwen sampling stable across retryable sealed windows.
					modelSettings: { temperature: 0 },
					context: [nativeSkillContext],
					structuredOutput: {
						schema: runtimeOutputSchema,
						errorStrategy: "strict",
						// This one-step call has no Tools, so native structured output
						// can constrain CPU Ollama without the former tool/schema conflict.
						jsonPromptInjection: false,
					},
				});
				return activityReflectionModelOutputSchema.parse(
					runtimeOutputSchema.parse(result.object),
				);
			},
		);
	}

	private async executePlanningModel(
		record: RunRecord,
		calendar: CalendarSnapshot,
		workflowAbortSignal: AbortSignal,
	): Promise<PlanningWorkflowOutcome> {
		const planning = record.planning;
		if (!planning) throw new Error("Planning run context is missing.");
		const agents = this.requireAgents();
		const relay = this.requireRelay();
		const abortSignal = AbortSignal.any([
			record.controller.signal,
			workflowAbortSignal,
		]);
		return relay.runInContext(
			{
				runId: record.snapshot.runId,
				originatingRequestId: record.snapshot.requestId,
			},
			async () => {
				const requestContext = this.createRequestContext(record);
				const stream = await agents.planning.stream(
					planningPrompt(planning.state, calendar),
					{
						runId: planningAgentRunId(record, "draft"),
						abortSignal,
						requestContext,
						structuredOutput: {
							schema: taskPlanningResultSchema,
							errorStrategy: "strict",
						},
					},
				);
				const result = await this.consumePlanningStream(record, stream);
				if (!result)
					throw runtimeError(
						"RUN_NOT_RESUMABLE",
						"Planning run was cancelled.",
					);
				if (result.status === "clarifying") {
					if (planning.state.clarificationRounds >= maxClarificationRounds) {
						throw runtimeError(
							"INTERNAL_ERROR",
							"The planning model exceeded the three-round clarification limit.",
						);
					}
					planning.state.clarificationRounds += 1;
					planning.state.version = await this.adapters.savePlanning(
						planning.state,
						result,
					);
					const clarification: PlanningWorkflowClarification = {
						kind: "planning.clarification",
						sessionId: planning.state.sessionId,
						status: "clarifying" as const,
						clarificationRounds: planning.state.clarificationRounds,
						version: planning.state.version,
						questions: result.questions,
					};
					record.snapshot.result = clarification;
					return clarification;
				}

				let draft = result.draft;
				let validation = await this.adapters.validatePlanning(
					planning.state.sessionId,
					draft,
				);
				if (!validation.ok) {
					const latestCalendar = await this.adapters.queryCalendar(
						planning.state.input,
					);
					const repairStream = await agents.planning.stream(
						planningRepairPrompt(
							planning.state,
							draft,
							validation.issues,
							latestCalendar,
						),
						{
							runId: planningAgentRunId(record, "repair"),
							abortSignal,
							requestContext: this.createRequestContext(record),
							structuredOutput: {
								schema: taskPlanningResultSchema,
								errorStrategy: "strict",
							},
						},
					);
					const repaired = await this.consumePlanningStream(
						record,
						repairStream,
					);
					if (!repaired)
						throw runtimeError(
							"RUN_NOT_RESUMABLE",
							"Planning run was cancelled.",
						);
					if (repaired.status === "draft") {
						draft = repaired.draft;
						validation = await this.adapters.validatePlanning(
							planning.state.sessionId,
							draft,
						);
					} else {
						validation = {
							ok: false,
							issues: [
								...validation.issues,
								{
									code: "repair-returned-clarifying",
									message: "规划修复重试没有返回可校验的 draft。",
								},
							],
						};
					}
				}

				if (!validation.ok) {
					const conflict = {
						status: "conflict" as const,
						draft,
						validationIssues: validation.issues.map((issue) => ({
							code: issue.code,
							message: issue.message,
							...(issue.proposalId ? { proposalId: issue.proposalId } : {}),
							...(issue.busyEventIds
								? { busyEventIds: [...issue.busyEventIds] }
								: {}),
						})),
					};
					planning.state.version = await this.adapters.savePlanning(
						planning.state,
						conflict,
					);
					const completion: PlanningWorkflowCompletion = {
						sessionId: planning.state.sessionId,
						...conflict,
						clarificationRounds: planning.state.clarificationRounds,
						version: planning.state.version,
					};
					record.snapshot.result = completion;
					return completion;
				}

				planning.state.version = await this.adapters.savePlanning(
					planning.state,
					{
						status: "draft",
						draft,
					},
				);
				const completion: PlanningWorkflowCompletion = {
					sessionId: planning.state.sessionId,
					status: "draft",
					clarificationRounds: planning.state.clarificationRounds,
					version: planning.state.version,
					draft,
				};
				record.snapshot.result = completion;
				return completion;
			},
		);
	}

	private async consumePlanningStream(
		record: RunRecord,
		stream: MastraModelOutput<TaskPlanningResult>,
	): Promise<TaskPlanningResult | null> {
		for await (const object of stream.objectStream) {
			if (this.isTerminal(record)) return null;
			record.snapshot.result = object;
			await this.emit(record, { kind: "planning.object.delta", object });
		}
		if (this.isTerminal(record)) return null;
		const finishReason = await stream.finishReason;
		if (finishReason === "suspended" || stream.status === "suspended") {
			throw runtimeError(
				"INTERNAL_ERROR",
				"Planning Agent suspended unexpectedly outside the planning Workflow boundary.",
			);
		}
		return taskPlanningResultSchema.parse(await stream.object);
	}

	private resumeRun(
		originatingRequestId: string,
		runId: string,
		resumeData: unknown,
		toolCallId: string | undefined,
		decision: "resume" | "approve" | "decline",
	): RunAcceptedResult {
		this.ensureReady();
		const record = this.requireRun(runId);
		if (
			record.snapshot.requestId !==
			requiredString(originatingRequestId, "originatingRequestId")
		) {
			throw conflictError(
				"Agent run originating request identity changed during resume.",
				{ runId },
			);
		}
		if (record.snapshot.status !== "suspended") {
			throw runtimeError("RUN_NOT_RESUMABLE", `Run ${runId} is not suspended.`);
		}
		if (record.snapshot.kind === "planning") {
			throw runtimeError(
				"RUN_NOT_RESUMABLE",
				"Planning Workflow suspension must be resumed with planning.answer.",
			);
		}
		if (
			decision === "resume" &&
			isRecord(record.snapshot.suspendPayload) &&
			record.snapshot.suspendPayload.kind === "tool-approval"
		) {
			throw runtimeError(
				"RUN_NOT_RESUMABLE",
				"Tool approval must be resolved with agent.approveTool or agent.declineTool.",
			);
		}
		if (decision !== "resume") {
			const decisionToolCallId = requiredString(toolCallId, "toolCallId");
			if (!record.toolProposals.has(decisionToolCallId)) {
				throw conflictError(
					"Tool approval does not match this suspended run.",
					{
						toolCallId: decisionToolCallId,
					},
				);
			}
		}
		record.snapshot.status = "running";
		record.snapshot.suspendPayload = undefined;
		record.snapshot.updatedAtMs = this.now();
		record.controller = new AbortController();
		this.schedule(record, () =>
			this.executeConversation(
				record,
				decision,
				resumeData,
				optionalString(toolCallId),
			),
		);
		return accepted(record);
	}

	private async cancelRun(
		runId: string,
		reason?: string,
	): Promise<{
		accepted: true;
		runId: string;
		status: AgentRunSnapshot["status"];
	}> {
		this.ensureReady();
		const record = this.requireRun(requiredString(runId, "runId"));
		if (!this.isTerminal(record))
			await this.cancelRecord(record, optionalString(reason) ?? null);
		return { accepted: true, runId, status: record.snapshot.status };
	}

	private async cancelRecord(
		record: RunRecord,
		reason: string | null,
	): Promise<void> {
		record.cancelReason = reason;
		record.controller.abort(reason ?? "Run cancelled");
		this.agents?.conversation.abortRunStream(record.snapshot.runId);
		this.agents?.planning.abortRunStream(record.snapshot.runId);
		this.agents?.activity.abortRunStream(record.snapshot.runId);
		record.snapshot.status = "cancelled";
		record.snapshot.terminalState = "cancelled";
		record.toolProposals.clear();
		await this.emit(record, { kind: "run.cancelled", reason });
	}

	private snapshot(runId: string): AgentRunSnapshot {
		this.ensureReady();
		return structuredClone(
			this.requireRun(requiredString(runId, "runId")).snapshot,
		);
	}

	private createRun(
		requestId: string,
		runId: string,
		kind: AgentRunSnapshot["kind"],
		conversation?: ConversationRunContext,
	): RunRecord {
		if (this.runs.has(runId)) {
			throw runtimeError("RUN_CONFLICT", `Run ID ${runId} already exists.`);
		}
		this.pruneRuns();
		const timestamp = this.now();
		const record: RunRecord = {
			snapshot: {
				runId,
				requestId,
				kind,
				status: "running",
				sequence: 0,
				version: 0,
				startedAtMs: timestamp,
				updatedAtMs: timestamp,
				terminalState: null,
				...(conversation
					? { conversationId: conversation.conversationId }
					: {}),
			},
			controller: new AbortController(),
			cancelReason: null,
			conversation,
			toolProposals: new Map(),
		};
		this.runs.set(runId, record);
		return record;
	}

	private async emit(
		record: RunRecord,
		event: AgentRunEventPayload,
	): Promise<void> {
		record.snapshot.sequence += 1;
		record.snapshot.version += 1;
		record.snapshot.updatedAtMs = this.now();
		const frame: AgentRunEventFrame = {
			protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
			type: "event",
			requestId: record.snapshot.requestId,
			runId: record.snapshot.runId,
			sequence: record.snapshot.sequence,
			version: record.snapshot.version,
			emittedAtMs: record.snapshot.updatedAtMs,
			terminalState: record.snapshot.terminalState,
			event,
		};
		await this.writer.write(frame);
	}

	private async complete(record: RunRecord, result: unknown): Promise<void> {
		if (this.isTerminal(record)) return;
		record.snapshot.status = "completed";
		record.snapshot.terminalState = "completed";
		record.snapshot.result = result;
		record.toolProposals.clear();
		await this.emit(record, { kind: "run.completed", result });
	}

	private async suspend(
		record: RunRecord,
		suspendPayload: unknown,
	): Promise<void> {
		if (this.isTerminal(record)) return;
		record.snapshot.status = "suspended";
		record.snapshot.suspendPayload = suspendPayload;
		await this.emit(record, { kind: "run.suspended", suspendPayload });
	}

	private async failUnlessTerminal(
		record: RunRecord,
		error: unknown,
	): Promise<void> {
		if (this.isTerminal(record)) return;
		if (record.controller.signal.aborted) {
			await this.cancelRecord(record, record.cancelReason);
			return;
		}
		const payload = protocolError(error);
		record.snapshot.status = "failed";
		record.snapshot.terminalState = "failed";
		record.snapshot.error = payload;
		record.toolProposals.clear();
		await this.emit(record, { kind: "run.failed", error: payload });
	}

	private ensureReady(): void {
		if (
			!this.initialized ||
			!this.agents ||
			!this.relay ||
			!this.reflectionRelay
		) {
			throw runtimeError(
				"NOT_INITIALIZED",
				"Call runtime.initialize before starting a run.",
				true,
			);
		}
		if (this.shuttingDown) {
			throw runtimeError("INVALID_REQUEST", "The Agent host is shutting down.");
		}
	}

	private requireAgents(): MastraAgentSet {
		this.ensureReady();
		return this.agents as MastraAgentSet;
	}

	private requireRelay(): ModelRelay {
		this.ensureReady();
		return this.relay as ModelRelay;
	}

	private requireReflectionRelay(): ModelRelay {
		this.ensureReady();
		return this.reflectionRelay as ModelRelay;
	}

	private requireStorage(): HostMastraStorage {
		this.ensureReady();
		return this.storage as HostMastraStorage;
	}

	private requireRun(runId: string): RunRecord {
		const record = this.runs.get(runId);
		if (!record)
			throw runtimeError("RUN_NOT_FOUND", `Run ${runId} does not exist.`);
		return record;
	}

	private isTerminal(record: RunRecord): boolean {
		return record.snapshot.terminalState !== null;
	}

	private schedule(record: RunRecord, operation: () => Promise<void>): void {
		setImmediate(() => {
			void this.hostRunContext
				.run(record.snapshot.runId, operation)
				.catch((error) => this.onBackgroundError(asError(error)));
		});
	}

	private pruneRuns(): void {
		if (this.runs.size < maxRetainedRuns) return;
		for (const [runId, record] of this.runs) {
			if (!this.isTerminal(record)) continue;
			this.runs.delete(runId);
			if (this.runs.size < maxRetainedRuns) return;
		}
	}
}

function accepted(record: RunRecord): RunAcceptedResult {
	return {
		accepted: true,
		runId: record.snapshot.runId,
		status: "running",
		version: record.snapshot.version,
	};
}

async function resumeAgentStream(
	agent: Agent,
	decision: "resume" | "approve" | "decline",
	runId: string,
	abortSignal: AbortSignal,
	resumeData: unknown,
	toolCallId?: string,
	requestContext?: RequestContext,
	threadId?: string,
	resourceId?: string,
) {
	const memory =
		threadId && resourceId
			? { thread: threadId, resource: resourceId }
			: undefined;
	if (decision === "approve") {
		return agent.approveToolCall({
			runId,
			toolCallId,
			abortSignal,
			requestContext,
			memory,
		});
	}
	if (decision === "decline") {
		return agent.declineToolCall({
			runId,
			toolCallId,
			abortSignal,
			requestContext,
			memory,
		});
	}
	return agent.resumeStream(resumeData, {
		runId,
		toolCallId,
		abortSignal,
		requestContext,
		memory,
	});
}

function planningPrompt(
	state: HostPlanningState,
	calendar: CalendarSnapshot,
): string {
	const remainingClarificationRounds = Math.max(
		0,
		maxClarificationRounds - state.clarificationRounds,
	);
	return [
		"请根据以下权威输入生成本轮计划结果。",
		`本轮剩余可用澄清轮数：${remainingClarificationRounds}。为 0 时必须返回 draft，不得继续 clarifying。`,
		"draft.calendarRevision 必须等于完整日历快照 revision。所有 schedule 必须避开日历占用，并处于 snapshot.fromDate（含）到目标 deadline（含）范围内。",
		"draft.phases 必须至少包含一个按 order 排序的明确阶段；每个 milestone.phaseId 必须引用 phases 中已有的 ID。",
		"规划输入：",
		JSON.stringify(state.input),
		"已确认答案：",
		JSON.stringify(state.answers),
		"完整日历快照：",
		JSON.stringify(calendar),
	].join("\n");
}

function planningRepairPrompt(
	state: HostPlanningState,
	originalDraft: TaskPlanningDraft,
	issues: readonly PlanningValidationIssue[],
	calendar: CalendarSnapshot,
): string {
	return [
		"上一次 draft 未通过 Bun 主进程的权威校验。你只有这一次修复机会。",
		"必须返回 status=draft；不得继续提问，不得虚构已执行或已提交的日历变更。",
		"逐项修复 validationIssues，并令 draft.calendarRevision 等于最新 snapshot.revision。",
		"保留或修复 phases 的明确顺序，并确保每个 milestone.phaseId 都引用已有阶段 ID。",
		"规划输入：",
		JSON.stringify(state.input),
		"已确认答案：",
		JSON.stringify(state.answers),
		"原始 draft：",
		JSON.stringify(originalDraft),
		"validationIssues：",
		JSON.stringify(issues),
		"最新完整日历快照：",
		JSON.stringify(calendar),
	].join("\n");
}

function planningAgentRunId(
	record: RunRecord,
	phase: "draft" | "repair",
): string {
	const planning = record.planning;
	if (!planning) throw new Error("Planning run context is missing.");
	return [
		planning.state.workflowRunId,
		planning.state.clarificationRounds,
		planning.state.answers.length,
		phase,
	].join(":");
}

function planningClarificationFromWorkflowSnapshot(
	value: unknown,
): PlanningWorkflowClarification | null {
	if (
		!isRecord(value) ||
		value.status !== "suspended" ||
		!isRecord(value.context)
	) {
		return null;
	}
	const step = value.context[planningWorkflowStepId];
	if (!isRecord(step) || step.status !== "suspended") return null;
	const parsed = planningWorkflowClarificationSchema.safeParse(
		step.suspendPayload,
	);
	return parsed.success ? parsed.data : null;
}

function answersMatchTail(
	allAnswers: readonly TaskPlanningAnswer[],
	resumeAnswers: readonly TaskPlanningAnswer[],
): boolean {
	if (allAnswers.length < resumeAnswers.length) return false;
	const offset = allAnswers.length - resumeAnswers.length;
	return resumeAnswers.every((answer, index) => {
		const persisted = allAnswers[offset + index];
		return (
			persisted?.questionKey === answer.questionKey &&
			persisted.answerText === answer.answerText
		);
	});
}

function activityAnalysisPrompt(context: ActivityAnalysisRunContext): string {
	const serializedAnalyses = JSON.stringify(context.analyses);
	if (serializedAnalyses.length > MAXIMUM_ACTIVITY_ANALYSIS_PROMPT_CHARACTERS) {
		throw runtimeError(
			"INVALID_REQUEST",
			"Activity analysis exceeds the prompt safety limit.",
		);
	}
	return [
		"以下是已经由活动 Worker 整理过的事件和分数，不是原始活动窗口。",
		"只能根据这些 Worker 结果生成后台反思摘要；不得要求或猜测原始桌面内容，不得调用任何工具。",
		`可消费总分：${context.consumedScore}`,
		"Worker 结果：",
		serializedAnalyses,
		"请用简洁中文输出：事件主题、分数含义、以及一个谨慎的下一步建议。",
	].join("\n");
}

function validateActivityAnalysisWorkerResults(
	value: unknown,
): readonly ActivityAnalysisWorkerResult[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > MAXIMUM_ACTIVITY_ANALYSIS_RESULTS
	) {
		throw runtimeError(
			"INVALID_REQUEST",
			"Activity analysis must contain Worker results.",
		);
	}
	const analyses = value.map((analysis) => {
		if (!isActivityAnalysisWorkerResult(analysis)) {
			throw runtimeError(
				"INVALID_REQUEST",
				"Activity analysis may contain Worker results only.",
			);
		}
		return structuredClone(analysis);
	});
	if (
		serializedActivityAnalysisLength(analyses) >
		MAXIMUM_ACTIVITY_ANALYSIS_PROMPT_CHARACTERS
	) {
		throw runtimeError(
			"INVALID_REQUEST",
			"Activity analysis exceeds the prompt safety limit.",
		);
	}
	return analyses;
}

function validateConversationMessage(value: unknown): ConversationInputMessage {
	if (
		!isRecord(value) ||
		(value.role !== "user" && value.role !== "assistant") ||
		typeof value.content !== "string" ||
		value.content.length > maxConversationCharacters
	) {
		throw runtimeError(
			"INVALID_REQUEST",
			"Conversation history contains an invalid message.",
		);
	}
	return { role: value.role, content: value.content };
}

function validatePlanningAnswers(
	value: unknown,
): readonly TaskPlanningAnswer[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
		throw runtimeError(
			"INVALID_REQUEST",
			"Planning answers must contain one to three items.",
		);
	}
	return value.map((answer) => {
		if (
			!isRecord(answer) ||
			typeof answer.questionKey !== "string" ||
			!taskPlanningQuestionKeySchema.safeParse(answer.questionKey).success ||
			typeof answer.answerText !== "string" ||
			!answer.answerText.trim()
		) {
			throw runtimeError(
				"INVALID_REQUEST",
				"Planning answers contain an invalid item.",
			);
		}
		return answer as unknown as TaskPlanningAnswer;
	});
}

function validatePlanningInput(value: unknown): TaskPlanningInput {
	if (!isRecord(value))
		throw runtimeError("INVALID_REQUEST", "Planning input must be an object.");
	const minutes = value.preferredSessionMinutes;
	if (
		typeof value.goal !== "string" ||
		!value.goal.trim() ||
		(value.planType !== "short-term" && value.planType !== "long-term") ||
		typeof value.deadline !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(value.deadline) ||
		(value.priority !== "low" &&
			value.priority !== "medium" &&
			value.priority !== "high") ||
		typeof value.weeklyCapacityHours !== "number" ||
		!Number.isFinite(value.weeklyCapacityHours) ||
		value.weeklyCapacityHours <= 0 ||
		!Array.isArray(value.unavailableDays) ||
		!value.unavailableDays.every((day) => typeof day === "string") ||
		!([30, 45, 60, 90] as const).includes(minutes as 30) ||
		(value.preferredDayPart !== "morning" &&
			value.preferredDayPart !== "afternoon" &&
			value.preferredDayPart !== "evening" &&
			value.preferredDayPart !== "flexible") ||
		typeof value.timeZone !== "string" ||
		!value.timeZone
	) {
		throw runtimeError("INVALID_REQUEST", "Planning input is invalid.");
	}
	return value as unknown as TaskPlanningInput;
}

function requiredString(value: unknown, name: string, max = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw runtimeError(
			"INVALID_REQUEST",
			`${name} must be a non-empty string up to ${max} characters.`,
		);
	}
	return value;
}

function requiredNonNegativeFiniteNumber(value: unknown, name: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 10_000
	) {
		throw runtimeError(
			"INVALID_REQUEST",
			`${name} must be a non-negative finite number.`,
		);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		throw runtimeError(
			"INVALID_REQUEST",
			"Optional string values cannot be empty.",
		);
	}
	return value;
}

function optionalVersion(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw runtimeError(
			"INVALID_REQUEST",
			"Version must be a non-negative safe integer.",
		);
	}
	return value as number;
}

function requireCanonicalToolName(
	value: string,
): NonNullable<ReturnType<typeof canonicalToolName>> {
	const name = canonicalToolName(value);
	if (!name) {
		throw runtimeError(
			"INVALID_REQUEST",
			`Agent attempted to use unavailable Tool ${value}.`,
		);
	}
	return name;
}

function toolArguments(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || Array.isArray(value)) {
		throw runtimeError(
			"INVALID_REQUEST",
			"Agent Tool arguments must be an object.",
		);
	}
	const { __mastraMetadata: _metadata, ...argumentsValue } = value;
	return structuredClone(argumentsValue);
}

function publicToolApproval(proposal: HostToolProposal) {
	return {
		approvalId: proposal.approvalId,
		toolCallId: proposal.toolCallId,
		title: proposal.title,
		description: proposal.description,
		risk: proposal.risk,
		inputDigest: proposal.inputDigest,
		requestedAtMs: proposal.requestedAtMs,
		expiresAtMs: proposal.expiresAtMs,
	};
}

function conflictError(
	message: string,
	details: Record<string, unknown>,
): AgentHostRuntimeError {
	return new AgentHostRuntimeError({
		code: "RUN_CONFLICT",
		message,
		retryable: true,
		details,
	});
}

function runtimeError(
	code: AgentHostErrorPayload["code"],
	message: string,
	retryable = false,
): AgentHostRuntimeError {
	return new AgentHostRuntimeError({ code, message, retryable });
}

class ActivityReflectionWorkflowDeadlineError extends Error {
	constructor() {
		super("Activity reflection workflow timed out.");
		this.name = "ActivityReflectionWorkflowDeadlineError";
	}
}

/**
 * Makes the no-persistence workflow cancellable even when an upstream model
 * implementation never settles. The losing operation remains observed, so a
 * late resolution/rejection cannot become an unhandled promise rejection.
 */
export function runActivityReflectionWithDeadline<TResult>(
	operation: () => Promise<TResult>,
	cancel: () => Promise<void>,
	timeoutMs: number,
	onCancelError: (error: unknown) => void = () => undefined,
): Promise<TResult> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		return Promise.reject(new Error("Activity reflection timeout is invalid."));
	}
	return new Promise<TResult>((resolve, reject) => {
		let settled = false;
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			settle();
		};
		const timer = setTimeout(() => {
			finish(() => {
				void cancel().catch(onCancelError);
				reject(new ActivityReflectionWorkflowDeadlineError());
			});
		}, timeoutMs);
		void Promise.resolve()
			.then(operation)
			.then(
				(value) => finish(() => resolve(value)),
				(error: unknown) => finish(() => reject(error)),
			);
	});
}

function asError(error: unknown): Error {
	// Only locally constructed protocol errors can cross the private-stdio
	// boundary verbatim. Model/provider objects can contain arbitrary prompts,
	// outputs or huge serialized payloads, so they deliberately become generic.
	if (error instanceof AgentHostRuntimeError) return error;
	if (isRecord(error) && typeof error.diagnostic === "string") {
		return new Error(error.diagnostic.replace(/[\r\n]+/g, " ").slice(0, 1_000));
	}
	return new Error("Agent runtime operation failed.");
}
