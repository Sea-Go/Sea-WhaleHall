import http from "node:http";
import https from "node:https";
import type {
	ConversationRpcResult,
	ConversationRpcSendResult,
	ConversationRpcThread,
} from "../shared/conversation";

const requestTimeoutMs = 30_000;
const transientStatusCodes = new Set([502, 503, 504]);

export class ConversationAgentClient {
	private readonly baseUrl: URL | null;
	private readonly token: string | undefined;

	constructor(
		baseUrl = process.env.WHALEHALL_AGENT_API_URL,
		token = process.env.WHALEHALL_AGENT_API_TOKEN,
	) {
		this.baseUrl = baseUrl ? parseAgentUrl(baseUrl) : null;
		this.token = token;
	}

	async loadActiveConversation(
		userId: string,
	): Promise<ConversationRpcResult<ConversationRpcThread | null>> {
		return this.request("/v1/conversations/active", userId, undefined, parseThreadOrNull);
	}

	async createConversation(
		userId: string,
		title?: string,
	): Promise<ConversationRpcResult<ConversationRpcThread>> {
		return this.request("/v1/conversations", userId, { title }, parseThreadResponse);
	}

	async sendMessage(input: {
		userId: string;
		conversationId: string;
		clientMessageId: string;
		text: string;
	}): Promise<ConversationRpcResult<ConversationRpcSendResult>> {
		return this.request(
			"/v1/conversations/messages",
			input.userId,
			{
				conversationId: input.conversationId,
				clientMessageId: input.clientMessageId,
				text: input.text,
			},
			parseSendResult,
		);
	}

	private async request<T>(
		path: string,
		userId: string,
		body: Record<string, unknown> | undefined,
		parse: (value: unknown) => T,
	): Promise<ConversationRpcResult<T>> {
		if (!this.baseUrl) {
			return {
				kind: "unavailable",
				message: "尚未配置 Agent 对话服务地址（WHALEHALL_AGENT_API_URL）。",
			};
		}

		try {
			const response = await requestWithTransientRetry(new URL(path, this.baseUrl), {
				method: body ? "POST" : "GET",
				userId,
				token: this.token,
				body,
			});
			if (response.statusCode < 200 || response.statusCode >= 300) {
				const message = await messageForResponse(response);
				console.warn("[conversation] Agent returned an error response", {
					operation: path,
					category: "agent-response",
					target: this.baseUrl.origin,
					statusCode: response.statusCode,
				});
				return {
					kind: response.statusCode >= 500 ? "error" : "unavailable",
					message: `${message}（HTTP ${response.statusCode}）`,
				};
			}
			return { kind: "success", data: parse(parseJson(response.body)) };
		} catch (reason) {
			const diagnostic = transportDiagnostic(reason);
			console.warn("[conversation] Agent request failed", {
				operation: path,
				category: "transport",
				diagnostic,
			});
			return {
				kind: "offline",
				message:
					reason instanceof Error && reason.name === "TimeoutError"
						? "对话服务响应超时。"
						: `无法连接到对话服务（${diagnostic}）。`,
			};
		}
	}
}

function parseAgentUrl(value: string): URL {
	const url = new URL(value);
	const localHost = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
		throw new Error("WHALEHALL_AGENT_API_URL must use HTTPS, or HTTP on loopback only.");
	}
	return new URL(url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`);
}

async function messageForResponse(response: AgentHttpResponse): Promise<string> {
	try {
		const payload = parseJson(response.body);
		if (isRecord(payload) && typeof payload.message === "string") return payload.message;
	} catch {
		// A safe generic message is used when the service does not return JSON.
	}
	return response.statusCode === 401 || response.statusCode === 403
		? "当前账号无权访问对话服务。"
		: "对话服务暂时无法处理此请求。";
}

type AgentHttpResponse = {
	statusCode: number;
	body: string;
};

function requestAgentJson(
	url: URL,
	input: {
		method: "GET" | "POST";
		userId: string;
		token?: string;
		body?: Record<string, unknown>;
	},
): Promise<AgentHttpResponse> {
	const body = input.body ? JSON.stringify(input.body) : undefined;
	const transport = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const request = transport.request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || undefined,
				path: `${url.pathname}${url.search}`,
				method: input.method,
				headers: {
					"x-whalehall-user-id": input.userId,
					...(input.token ? { "x-whalehall-agent-token": input.token } : {}),
					...(body
						? {
							"content-type": "application/json",
							"content-length": Buffer.byteLength(body).toString(),
						}
						: {}),
				},
			},
			(response) => {
				let responseBody = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					responseBody += chunk;
				});
				response.on("end", () => {
					resolve({ statusCode: response.statusCode ?? 0, body: responseBody });
				});
			},
		);
		request.setTimeout(requestTimeoutMs, () => {
			const error = new Error("Agent HTTP request timed out.");
			error.name = "TimeoutError";
			request.destroy(error);
		});
		request.on("error", reject);
		if (body) request.write(body);
		request.end();
	});
}

async function requestWithTransientRetry(
	url: URL,
	input: Parameters<typeof requestAgentJson>[1],
): Promise<AgentHttpResponse> {
	let response = await requestAgentJson(url, input);
	for (const retryDelayMs of [300, 1_000]) {
		if (!transientStatusCodes.has(response.statusCode)) return response;
		await delay(retryDelayMs);
		response = await requestAgentJson(url, input);
	}
	return response;
}

function delay(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function parseJson(value: string): unknown {
	return JSON.parse(value) as unknown;
}

function parseThreadOrNull(value: unknown): ConversationRpcThread | null {
	if (!isRecord(value) || value.conversation === null) return null;
	return parseThread(value.conversation);
}

function parseThreadResponse(value: unknown): ConversationRpcThread {
	if (!isRecord(value)) throw new Error("Conversation response is invalid.");
	return parseThread(value.conversation);
}

function parseThread(value: unknown): ConversationRpcThread {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") {
		throw new Error("Conversation response has an invalid thread.");
	}
	return {
		id: value.id,
		title: value.title,
		updatedAtMs: parseTimestamp(value.updatedAt),
		messages: Array.isArray(value.messages) ? value.messages.map(parseMessage) : [],
	};
}

function parseSendResult(value: unknown): ConversationRpcSendResult {
	if (!isRecord(value)) throw new Error("Conversation response is invalid.");
	return {
		conversation: parseThread(value.conversation),
		userMessage: parseMessage(value.userMessage),
		assistantMessage: parseMessage(value.assistantMessage),
	};
}

function parseMessage(value: unknown): ConversationRpcSendResult["userMessage"] {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.content !== "string") {
		throw new Error("Conversation response has an invalid message.");
	}
	if (value.role !== "user" && value.role !== "assistant") {
		throw new Error("Conversation response has an invalid message role.");
	}
	return { id: value.id, role: value.role, content: value.content, createdAtMs: parseTimestamp(value.createdAt) };
}

function parseTimestamp(value: unknown): number {
	if (typeof value !== "string") throw new Error("Conversation response has an invalid timestamp.");
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error("Conversation response has an invalid timestamp.");
	return timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function transportDiagnostic(reason: unknown): string {
	if (!(reason instanceof Error)) return "未知连接错误";
	const cause = reason.cause;
	if (cause instanceof Error && cause.message.trim()) return cause.message.trim();
	return reason.message.trim() || reason.name;
}
