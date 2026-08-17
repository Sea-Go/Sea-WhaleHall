import type { ConversationRpcThread } from "./conversation";
import type {
	TaskPlanningInput,
	TaskPlanningQuestion,
	TaskPlanningSession,
} from "./task-planning";

export const AGENT_RUN_EVENT_SCHEMA_VERSION = "agent-run-event.v1" as const;
export const AGENT_RUN_SNAPSHOT_SCHEMA_VERSION =
	"agent-run-snapshot.v1" as const;

/**
 * Stable, renderer-safe Agent boundary. Provider SDK and framework-specific
 * event types must be translated before they cross this contract.
 */
export type AgentRunKind =
	| "conversation-turn"
	| "task-planning"
	/** Internal-only background run; it is never emitted to the renderer. */
	| "activity-analysis";

/** The renderer contract cannot represent internal activity-analysis runs. */
export type RendererAgentRunKind = Exclude<AgentRunKind, "activity-analysis">;

export type AgentRunStatus =
	| "starting"
	| "running"
	| "suspended"
	| "cancelling"
	| "completed"
	| "cancelled"
	| "interrupted"
	| "failed";

export type AgentRunProgressPhase = "thinking" | "using-tool" | "finalizing";

export type AgentToolRisk = "read" | "write" | "control";

export type AgentToolCallStatus =
	| "queued"
	| "awaiting-approval"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

/** A deliberately small Tool projection. Raw arguments and output stay in Bun. */
export interface AgentToolCallSummary {
	id: string;
	name: string;
	label: string;
	risk: AgentToolRisk;
	status: AgentToolCallStatus;
	startedAtMs?: number;
	completedAtMs?: number;
	summary?: string;
}

export interface AgentToolApprovalRequest {
	approvalId: string;
	toolCallId: string;
	title: string;
	description: string;
	risk: AgentToolRisk;
	inputDigest: string;
	requestedAtMs: number;
}

export type AgentToolApprovalDecision = "approve-once" | "deny";

export interface AgentRunFailure {
	code:
		| "offline"
		| "unavailable"
		| "invalid-request"
		| "revision-conflict"
		| "tool-failed"
		| "model-failed"
		| "internal";
	message: string;
	retryable: boolean;
}

export type AgentRunEvent =
	| { type: "run.started"; startedAtMs: number }
	| {
			type: "run.progress";
			phase: AgentRunProgressPhase;
			message: string;
	  }
	| {
			type: "conversation.message.started";
			conversationId: string;
			messageId: string;
			createdAtMs: number;
	  }
	| {
			type: "conversation.message.delta";
			conversationId: string;
			messageId: string;
			startOffset: number;
			delta: string;
	  }
	| {
			type: "conversation.message.completed";
			conversationId: string;
			messageId: string;
			content: string;
			createdAtMs: number;
	  }
	| { type: "tool.call.proposed"; toolCall: AgentToolCallSummary }
	| { type: "tool.call.started"; toolCall: AgentToolCallSummary }
	| {
			type: "tool.call.progress";
			toolCallId: string;
			message: string;
	  }
	| { type: "tool.call.completed"; toolCall: AgentToolCallSummary }
	| {
			type: "tool.call.failed";
			toolCall: AgentToolCallSummary;
			message: string;
	  }
	| { type: "tool.call.updated"; toolCall: AgentToolCallSummary }
	| {
			type: "tool.approval.requested";
			approval: AgentToolApprovalRequest;
	  }
	| {
			type: "tool.approval.resolved";
			approvalId: string;
			decision: AgentToolApprovalDecision;
	  }
	| {
			type: "planning.clarification.requested";
			sessionId: string;
			questions: readonly TaskPlanningQuestion[];
	  }
	| {
			type: "planning.draft.ready";
			session: Exclude<TaskPlanningSession, { status: "clarifying" }>;
	  }
	| { type: "planning.completed"; session: TaskPlanningSession }
	| {
			type: "run.suspended";
			reason: "approval-required" | "clarification-required";
	  }
	| { type: "run.cancelling" }
	| { type: "run.completed"; completedAtMs: number }
	| { type: "run.cancelled"; cancelledAtMs: number; message?: string }
	| {
			type: "run.interrupted";
			interruptedAtMs: number;
			message: string;
			restorable: boolean;
	  }
	| { type: "run.failed"; failedAtMs: number; failure: AgentRunFailure };

/** sequence is strictly increasing per run; revision protects mutations. */
interface AgentRunEventEnvelopeBase<TKind extends AgentRunKind> {
	schemaVersion: typeof AGENT_RUN_EVENT_SCHEMA_VERSION;
	runId: string;
	requestId: string;
	kind: TKind;
	sequence: number;
	revision: number;
	emittedAtMs: number;
	event: AgentRunEvent;
}

/** Public event envelope sent through renderer RPC only. */
export type AgentRunEventEnvelope =
	AgentRunEventEnvelopeBase<RendererAgentRunKind>;

/** Bun-only envelope; it may represent a hidden activity-analysis run. */
export type InternalAgentRunEventEnvelope =
	AgentRunEventEnvelopeBase<AgentRunKind>;

export interface AgentRunSnapshotBase {
	schemaVersion: typeof AGENT_RUN_SNAPSHOT_SCHEMA_VERSION;
	runId: string;
	requestId: string;
	kind: AgentRunKind;
	status: AgentRunStatus;
	revision: number;
	lastSequence: number;
	startedAtMs: number;
	updatedAtMs: number;
	toolCalls: readonly AgentToolCallSummary[];
	pendingApproval: AgentToolApprovalRequest | null;
	failure?: AgentRunFailure;
}

export interface ConversationAgentRunSnapshot extends AgentRunSnapshotBase {
	kind: "conversation-turn";
	conversationId: string;
	clientMessageId: string;
	assistantMessageId?: string;
	conversation: ConversationRpcThread;
}

export interface TaskPlanningAgentRunSnapshot extends AgentRunSnapshotBase {
	kind: "task-planning";
	input: TaskPlanningInput;
	session: TaskPlanningSession | null;
}

/**
 * Persisted only in the encrypted local Agent repository. The payload itself
 * contains Worker-produced event summaries and scores, never a raw activity
 * window. It intentionally has no renderer RPC start command or view state.
 */
export interface ActivityAnalysisAgentRunSnapshot extends AgentRunSnapshotBase {
	kind: "activity-analysis";
	activityJobId: string;
	analysisCount: number;
	consumedScore: number;
	result: string | null;
}

export type AgentRunSnapshot =
	| ConversationAgentRunSnapshot
	| TaskPlanningAgentRunSnapshot
	| ActivityAnalysisAgentRunSnapshot;

export interface AgentRunAccepted {
	runId: string;
	requestId: string;
	kind: AgentRunKind;
	revision: number;
	acceptedAtMs: number;
}

export interface AgentRunCommandAccepted {
	runId: string;
	requestId: string;
	revision: number;
	acceptedAtMs: number;
}

export interface AgentRunRestorableSummary {
	runId: string;
	requestId: string;
	kind: AgentRunKind;
	status: Extract<
		AgentRunStatus,
		"starting" | "running" | "suspended" | "cancelling" | "interrupted"
	>;
	revision: number;
	lastSequence: number;
	updatedAtMs: number;
	conversationId?: string;
	title?: string;
}

export type AgentRunRpcResult<T> =
	| { kind: "success"; data: T }
	| { kind: "offline" | "unavailable"; message: string }
	| {
			kind: "conflict";
			message: string;
			currentRevision: number;
	  }
	| { kind: "not-found"; message: string }
	| { kind: "error"; message: string; retryable: boolean };

export interface StartConversationTurnRequest {
	requestId: string;
	conversationId?: string;
	/** Explicit retry identity; Bun must not persist the user message twice. */
	retryOfRunId?: string;
	clientMessageId: string;
	text: string;
}

export interface StartTaskPlanningRunRequest {
	requestId: string;
	input: TaskPlanningInput;
}

export interface SubmitPlanningClarificationRequest {
	requestId: string;
	runId: string;
	expectedRevision: number;
	answers: readonly {
		questionKey: TaskPlanningQuestion["key"];
		answerText: string;
	}[];
}

export interface DecideAgentToolApprovalRequest {
	requestId: string;
	runId: string;
	approvalId: string;
	toolCallId: string;
	inputDigest: string;
	expectedRevision: number;
	decision: AgentToolApprovalDecision;
}

export interface CancelAgentRunRequest {
	requestId: string;
	runId: string;
	expectedRevision: number;
}

export interface GetAgentRunSnapshotRequest {
	runId: string;
}

export interface ListRestorableAgentRunsRequest {
	kind?: AgentRunKind;
	conversationId?: string;
}
