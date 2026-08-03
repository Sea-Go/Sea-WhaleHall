export type ConversationRole = "user" | "assistant";

export type ConversationMessageState =
	| "queued"
	| "complete"
	| "streaming"
	| "failed"
	| "cancelled";

/**
 * A renderer-safe message contract. Provider-specific fields, model prompts,
 * and raw tool payloads intentionally stay outside the client domain.
 */
export interface ConversationMessage {
	id: string;
	role: ConversationRole;
	content: string;
	createdAtMs: number;
	state: ConversationMessageState;
}

export interface ConversationThread {
	id: string;
	title: string;
	updatedAtMs: number;
	messages: readonly ConversationMessage[];
	/** A local empty shell; the first turn lets Bun allocate the real id. */
	isDraft?: boolean;
}

export interface ConversationDraft {
	conversationId?: string;
	clientMessageId: string;
	text: string;
}

export interface CreateConversationInput {
	title?: string;
}

export type ConversationRunStatus =
	| "starting"
	| "running"
	| "suspended"
	| "cancelling"
	| "completed"
	| "cancelled"
	| "interrupted"
	| "failed";

export type ConversationRunPhase = "thinking" | "using-tool" | "finalizing";
export type ConversationToolRisk = "read" | "write" | "control";
export type ConversationToolCallStatus =
	| "queued"
	| "awaiting-approval"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface ConversationToolCall {
	id: string;
	name: string;
	label: string;
	risk: ConversationToolRisk;
	status: ConversationToolCallStatus;
	startedAtMs?: number;
	completedAtMs?: number;
	summary?: string;
	progress?: string;
}

export interface ConversationToolApproval {
	id: string;
	toolCallId: string;
	title: string;
	description: string;
	risk: ConversationToolRisk;
	inputDigest: string;
	requestedAtMs: number;
}

export type ConversationToolApprovalDecision = "approve-once" | "deny";

export interface ConversationRun {
	id: string;
	requestId: string;
	clientMessageId: string;
	status: ConversationRunStatus;
	revision: number;
	lastSequence: number;
	startedAtMs: number;
	updatedAtMs: number;
	phase?: ConversationRunPhase;
	statusMessage?: string;
	toolCalls: readonly ConversationToolCall[];
	pendingApproval: ConversationToolApproval | null;
	approvalDecisionPending: boolean;
	commandError?: string;
}

export interface ConversationRestorableRun {
	runId: string;
	requestId: string;
	status: "starting" | "running" | "suspended" | "cancelling" | "interrupted";
	revision: number;
	lastSequence: number;
	updatedAtMs: number;
	conversationId?: string;
	title?: string;
}
