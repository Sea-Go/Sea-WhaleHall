import type { ActivityAnalysisWorkerResult } from "../../shared/activity-analysis-contract";

export const AGENT_HOST_PROTOCOL_VERSION = 1 as const;
export const AGENT_HOST_SERVICE = "whalehall-agent-host" as const;
export const MAX_MODEL_RELAY_CHUNK_BYTES = 64 * 1024;

export type AgentRunKind = "conversation" | "planning" | "activity";
export type AgentRunStatus =
	| "running"
	| "suspended"
	| "completed"
	| "failed"
	| "cancelled";
export type AgentRunTerminalState = Extract<
	AgentRunStatus,
	"completed" | "failed" | "cancelled"
>;

export interface AgentHostErrorPayload {
	code:
		| "INVALID_REQUEST"
		| "NOT_INITIALIZED"
		| "ALREADY_INITIALIZED"
		| "RUN_CONFLICT"
		| "RUN_NOT_FOUND"
		| "RUN_NOT_RESUMABLE"
		| "SESSION_NOT_FOUND"
		| "MODEL_RELAY_ERROR"
		| "MODEL_RELAY_UNAVAILABLE"
		| "CANCELLED"
		| "UNSUPPORTED_METHOD"
		| "INTERNAL_ERROR";
	message: string;
	retryable: boolean;
	details?: Record<string, unknown>;
}

export interface RuntimeInitializeParams {
	protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION;
	client?: {
		name: string;
		version: string;
	};
	model: RuntimeModelConfiguration;
	/**
	 * Separate logical provider for the sealed-window reflection role. Its key
	 * remains in Bun; the Sidecar only creates the already-complete model body.
	 */
	reflectionModel: RuntimeModelConfiguration;
}

export interface RuntimeModelConfiguration {
	provider: string;
	modelId: string;
	/**
	 * A logical OpenAI-compatible base URL. The sidecar never opens this URL;
	 * every request is relayed to the host through `model/relay.open`.
	 */
	baseUrl?: string;
	supportsStructuredOutputs?: boolean;
}

export interface RuntimeInitializeResult {
	service: typeof AGENT_HOST_SERVICE;
	protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION;
	initializedAtMs: number;
	capabilities: {
		methods: readonly AgentHostMethod[];
		hostCalls: readonly SidecarHostMethod[];
		streaming: true;
		structuredPlanning: true;
		listensOnNetwork: false;
	};
}

export interface ConversationInputMessage {
	role: "user" | "assistant";
	content: string;
}

export interface ConversationStartParams {
	runId: string;
	conversationId: string;
	resourceId?: string;
	message: string;
	history?: readonly ConversationInputMessage[];
	expectedVersion?: number;
}

export type TaskPlanningQuestionKey =
	| "task_type"
	| "brief_extraction_confirmation"
	| "expected_outcome"
	| "deadline"
	| "current_progress"
	| "scope"
	| "capacity"
	| "constraints"
	| "skill_context"
	| "risks";

export interface TaskPlanningInput {
	goal: string;
	planType: "short-term" | "long-term";
	deadline: string;
	priority: "low" | "medium" | "high";
	weeklyCapacityHours: number;
	unavailableDays: readonly string[];
	preferredSessionMinutes: 30 | 45 | 60 | 90;
	preferredDayPart: "morning" | "afternoon" | "evening" | "flexible";
	timeZone: string;
}

export interface TaskPlanningAnswer {
	questionKey: TaskPlanningQuestionKey;
	answerText: string;
}

export interface PlanningStartParams {
	runId: string;
	sessionId: string;
	input: TaskPlanningInput;
	expectedVersion?: number;
}

export interface PlanningAnswerParams {
	runId: string;
	sessionId: string;
	/** Durable request identity from the original persisted planning run. */
	originatingRequestId: string;
	answers: readonly TaskPlanningAnswer[];
	expectedVersion?: number;
}

export type { ActivityAnalysisWorkerResult } from "../../shared/activity-analysis-contract";

export interface ActivityAnalysisStartParams {
	runId: string;
	activityJobId: string;
	consumedScore: number;
	analyses: readonly ActivityAnalysisWorkerResult[];
}

/** A local, no-persistence model invocation for one sealed activity window. */
export interface ActivityReflectionAnalyzeParams {
	invocationId: string;
	requestId: string;
	/** Client-derived IDs from the prompt's local signal index. They let the
	 * structured schema forbid invented time segments without sending raw data
	 * over a separate channel. */
	signalSegmentIds: readonly string[];
	/** Union of the candidate activities from this local signal index. The
	 * per-window response schema uses it to rule out unrelated categories. */
	candidateActivities: readonly string[];
	/** Complete client-owned prompt. It may contain raw activity and never leaves
	 * the local Bun/Sidecar process except inside the resulting model request. */
	userPrompt: string;
}

export interface RunTargetParams {
	runId: string;
}

export interface RunCancelParams extends RunTargetParams {
	reason?: string;
}

export interface RunResumeParams extends RunTargetParams {
	originatingRequestId: string;
	resumeData?: unknown;
	toolCallId?: string;
}

export interface AgentToolDecisionParams extends RunTargetParams {
	originatingRequestId: string;
	toolCallId?: string;
	resumeData?: unknown;
	reason?: string;
}

export interface RunAcceptedResult {
	accepted: true;
	runId: string;
	status: "running";
	version: number;
}

export interface AgentRunSnapshot {
	runId: string;
	requestId: string;
	kind: AgentRunKind;
	status: AgentRunStatus;
	sequence: number;
	version: number;
	startedAtMs: number;
	updatedAtMs: number;
	terminalState: AgentRunTerminalState | null;
	conversationId?: string;
	sessionId?: string;
	activityJobId?: string;
	text?: string;
	result?: unknown;
	suspendPayload?: unknown;
	error?: AgentHostErrorPayload;
}

export interface HostPlanningState {
	sessionId: string;
	runId: string;
	input: TaskPlanningInput;
	answers: readonly TaskPlanningAnswer[];
	clarificationRounds: number;
	workflowRunId: string;
	version: number;
}

export type AgentHostMethod =
	| "runtime.initialize"
	| "runtime.shutdown"
	| "conversation.start"
	| "planning.start"
	| "activity.start"
	| "reflection.analyze"
	| "planning.answer"
	| "agent.approveTool"
	| "agent.declineTool"
	| "run.cancel"
	| "run.resume"
	| "run.snapshot";

/** Calls initiated by the Node sidecar and implemented by the authenticated
 * Bun host. The sidecar never opens a model or Local Tool network endpoint. */
export type SidecarHostMethod =
	| "model/relay.open"
	| "model/relay.abort"
	| "memory/load"
	| "memory/append"
	| "workflow/start"
	| "workflow/resume"
	| "workflow/snapshot.persist"
	| "workflow/snapshot.load"
	| "workflow/snapshot.list"
	| "workflow/snapshot.get"
	| "workflow/snapshot.delete"
	| "workflow/snapshot.update-results"
	| "workflow/snapshot.update-state"
	| "calendar/query"
	| "calendar/mutate"
	| "planning/load"
	| "planning/save"
	| "planning/validate"
	| "tool/list"
	| "tool/propose"
	| "tool/call"
	| "tool/cancel";

interface RequestEnvelope<M extends string, P> {
	protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION;
	type: "request";
	requestId: string;
	method: M;
	params: P;
}

export type AgentHostRequest =
	| RequestEnvelope<"runtime.initialize", RuntimeInitializeParams>
	| RequestEnvelope<"runtime.shutdown", Record<string, never>>
	| RequestEnvelope<"conversation.start", ConversationStartParams>
	| RequestEnvelope<"planning.start", PlanningStartParams>
	| RequestEnvelope<"activity.start", ActivityAnalysisStartParams>
	| RequestEnvelope<"reflection.analyze", ActivityReflectionAnalyzeParams>
	| RequestEnvelope<"planning.answer", PlanningAnswerParams>
	| RequestEnvelope<"agent.approveTool", AgentToolDecisionParams>
	| RequestEnvelope<"agent.declineTool", AgentToolDecisionParams>
	| RequestEnvelope<"run.cancel", RunCancelParams>
	| RequestEnvelope<"run.resume", RunResumeParams>
	| RequestEnvelope<"run.snapshot", RunTargetParams>;

export interface ModelRelayOpenParams {
	relayId: string;
	runId: string | null;
	originatingRequestId: string;
	provider: string;
	modelId: string;
	request: {
		url: string;
		method: string;
		headers: Record<string, string>;
		bodyBase64: string | null;
	};
}

export interface ModelRelayOpenResult {
	relayId: string;
	status: number;
	statusText?: string;
	headers: Record<string, string>;
	/** Optional complete body for hosts that do not need streaming. */
	bodyBase64?: string;
	completed?: boolean;
}

export interface ModelRelayAbortParams {
	relayId: string;
	runId: string | null;
	reason?: string;
}

export type SidecarHostRequest =
	| RequestEnvelope<"model/relay.open", ModelRelayOpenParams>
	| RequestEnvelope<"model/relay.abort", ModelRelayAbortParams>
	| RequestEnvelope<
			Exclude<SidecarHostMethod, "model/relay.open" | "model/relay.abort">,
			Record<string, unknown>
	  >;

export interface SuccessResponse<TResult = unknown> {
	protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION;
	type: "response";
	requestId: string;
	ok: true;
	result: TResult;
}

export interface ErrorResponse {
	protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION;
	type: "response";
	requestId: string;
	ok: false;
	error: AgentHostErrorPayload;
}

export type ProtocolResponse<TResult = unknown> =
	| SuccessResponse<TResult>
	| ErrorResponse;

export type AgentRunEventPayload =
	| { kind: "run.started"; runKind: AgentRunKind }
	| { kind: "run.resumed"; decision: "resume" | "approve" | "decline" }
	| { kind: "conversation.text.delta"; delta: string; text: string }
	| {
			kind: "agent.tool.call";
			toolCallId: string;
			toolName: string;
	  }
	| {
			kind: "agent.tool.approval.required";
			toolCallId: string;
			toolName: string;
			approval: HostToolApprovalSummary;
			runVersion: number;
	  }
	| {
			kind: "agent.tool.result";
			toolCallId: string;
			toolName: string;
			isError: boolean;
	  }
	| { kind: "planning.object.delta"; object: unknown }
	| { kind: "run.suspended"; suspendPayload: unknown }
	| { kind: "run.completed"; result: unknown }
	| { kind: "run.cancelled"; reason: string | null }
	| { kind: "run.failed"; error: AgentHostErrorPayload };

export interface HostToolApprovalSummary {
	approvalId: string;
	toolCallId: string;
	title: string;
	description: string;
	risk: "write" | "control";
	inputDigest: string;
	requestedAtMs: number;
	expiresAtMs: number;
}

export interface AgentRunEventFrame {
	protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION;
	type: "event";
	requestId: string;
	runId: string;
	sequence: number;
	version: number;
	emittedAtMs: number;
	terminalState: AgentRunTerminalState | null;
	event: AgentRunEventPayload;
}

export type ModelRelayEvent =
	| { kind: "model/relay.chunk"; bodyBase64: string }
	| { kind: "model/relay.end" }
	| { kind: "model/relay.error"; error: AgentHostErrorPayload };

export interface ModelRelayEventFrame {
	protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION;
	type: "relay-event";
	requestId: string;
	relayId: string;
	sequence: number;
	emittedAtMs: number;
	event: ModelRelayEvent;
}

export type ProtocolMessage =
	| AgentHostRequest
	| SidecarHostRequest
	| ProtocolResponse
	| AgentRunEventFrame
	| ModelRelayEventFrame;

export const AGENT_HOST_METHODS: readonly AgentHostMethod[] = [
	"runtime.initialize",
	"runtime.shutdown",
	"conversation.start",
	"planning.start",
	"activity.start",
	"reflection.analyze",
	"planning.answer",
	"agent.approveTool",
	"agent.declineTool",
	"run.cancel",
	"run.resume",
	"run.snapshot",
];

export const SIDECAR_HOST_METHODS: readonly SidecarHostMethod[] = [
	"model/relay.open",
	"model/relay.abort",
	"memory/load",
	"memory/append",
	"workflow/start",
	"workflow/resume",
	"workflow/snapshot.persist",
	"workflow/snapshot.load",
	"workflow/snapshot.list",
	"workflow/snapshot.get",
	"workflow/snapshot.delete",
	"workflow/snapshot.update-results",
	"workflow/snapshot.update-state",
	"calendar/query",
	"calendar/mutate",
	"planning/load",
	"planning/save",
	"planning/validate",
	"tool/list",
	"tool/propose",
	"tool/call",
	"tool/cancel",
];

export function successResponse<TResult>(
	requestId: string,
	result: TResult,
): SuccessResponse<TResult> {
	return {
		protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
		type: "response",
		requestId,
		ok: true,
		result,
	};
}

export function errorResponse(
	requestId: string,
	error: AgentHostErrorPayload,
): ErrorResponse {
	return {
		protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
		type: "response",
		requestId,
		ok: false,
		error,
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProtocolResponse(value: unknown): value is ProtocolResponse {
	if (
		!(
			isRecord(value) &&
			value.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
			value.type === "response" &&
			typeof value.requestId === "string" &&
			typeof value.ok === "boolean"
		)
	)
		return false;
	return value.ok
		? Object.hasOwn(value, "result")
		: isAgentHostErrorPayload(value.error);
}

export function isAgentHostRequest(value: unknown): value is AgentHostRequest {
	return (
		isRecord(value) &&
		value.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
		value.type === "request" &&
		typeof value.requestId === "string" &&
		typeof value.method === "string" &&
		(AGENT_HOST_METHODS as readonly string[]).includes(value.method) &&
		isRecord(value.params)
	);
}

export function isSidecarHostRequest(
	value: unknown,
): value is SidecarHostRequest {
	return (
		isRecord(value) &&
		value.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
		value.type === "request" &&
		isBoundedString(value.requestId, 512) &&
		typeof value.method === "string" &&
		(SIDECAR_HOST_METHODS as readonly string[]).includes(value.method) &&
		isRecord(value.params)
	);
}

export function isAgentRunEventFrame(
	value: unknown,
): value is AgentRunEventFrame {
	if (
		!(
			isRecord(value) &&
			value.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
			value.type === "event" &&
			isBoundedString(value.requestId, 512) &&
			isBoundedString(value.runId, 512) &&
			isPositiveInteger(value.sequence) &&
			isPositiveInteger(value.version) &&
			isNonNegativeInteger(value.emittedAtMs) &&
			(value.terminalState === null ||
				value.terminalState === "completed" ||
				value.terminalState === "failed" ||
				value.terminalState === "cancelled") &&
			isRecord(value.event) &&
			isAgentRunEventPayload(value.event)
		)
	)
		return false;
	const terminalForKind =
		value.event.kind === "run.completed"
			? "completed"
			: value.event.kind === "run.failed"
				? "failed"
				: value.event.kind === "run.cancelled"
					? "cancelled"
					: null;
	return value.terminalState === terminalForKind;
}

export function isModelRelayEventFrame(
	value: unknown,
): value is ModelRelayEventFrame {
	if (
		!(
			isRecord(value) &&
			value.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
			value.type === "relay-event" &&
			typeof value.requestId === "string" &&
			typeof value.relayId === "string" &&
			Number.isSafeInteger(value.sequence) &&
			(value.sequence as number) > 0 &&
			Number.isSafeInteger(value.emittedAtMs) &&
			(value.emittedAtMs as number) >= 0 &&
			isRecord(value.event)
		)
	)
		return false;
	if (value.event.kind === "model/relay.end") return true;
	if (value.event.kind === "model/relay.error") {
		return isAgentHostErrorPayload(value.event.error);
	}
	return (
		value.event.kind === "model/relay.chunk" &&
		typeof value.event.bodyBase64 === "string" &&
		value.event.bodyBase64.length <=
			Math.ceil((MAX_MODEL_RELAY_CHUNK_BYTES * 4) / 3) + 4
	);
}

function isAgentHostErrorPayload(
	value: unknown,
): value is AgentHostErrorPayload {
	return (
		isRecord(value) &&
		typeof value.code === "string" &&
		typeof value.message === "string" &&
		typeof value.retryable === "boolean" &&
		(value.details === undefined || isRecord(value.details))
	);
}

function isAgentRunEventPayload(
	value: Record<string, unknown>,
): value is AgentRunEventPayload {
	switch (value.kind) {
		case "run.started":
			return (
				value.runKind === "conversation" ||
				value.runKind === "planning" ||
				value.runKind === "activity"
			);
		case "run.resumed":
			return (
				value.decision === "resume" ||
				value.decision === "approve" ||
				value.decision === "decline"
			);
		case "conversation.text.delta":
			return (
				isBoundedString(value.delta, 64 * 1024) &&
				isBoundedString(value.text, 64 * 1024)
			);
		case "agent.tool.call":
			return (
				isBoundedString(value.toolCallId, 512) &&
				isBoundedString(value.toolName, 256)
			);
		case "agent.tool.approval.required":
			return (
				isBoundedString(value.toolCallId, 512) &&
				isBoundedString(value.toolName, 256) &&
				isPositiveInteger(value.runVersion) &&
				isHostToolApprovalSummary(value.approval)
			);
		case "agent.tool.result":
			return (
				isBoundedString(value.toolCallId, 512) &&
				isBoundedString(value.toolName, 256) &&
				typeof value.isError === "boolean"
			);
		case "planning.object.delta":
			return Object.hasOwn(value, "object");
		case "run.suspended":
			return Object.hasOwn(value, "suspendPayload");
		case "run.completed":
			return Object.hasOwn(value, "result");
		case "run.cancelled":
			return value.reason === null || isBoundedString(value.reason, 4_096);
		case "run.failed":
			return isAgentHostErrorPayload(value.error);
		default:
			return false;
	}
}

function isHostToolApprovalSummary(
	value: unknown,
): value is HostToolApprovalSummary {
	return (
		isRecord(value) &&
		isBoundedString(value.approvalId, 512) &&
		isBoundedString(value.toolCallId, 512) &&
		isBoundedString(value.title, 512) &&
		isBoundedString(value.description, 2_048) &&
		(value.risk === "write" || value.risk === "control") &&
		typeof value.inputDigest === "string" &&
		/^[a-f0-9]{64}$/.test(value.inputDigest) &&
		isNonNegativeInteger(value.requestedAtMs) &&
		isNonNegativeInteger(value.expiresAtMs) &&
		(value.expiresAtMs as number) > (value.requestedAtMs as number)
	);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maxLength
	);
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
