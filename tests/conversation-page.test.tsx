import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationPage } from "../src/views/client/features/conversation/ConversationPage";
import type { ConversationRun } from "../src/views/client/features/conversation/domain";

const run: ConversationRun = {
	id: "run-1",
	requestId: "request-1",
	clientMessageId: "user-1",
	status: "running",
	revision: 3,
	lastSequence: 8,
	startedAtMs: 1,
	updatedAtMs: 8,
	phase: "using-tool",
	statusMessage: "正在读取日程摘要",
	toolCalls: [
		{
			id: "tool-1",
			name: "calendar.read",
			label: "读取今日日程",
			risk: "read",
			status: "running",
			progress: "已读取 2 个日程块",
		},
	],
	pendingApproval: null,
	approvalDecisionPending: false,
};

const thread = {
	id: "conversation-1",
	title: "今天的计划",
	updatedAtMs: 8,
	messages: [
		{ id: "user-1", role: "user" as const, content: "帮我看看今天", createdAtMs: 1, state: "complete" as const },
		{ id: "assistant-1", role: "assistant" as const, content: "你今天有两个", createdAtMs: 2, state: "streaming" as const },
	],
};

describe("ConversationPage Agent run states", () => {
	test("renders partial streaming content, Tool progress, and an explicit Stop control", () => {
		const markup = renderToStaticMarkup(
			<ConversationPage
				state={{ status: "ready", thread, turn: { status: "running", run } }}
				actions={{ onStopRun: () => {} }}
			/>,
		);

		expect(markup).toContain("你今天有两个");
		expect(markup).toContain("正在生成回复");
		expect(markup).toContain("读取今日日程");
		expect(markup).toContain("已读取 2 个日程块");
		expect(markup).toContain(">停止<");
		expect(markup).not.toContain('conversation-workspace__messages" aria-live');
	});

	test("renders one-time approval and deny actions without exposing the input digest", () => {
		const approvalRun: ConversationRun = {
			...run,
			status: "suspended",
			pendingApproval: {
				id: "approval-1",
				toolCallId: "tool-1",
				title: "允许读取本地日历？",
				description: "只读取日程标题和时间，不会修改内容。",
				risk: "read",
				inputDigest: "sha256:must-stay-hidden",
				requestedAtMs: 8,
			},
		};
		const markup = renderToStaticMarkup(
			<ConversationPage
				state={{ status: "ready", thread, turn: { status: "suspended", run: approvalRun } }}
				actions={{ onApproveTool: () => {}, onDeclineTool: () => {}, onStopRun: () => {} }}
			/>,
		);

		expect(markup).toContain("仅本次允许");
		expect(markup).toContain(">拒绝<");
		expect(markup).toContain("只读操作");
		expect(markup).not.toContain("sha256:must-stay-hidden");
	});

	test("labels cancelled partial output and enables the next composer turn", () => {
		const markup = renderToStaticMarkup(
			<ConversationPage
				state={{
					status: "ready",
					thread: {
						...thread,
						messages: [{ ...thread.messages[1]!, state: "cancelled" }],
					},
					turn: {
						status: "cancelled",
						run: { ...run, status: "cancelled" },
						message: "已停止生成，已保留当前内容。",
					},
				}}
				actions={{ onSendMessage: () => {} }}
			/>,
		);

		expect(markup).toContain("生成已停止，已保留部分内容");
		expect(markup).toContain("已停止生成，已保留当前内容");
		expect(markup).not.toContain('id="conversation-draft" disabled');
	});
});
