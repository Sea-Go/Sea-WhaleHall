import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useState } from "react";

GlobalRegistrator.register({
	url: "http://whalehall-pet.test/",
	width: 360,
	height: 300,
});
const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [
	{ act, cleanup, render },
	{ default: userEvent },
	{ PetActivityFeedbackBubbleView },
	{ clearSensitivePetFeedbackSynchronously },
] = await Promise.all([
	import("@testing-library/react"),
	import("@testing-library/user-event"),
	import("../src/views/pet/PetActivityFeedbackBubbleView"),
	import("../src/views/pet/sensitive-feedback-clear"),
]);

afterEach(() => cleanup());

afterAll(async () => {
	delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	await GlobalRegistrator.unregister();
});

describe("pet activity feedback bubble", () => {
	test("commits old-account text removal before a clear ACK can return", () => {
		let clearBeforeAck!: () => void;
		let absentBeforeReturn = false;
		function SensitiveMessageHarness() {
			const [message, setMessage] = useState<string | null>("账号 A 的反馈");
			clearBeforeAck = () => {
				clearSensitivePetFeedbackSynchronously(() => setMessage(null));
				absentBeforeReturn =
					document.body.textContent?.includes("账号 A") === false;
			};
			return message === null ? null : <p>{message}</p>;
		}
		const view = render(<SensitiveMessageHarness />);
		expect(view.getByText("账号 A 的反馈")).toBeTruthy();
		act(() => clearBeforeAck());
		expect(absentBeforeReturn).toBeTrue();
		expect(view.queryByText("账号 A 的反馈")).toBeNull();
	});

	test("renders safe Markdown while exposing progress and explicit controls", () => {
		const view = render(
			<PetActivityFeedbackBubbleView
				page={{
					presentationId: "feedback-ui",
					generatedAtMs: 1_786_464_000_000,
					text: "**重点观察**\n\n- 第一项\n- 第二项\n\n<b>HTML 保持文字</b>",
					pageNumber: 2,
					pageCount: 4,
					dwellMs: 8_000,
				}}
				onNext={() => {}}
				onDismiss={() => {}}
			/>,
		);
		const status = view.getByRole("status", { name: "Agent 主动反馈" });
		expect(status.getAttribute("aria-live")).toBe("polite");
		expect(status.getAttribute("aria-atomic")).toBe("true");
		expect(view.getByText("重点观察").tagName).toBe("STRONG");
		expect(view.getByText(/第一项/u).closest("li")).toBeTruthy();
		expect(view.getByText(/第二项/u).closest("li")).toBeTruthy();
		expect(view.getByText("<b>HTML 保持文字</b>")).toBeTruthy();
		expect(view.container.querySelector("b")).toBeNull();
		expect(view.getByText("第 2 段，共 4 段")).toBeTruthy();
		expect(view.getByText("2/4")).toBeTruthy();
		expect(view.getByRole("button", { name: "下一段" })).toBeTruthy();
		expect(view.getByRole("button", { name: "收起剩余" })).toBeTruthy();
	});

	test("never creates active content, links, or images from model Markdown", () => {
		const view = render(
			<PetActivityFeedbackBubbleView
				page={{
					presentationId: "feedback-hostile-markdown",
					generatedAtMs: 1_786_464_000_000,
					text: [
						"[不要跳转](javascript:alert(1))",
						"![不要加载](https://invalid.example/image.png)",
						"<script>globalThis.compromised = true</script>",
						"<https://invalid.example/auto>",
					].join("\n\n"),
					pageNumber: 1,
					pageCount: 1,
					dwellMs: 8_000,
				}}
				onNext={() => {}}
				onDismiss={() => {}}
			/>,
		);
		expect(view.getByText("[不要跳转](javascript:alert(1))")).toBeTruthy();
		expect(
			view.getByText("![不要加载](https://invalid.example/image.png)"),
		).toBeTruthy();
		expect(
			view.getByText("<script>globalThis.compromised = true</script>"),
		).toBeTruthy();
		expect(view.getByText("<https://invalid.example/auto>")).toBeTruthy();
		expect(view.container.querySelector("a")).toBeNull();
		expect(view.container.querySelector("img")).toBeNull();
		expect(view.container.querySelector("script")).toBeNull();
	});

	test("bubble controls do not bubble into pet pointer interaction", async () => {
		let nextCalls = 0;
		let dismissCalls = 0;
		let parentPointerCalls = 0;
		const view = render(
			<PetActivityFeedbackBubbleView
				page={{
					presentationId: "feedback-controls",
					generatedAtMs: 1_786_464_000_000,
					text: "保持桌宠交互隔离",
					pageNumber: 1,
					pageCount: 2,
					dwellMs: 8_000,
				}}
				onNext={() => {
					nextCalls += 1;
				}}
				onDismiss={() => {
					dismissCalls += 1;
				}}
			/>,
		);
		const recordParentPointer = () => {
			parentPointerCalls += 1;
		};
		document.body.addEventListener("click", recordParentPointer);
		document.body.addEventListener("pointerdown", recordParentPointer);
		const user = userEvent.setup({ document });
		try {
			await user.click(view.getByRole("button", { name: "下一段" }));
			await user.click(view.getByRole("button", { name: "收起剩余" }));
		} finally {
			document.body.removeEventListener("click", recordParentPointer);
			document.body.removeEventListener("pointerdown", recordParentPointer);
		}
		expect(nextCalls).toBe(1);
		expect(dismissCalls).toBe(1);
		expect(parentPointerCalls).toBe(0);
	});
});
