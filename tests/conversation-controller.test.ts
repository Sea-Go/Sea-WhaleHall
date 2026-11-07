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
