import { describe, expect, test } from "bun:test";

import { ConversationController } from "../src/views/client/features/conversation/ConversationController";
import type { ConversationService } from "../src/views/client/features/conversation/conversation-service";
import type { ConversationThread } from "../src/views/client/features/conversation/domain";

const initialThread: ConversationThread = {
	id: "conversation-1",
	title: "新对话",
	updatedAtMs: 1,
	messages: [],
};

describe("ConversationController", () => {
	test("loads, sends optimistically, then replaces with the persisted full history", async () => {
		let resolveSend: ((value: Awaited<ReturnType<ConversationService["sendMessage"]>>) => void) | undefined;
		const service: ConversationService = {
			loadActiveConversation: async () => initialThread,
			createConversation: async () => initialThread,
			sendMessage: () => new Promise((resolve) => {
				resolveSend = resolve;
			}),
		};
		const controller = new ConversationController(service);

		await controller.load();
		expect(controller.getSnapshot()).toEqual({ status: "ready", thread: initialThread });

		const sending = controller.sendMessage({
			conversationId: initialThread.id,
			clientMessageId: "message-user-1",
			text: "帮我看看今天的计划",
		});
		expect(controller.getSnapshot().status).toBe("sending");

		resolveSend?.({
			conversation: {
				...initialThread,
				updatedAtMs: 3,
				messages: [
					{ id: "message-user-1", role: "user", content: "帮我看看今天的计划", createdAtMs: 2, state: "complete" },
					{ id: "message-assistant-1", role: "assistant", content: "我先帮你查看。", createdAtMs: 3, state: "complete" },
				],
			},
			userMessage: { id: "message-user-1", role: "user", content: "帮我看看今天的计划", createdAtMs: 2, state: "complete" },
			assistantMessage: { id: "message-assistant-1", role: "assistant", content: "我先帮你查看。", createdAtMs: 3, state: "complete" },
		});
		await sending;

		const state = controller.getSnapshot();
		expect(state.status).toBe("ready");
		if (state.status === "ready") {
			expect(state.thread.messages).toHaveLength(2);
			expect(state.thread.messages[1]?.content).toBe("我先帮你查看。");
		}
	});
});
