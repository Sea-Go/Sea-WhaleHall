import { describe, expect, test } from "bun:test";
import type {
	ProactiveFeedbackAvailable,
	ProactiveFeedbackHistoryCursor,
	SetProactiveFeedbackPolicyRequest,
} from "../src/shared/proactive-feedback";
import { ProactiveFeedbackServiceError } from "../src/views/client/features/proactive-feedback/proactive-feedback-service";
import {
	ElectrobunProactiveFeedbackService,
	type ProactiveFeedbackRpcClient,
} from "../src/views/client/infrastructure/proactive-feedback/ElectrobunProactiveFeedbackService";

class TestRpcClient implements ProactiveFeedbackRpcClient {
	setRequests: SetProactiveFeedbackPolicyRequest[] = [];
	listRequests: Array<{
		cursor?: ProactiveFeedbackHistoryCursor;
		limit: number;
	}> = [];
	clearCalls = 0;
	listResult: unknown = {
		kind: "success",
		data: {
			items: [{ id: "feedback-1", generatedAtMs: 100, message: "最终反馈" }],
			nextCursor: null,
		},
	};
	private listener: ((event: ProactiveFeedbackAvailable) => void) | null = null;

	async getProactiveFeedbackPolicy(): Promise<unknown> {
		return {
			kind: "success",
			data: {
				policy: { enabled: true, retention: 30 },
				revision: 2,
				updatedAtMs: 100,
			},
		};
	}

	async setProactiveFeedbackPolicy(
		request: SetProactiveFeedbackPolicyRequest,
	): Promise<unknown> {
		this.setRequests.push(request);
		return {
			kind: "success",
			data: {
				policy: request.policy,
				revision: request.expectedRevision + 1,
				updatedAtMs: 101,
			},
		};
	}

	async listProactiveFeedback(request: {
		cursor?: ProactiveFeedbackHistoryCursor;
		limit: number;
	}): Promise<unknown> {
		this.listRequests.push(request);
		return this.listResult;
	}

	async clearProactiveFeedbackData(): Promise<unknown> {
		this.clearCalls += 1;
		return { kind: "success", data: { clearedAtMs: 102 } };
	}

	onProactiveFeedbackAvailable(
		listener: (event: ProactiveFeedbackAvailable) => void,
	): () => void {
		this.listener = listener;
		return () => {
			this.listener = null;
		};
	}

	emit(event: ProactiveFeedbackAvailable): void {
		this.listener?.(event);
	}
}

describe("ElectrobunProactiveFeedbackService", () => {
	test("maps policy, keyset history, clear, and content-free availability without account identity", async () => {
		const client = new TestRpcClient();
		const service = new ElectrobunProactiveFeedbackService(client);
		expect(await service.loadPolicy()).toEqual({
			policy: { enabled: true, retention: 30 },
			revision: 2,
			updatedAtMs: 100,
		});
		await service.setPolicy({ enabled: false, retention: "forever" }, 2);
		expect(client.setRequests).toEqual([
			{
				policy: { enabled: false, retention: "forever" },
				expectedRevision: 2,
			},
		]);
		await service.listHistory({ limit: 20 });
		expect(client.listRequests).toEqual([{ limit: 20 }]);
		expect(JSON.stringify(client.listRequests)).not.toContain("accountId");
		expect(await service.clear()).toEqual({ clearedAtMs: 102 });
		expect(client.clearCalls).toBe(1);

		const events: ProactiveFeedbackAvailable[] = [];
		const unsubscribe = service.onAvailable((event) => events.push(event));
		await waitFor(() => true);
		client.emit({ id: "feedback-2", generatedAtMs: 200 });
		expect(events).toEqual([{ id: "feedback-2", generatedAtMs: 200 }]);
		unsubscribe();
	});

	test("rejects a renderer projection carrying extra sensitive fields", async () => {
		const client = new TestRpcClient();
		client.listResult = {
			kind: "success",
			data: {
				items: [
					{
						id: "feedback-1",
						generatedAtMs: 100,
						message: "最终反馈",
						rawEventStream: "must-not-cross-rpc",
					},
				],
				nextCursor: null,
			},
		};
		const service = new ElectrobunProactiveFeedbackService(client);
		try {
			await service.listHistory({ limit: 20 });
			throw new Error("Expected invalid response");
		} catch (reason) {
			expect(reason).toBeInstanceOf(ProactiveFeedbackServiceError);
			if (!(reason instanceof ProactiveFeedbackServiceError)) throw reason;
			expect(reason.failure).toBe("invalid-response");
		}
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		await Promise.resolve();
		if (predicate()) return;
	}
	throw new Error("Condition was not met");
}
