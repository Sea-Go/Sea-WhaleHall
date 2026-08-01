import http from "node:http";
import https from "node:https";
import type {
	TaskPlanningAnswer,
	TaskPlanningInput,
	TaskPlanningQuestionKey,
	TaskPlanningQuestion,
	TaskPlanningRpcResult,
	TaskPlanningSession,
} from "../shared/task-planning";

const timeoutMs = 30_000;
const retryableStatusCodes = new Set([502, 503, 504]);
const questionKeys = new Set<TaskPlanningQuestionKey>([
	"task_type", "brief_extraction_confirmation", "expected_outcome", "deadline",
	"current_progress", "scope", "capacity", "constraints", "skill_context", "risks",
]);

export class TaskPlanningAgentClient {
	private readonly baseUrl: URL | null;
	private readonly token: string | undefined;

	constructor(
		baseUrl = process.env.WHALEHALL_AGENT_API_URL,
		token = process.env.WHALEHALL_AGENT_API_TOKEN,
	) {
		this.baseUrl = baseUrl ? parseAgentUrl(baseUrl) : null;
		this.token = token;
	}

	createSession(userId: string, input: TaskPlanningInput): Promise<TaskPlanningRpcResult<TaskPlanningSession>> {
		return this.request("/v1/task-planning/start", userId, input);
	}

	submitAnswers(
		userId: string,
		sessionId: string,
		answers: readonly TaskPlanningAnswer[],
	): Promise<TaskPlanningRpcResult<TaskPlanningSession>> {
		return this.request(`/v1/task-planning/${encodeURIComponent(sessionId)}/answers`, userId, { answers });
	}

	private async request(
		path: string,
		userId: string,
		body: object,
	): Promise<TaskPlanningRpcResult<TaskPlanningSession>> {
		if (!this.baseUrl) {
			return { kind: "unavailable", message: "尚未配置 Agent 任务拆分服务地址（WHALEHALL_AGENT_API_URL）。" };
		}
		try {
			const response = await requestWithRetry(new URL(path, this.baseUrl), userId, this.token, body);
			if (response.statusCode < 200 || response.statusCode >= 300) {
				console.warn("[task-planning] Agent returned an error response", {
					operation: path, category: "agent-response", target: this.baseUrl.origin, statusCode: response.statusCode,
				});
				return {
					kind: response.statusCode >= 500 ? "error" : "unavailable",
					message: `任务拆分服务暂时无法处理此请求（HTTP ${response.statusCode}）。`,
				};
			}
			return { kind: "success", data: parseSession(JSON.parse(response.body) as unknown) };
		} catch (reason) {
			console.warn("[task-planning] Agent request failed", {
				operation: path, category: "transport", diagnostic: diagnostic(reason),
			});
			return {
				kind: "offline",
				message: reason instanceof Error && reason.name === "TimeoutError"
					? "任务拆分服务响应超时。"
					: `无法连接到任务拆分服务（${diagnostic(reason)}）。`,
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

type AgentHttpResponse = { statusCode: number; body: string };

async function requestWithRetry(url: URL, userId: string, token: string | undefined, body: object): Promise<AgentHttpResponse> {
	let response = await requestJson(url, userId, token, body);
	for (const delayMs of [300, 1_000]) {
		if (!retryableStatusCodes.has(response.statusCode)) return response;
		await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		response = await requestJson(url, userId, token, body);
	}
	return response;
}

function requestJson(url: URL, userId: string, token: string | undefined, input: object): Promise<AgentHttpResponse> {
	const body = JSON.stringify(input);
	const transport = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const request = transport.request({
			protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
			path: `${url.pathname}${url.search}`, method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body).toString(),
				"x-whalehall-user-id": userId,
				...(token ? { "x-whalehall-agent-token": token } : {}),
			},
		}, (response) => {
			let responseBody = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => { responseBody += chunk; });
			response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: responseBody }));
		});
		request.setTimeout(timeoutMs, () => {
			const error = new Error("Agent HTTP request timed out.");
			error.name = "TimeoutError";
			request.destroy(error);
		});
		request.on("error", reject);
		request.write(body);
		request.end();
	});
}

function parseSession(value: unknown): TaskPlanningSession {
	if (!isRecord(value) || !isRecord(value.session) || typeof value.session.id !== "string") {
		throw new Error("Task planning response has an invalid session.");
	}
	const session = value.session;
	const sessionId = session.id;
	if (typeof sessionId !== "string") throw new Error("Task planning response has an invalid session.");
	if (session.status === "clarifying" && Array.isArray(session.questions)) {
		return {
			id: sessionId,
			status: "clarifying",
			questions: session.questions.map(parseQuestion),
		};
	}
	if (session.status === "draft") return { id: sessionId, status: "draft", draft: parseDraft(session.draft) };
	throw new Error("Task planning response has an unsupported state.");
}

function parseQuestion(value: unknown): TaskPlanningQuestion {
	if (!isRecord(value) || typeof value.key !== "string" || !questionKeys.has(value.key as TaskPlanningQuestionKey) || typeof value.text !== "string" || typeof value.required !== "boolean") {
		throw new Error("Task planning response has an invalid question.");
	}
	return { key: value.key as TaskPlanningQuestionKey, text: value.text, required: value.required };
}

function parseDraft(value: unknown): Extract<TaskPlanningSession, { status: "draft" }>["draft"] {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || !Array.isArray(value.milestones) || !Array.isArray(value.tasks)) {
		throw new Error("Task planning response has an invalid draft.");
	}
	return {
		id: value.id, title: value.title,
		assumptions: stringArray(value.assumptions),
		milestones: value.milestones.map((item) => {
			if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.description !== "string") throw new Error("Task planning response has an invalid milestone.");
			return { id: item.id, title: item.title, description: item.description, ...(typeof item.targetDate === "string" ? { targetDate: item.targetDate } : {}), acceptanceCriteria: stringArray(item.acceptanceCriteria) };
		}),
		tasks: value.tasks.map((item) => {
			if (!isRecord(item) || typeof item.id !== "string" || typeof item.milestoneId !== "string" || typeof item.title !== "string" || typeof item.description !== "string" || typeof item.estimatedMinutes !== "number" || !Number.isFinite(item.estimatedMinutes)) throw new Error("Task planning response has an invalid task.");
			const importance = parseImportance(item.importance);
			if (!importance) throw new Error("Task planning response has an invalid task.");
			return { id: item.id, milestoneId: item.milestoneId, title: item.title, description: item.description, estimatedMinutes: item.estimatedMinutes, importance, dependencies: stringArray(item.dependencies), completionCriteria: stringArray(item.completionCriteria) };
		}),
	};
}

function stringArray(value: unknown): readonly string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("Task planning response has an invalid text list.");
	return value;
}

function parseImportance(value: unknown): "low" | "medium" | "high" | null {
	if (value === "low" || value === "LOW") return "low";
	if (value === "medium" || value === "MEDIUM") return "medium";
	if (value === "high" || value === "HIGH" || value === "URGENT") return "high";
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function diagnostic(reason: unknown): string { return reason instanceof Error ? reason.message || reason.name : "未知连接错误"; }
