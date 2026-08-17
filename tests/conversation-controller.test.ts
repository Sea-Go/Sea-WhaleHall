import { describe, expect, test } from "bun:test";

import {
	ConversationController,
	type ConversationPageState,
} from "../src/views/client/features/conversation/ConversationController";
import {
	type CancelConversationRunInput,
	type ConversationCommandAccepted,
	type ConversationRunAccepted,
	type ConversationRunEvent,
	type ConversationRunEventEnvelope,
	type ConversationRunListener,
	type ConversationRunSnapshot,
	type ConversationService,
	ConversationServiceError,
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
	activeConversationLoads: (ConversationThread | null)[] = [];
	loadActiveConversationCalls = 0;
	restorableRuns: readonly ConversationRestorableRun[] = [];
	startFailure: unknown = null;
	startInputs: ConversationStartInput[] = [];
	cancelInputs: CancelConversationRunInput[] = [];
	decisionInputs: DecideConversationToolApprovalInput[] = [];
	snapshot: ConversationRunSnapshot | null = null;
	snapshotFailure: unknown = null;
	snapshotLoader: ((runId: string) => Promise<ConversationRunSnapshot>) | null =
		null;
	snapshotRequests: string[] = [];
	private readonly listeners = new Set<ConversationRunListener>();
	subscribeCalls = 0;
	unsubscribeCalls = 0;

	get listenerCount(): number {
		return this.listeners.size;
	}

	async loadActiveConversation(): Promise<ConversationThread | null> {
		this.loadActiveConversationCalls += 1;
		if (this.activeConversationLoads.length > 0) {
			return this.activeConversationLoads.shift() ?? null;
		}
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

	async cancelRun(
		input: CancelConversationRunInput,
	): Promise<ConversationCommandAccepted> {
		this.cancelInputs.push(input);
		return {
			runId: input.runId,
			requestId: input.requestId,
			revision: 2,
			acceptedAtMs: 40,
		};
	}

	async decideToolApproval(
		input: DecideConversationToolApprovalInput,
	): Promise<ConversationCommandAccepted> {
		this.decisionInputs.push(input);
		return {
			runId: input.runId,
			requestId: input.requestId,
			revision: 2,
			acceptedAtMs: 40,
		};
	}

	async getRunSnapshot(runId: string): Promise<ConversationRunSnapshot> {
		this.snapshotRequests.push(runId);
		if (this.snapshotFailure) throw this.snapshotFailure;
		if (this.snapshotLoader) return this.snapshotLoader(runId);
		if (!this.snapshot) throw new Error("missing fake snapshot");
		return this.snapshot;
	}

	async listRestorableRuns(): Promise<readonly ConversationRestorableRun[]> {
		return this.restorableRuns;
	}

	subscribe(listener: ConversationRunListener): () => void {
		this.subscribeCalls += 1;
		this.listeners.add(listener);
		return () => {
			if (!this.listeners.delete(listener)) return;
			this.unsubscribeCalls += 1;
		};
	}

	emit(event: ConversationRunEventEnvelope): void {
		for (const listener of this.listeners) listener(event);
	}

	emitRun(
		sequence: number,
		revision: number,
		event: ConversationRunEvent,
	): void {
		const requestId = this.startInputs.at(-1)?.requestId;
		if (!requestId)
			throw new Error("No started run is available for this event.");
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
	test("keeps construction pure and owns one service subscription after load", async () => {
		const abandonedService = new FakeConversationService();
		const abandonedController = new ConversationController(abandonedService);
		const committedService = new FakeConversationService();
		const committedController = new ConversationController(committedService);

		expect(abandonedService.subscribeCalls).toBe(0);
		expect(committedService.subscribeCalls).toBe(0);

		await committedController.load();
		await committedController.load();
		expect(committedService.subscribeCalls).toBe(1);
		expect(committedService.listenerCount).toBe(1);

		committedController.dispose();
		expect(committedService.listenerCount).toBe(0);
		expect(committedService.unsubscribeCalls).toBe(1);
		abandonedController.dispose();
		expect(abandonedService.unsubscribeCalls).toBe(0);
	});

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

	test("re-reads the durable thread when a run finishes during initial load", async () => {
		const service = new FakeConversationService();
		service.activeConversationLoads = [
			{
				...initialThread,
				messages: [
					{
						id: "user-race",
						role: "user",
						content: "继续",
						createdAtMs: 2,
						state: "complete",
					},
				],
			},
			{
				...initialThread,
				updatedAtMs: 4,
				messages: [
					{
						id: "user-race",
						role: "user",
						content: "继续",
						createdAtMs: 2,
						state: "complete",
					},
					{
						id: "assistant-race",
						role: "assistant",
						content: "已完成",
						createdAtMs: 4,
						state: "complete",
					},
				],
			},
		];
		const controller = new ConversationController(service);

		await controller.load();

		expect(service.loadActiveConversationCalls).toBe(2);
		expect(readyState(controller.getSnapshot()).thread.messages).toEqual([
			expect.objectContaining({ id: "user-race", content: "继续" }),
			expect.objectContaining({ id: "assistant-race", content: "已完成" }),
		]);
		controller.dispose();
	});

	test("starts a draft thread without an identity and backfills Bun's conversation id", async () => {
		const service = new FakeConversationService();
		service.activeConversation = null;
		const controller = new ConversationController(service);
		await controller.load();
		await controller.createConversation({ title: "新的讨论" });
		await controller.sendMessage({
			clientMessageId: "user-new",
			text: "从这里开始",
		});

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
		service.restorableRuns = [
			{
				runId: "run-1",
				requestId: "request-restored",
				status: "interrupted",
				revision: 4,
				lastSequence: 12,
				updatedAtMs: 50,
				conversationId: initialThread.id,
			},
		];
		service.snapshot = snapshot({
			requestId: "request-restored",
			status: "interrupted",
			revision: 4,
			lastSequence: 12,
		});
		const controller = new ConversationController(service);

		await controller.load();

		expect(service.snapshotRequests).toEqual(["run-1"]);
		expect(readyState(controller.getSnapshot()).turn.status).toBe(
			"interrupted",
		);
		controller.dispose();
	});

	test("replays a terminal event that arrives while the initial snapshot is loading", async () => {
		const service = new FakeConversationService();
		service.restorableRuns = [
			{
				runId: "run-1",
				requestId: "snapshot-request",
				status: "running",
				revision: 1,
				lastSequence: 1,
				updatedAtMs: 20,
				conversationId: initialThread.id,
			},
		];
		service.snapshotLoader = async () => {
			service.emit({
				runId: "run-1",
				requestId: "snapshot-request",
				sequence: 2,
				revision: 2,
				emittedAtMs: 30,
				event: { type: "run.completed", completedAtMs: 30 },
			});
			return snapshot({
				requestId: "snapshot-request",
				status: "running",
				revision: 1,
				lastSequence: 1,
			});
		};
		const controller = new ConversationController(service);

		await controller.load();

		const state = readyState(controller.getSnapshot());
		expect(state.turn.status).toBe("idle");
		expect(state.thread.messages.at(-1)?.state).toBe("complete");
		controller.dispose();
	});

	test("does not append a buffered delta already present in the loaded conversation", async () => {
		const service = new FakeConversationService();
		service.restorableRuns = [
			{
				runId: "run-1",
				requestId: "snapshot-request",
				status: "running",
				revision: 1,
				lastSequence: 1,
				updatedAtMs: 20,
				conversationId: initialThread.id,
			},
		];
		service.snapshotLoader = async () => {
			service.emit({
				runId: "run-1",
				requestId: "snapshot-request",
				sequence: 2,
				revision: 1,
				emittedAtMs: 21,
				event: {
					type: "message.delta",
					conversationId: initialThread.id,
					messageId: "assistant-1",
					startOffset: 0,
					delta: "片段",
				},
			});
			const loaded = snapshot({
				requestId: "snapshot-request",
				status: "running",
				revision: 1,
				lastSequence: 1,
			});
			return {
				...loaded,
				conversation: {
					...loaded.conversation,
					messages: loaded.conversation.messages.map((message) =>
						message.id === "assistant-1"
							? { ...message, content: "片段" }
							: message,
					),
				},
			};
		};
		const controller = new ConversationController(service);

		await controller.load();

		const state = readyState(controller.getSnapshot());
		expect(state.thread.messages.at(-1)?.content).toBe("片段");
		expect(state.turn.status).toBe("running");
		if (state.turn.status === "running") {
			expect(state.turn.run.lastSequence).toBe(2);
		}
		controller.dispose();
	});

	test("reconciles a buffered delta when snapshot sequence leads its conversation content", async () => {
		const service = new FakeConversationService();
		service.restorableRuns = [
			{
				runId: "run-1",
				requestId: "snapshot-request",
				status: "running",
				revision: 1,
				lastSequence: 2,
				updatedAtMs: 20,
				conversationId: initialThread.id,
			},
		];
		service.snapshotLoader = async () => {
			service.emit({
				runId: "run-1",
				requestId: "snapshot-request",
				sequence: 2,
				revision: 1,
				emittedAtMs: 21,
				event: {
					type: "message.delta",
					conversationId: initialThread.id,
					messageId: "assistant-1",
					startOffset: 0,
					delta: "补齐正文",
				},
			});
			const loaded = snapshot({
				requestId: "snapshot-request",
				status: "running",
				revision: 1,
				lastSequence: 2,
			});
			return {
				...loaded,
				conversation: {
					...loaded.conversation,
					messages: loaded.conversation.messages.map((message) =>
						message.id === "assistant-1"
							? { ...message, content: "" }
							: message,
					),
				},
			};
		};
		const controller = new ConversationController(service);

		await controller.load();

		const state = readyState(controller.getSnapshot());
		expect(state.thread.messages.at(-1)?.content).toBe("补齐正文");
		expect(state.turn.status).toBe("running");
		if (state.turn.status === "running") {
			expect(state.turn.run.lastSequence).toBe(2);
		}
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
		expect(
			state.thread.messages.filter((message) => message.role === "user"),
		).toEqual([expect.objectContaining({ id: "user-1", content: "继续" })]);
		expect(state.thread.messages).toHaveLength(2);
		controller.dispose();
	});

	test("deduplicates concurrent resume actions before starting a replacement run", async () => {
		const service = new FakeConversationService();
		service.restorableRuns = [
			{
				runId: "run-1",
				requestId: "request-interrupted",
				status: "interrupted",
				revision: 4,
				lastSequence: 12,
				updatedAtMs: 50,
				conversationId: initialThread.id,
			},
		];
		const interrupted = snapshot({
			requestId: "request-interrupted",
			status: "interrupted",
			revision: 4,
			lastSequence: 12,
		});
		service.snapshot = interrupted;
		const controller = new ConversationController(service);
		await controller.load();
		let resolveSnapshot!: (value: ConversationRunSnapshot) => void;
		service.snapshotLoader = () =>
			new Promise((resolve) => {
				resolveSnapshot = resolve;
			});

		const first = controller.resumeInterruptedRun("run-1");
		const second = controller.resumeInterruptedRun("run-1");
		expect(readyState(controller.getSnapshot()).turn.status).toBe("recovering");
		expect(service.snapshotRequests).toHaveLength(2);
		resolveSnapshot(interrupted);
		await Promise.all([first, second]);

		expect(service.startInputs).toHaveLength(1);
		controller.dispose();
	});

	test("does not let a stale resume replace a newly created conversation", async () => {
		const service = new FakeConversationService();
		service.restorableRuns = [
			{
				runId: "run-1",
				requestId: "request-interrupted",
				status: "interrupted",
				revision: 4,
				lastSequence: 12,
				updatedAtMs: 50,
				conversationId: initialThread.id,
			},
		];
		const interrupted = snapshot({
			requestId: "request-interrupted",
			status: "interrupted",
			revision: 4,
			lastSequence: 12,
		});
		service.snapshot = interrupted;
		const controller = new ConversationController(service);
		await controller.load();
		let resolveSnapshot!: (value: ConversationRunSnapshot) => void;
		service.snapshotLoader = () =>
			new Promise((resolve) => {
				resolveSnapshot = resolve;
			});

		const resuming = controller.resumeInterruptedRun("run-1");
		await controller.createConversation({ title: "不要被旧恢复覆盖" });
		resolveSnapshot(interrupted);
		await resuming;

		expect(service.startInputs).toEqual([]);
		const state = readyState(controller.getSnapshot());
		expect(state.thread.title).toBe("不要被旧恢复覆盖");
		expect(state.thread.isDraft).toBe(true);
		expect(state.turn.status).toBe("idle");
		controller.dispose();
	});

	test("surfaces a snapshot failure while resuming without rejecting the UI action", async () => {
		const service = new FakeConversationService();
		service.restorableRuns = [
			{
				runId: "run-1",
				requestId: "request-interrupted",
				status: "interrupted",
				revision: 4,
				lastSequence: 12,
				updatedAtMs: 50,
				conversationId: initialThread.id,
			},
		];
		service.snapshot = snapshot({
			requestId: "request-interrupted",
			status: "interrupted",
			revision: 4,
			lastSequence: 12,
		});
		const controller = new ConversationController(service);
		await controller.load();
		service.snapshotFailure = new ConversationServiceError(
			"offline",
			"暂时无法恢复",
		);

		await expect(
			controller.resumeInterruptedRun("run-1"),
		).resolves.toBeUndefined();
		expect(controller.getSnapshot()).toMatchObject({
			status: "offline",
			message: "暂时无法恢复",
		});
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
			startOffset: 0,
			delta: "我先",
		});
		service.emitRun(4, 1, {
			type: "message.delta",
			conversationId: initialThread.id,
			messageId: "message-assistant-1",
			startOffset: 2,
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

	test("uses UTF-16 offsets to preserve consecutive identical deltas", async () => {
		const service = new FakeConversationService();
		const controller = new ConversationController(service);
		await controller.load();
		await controller.sendMessage({
			clientMessageId: "message-user-repeat",
			text: "重复字符",
			conversationId: initialThread.id,
		});
		service.emitRun(1, 1, { type: "run.started", startedAtMs: 10 });
		service.emitRun(2, 1, {
			type: "message.started",
			conversationId: initialThread.id,
			messageId: "message-assistant-repeat",
			createdAtMs: 20,
		});
		service.emitRun(3, 1, {
			type: "message.delta",
			conversationId: initialThread.id,
			messageId: "message-assistant-repeat",
			startOffset: 0,
			delta: "🐋",
		});
		service.emitRun(4, 1, {
			type: "message.delta",
			conversationId: initialThread.id,
			messageId: "message-assistant-repeat",
			startOffset: 2,
			delta: "🐋",
		});

		expect(
			readyState(controller.getSnapshot()).thread.messages.at(-1)?.content,
		).toBe("🐋🐋");
		controller.dispose();
	});

	test("accepts the first push event even when it arrives before the short request ACK", async () => {
		const service = new FakeConversationService();
		let resolveStart!: (accepted: ConversationRunAccepted) => void;
		service.startTurn = (input) => {
			service.startInputs.push(input);
			return new Promise((resolve) => {
				resolveStart = resolve;
			});
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
		if (state.turn.status === "running")
			expect(state.turn.run.lastSequence).toBe(1);
		controller.dispose();
	});

	test("cancels by revision and marks a partial assistant message as retained", async () => {
		const service = new FakeConversationService();
		const controller = new ConversationController(service);
		await controller.load();
		await controller.sendMessage({
			clientMessageId: "user-1",
			text: "继续",
			conversationId: initialThread.id,
		});
		service.emitRun(1, 1, { type: "run.started", startedAtMs: 10 });
		service.emitRun(2, 1, {
			type: "message.delta",
			conversationId: initialThread.id,
			messageId: "assistant-1",
			startOffset: 0,
			delta: "部分结果",
		});

		await controller.stopRun();
		expect(service.cancelInputs[0]).toMatchObject({
			runId: "run-1",
			expectedRevision: 1,
		});
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
		await controller.sendMessage({
			clientMessageId: "user-1",
			text: "读取状态",
			conversationId: initialThread.id,
		});
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
		await controller.sendMessage({
			clientMessageId: "user-1",
			text: "继续",
			conversationId: initialThread.id,
		});
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

	test("replays a terminal event received while a gap recovery snapshot is pending", async () => {
		const service = new FakeConversationService();
		let resolveSnapshot!: (snapshot: ConversationRunSnapshot) => void;
		service.snapshotLoader = () =>
			new Promise((resolve) => {
				resolveSnapshot = resolve;
			});
		const controller = new ConversationController(service);
		await controller.load();
		await controller.sendMessage({
			clientMessageId: "user-recovery-race",
			text: "不要让旧快照覆盖完成事件",
			conversationId: initialThread.id,
		});
		service.emitRun(1, 1, { type: "run.started", startedAtMs: 10 });

		service.emitRun(3, 2, {
			type: "run.progress",
			phase: "thinking",
			message: "处理中",
		});
		expect(service.snapshotRequests).toEqual(["run-1"]);
		service.emitRun(4, 3, { type: "run.completed", completedAtMs: 40 });
		const requestId = service.startInputs[0]?.requestId;
		if (!requestId) throw new Error("missing started request");
		resolveSnapshot(
			snapshot({
				requestId,
				status: "running",
				revision: 2,
				lastSequence: 3,
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const state = readyState(controller.getSnapshot());
		expect(state.turn.status).toBe("idle");
		expect(state.thread.messages.at(-1)?.state).toBe("complete");
		controller.dispose();
	});

	test("keeps the optimistic thread visible when starting fails offline", async () => {
		const service = new FakeConversationService();
		service.startFailure = new ConversationServiceError(
			"offline",
			"当前离线。",
		);
		const controller = new ConversationController(service);
		await controller.load();

		await controller.sendMessage({
			clientMessageId: "user-1",
			text: "继续",
			conversationId: initialThread.id,
		});
		const state = controller.getSnapshot();
		expect(state.status).toBe("offline");
		if (state.status === "offline") {
			expect(state.cachedThread?.messages[0]?.state).toBe("failed");
			expect(state.turn?.status).toBe("failed");
		}
		controller.dispose();
	});
});

function readyState(
	state: ConversationPageState,
): Extract<ConversationPageState, { status: "ready" }> {
	if (state.status !== "ready")
		throw new Error(`Expected ready state, received ${state.status}`);
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
				{
					id: "user-1",
					role: "user",
					content: "继续",
					createdAtMs: 10,
					state: "complete",
				},
				{
					id: "assistant-1",
					role: "assistant",
					content: "权威内容",
					createdAtMs: 20,
					state: "streaming",
				},
			],
		},
		clientMessageId: "user-1",
		assistantMessageId: "assistant-1",
	};
}
