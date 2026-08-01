/**
 * Renderer-safe conversation payloads exchanged only through the Bun RPC
 * boundary. Agent-internal prompts, retrieval records, traces, and action
 * payloads deliberately never cross this contract.
 */
export type ConversationRpcRole = "user" | "assistant";

export interface ConversationRpcMessage {
	id: string;
	role: ConversationRpcRole;
	content: string;
	createdAtMs: number;
}

export interface ConversationRpcThread {
	id: string;
	title: string;
	updatedAtMs: number;
	messages: ConversationRpcMessage[];
}

export type ConversationRpcResult<T> =
	| { kind: "success"; data: T }
	| { kind: "offline"; message: string }
	| { kind: "unavailable"; message: string }
	| { kind: "error"; message: string };

export interface ConversationRpcSendResult {
	conversation: ConversationRpcThread;
	userMessage: ConversationRpcMessage;
	assistantMessage: ConversationRpcMessage;
}
