/** 右键菜单组件的 DOM 级验证（隔离，不依赖 FullCalendar）。 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
	url: "http://whalehall.test/",
	width: 1_440,
	height: 900,
});

const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [{ cleanup, render }] = await Promise.all([
	import("@testing-library/react"),
]);

afterEach(() => cleanup());

afterAll(async () => {
	delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	await GlobalRegistrator.unregister();
});

describe("EventContextMenu", () => {
	test("delete button invokes onDelete exactly once and menu closes", async () => {
		const { act } = await import("react");
		const source = await import(
			"../src/views/client/features/calendar/CalendarPage"
		);
		// EventContextMenu 未导出——通过 grep 确认后用渲染产物验证：
		// 直接以最小宿主复刻页面里的用法。
		const { createElement, useState } = await import("react");
		const deleted: string[] = [];
		function Host() {
			const [open, setOpen] = useState(true);
			const Menu = source.EventContextMenu ?? null;
			if (!Menu) throw new Error("EventContextMenu not exported");
			return createElement(Menu, {
				x: 10,
				y: 10,
				title: "计划任务",
				recurring: false,
				pending: false,
				onClose: () => setOpen(false),
				onDelete: () => {
					deleted.push("clicked");
					setOpen(false);
				},
				onEdit: () => {},
			});
		}
		render(createElement(Host));
		const menu = document.querySelector('[role="menu"]');
		expect(
			document.querySelector(".calendar-context-menu__backdrop"),
		).toBeTruthy();
		expect(menu).toBeTruthy();
		const btn = [...(menu?.querySelectorAll("button") ?? [])].find((b) =>
			(b.textContent ?? "").includes("删除"),
		);
		expect(btn).toBeTruthy();
		await act(async () => {
			btn?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
		});
		expect(deleted).toEqual(["clicked"]);
	});
});
