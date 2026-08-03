import { describe, expect, test } from "bun:test";

import {
	ConversationController,
	type ConversationPageState,
} from "../src/views/client/features/conversation/ConversationController";
import {
	ConversationServiceError,
	type CancelConversationRunInput,
	type ConversationCommandAccepted,
	type ConversationRunEvent,
	type ConversationRunEventEnvelope,
	type ConversationRunListener,
	type ConversationRunAccepted,
	type ConversationRunSnapshot,
	type ConversationService,
	type ConversationStartInput,
	type DecideConversationToolApprovalInput,
} from "../src/views/client/features/conversation/conversation-service";
import type {
	ConversationRestorableRun,
	ConversationRun,
	ConversationThread,
} from "../src/views/client/features/conversation/domain";

const initialThread: ConversationThread = {
	id: "conversation-1",
	title: "新对话",
	updatedAtMs: 1,
	messages: [],
};

class FakeConversationService implements ConversationService {
	activeConversation: ConversationThread | null = initialThread;
	restorableRuns: readonly ConversationRestorableRun[] = [];
	startFailure: unknown = null;
	startInputs: ConversationStartInput[] = [];
	cancelInputs: CancelConversationRunInput[] = [];
	decisionInputs: DecideConversationToolApprovalInput[] = [];
	snapshot: ConversationRunSnapshot | null = null;
	snapshotRequests: string[] = [];
	private readonly listeners = new Set<ConversationRunListener>();

	async loadActiveConversation(): Promise<ConversationThread | null> {
		return this.activeConversation;
	}

	async startTurn(input: ConversationStartInput) {
		this.startInputs.push(input);
		if (this.startFailure) throw this.startFailure;
		return {
			runId: "run-1",
			requestId: input.requestId,
			revision: 1,
			acceptedAtMs: 10,
		};
	}

	async cancelRun(input: CancelConversationRunInput): Promise<ConversationCommandAccepted> {
		this.cancelInputs.push(input);
		return { runId: input.runId, requestId: input.requestId, revision: 2, acceptedAtMs: 40 };
	}

	async decideToolApproval(
		input: DecideConversationToolApprovalInput,
	): Promise<ConversationCommandAccepted> {
		this.decisionInputs.push(input);
		return { runId: input.runId, requestId: input.requestId, revision: 2, acceptedAtMs: 40 };
	}

	async getRunSnapshot(runId: string): Promise<ConversationRunSnapshot> {
		this.snapshotRequests.push(runId);
		if (!this.snapshot) throw new Error("missing fake snapshot");
		return this.snapshot;
	}

	async listRestorableRuns(): Promise<readonly ConversationRestorableRun[]> {
		return this.restorableRuns;
	}

	subscribe(listener: ConversationRunListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: ConversationRunEventEnvelope): void {
		for (const listener of this.listeners) listener(event);
	}

	emitRun(sequence: number, revision: number, event: ConversationRunEvent): void {
		const requestId = this.startInputs.at(-1)?.requestId;
		if (!requestId) throw new Error("No started run is available for this event.");
		this.emit({
			runId: "run-1",
			requestId,
			sequence,
			revision,
			emittedAtMs: 10 + sequence,
			event,
		});
	}
}

describe("ConversationController", () => {
	test("loads a persisted thread into an idle turn", async () => {
		const service = new FakeConversationService();
		const controller = new ConversationController(service);

		await controller.load();

		expect(controller.getSnapshot()).toEqual({
			status: "ready",
			thread: initialThread,
			turn: { status: "idle" },
		});
		controller.dispose();
	});

	test("starts a draft thread without an identity and backfills Bun's conversation id", async () => {
		const service = new FakeConversationService();
		service.activeConversation = null;
		const controller = new ConversationController(service);
		await controller.load();
		await controller.createConversation({ title: "新的讨论" });
		await controller.sendMessage({ clientMessageId: "user-new", text: "从这里开始" });

		expect(service.startInputs[0]?.conversationId).toBeUndefined();
		service.emitRun(1, 1, { type: "run.started", startedAtMs: 10 });
		service.emitRun(2, 1, {
			type: "message.started",
			conversationId: "conversation-created-by-bun",
			messageId: "assistant-new",
			createdAtMs: 20,
		});

		const state = readyState(controller.getSnapshot());
		expect(state.thread.id).toBe("conversation-created-by-bun");
		expect(state.thread.isDraft).toBe(false);
		controller.dispose();
	});

	test("restores the latest interrupted run during initial history load", async () => {
		const service = new FakeConversationService();
		service.restorableRuns = [{
			runId: "run-1",
			requestId: "request-restored",
			status: "interrupted",
			revision: 4,
			lastSequence: 12,
			updatedAtMs: 50,
			conversationId: initialThread.id,
		}];
		service.snapshot = snapshot({
			requestId: "request-restored",
			status: "interrupted",
			revision: 4,
			lastSequence: 12,
		});
		const controller = new ConversationController(service);

		await controller.load();

		expect(service.snapshotRequests).toEqual(["run-1"]);
		expect(readyState(controller.getSnapshot()).turn.status).toBe("interrupted");
		controller.dispose();
	});

	test("explicitly retries an interrupted run without duplicating the user message", async () => {
		const service = new FakeConversationService();
		service.snapshot = snapshot({
			requestId: "request-interrupted",
			status: "interrupted",
			revision: 4,
			lastSequence: 12,
		});
		const controller = new ConversationController(service);
		await controller.load();

		await controller.resumeInterruptedRun("run-1");

		expect(service.startInputs).toEqual([
			expect.objectContaining({
				conversationId: initialThread.id,
				retryOfRunId: "run-1",
				clientMessageId: "user-1",
				text: "继续",
			}),
		]);
		const state = readyState(controller.getSnapshot());
		expect(state.thread.messages.filter((message) => message.role === "user")).toEqual([
			expect.objectContaining({ id: "user-1", content: "继续" }),
		]);
		expect(state.thread.messages).toHaveLength(2);
		controller.dispose();
	});

	test("applies ordered deltas and keeps partial content until the terminal event", async () => {
		const service = new FakeConversationService();
		const controller = new ConversationController(service);
		await controller.load();

		await controller.sendMessage({
			conversationId: initialThread.id,
			clientMessageId: "message-user-1",
			text: "帮我看看今天的计划",
		});
		expect(readyState(controller.getSnapshot()).turn.status).toBe("starting");

		service.emitRun(1, 1, { type: "run.started", startedAtMs: 10 });
		service.emitRun(2, 1, {
			type: "message.started",
			conversationId: initialThread.id,
			messageId: "message-assistant-1",
			createdAtMs: 20,
		});
		service.emitRun(3, 1, {
			type: "message.delta",
			conversationId: initialThread.id,
			messageId: "message-assistant-1",
			delta: "我先",
		});
		service.emitRun(4, 1, {
			type: "message.delta",
			conversationId: initialThread.id,
			messageId: "message-assistant-1",
			delta: "帮你查看。",
		});

		let state = readyState(controller.getSnapshot());
		expect(state.thread.messages[0]?.state).toBe("complete");
		expect(state.thread.messages[1]).toMatchObject({
			content: "我先帮你查看。",
			state: "streaming",
		});

		service.emitRun(5, 1, {
			type: "message.completed",
			conversationId: initialThread.id,
			messageId: "message-assistant-1",
			content: "我先帮你查看。",
			createdAtMs: 20,
		});
		service.emitRun(6, 2, { type: "run.completed", completedAtMs: 30 });

		state = readyState(controller.getSnapshot());
		expect(state.turn.status).toBe("idle");
		expect(state.thread.messages[1]?.state).toBe("complete");
		controller.dispose();
	});

	test("accepts the first push event even when it arrives before the short request ACK", async () => {
		const service = new FakeConversationService();
		let resolveStart!: (accepted: ConversationRunAccepted) => void;
		service.startTurn = (input) => {
			service.startInputs.push(input);
			return new Promise((resolve) => { resolveStart = resolve; });
		};
		const controller = new ConversationController(service);
		await controller.load();

		const sending = controller.sendMessage({
			clientMessageId: "user-race",
			text: "不要漏掉第一条事件",
			conversationId: initialThread.id,
		});
		await Promise.resolve();
		service.emitRun(1, 1, { type: "run.started", startedAtMs: 10 });
		expect(readyState(controller.getSnapshot()).turn.status).toBe("running");

		resolveStart({
			runId: "run-1",
			requestId: service.startInputs[0]!.requestId,
			revision: 1,
			acceptedAtMs: 10,
		});
		await sending;
		const state = readyState(controller.getSnapshot());
		expect(state.turn.status).toBe("running");
		if (state.turn.status === "running") expect(state.turn.run.lastSequence).toBe(1);
		controller.dispose();
	});

	test("cancels by revision and marks a partial assistant message as retained", async () => {
		const service = new FakeConversationService();
		const controller = new ConversationController(service);
		await controller.load();
		await controller.sendMessage({ clientMessageId: "user-1", text: "继续", conversationId: initialThread.id });
		service.emitRun(1, 1, { type: "run.started", startedAtMs: 10 });
		service.emitRun(2, 1, {
			type: "message.delta",
			conversationId: initialThread.id,
			messageId: "assistant-1",
			delta: "部分结果",
		});

		await controller.stopRun();
		expect(service.cancelInputs[0]).toMatchObject({ runId: "run-1", expectedRevision: 1 });
		expect(readyState(controller.getSnapshot()).turn.status).toBe("cancelling");

		service.emitRun(3, 2, {
			type: "run.cancelled",
			cancelledAtMs: 50,
			message: "用户停止了运行。",
		});
		const state = readyState(controller.getSnapshot());
		expect(state.turn.status).toBe("cancelled");
		expect(state.thread.messages[1]?.state).toBe("cancelled");
		controller.dispose();
	});

	test("binds approve-once to the pending approval digest and expected revision", async () => {
		const service = new FakeConversationService();
		const controller = new ConversationController(service);
		await controller.load();
		await controller.sendMessage({ clientMessageId: "user-1", text: "读取状态", conversationId: initialThread.id });
		service.emitRun(1, 1, { type: "run.started", startedAtMs: 10 });
		service.emitRun(2, 1, {
			type: "tool.updated",
			toolCall: {
				id: "tool-1",
				name: "local.status",
				label: "读取本地状态",
				risk: "read",
				status: "awaiting-approval",
			},
		});
		service.emitRun(3, 1, {
			type: "approval.requested",
			approval: {
				id: "approval-1",
				toolCallId: "tool-1",
				title: "允许读取本地状态？",
				description: "只读取运行状态，不会修改数据。",
				risk: "read",
				inputDigest: "sha256:bound-input",
				requestedAtMs: 30,
			},
		});

		await controller.approveTool();
		expect(service.decisionInputs[0]).toMatchObject({
			runId: "run-1",
			approvalId: "approval-1",
			toolCallId: "tool-1",
			inputDigest: "sha256:bound-input",
			expectedRevision: 1,
			decision: "approve-once",
		});
		const state = readyState(controller.getSnapshot());
		expect(state.turn.status).toBe("suspended");
		if (state.turn.status === "suspended") {
			expect(state.turn.run.approvalDecisionPending).toBe(true);
		}
		controller.dispose();
	});

	test("recovers from an event sequence gap using an authoritative snapshot", async () => {
		const service = new FakeConversationService();
		const controller = new ConversationController(service);
		await controller.load();
		await controller.sendMessage({ clientMessageId: "user-1", text: "继续", conversationId: initialThread.id });
		service.emitRun(1, 1, { type: "run.started", startedAtMs: 10 });
		service.snapshot = snapshot({
			lastSequence: 3,
			revision: 2,
			status: "running",
		});

		service.emitRun(3, 2, {
			type: "run.progress",
			phase: "thinking",
			message: "处理中",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(service.snapshotRequests).toEqual(["run-1"]);
		const state = readyState(controller.getSnapshot());
		expect(state.turn.status).toBe("running");
		if (state.turn.status === "running") {
			expect(state.turn.run.lastSequence).toBe(3);
			expect(state.turn.run.revision).toBe(2);
		}
		controller.dispose();
	});

	test("keeps the optimistic thread visible when starting fails offline", async () => {
		const service = new FakeConversationService();
		service.startFailure = new ConversationServiceError("offline", "当前离线。");
		const controller = new ConversationController(service);
		await controller.load();

		await controller.sendMessage({ clientMessageId: "user-1", text: "继续", conversationId: initialThread.id });
		const state = controller.getSnapshot();
		expect(state.status).toBe("offline");
		if (state.status === "offline") {
			expect(state.cachedThread?.messages[0]?.state).toBe("failed");
			expect(state.turn?.status).toBe("failed");
		}
		controller.dispose();
	});
});

function readyState(state: ConversationPageState): Extract<ConversationPageState, { status: "ready" }> {
	if (state.status !== "ready") throw new Error(`Expected ready state, received ${state.status}`);
	return state;
}

function snapshot(
	overrides: Partial<ConversationRun>,
): ConversationRunSnapshot {
	return {
			run: {
				id: "run-1",
				requestId: "snapshot-request",
				clientMessageId: "user-1",
			status: "running",
			revision: 1,
			lastSequence: 1,
			startedAtMs: 10,
			updatedAtMs: 20,
			toolCalls: [],
			pendingApproval: null,
			approvalDecisionPending: false,
			...overrides,
		},
		conversation: {
			...initialThread,
			updatedAtMs: 20,
			messages: [
				{ id: "user-1", role: "user", content: "继续", createdAtMs: 10, state: "complete" },
				{ id: "assistant-1", role: "assistant", content: "权威内容", createdAtMs: 20, state: "streaming" },
			],
		},
		clientMessageId: "user-1",
		assistantMessageId: "assistant-1",
	};
}
