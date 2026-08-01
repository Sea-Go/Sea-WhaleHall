export type ConversationRole = "user" | "assistant";

export type ConversationMessageState =
	| "complete"
	| "streaming"
	| "failed";

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
}

export interface ConversationDraft {
	conversationId: string;
	clientMessageId: string;
	text: string;
}

export interface CreateConversationInput {
	title?: string;
}
