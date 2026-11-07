import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type EditorState,
	EventEditor,
} from "../src/views/client/features/calendar/CalendarPage";
import { calendarScenarioEvents } from "../src/views/client/features/calendar/fixtures";
import { dayClickDraft } from "../src/views/client/features/calendar/fullcalendar-adapter";
import { PlanningController } from "../src/views/client/features/planning/PlanningController";
import { SmartScheduleComposer } from "../src/views/client/features/planning/PlanningPanels";
import type { PlanningService } from "../src/views/client/features/planning/planning-service";

const emptyPlanningService: PlanningService = {
	subscribe: () => () => {},
	onPlanningProgress() {
		return () => {};
	},
	listPlans: async () => [],
	getPlan: async () => {
		throw new Error("not used");
	},
	createPlanDraft: async () => ({ planId: "not-used" }),
	sendPlanMessage: async () => {},
	confirmPlanRevision: async () => {},
	setTaskStatus: async () => {},
	setTaskRelevance: async () => {},
	confirmObservationAttribution: async () => {},
	pausePlan: async () => {},
	resumePlan: async () => {},
	completePlan: async () => {},
	archivePlan: async () => {},
	undoPlanAdjustment: async () => {},
	retryPendingAnalysis: async () => {},
};

describe("calendar keyboard and form alternatives", () => {
	test("create form exposes labeled date/time, recurrence, and 15-minute controls", () => {
		const editor: EditorState = {
			event: null,
			selection: null,
			occurrenceStart: null,
			presetKind: "manual-block",
			returnFocus: null,
		};
		const markup = renderToStaticMarkup(
			<EventEditor
				editor={editor}
				timeZone="Asia/Shanghai"
				pending={false}
				onClose={() => {}}
				onSave={async () => {}}
				onDelete={async () => {}}
			/>,
		);
		expect(markup).toContain('role="dialog"');
		expect(markup).toContain("开始日期");
		expect(markup).toContain("开始时间");
		expect(markup).toContain("整体提前");
		expect(markup).toContain("整体延后");
		expect(markup).toContain("缩短");
		expect(markup).toContain("延长");
		expect(markup).toContain("每天重复 5 次");
		expect(markup).toContain('type="submit"');
		expect(markup).not.toContain("计划日程");
	});

	test("smart compose body replaces the manual form for new schedules", async () => {
		const editor: EditorState = {
			event: null,
			selection: null,
			occurrenceStart: null,
			presetKind: "manual-block",
			returnFocus: null,
		};
		const planningController = new PlanningController(emptyPlanningService);
		await planningController.initialize();
		const markup = renderToStaticMarkup(
			<EventEditor
				editor={editor}
				timeZone="Asia/Shanghai"
				pending={false}
				onClose={() => {}}
				onSave={async () => {}}
				onDelete={async () => {}}
				bodyOverride={
					<SmartScheduleComposer
						controller={planningController}
						onOpenManual={() => {}}
						onPlanned={() => {}}
					/>
				}
			/>,
		);
		expect(markup).toContain('role="dialog"');
		expect(markup).toContain("安排什么？");
		expect(markup).toContain("智能安排");
		expect(markup).toContain("手动设置");
		// 手动表单不与智能主体同时出现。
		expect(markup).not.toContain("开始日期");
		expect(markup).not.toContain("保存日程");
	});




});

describe("calendar day click draft", () => {

});
