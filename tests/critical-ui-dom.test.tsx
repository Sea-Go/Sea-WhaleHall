import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { StrictMode, useEffect } from "react";
import type { AuthCredentials } from "../src/views/client/features/auth/domain";
import type { ConversationRun } from "../src/views/client/features/conversation/domain";
import type { ProactiveFeedbackService } from "../src/views/client/features/proactive-feedback/proactive-feedback-service";

GlobalRegistrator.register({
	url: "http://whalehall.test/",
	width: 1_440,
	height: 900,
});
const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [
	{ cleanup, render, waitFor },
	{ default: userEvent },
	{ AuthPage },
	{ ConversationPage },
	{ ProactiveFeedbackPolicyController },
	{ useStrictModeSafeDispose },
] = await Promise.all([
	import("@testing-library/react"),
	import("@testing-library/user-event"),
	import("../src/views/client/features/auth/AuthPage"),
	import("../src/views/client/features/conversation/ConversationPage"),
	import(
		"../src/views/client/features/proactive-feedback/ProactiveFeedbackPolicyController"
	),
	import("../src/views/client/use-strict-mode-safe-dispose"),
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

describe("StrictMode-owned account controllers", () => {
	test("keeps the policy controller alive through rehearsal and disposes it on real unmount", async () => {
		let revision = 0;
		const service: ProactiveFeedbackService = {
			loadPolicy: async () => ({
				policy: { enabled: true, retention: 30 },
				revision,
				updatedAtMs: 1_800_000_000_000,
			}),
			setPolicy: async (policy, expectedRevision) => {
				expect(expectedRevision).toBe(revision);
				revision += 1;
				return {
					policy: { ...policy },
					revision,
					updatedAtMs: 1_800_000_000_001,
				};
			},
			listHistory: async () => ({ items: [], nextCursor: null }),
			clear: async () => ({ clearedAtMs: 1_800_000_000_002 }),
			onAvailable: () => () => {},
		};
		const controller = new ProactiveFeedbackPolicyController(service);

		function PolicyOwner() {
			useStrictModeSafeDispose(controller, (owned) => owned.dispose());
			useEffect(() => {
				void controller.load();
			}, []);
			return null;
		}

		const view = render(
			<StrictMode>
				<PolicyOwner />
			</StrictMode>,
		);
		await waitFor(() => expect(controller.getSnapshot().status).toBe("ready"));
		expect(await controller.setEnabled(false)).toMatchObject({
			policy: { enabled: false, retention: 30 },
			revision: 1,
		});

		view.unmount();
		await Promise.resolve();
		expect(await controller.load()).toBeNull();
	});
});

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
				actions={{
					onStopRun: () => {
						stopCalls += 1;
					},
				}}
			/>,
		);
		const user = userEvent.setup({ document });

		expect(
			view.getByText("你今天有两个").closest("article")?.className,
		).toContain("conversation-message--assistant");
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
				actions={{
					onStopRun: () => {
						stopCalls += 1;
					},
				}}
			/>,
		);
		expect(view.getByText("你今天有两个重要日程")).toBeTruthy();
		expect(liveRegionText(view.container)).toEqual(liveTextBefore);

		await user.click(view.getByRole("button", { name: "停止" }));
		expect(stopCalls).toBe(1);
	});
});

describe("critical AuthPage DOM behavior", () => {});

function liveRegionText(container: HTMLElement): string[] {
	return [...container.querySelectorAll<HTMLElement>("[aria-live]")].map(
		(region) => region.textContent ?? "",
	);
}
