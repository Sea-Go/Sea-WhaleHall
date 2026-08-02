import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	EventEditor,
	type EditorState,
} from "../src/views/client/features/calendar/CalendarPage";
import { calendarScenarioEvents } from "../src/views/client/features/calendar/fixtures";

describe("calendar keyboard and form alternatives", () => {
	test("create form exposes labeled date/time, recurrence, and 15-minute controls", () => {
		const editor: EditorState = {
			event: null,
			selection: null,
			occurrenceStart: null,
			presetKind: "plan",
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
	});

	test("editable recurring event offers scope, delete, movement, and resize alternatives", () => {
		const event = calendarScenarioEvents("recurrence")[0];
		if (!event) throw new Error("Missing recurrence fixture");
		const editor: EditorState = {
			event,
			selection: null,
			occurrenceStart: "2026-07-29T12:00:00Z",
			presetKind: "plan",
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
		expect(markup).toContain("修改范围");
		expect(markup).toContain("仅这一次");
		expect(markup).toContain("整个系列");
		expect(markup).toContain("删除");
	});

	test("external event editor is visibly read-only", () => {
		const event = calendarScenarioEvents("external")[0];
		if (!event) throw new Error("Missing external fixture");
		const markup = renderToStaticMarkup(
			<EventEditor
				editor={{
					event,
					selection: null,
					occurrenceStart: null,
					presetKind: "external",
					returnFocus: null,
				}}
				timeZone="Asia/Shanghai"
				pending={false}
				onClose={() => {}}
				onSave={async () => {}}
				onDelete={async () => {}}
			/>,
		);
		expect(markup).toContain("仅可查看");
		expect(markup).not.toContain(">保存日程<");
		expect(markup).not.toContain(">删除<");
	});

	test("ambiguous repeated hour offers an explicit earlier/later choice", () => {
		const event = calendarScenarioEvents("short")[0];
		if (!event) throw new Error("Missing timed fixture");
		const markup = renderToStaticMarkup(
			<EventEditor
				editor={{
					event: {
						...event,
						schedule: {
							allDay: false,
							start: "2026-11-01T05:30:00Z",
							end: "2026-11-01T06:30:00Z",
							timeZone: "America/New_York",
						},
					},
					selection: null,
					occurrenceStart: null,
					presetKind: "plan",
					returnFocus: null,
				}}
				timeZone="America/New_York"
				pending={false}
				onClose={() => {}}
				onSave={async () => {}}
				onDelete={async () => {}}
			/>,
		);
		expect(markup).toContain("夏令时重复小时");
		expect(markup).toContain("采用第一次出现");
		expect(markup).toContain("采用第二次出现");
	});
});
