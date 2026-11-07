import type { AgentRunEventEnvelope } from "../../shared/agent-runs";

/**
 * 桌宠对话控制器：输入 → petRPC startPetChatTurn；事件流（message.delta、
 * tool.call、终态）经 petChatEvent 按 requestId 送回。与客户端「对话」页共用
 * 同一 conversation，桌宠面板只呈现本轮问答。
 */

export interface PetChatPort {
	startTurn(input: { requestId: string; text: string }): void;
	cancelTurn(input: {
		requestId: string;
		runId: string;
		expectedRevision: number;
	}): void;
	/** 状态面包屑（诊断用）；实现方可选。 */
	reportState?(state: {
		kind: string;
		requestId: string | null;
		detail: string;
	}): void;
}

export type PetChatToolActivity = {
	toolCallId: string;
	label: string;
	status: "running" | "succeeded" | "failed";
};

/** 轮次发起方：用户输入，或大肥鱼主动搭话（心跳观察经 conversation agent）。 */
export type PetChatTurnOrigin = "user" | "proactive";

export type PetChatState =
	| { kind: "unavailable"; message: string }
	| { kind: "idle" }
	| {
			kind: "running";
			requestId: string;
			runId: string | null;
			revision: number;
			streaming: string;
			/** 思考模型的实时推理流：等待正文期间的显示，不进最终回答。 */
			reasoning: string;
			tools: readonly PetChatToolActivity[];
			origin: PetChatTurnOrigin;
	  }
	| {
			kind: "done";
			requestId: string;
			answer: string;
			toolsUsed: boolean;
			origin: PetChatTurnOrigin;
			/** 本轮思考流存档：done 后继续显示，直到下一轮覆盖。 */
			reasoning: string;
	  }
	| { kind: "failed"; message: string; origin?: PetChatTurnOrigin };

const CLOUD_TOOL_LABELS: Record<string, string> = {
	search_fast: "云检索·快搜",
	search_detailed: "云检索·详搜",
	read_evidence: "云检索·读证据",
};

const TERMINAL_TYPES = new Set([
	"run.completed",
	"run.cancelled",
	"run.failed",
	"run.interrupted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从渲染事件包里提取本面板需要的字段（宽松读取，未知事件忽略）。 */
function readEnvelope(
	envelope: unknown,
): { type: string; runId: string; revision: number } | null {
	if (!isRecord(envelope)) return null;
	const event = envelope.event;
	if (!isRecord(event)) return null;
	const type = typeof event.type === "string" ? event.type : "";
	const runId = typeof envelope.runId === "string" ? envelope.runId : "";
	const revision = Number.isSafeInteger(envelope.revision)
		? (envelope.revision as number)
		: 0;
	if (!type || !runId) return null;
	return { type, runId, revision };
}

export class PetChatController {
	private state: PetChatState = { kind: "idle" };
	private generation = 0;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly port: PetChatPort | null) {}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getState(): PetChatState {
		return this.state;
	}

	setAvailable(available: boolean): void {
		if (available) {
			if (this.state.kind === "unavailable") {
				this.state = { kind: "idle" };
				this.emit();
			}
			return;
		}
		if (this.state.kind !== "running") {
			this.state = {
				kind: "unavailable",
				message: "登录 WhaleHall 账号后即可与大肥鱼对话。",
			};
		}
	}

	startTurn(rawText: string): void {
		const text = rawText.trim();
		if (!this.port) {
			this.state = {
				kind: "unavailable",
				message: "登录 WhaleHall 账号后即可与大肥鱼对话。",
			};
			this.emit();
			return;
		}
		if (text.length === 0 || new TextEncoder().encode(text).length > 8192) {
			return;
		}
		if (this.state.kind === "running") return;
		const requestId = crypto.randomUUID();
		const generation = ++this.generation;
		this.state = {
			kind: "running",
			requestId,
			runId: null,
			revision: 0,
			streaming: "",
			reasoning: "",
			tools: [],
			origin: "user",
		};
		this.emit();
		this.port.startTurn({ requestId, text });
		void generation;
	}

	/** petChatProactiveTurn：大肥鱼主动搭话的轮次（渲染器只显示流式回答）。 */
	enterProactiveTurn(requestId: string): void {
		if (this.state.kind === "running") return;
		this.state = {
			kind: "running",
			requestId,
			runId: null,
			revision: 0,
			streaming: "",
			reasoning: "",
			tools: [],
			origin: "proactive",
		};
		this.emit();
	}

	cancelTurn(): void {
		if (this.state.kind !== "running" || !this.port) return;
		const { requestId, runId, revision } = this.state;
		if (runId === null) return;
		this.port.cancelTurn({ requestId, runId, expectedRevision: revision });
	}

	/** petChatTurnRejected：发起即失败。 */
	rejectTurn(requestId: string, message: string): void {
		if (this.state.kind !== "running" || this.state.requestId !== requestId) {
			return;
		}
		this.state = { kind: "failed", message, origin: this.state.origin };
		this.emit();
	}

	/** petChatEvent：按 requestId 应用事件。 */
	applyEvent(requestId: string, envelope: unknown): void {
		if (this.state.kind !== "running" || this.state.requestId !== requestId) {
			return;
		}
		const parsed = readEnvelope(envelope);
		if (!parsed) return;
		// 浅拷贝出新对象再改：useSyncExternalStore 以快照身份判断变更，
		// 原地修改同一引用会让面板在流式期间不重渲（真 bug，勿回退）。
		const state = { ...this.state, tools: [...this.state.tools] };
		this.state = state;
		state.runId = parsed.runId;
		state.revision = parsed.revision;
		const event = (envelope as { event: Record<string, unknown> }).event;
		switch (parsed.type) {
			case "conversation.reasoning.delta": {
				const delta = typeof event.delta === "string" ? event.delta : "";
				if (delta) state.reasoning += delta;
				break;
			}
			case "conversation.message.delta": {
				const delta = typeof event.delta === "string" ? event.delta : "";
				if (delta) state.streaming += delta;
				break;
			}
			case "conversation.message.completed": {
				const content =
					typeof event.content === "string" ? event.content : state.streaming;
				if (content) state.streaming = content;
				break;
			}
			case "tool.call.started":
			case "tool.call.completed":
			case "tool.call.failed": {
				const toolCall = event.toolCall as Record<string, unknown> | undefined;
				const id = typeof toolCall?.id === "string" ? toolCall.id : "";
				const label =
					typeof toolCall?.label === "string"
						? toolCall.label
						: (CLOUD_TOOL_LABELS[String(toolCall?.name ?? "")] ??
							String(toolCall?.name ?? "工具"));
				if (!id) break;
				const status =
					parsed.type === "tool.call.started"
						? "running"
						: parsed.type === "tool.call.failed"
							? "failed"
							: "succeeded";
				const next = state.tools.filter((tool) => tool.toolCallId !== id);
				next.push({ toolCallId: id, label, status });
				state.tools = next;
				break;
			}
			case "run.completed": {
				this.state = {
					kind: "done",
					requestId,
					answer: state.streaming.trim(),
					toolsUsed: state.tools.length > 0,
					origin: state.origin,
					reasoning: state.reasoning,
				};
				this.emit();
				return;
			}
			case "run.failed":
			case "run.interrupted": {
				this.state = {
					kind: "failed",
					message: "这轮对话没能完成，请重试。",
					origin: state.origin,
				};
				this.emit();
				return;
			}
			case "run.cancelled": {
				this.state = { kind: "idle" };
				this.emit();
				return;
			}
			default:
				break;
		}
		this.emit();
	}

	private emit(): void {
		this.port?.reportState?.({
			kind: this.state.kind,
			requestId:
				this.state.kind === "running" || this.state.kind === "done"
					? this.state.requestId
					: null,
			detail: describePetChatState(this.state),
		});
		for (const listener of this.listeners) listener();
	}
}

function describePetChatState(state: PetChatState): string {
	switch (state.kind) {
		case "idle":
			return "idle";
		case "unavailable":
			return `unavailable ${state.message}`;
		case "failed":
			return `failed${state.origin === "proactive" ? "(proactive)" : ""} ${state.message}`;
		case "done":
			return `done${state.origin === "proactive" ? "(proactive)" : ""} toolsUsed=${state.toolsUsed} answerChars=${state.answer.length} reasoningChars=${state.reasoning.length} tail=${state.answer.slice(-72)}`;
		case "running":
			return `running${state.origin === "proactive" ? "(proactive)" : ""} rev=${state.revision} streamChars=${state.streaming.length} reasoningChars=${state.reasoning.length} tail=${state.streaming.slice(-48)} tools=[${state.tools
				.map((tool) => `${tool.label}:${tool.status}`)
				.join(",")}]`;
	}
}
