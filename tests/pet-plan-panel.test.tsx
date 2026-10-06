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
		expect(view.getByText(/还没有进行中的计划/u)).toBeTruthy();
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

	test("offers the check-in three keys only on active items", () => {
		const view = render(<PetPlanPanel plan={MOCK_PET_PLAN} />);
		expect(view.getAllByRole("group", { name: "打卡" }).length).toBe(1);
		expect(view.getByRole("button", { name: "推迟" })).toBeTruthy();
		expect(view.getByRole("button", { name: "跳过" })).toBeTruthy();
	});

	test("check-in keys report the outcome; the why-note stays memory-only", async () => {
		const events: Array<{ itemId: string; outcome: string; note?: string }> =
			[];
		const view = render(
			<PetPlanPanel
				plan={MOCK_PET_PLAN}
				onCheckin={(itemId, outcome, note) => {
					events.push({ itemId, outcome, note });
				}}
			/>,
		);
		const user = userEvent.setup({ document });
		await user.click(view.getByRole("button", { name: "为什么？" }));
		expect(view.getByText(/只入记忆、不写计划/u)).toBeTruthy();
		await user.type(view.getByRole("textbox"), "昨晚没睡好");
		await user.click(view.getByRole("button", { name: "推迟" }));
		expect(events).toEqual([
			{ itemId: "item-1", outcome: "postponed", note: "昨晚没睡好" },
		]);
		// The note collapses after a check-in.
		expect(view.queryByRole("textbox")).toBeNull();
		await user.click(view.getByRole("button", { name: "完成" }));
		expect(events[1]).toEqual({ itemId: "item-1", outcome: "done" });
	});

	test("panel interactions stay inside the pet card", async () => {
		let parentClicks = 0;
		const onParentClick = () => {
			parentClicks += 1;
		};
		document.body.addEventListener("click", onParentClick);
		try {
			const view = render(<PetPlanPanel plan={MOCK_PET_PLAN} />);
			const user = userEvent.setup({ document });
			await user.click(view.getByRole("button", { name: "跳过" }));
			expect(parentClicks).toBe(0);
		} finally {
			document.body.removeEventListener("click", onParentClick);
		}
	});
});
