import type {
	ConversationDraft,
	ConversationMessage,
	ConversationThread,
	CreateConversationInput,
} from "../../features/conversation/domain";
import {
	ConversationServiceError,
	type ConversationExchange,
	type ConversationService,
} from "../../features/conversation/conversation-service";
import type {
	ConversationRpcMessage,
	ConversationRpcResult,
	ConversationRpcThread,
} from "../../../../shared/conversation";

export class ElectrobunConversationService implements ConversationService {
	constructor(private readonly userId: string) {}

	async loadActiveConversation(): Promise<ConversationThread | null> {
		const { clientApi } = await loadClientApi();
		const result = await clientApi.loadActiveConversation(this.userId);
		return mapResult(result, (thread) => (thread ? mapThread(thread) : null));
	}

	async createConversation(input: CreateConversationInput): Promise<ConversationThread> {
		const { clientApi } = await loadClientApi();
		const result = await clientApi.createConversation(this.userId, input.title);
		return mapResult(result, mapThread);
	}

	async sendMessage(input: ConversationDraft): Promise<ConversationExchange> {
		const { clientApi } = await loadClientApi();
		const result = await clientApi.sendConversationMessage({ ...input, userId: this.userId });
		return mapResult(result, (exchange) => ({
			conversation: mapThread(exchange.conversation),
			userMessage: mapMessage(exchange.userMessage),
			assistantMessage: mapMessage(exchange.assistantMessage),
		}));
	}
}

async function loadClientApi() {
	if (!hasElectrobunRuntime()) {
		throw new ConversationServiceError("unavailable", "当前运行环境未提供桌面端对话服务。");
	}
	return import("../../rpc");
}

function mapResult<T, R>(result: ConversationRpcResult<T>, map: (value: T) => R): R {
	if (result.kind === "success") return map(result.data);
	if (result.kind === "offline" || result.kind === "unavailable") {
		throw new ConversationServiceError(result.kind, result.message);
	}
	throw new ConversationServiceError("invalid-response", result.message);
}

function mapThread(thread: ConversationRpcThread): ConversationThread {
	return {
		id: thread.id,
		title: thread.title,
		updatedAtMs: thread.updatedAtMs,
		messages: thread.messages.map(mapMessage),
	};
}

function mapMessage(message: ConversationRpcMessage): ConversationMessage {
	return { ...message, state: "complete" };
}

function hasElectrobunRuntime(): boolean {
	return typeof window !== "undefined" && "__electrobun" in window && "__electrobunBunBridge" in window;
}
