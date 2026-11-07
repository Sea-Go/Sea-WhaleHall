import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
	url: "http://whalehall-pet-plan-panel.test/",
	width: 360,
	height: 300,
});
const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [
	{ cleanup, render },
	{ default: userEvent },
	{ PetPlanPanel, MOCK_PET_PLAN },
] = await Promise.all([
	import("@testing-library/react"),
	import("@testing-library/user-event"),
	import("../src/views/pet/PetPlanPanel"),
]);

afterEach(() => cleanup());
afterAll(async () => {
	delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	await GlobalRegistrator.unregister();
});

describe("PetPlanPanel", () => {
	test("shows the empty state without a plan payload", () => {
		const view = render(<PetPlanPanel plan={null} />);
		expect(view.getByText(/暂无进行中的计划/u)).toBeTruthy();
		expect(view.queryByRole("button", { name: "完成" })).toBeNull();
	});

	test("renders cue, action, micro step, and badges from the plan payload", () => {
		const view = render(<PetPlanPanel plan={MOCK_PET_PLAN} />);
		expect(view.getByText("养成晨间阅读习惯")).toBeTruthy();
		expect(view.getByText("每天 08:00 · 书桌 · 早餐放下筷子后")).toBeTruthy();
		expect(view.getByText("读《深海生物学》第一章")).toBeTruthy();
		expect(view.getByText("微步骤：翻开书读两分钟")).toBeTruthy();
		// Item 1 inherits the plan's active badge; item 2 overrides to confirmed.
		expect(
			view.container.querySelectorAll('[data-status="active"]').length,
		).toBe(2);
		expect(
			view.container.querySelectorAll('[data-status="confirmed"]').length,
		).toBe(1);
	});
});
