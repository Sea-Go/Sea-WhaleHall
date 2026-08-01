import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AuthCredentials } from "../src/views/client/features/auth/domain";
import type { ConversationRun } from "../src/views/client/features/conversation/domain";
import { MOCK_AUTH_EXPERIENCE } from "../src/views/client/infrastructure/auth/MockAuthService";

GlobalRegistrator.register({
	url: "http://whalehall.test/",
	width: 1_440,
	height: 900,
});
const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [{ cleanup, render }, { default: userEvent }, { AuthPage }, { ConversationPage }] =
	await Promise.all([
		import("@testing-library/react"),
		import("@testing-library/user-event"),
		import("../src/views/client/features/auth/AuthPage"),
		import("../src/views/client/features/conversation/ConversationPage"),
	]);

afterEach(() => cleanup());

afterAll(async () => {
	delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	await GlobalRegistrator.unregister();
});

const runningRun: ConversationRun = {
	id: "run-dom-1",
	requestId: "request-dom-1",
	clientMessageId: "user-dom-1",
	status: "running",
	revision: 3,
	lastSequence: 8,
	startedAtMs: 1,
	updatedAtMs: 8,
	phase: "using-tool",
	statusMessage: "正在读取日程摘要",
	toolCalls: [
		{
			id: "tool-dom-1",
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

const streamingThread = {
	id: "conversation-dom-1",
	title: "今天的计划",
	updatedAtMs: 8,
	messages: [
		{
			id: "user-dom-1",
			role: "user" as const,
			content: "帮我看看今天",
			createdAtMs: 1,
			state: "complete" as const,
		},
		{
			id: "assistant-dom-1",
			role: "assistant" as const,
			content: "你今天有两个",
			createdAtMs: 2,
			state: "streaming" as const,
		},
	],
};

describe("critical ConversationPage DOM behavior", () => {
	test("renders a streaming bubble, wires Stop, and never announces token deltas", async () => {
		let stopCalls = 0;
		const view = render(
			<ConversationPage
				state={{
					status: "ready",
					thread: streamingThread,
					turn: { status: "running", run: runningRun },
				}}
				actions={{ onStopRun: () => { stopCalls += 1; } }}
			/>,
		);
		const user = userEvent.setup({ document });

		expect(view.getByText("你今天有两个").closest("article")?.className).toContain(
			"conversation-message--assistant",
		);
		expect(view.getByText("正在生成回复…")).toBeTruthy();
		expect(view.getByText("已读取 2 个日程块")).toBeTruthy();
		const liveTextBefore = liveRegionText(view.container);
		expect(liveTextBefore.length).toBeGreaterThan(0);
		expect(liveTextBefore.join(" ")).not.toContain("你今天有两个");

		view.rerender(
			<ConversationPage
				state={{
					status: "ready",
					thread: {
						...streamingThread,
						messages: streamingThread.messages.map((message) =>
							message.id === "assistant-dom-1"
								? { ...message, content: "你今天有两个重要日程" }
								: message,
						),
					},
					turn: { status: "running", run: runningRun },
				}}
				actions={{ onStopRun: () => { stopCalls += 1; } }}
			/>,
		);
		expect(view.getByText("你今天有两个重要日程")).toBeTruthy();
		expect(liveRegionText(view.container)).toEqual(liveTextBefore);

		await user.click(view.getByRole("button", { name: "停止" }));
		expect(stopCalls).toBe(1);
	});

	test("wires one-time approval and denial without exposing the input digest", async () => {
		let approveCalls = 0;
		let declineCalls = 0;
		const approvalRun: ConversationRun = {
			...runningRun,
			status: "suspended",
			toolCalls: [
				{
					id: "tool-dom-write-1",
					name: "calendar.create_event",
					label: "创建日程",
					risk: "write",
					status: "awaiting-approval",
				},
			],
			pendingApproval: {
				id: "approval-dom-1",
				toolCallId: "tool-dom-write-1",
				title: "允许创建本地日程？",
				description: "确认后会把这个日程写入本地日历。",
				risk: "write",
				inputDigest: "sha256:must-stay-hidden",
				requestedAtMs: 8,
			},
		};
		const pageActions = {
			onSendMessage: () => {},
			onStopRun: () => {},
			onApproveTool: () => { approveCalls += 1; },
			onDeclineTool: () => { declineCalls += 1; },
		};
		const view = render(
			<ConversationPage
				state={{
					status: "ready",
					thread: streamingThread,
					turn: { status: "suspended", run: approvalRun },
				}}
				actions={pageActions}
			/>,
		);
		const user = userEvent.setup({ document });

		expect(view.container.innerHTML).not.toContain("sha256:must-stay-hidden");
		expect(view.getByText("会修改数据")).toBeTruthy();
		await user.click(view.getByRole("button", { name: "仅本次允许" }));
		expect(approveCalls).toBe(1);
		expect(declineCalls).toBe(0);

		const continuedRun: ConversationRun = {
			...approvalRun,
			status: "running",
			pendingApproval: null,
			toolCalls: approvalRun.toolCalls.map((toolCall) => ({
				...toolCall,
				status: "running" as const,
			})),
		};
		view.rerender(
			<ConversationPage
				state={{
					status: "ready",
					thread: streamingThread,
					turn: { status: "running", run: continuedRun },
				}}
				actions={pageActions}
			/>,
		);
		expect(document.activeElement).toBe(view.getByRole("status"));

		const declinedApprovalRun: ConversationRun = {
			...approvalRun,
			pendingApproval: {
				...approvalRun.pendingApproval!,
				id: "approval-dom-2",
			},
		};
		view.rerender(
			<ConversationPage
				state={{
					status: "ready",
					thread: streamingThread,
					turn: { status: "suspended", run: declinedApprovalRun },
				}}
				actions={pageActions}
			/>,
		);
		await user.click(view.getByRole("button", { name: "拒绝" }));
		expect(declineCalls).toBe(1);
		view.rerender(
			<ConversationPage
				state={{
					status: "ready",
					thread: streamingThread,
					turn: { status: "idle" },
				}}
				actions={pageActions}
			/>,
		);
		expect(document.activeElement).toBe(view.getByLabelText("输入消息"));

		const finalApprovalRun: ConversationRun = {
			...approvalRun,
			pendingApproval: {
				...approvalRun.pendingApproval!,
				id: "approval-dom-3",
			},
		};
		view.rerender(
			<ConversationPage
				state={{
					status: "ready",
					thread: streamingThread,
					turn: { status: "suspended", run: finalApprovalRun },
				}}
				actions={pageActions}
			/>,
		);
		await user.click(view.getByRole("button", { name: "仅本次允许" }));
		await user.click(view.getByRole("button", { name: "停止" }));
		view.rerender(
			<ConversationPage
				state={{
					status: "ready",
					thread: streamingThread,
					turn: { status: "running", run: continuedRun },
				}}
				actions={pageActions}
			/>,
		);
		expect(document.activeElement).toBe(view.getByRole("button", { name: "停止" }));
	});
});

describe("critical AuthPage DOM behavior", () => {
	test("prefills the historical account, reveals the password, and clears it on Enter submit", async () => {
		const submissions: AuthCredentials[] = [];
		let releaseSubmission!: () => void;
		const submission = new Promise<void>((resolve) => {
			releaseSubmission = resolve;
		});
		const view = render(
			<AuthPage
				state={{ status: "unauthenticated", notice: null }}
				experienceCredentials={MOCK_AUTH_EXPERIENCE}
				onSubmit={(credentials) => {
					submissions.push({ ...credentials });
					return submission;
				}}
				onRetry={async () => {}}
			/>,
		);
		const user = userEvent.setup({ document });
		const email = view.getByLabelText("邮箱") as HTMLInputElement;
		const password = view.getByLabelText("密码") as HTMLInputElement;

		expect(email.value).toBe("demo@whalehall.local");
		expect(password.value).toBe("");
		expect(password.type).toBe("password");
		expect(view.getByText("体验密码：whalehall")).toBeTruthy();

		await user.type(password, "whalehall");
		await user.click(view.getByRole("button", { name: "显示密码" }));
		expect(password.type).toBe("text");
		expect(password.value).toBe("whalehall");

		await user.click(password);
		await user.keyboard("{Enter}");
		expect(submissions).toEqual([
			{
				email: "demo@whalehall.local",
				password: "whalehall",
			},
		]);
		expect(password.value).toBe("");
		expect(password.type).toBe("password");
		releaseSubmission();
		await submission;
	});
});

function liveRegionText(container: HTMLElement): string[] {
	return [...container.querySelectorAll<HTMLElement>("[aria-live]")].map(
		(region) => region.textContent ?? "",
	);
}
