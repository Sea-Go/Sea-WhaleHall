import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
	url: "http://whalehall-pet-panel.test/",
	width: 320,
	height: 250,
});
const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [{ act, cleanup, fireEvent, render }, { PetChatPanel }] =
	await Promise.all([
		import("@testing-library/react"),
		import("../src/views/pet/PetChatPanel"),
	]);
const { PetChatController } = await import("../src/views/pet/chat");

afterEach(() => cleanup());
afterAll(async () => {
	delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	await GlobalRegistrator.unregister();
});

function mountPanel() {
	const started: { requestId: string; text: string }[] = [];
	const controller = new PetChatController({
		startTurn: (input) => {
			started.push(input);
		},
		cancelTurn: () => {},
		reportState: () => {},
	});
	controller.setAvailable(true);
	const view = render(<PetChatPanel controller={controller} />);
	const input = view.getByLabelText("问点什么，回车发送") as HTMLInputElement;
	return { controller, started, view, input };
}

describe("PetChatPanel", () => {
	test("回车提交：清空输入并走 startTurn，不再渲染发送按钮", () => {
		const { started, view, input } = mountPanel();
		expect(view.queryByText("发送")).toBeNull();

		fireEvent.change(input, { target: { value: "帮我查一下知识库" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(started).toHaveLength(1);
		expect(started[0]?.text).toBe("帮我查一下知识库");
		expect(input.value).toBe("");
	});

	test("空输入回车不发起轮次", () => {
		const { started, input } = mountPanel();
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(started).toHaveLength(0);
	});
});
