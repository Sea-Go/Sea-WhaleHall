import type { CalendarEvent } from "./domain";

export type CalendarScenarioId =
	| "empty"
	| "normal"
	| "dense"
	| "overlap"
	| "short"
	| "long"
	| "all-day"
	| "proposed"
	| "manual"
	| "external"
	| "conflict"
	| "recurrence";

export const CALENDAR_SCENARIOS: ReadonlyArray<{
	id: CalendarScenarioId;
	label: string;
}> = [
	{ id: "normal", label: "日常安排" },
	{ id: "empty", label: "空日历" },
	{ id: "dense", label: "密集日程" },
	{ id: "overlap", label: "重叠日程" },
	{ id: "short", label: "15 分钟" },
	{ id: "long", label: "长日程" },
	{ id: "all-day", label: "全天日程" },
	{ id: "proposed", label: "待确认计划" },
	{ id: "manual", label: "手动占用" },
	{ id: "external", label: "外部只读" },
	{ id: "conflict", label: "冲突状态" },
	{ id: "recurrence", label: "重复与例外" },
];

const timeZone = "Asia/Shanghai";

function timed(
	id: string,
	title: string,
	start: string,
	end: string,
	overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
	return {
		id,
		title,
		kind: "plan",
		state: "committed",
		schedule: { allDay: false, start, end, timeZone },
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: `plan-${id}`,
		sourceTaskId: `task-${id}`,
		scheduleOrigin: "model",
		userLocked: false,
		editable: true,
		version: 1,
		...overrides,
	};
}

const focus = timed(
	"focus-review",
	"每日目标回顾",
	"2026-07-27T11:00:00Z",
	"2026-07-27T11:30:00Z",
);
const design = timed(
	"design-system",
	"WhaleHall 日历交互评审",
	"2026-07-29T06:00:00Z",
	"2026-07-29T07:30:00Z",
);
const writing = timed(
	"writing",
	"项目文档整理",
	"2026-07-30T01:30:00Z",
	"2026-07-30T03:00:00Z",
);
const breakEvent = timed(
	"break-walk",
	"散步与恢复",
	"2026-07-29T08:15:00Z",
	"2026-07-29T08:45:00Z",
	{
		kind: "break",
		sourcePlanId: null,
		sourceTaskId: null,
		scheduleOrigin: null,
	},
);
const allDay: CalendarEvent = {
	id: "launch-day",
	title: "WhaleHall 里程碑",
	kind: "plan",
	state: "committed",
	schedule: {
		allDay: true,
		startDate: "2026-07-30",
		endDateExclusive: "2026-08-01",
	},
	recurrence: null,
	occurrenceId: null,
	sourcePlanId: "plan-launch",
	sourceTaskId: "task-launch",
	scheduleOrigin: "model",
	userLocked: false,
	editable: true,
	version: 1,
};
const manual = timed(
	"manual-family",
	"已占用 · 家庭时间",
	"2026-07-29T10:00:00Z",
	"2026-07-29T11:00:00Z",
	{
		kind: "manual-block",
		sourcePlanId: null,
		sourceTaskId: null,
		scheduleOrigin: null,
	},
);
const external = timed(
	"external-team",
	"产品周会 · 外部日历",
	"2026-07-31T02:00:00Z",
	"2026-07-31T03:00:00Z",
	{
		kind: "external",
		editable: false,
		sourcePlanId: null,
		sourceTaskId: null,
		scheduleOrigin: null,
	},
);
const proposed = timed(
	"proposed-reading",
	"阅读时间（待确认）",
	"2026-07-28T11:00:00Z",
	"2026-07-28T12:00:00Z",
	{ state: "proposed", version: 0 },
);
const recurring = timed(
	"daily-retro",
	"晚间复盘",
	"2026-07-27T06:00:00Z",
	"2026-07-27T06:30:00Z",
	{
		recurrence: {
			seriesId: "series-daily-retro",
			rrule: "FREQ=DAILY;COUNT=5",
			timeZone,
			exceptionDates: ["2026-07-29T06:00:00Z"],
		},
	},
);

const normal = [focus, proposed, design, breakEvent, writing, allDay, manual, external];

export function calendarScenarioEvents(
	scenario: CalendarScenarioId,
): CalendarEvent[] {
	switch (scenario) {
		case "empty":
			return [];
		case "normal":
			return normal.map((event) => structuredClone(event));
		case "dense":
			return [
				...normal,
				timed("dense-1", "需求梳理", "2026-07-27T01:00:00Z", "2026-07-27T02:00:00Z"),
				timed("dense-2", "专注开发", "2026-07-27T02:15:00Z", "2026-07-27T05:00:00Z"),
				timed("dense-3", "午间记录", "2026-07-28T04:00:00Z", "2026-07-28T04:30:00Z"),
				timed("dense-4", "研究访谈", "2026-07-28T06:00:00Z", "2026-07-28T08:00:00Z"),
				timed("dense-5", "指标复核", "2026-07-30T06:00:00Z", "2026-07-30T06:45:00Z"),
				timed("dense-6", "发布准备", "2026-07-31T06:30:00Z", "2026-07-31T09:00:00Z"),
			].map((event) => structuredClone(event));
		case "overlap":
			return [
				design,
				timed("overlap-a", "设计走查", "2026-07-29T06:30:00Z", "2026-07-29T08:00:00Z"),
				timed("overlap-b", "技术同步", "2026-07-29T07:00:00Z", "2026-07-29T07:45:00Z"),
			].map((event) => structuredClone(event));
		case "short":
			return [
				timed("short-event", "快速确认", "2026-07-29T03:00:00Z", "2026-07-29T03:15:00Z"),
			].map((event) => structuredClone(event));
		case "long":
			return [
				timed("long-event", "深度工作 · 完成日历核心", "2026-07-29T01:00:00Z", "2026-07-29T06:00:00Z"),
			].map((event) => structuredClone(event));
		case "all-day":
			return [allDay].map((event) => structuredClone(event));
		case "proposed":
			return [proposed].map((event) => structuredClone(event));
		case "manual":
			return [manual].map((event) => structuredClone(event));
		case "external":
			return [external].map((event) => structuredClone(event));
		case "conflict":
			return [
				{
					...manual,
					schedule: {
						allDay: false as const,
						start: "2026-07-29T06:00:00Z",
						end: "2026-07-29T07:00:00Z",
						timeZone,
					},
				},
				timed("conflicting-event", "冲突：准备提案", "2026-07-29T06:15:00Z", "2026-07-29T06:45:00Z", {
					state: "proposed",
				}),
			].map((event) => structuredClone(event));
		case "recurrence":
			return [recurring].map((event) => structuredClone(event));
	}
}

export const CALENDAR_REFERENCE_DATE = "2026-07-29";
export const CALENDAR_TIME_ZONE = timeZone;
