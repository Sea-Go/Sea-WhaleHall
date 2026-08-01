import type {
	ConversationDraft,
	ConversationRestorableRun,
	ConversationRun,
	ConversationRunPhase,
	ConversationThread,
	ConversationToolApproval,
	ConversationToolApprovalDecision,
	ConversationToolCall,
} from "./domain";

export interface ConversationStartInput extends ConversationDraft {
	requestId: string;
	retryOfRunId?: string;
}

export interface ConversationRunAccepted {
	runId: string;
	requestId: string;
	revision: number;
	acceptedAtMs: number;
}

export interface ConversationCommandAccepted {
	runId: string;
	requestId: string;
	revision: number;
	acceptedAtMs: number;
}

export interface CancelConversationRunInput {
	requestId: string;
	runId: string;
	expectedRevision: number;
}

export interface DecideConversationToolApprovalInput {
	requestId: string;
	runId: string;
	approvalId: string;
	toolCallId: string;
	inputDigest: string;
	expectedRevision: number;
	decision: ConversationToolApprovalDecision;
}

export interface ConversationRunSnapshot {
	run: ConversationRun;
	conversation: ConversationThread;
	clientMessageId: string;
	assistantMessageId?: string;
	failure?: { message: string; retryable: boolean };
}

export type ConversationRunEvent =
	| { type: "run.started"; startedAtMs: number }
	| {
			type: "run.progress";
			phase: ConversationRunPhase;
			message: string;
	  }
	| {
			type: "message.started";
			conversationId: string;
			messageId: string;
			createdAtMs: number;
	  }
	| {
			type: "message.delta";
			conversationId: string;
			messageId: string;
			delta: string;
	  }
	| {
			type: "message.completed";
			conversationId: string;
			messageId: string;
			content: string;
			createdAtMs: number;
	  }
	| { type: "tool.updated"; toolCall: ConversationToolCall }
	| { type: "tool.progress"; toolCallId: string; message: string }
	| { type: "approval.requested"; approval: ConversationToolApproval }
	| {
			type: "approval.resolved";
			approvalId: string;
			decision: ConversationToolApprovalDecision;
	  }
	| { type: "run.suspended" }
	| { type: "run.cancelling" }
	| { type: "run.completed"; completedAtMs: number }
	| { type: "run.cancelled"; cancelledAtMs: number; message?: string }
	| {
			type: "run.interrupted";
			interruptedAtMs: number;
			message: string;
			restorable: boolean;
	  }
	| {
			type: "run.failed";
			failedAtMs: number;
			message: string;
			retryable: boolean;
	  };

export interface ConversationRunEventEnvelope {
	runId: string;
	requestId: string;
	sequence: number;
	revision: number;
	emittedAtMs: number;
	event: ConversationRunEvent;
}

export type ConversationRunListener = (event: ConversationRunEventEnvelope) => void;

/** Renderer-facing integration seam. No provider or Mastra types cross it. */
export interface ConversationService {
	loadActiveConversation(): Promise<ConversationThread | null>;
	startTurn(input: ConversationStartInput): Promise<ConversationRunAccepted>;
	cancelRun(input: CancelConversationRunInput): Promise<ConversationCommandAccepted>;
	decideToolApproval(
		input: DecideConversationToolApprovalInput,
	): Promise<ConversationCommandAccepted>;
	getRunSnapshot(runId: string): Promise<ConversationRunSnapshot>;
	listRestorableRuns(conversationId?: string): Promise<readonly ConversationRestorableRun[]>;
	subscribe(listener: ConversationRunListener): () => void;
}

export class ConversationServiceError extends Error {
	constructor(
		readonly kind:
			| "offline"
			| "unavailable"
			| "invalid-response"
			| "conflict"
			| "not-found",
		message: string,
		readonly retryable = true,
		readonly currentRevision?: number,
	) {
		super(message);
		this.name = "ConversationServiceError";
	}
}
