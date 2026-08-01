import type {
	ConversationDraft,
	ConversationMessage,
	ConversationThread,
	CreateConversationInput,
} from "./domain";

/**
 * Integration seam for the future Agent/RPC adapter. This feature deliberately
 * does not choose a model, persist conversation content, or call native APIs.
 */
export interface ConversationService {
	loadActiveConversation(): Promise<ConversationThread | null>;
	createConversation(input: CreateConversationInput): Promise<ConversationThread>;
	sendMessage(input: ConversationDraft): Promise<ConversationExchange>;
}

export interface ConversationExchange {
	conversation: ConversationThread;
	userMessage: ConversationMessage;
	assistantMessage: ConversationMessage;
}

export class ConversationServiceError extends Error {
	constructor(
		readonly kind: "offline" | "unavailable" | "invalid-response",
		message: string,
	) {
		super(message);
		this.name = "ConversationServiceError";
	}
}
