import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	PlanningPage,
	ProposalEditor,
} from "../src/views/client/features/planning/PlanningPage";
import { PlanningController } from "../src/views/client/features/planning/PlanningController";
import { CalendarPlanningGateway } from "../src/views/client/infrastructure/planning/CalendarPlanningGateway";
import { MockCalendarService } from "../src/views/client/infrastructure/calendar/MockCalendarService";
import { MockPlanningGenerationService } from "../src/views/client/infrastructure/planning/MockPlanningGenerationService";

function setup() {
	const calendar = new MockCalendarService({ latencyMs: 0 });
	const controller = new PlanningController(
		new MockPlanningGenerationService({ latencyMs: 0 }),
		new CalendarPlanningGateway(calendar, () => "mutation"),
		() => "2026-07-29",
		() => "Asia/Shanghai",
		() => "apply",
	);
	const render = () =>
		renderToStaticMarkup(
			<PlanningPage
				controller={controller}
				onNotify={() => {}}
				onOpenCalendar={() => {}}
				renderSchedulePreview={() => <div>可拖动周视图</div>}
			/>,
		);
	return { controller, render };
}

async function readyReview(controller: PlanningController) {
	controller.start();
	controller.updateInput({ goal: "完成个人作品集与求职材料" });
	controller.next();
	controller.updateInput({ type: "long-term" });
	controller.next();
	controller.updateInput({
		deadline: "2026-10-01",
		weeklyCapacityHours: 6,
	});
	await controller.generate();
}

describe("planning guided UI", () => {
	test("starts with natural language instead of a long form", () => {
		const { controller, render } = setup();
		controller.start();
		const markup = render();
		expect(markup).toContain("你想完成什么？");
		expect(markup).toContain("目标描述");
		expect(markup).toContain("按 ⌘ Enter 继续");
		expect(markup).not.toContain("每周可投入");
		expect(markup).not.toContain("优先级");
	});

	test("shows seven clear steps and distinguishes draft from committed calendar", async () => {
		const { controller, render } = setup();
		await readyReview(controller);
		controller.openSchedule();
		const markup = render();
		for (const label of [
			"描述目标",
			"选择类型",
			"补充约束",
			"生成计划",
			"审阅结构",
			"调整日程",
			"确认写入",
		]) {
			expect(markup).toContain(label);
		}
		expect(markup).toContain("日程草案 · 尚未写入");
		expect(markup).toContain("此刻正式日历仍未改变");
		expect(markup).toContain("可拖动周视图");
		expect(markup).toContain("重新生成");
	});

	test("confirm screen requires an explicit write action", async () => {
		const { controller, render } = setup();
		await readyReview(controller);
		controller.openSchedule();
		controller.openConfirm();
		const markup = render();
		expect(markup).toContain("最后确认");
		expect(markup).toContain("确认并写入日历");
		expect(markup).toContain("失败时不会留下半套安排");
	});

	test("proposal editor provides keyboard-close, labeled fields, and delete alternative", () => {
		const markup = renderToStaticMarkup(
			<ProposalEditor
				item={{
					id: "proposal",
					sourcePlanId: "plan",
					taskId: "task",
					title: "完成核心任务",
					state: "proposed",
					start: "2026-07-30T01:00:00Z",
					end: "2026-07-30T02:00:00Z",
					timeZone: "Asia/Shanghai",
					version: 0,
				}}
				onClose={() => {}}
				onDelete={() => {}}
				onSave={() => {}}
			/>,
		);
		expect(markup).toContain('role="dialog"');
		expect(markup).toContain('aria-modal="true"');
		expect(markup).toContain('aria-label="关闭编辑"');
		expect(markup).toContain("开始");
		expect(markup).toContain("结束");
		expect(markup).toContain("从草案删除");
		expect(markup).toContain("保存只更新草案");
	});
});
