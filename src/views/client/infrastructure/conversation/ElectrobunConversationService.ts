import type {
	AgentRunEventEnvelope,
	AgentRunRestorableSummary,
	AgentRunRpcResult,
	AgentRunSnapshot,
	AgentToolApprovalRequest,
	AgentToolCallSummary,
	ConversationAgentRunSnapshot,
} from "../../../../shared/agent-runs";
import type {
	ConversationRpcMessage,
	ConversationRpcResult,
	ConversationRpcThread,
} from "../../../../shared/conversation";
import type {
	ConversationMessage,
	ConversationRestorableRun,
	ConversationRun,
	ConversationThread,
	ConversationToolApproval,
	ConversationToolCall,
} from "../../features/conversation/domain";
import {
	ConversationServiceError,
	type CancelConversationRunInput,
	type ConversationCommandAccepted,
	type ConversationRunAccepted,
	type ConversationRunEvent,
	type ConversationRunEventEnvelope,
	type ConversationRunListener,
	type ConversationRunSnapshot,
	type ConversationService,
	type ConversationStartInput,
	type DecideConversationToolApprovalInput,
} from "../../features/conversation/conversation-service";

export class ElectrobunConversationService implements ConversationService {
	private readonly listeners = new Set<ConversationRunListener>();
	private removeClientListener: (() => void) | null = null;
	private subscriptionAttempt: Promise<void> | null = null;

	async loadActiveConversation(): Promise<ConversationThread | null> {
		const { clientApi } = await loadClientApi();
		const result = await clientApi.getActiveConversation();
		return mapConversationResult(result, (thread) =>
			thread ? mapThread(thread) : null,
		);
	}

	async startTurn(input: ConversationStartInput): Promise<ConversationRunAccepted> {
		await this.ensureEventSubscription();
		const { clientApi } = await loadClientApi();
		const result = await clientApi.startConversationTurn({
			requestId: input.requestId,
			conversationId: input.conversationId,
			retryOfRunId: input.retryOfRunId,
			clientMessageId: input.clientMessageId,
			text: input.text,
		});
		return mapAgentResult(result, (accepted) => {
			if (accepted.kind !== "conversation-turn") {
				throw invalidResponse("对话请求返回了不匹配的运行类型。");
			}
			return {
				runId: accepted.runId,
				requestId: accepted.requestId,
				revision: accepted.revision,
				acceptedAtMs: accepted.acceptedAtMs,
			};
		});
	}

	async cancelRun(input: CancelConversationRunInput): Promise<ConversationCommandAccepted> {
		const { clientApi } = await loadClientApi();
		return mapAgentResult(await clientApi.cancelAgentRun(input), mapCommandAccepted);
	}

	async decideToolApproval(
		input: DecideConversationToolApprovalInput,
	): Promise<ConversationCommandAccepted> {
		const { clientApi } = await loadClientApi();
		return mapAgentResult(
			await clientApi.decideAgentToolApproval(input),
			mapCommandAccepted,
		);
	}

	async getRunSnapshot(runId: string): Promise<ConversationRunSnapshot> {
		const { clientApi } = await loadClientApi();
		return mapAgentResult(
			await clientApi.getAgentRunSnapshot({ runId }),
			mapConversationSnapshot,
		);
	}

	async listRestorableRuns(
		conversationId?: string,
	): Promise<readonly ConversationRestorableRun[]> {
		const { clientApi } = await loadClientApi();
		return mapAgentResult(
			await clientApi.listRestorableAgentRuns({
				kind: "conversation-turn",
				conversationId,
			}),
			({ runs }) => runs.filter(isConversationRun).map(mapRestorableRun),
		);
	}

	subscribe(listener: ConversationRunListener): () => void {
		this.listeners.add(listener);
		void this.ensureEventSubscription();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size !== 0) return;
			this.removeClientListener?.();
			this.removeClientListener = null;
		};
	}

	private async ensureEventSubscription(): Promise<void> {
		if (this.removeClientListener || this.subscriptionAttempt) return;
		this.subscriptionAttempt = (async () => {
			try {
				const { clientApi } = await loadClientApi();
				if (this.listeners.size === 0 || this.removeClientListener) return;
				this.removeClientListener = clientApi.onAgentRunEvent((wireEvent) => {
					const event = mapConversationEvent(wireEvent);
					if (!event) return;
					for (const listener of this.listeners) listener(event);
				});
			} catch {
				// A request surface reports bridge availability with user-visible state.
			} finally {
				this.subscriptionAttempt = null;
			}
		})();
		await this.subscriptionAttempt;
	}
}

async function loadClientApi() {
	if (!hasElectrobunRuntime()) {
		throw new ConversationServiceError(
			"unavailable",
			"当前运行环境未提供桌面端对话服务。",
			false,
		);
	}
	return import("../../rpc");
}

function mapConversationResult<T, R>(
	result: ConversationRpcResult<T>,
	map: (value: T) => R,
): R {
	if (result.kind === "success") return map(result.data);
	if (result.kind === "offline" || result.kind === "unavailable") {
		throw new ConversationServiceError(result.kind, result.message);
	}
	throw invalidResponse(result.message);
}

function mapAgentResult<T, R>(
	result: AgentRunRpcResult<T>,
	map: (value: T) => R,
): R {
	if (result.kind === "success") return map(result.data);
	if (result.kind === "conflict") {
		throw new ConversationServiceError(
			"conflict",
			result.message,
			true,
			result.currentRevision,
		);
	}
	if (result.kind === "not-found") {
		throw new ConversationServiceError("not-found", result.message, false);
	}
	if (result.kind === "offline" || result.kind === "unavailable") {
		throw new ConversationServiceError(result.kind, result.message);
	}
	if (result.kind === "error") {
		throw new ConversationServiceError(
			"invalid-response",
			result.message,
			result.retryable,
		);
	}
	throw invalidResponse("Agent 运行返回了未知结果。");
}

function mapCommandAccepted(value: {
	runId: string;
	requestId: string;
	revision: number;
	acceptedAtMs: number;
}): ConversationCommandAccepted {
	return { ...value };
}

function mapConversationSnapshot(snapshot: AgentRunSnapshot): ConversationRunSnapshot {
	if (snapshot.kind !== "conversation-turn") {
		throw invalidResponse("运行快照不是对话类型。");
	}
	return {
		run: mapRun(snapshot),
		conversation: mapThread(snapshot.conversation),
		clientMessageId: snapshot.clientMessageId,
		assistantMessageId: snapshot.assistantMessageId,
		failure: snapshot.failure
			? { message: snapshot.failure.message, retryable: snapshot.failure.retryable }
			: undefined,
	};
}

function mapRun(snapshot: ConversationAgentRunSnapshot): ConversationRun {
	return {
		id: snapshot.runId,
		requestId: snapshot.requestId,
		clientMessageId: snapshot.clientMessageId,
		status: snapshot.status,
		revision: snapshot.revision,
		lastSequence: snapshot.lastSequence,
		startedAtMs: snapshot.startedAtMs,
		updatedAtMs: snapshot.updatedAtMs,
		toolCalls: snapshot.toolCalls.map(mapToolCall),
		pendingApproval: snapshot.pendingApproval
			? mapApproval(snapshot.pendingApproval)
			: null,
		approvalDecisionPending: false,
	};
}

function mapConversationEvent(
	envelope: AgentRunEventEnvelope,
): ConversationRunEventEnvelope | null {
	if (envelope.kind !== "conversation-turn") return null;
	const event = mapEvent(envelope.event);
	return event
		? {
			runId: envelope.runId,
			requestId: envelope.requestId,
			sequence: envelope.sequence,
			revision: envelope.revision,
			emittedAtMs: envelope.emittedAtMs,
			event,
		}
		: null;
}

function mapEvent(event: AgentRunEventEnvelope["event"]): ConversationRunEvent | null {
	switch (event.type) {
		case "run.started":
		case "run.progress":
		case "run.cancelling":
		case "run.completed":
		case "run.cancelled":
			return { ...event };
		case "conversation.message.started":
			return { type: "message.started", ...withoutType(event) };
		case "conversation.message.delta":
			return { type: "message.delta", ...withoutType(event) };
		case "conversation.message.completed":
			return { type: "message.completed", ...withoutType(event) };
		case "tool.call.proposed":
		case "tool.call.started":
		case "tool.call.completed":
		case "tool.call.updated":
			return { type: "tool.updated", toolCall: mapToolCall(event.toolCall) };
		case "tool.call.progress":
			return {
				type: "tool.progress",
				toolCallId: event.toolCallId,
				message: event.message,
			};
		case "tool.call.failed":
			return {
				type: "tool.updated",
				toolCall: mapToolCall({ ...event.toolCall, summary: event.message }),
			};
		case "tool.approval.requested":
			return { type: "approval.requested", approval: mapApproval(event.approval) };
		case "tool.approval.resolved":
			return { type: "approval.resolved", ...withoutType(event) };
		case "run.suspended":
			return { type: "run.suspended" };
		case "run.interrupted":
			return { ...event };
		case "run.failed":
			return {
				type: "run.failed",
				failedAtMs: event.failedAtMs,
				message: event.failure.message,
				retryable: event.failure.retryable,
			};
		case "planning.clarification.requested":
		case "planning.draft.ready":
		case "planning.completed":
			return null;
	}
}

function withoutType<T extends { type: string }>(value: T): Omit<T, "type"> {
	const { type: _type, ...rest } = value;
	return rest;
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
	return { ...message, state: message.state ?? "complete" };
}

function mapToolCall(toolCall: AgentToolCallSummary): ConversationToolCall {
	return { ...toolCall };
}

function mapApproval(approval: AgentToolApprovalRequest): ConversationToolApproval {
	return {
		id: approval.approvalId,
		toolCallId: approval.toolCallId,
		title: approval.title,
		description: approval.description,
		risk: approval.risk,
		inputDigest: approval.inputDigest,
		requestedAtMs: approval.requestedAtMs,
	};
}

function isConversationRun(
	run: AgentRunRestorableSummary,
): run is AgentRunRestorableSummary & { kind: "conversation-turn" } {
	return run.kind === "conversation-turn";
}

function mapRestorableRun(run: AgentRunRestorableSummary): ConversationRestorableRun {
	return {
		runId: run.runId,
		requestId: run.requestId,
		status: run.status,
		revision: run.revision,
		lastSequence: run.lastSequence,
		updatedAtMs: run.updatedAtMs,
		conversationId: run.conversationId,
		title: run.title,
	};
}

function invalidResponse(message: string): ConversationServiceError {
	return new ConversationServiceError("invalid-response", message);
}

function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}
