import FullCalendar, {
	type CalendarRef,
	type DateSelectInfo,
	type DatesSetInfo,
	type EventClickInfo,
	type EventDisplayInfo,
	type EventDropInfo,
	type EventInput,
	type EventResizeDoneInfo,
} from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import breezyThemePlugin from "@fullcalendar/react/themes/breezy";
import rrulePlugin from "@fullcalendar/rrule";
import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	type ReactNode,
} from "react";
import { RRule } from "rrule";
import {
	dateDurationDays,
	durationMinutes,
	type LocalDateTimeParts,
} from "./date-time";
import type {
	CalendarConflict,
	CalendarEvent,
	CalendarMutationResult,
	TimedSchedule,
} from "./domain";
import { detectCalendarConflict } from "./domain";

export type CalendarView = "day" | "week" | "month";

export interface CalendarRange {
	title: string;
	start: string;
	end: string;
	currentDate: string;
	view: CalendarView;
}

export interface CalendarSelectionDraft {
	schedule:
		| TimedSchedule
		| {
				allDay: true;
				startDate: string;
				endDateExclusive: string;
		  };
}

export interface CalendarOccurrenceSelection {
	eventId: string;
	occurrenceStart: string | null;
}

export interface WhaleCalendarHandle {
	today(): void;
	previous(): void;
	next(): void;
	goToDate(date: string): void;
	focusGrid(): void;
}

export interface WhaleCalendarProps {
	events: readonly CalendarEvent[];
	view: CalendarView;
	timeZone: string;
	initialDate: string;
	pendingEventIds: ReadonlySet<string>;
	onRangeChange: (range: CalendarRange) => void;
	onSelect: (draft: CalendarSelectionDraft) => void;
	onEventClick: (selection: CalendarOccurrenceSelection) => void;
	onMove: (
		before: CalendarEvent,
		after: CalendarEvent,
	) => Promise<CalendarMutationResult>;
	onResize: (
		before: CalendarEvent,
		after: CalendarEvent,
	) => Promise<CalendarMutationResult>;
}

export interface CalendarChangeSnapshot {
	allDay: boolean;
	startStr: string;
	endStr: string;
	oldStartStr: string;
	displayTimeZone: string;
}

const viewNames: Record<CalendarView, string> = {
	day: "timeGridDay",
	week: "timeGridWeek",
	month: "dayGridMonth",
};

function recurrenceInput(event: CalendarEvent): Partial<EventInput> {
	if (!event.recurrence) return {};
	const schedule = event.schedule;
	const parsedRule = RRule.parseString(event.recurrence.rrule);
	return {
		rrule: {
			...parsedRule,
			dtstart: schedule.allDay ? schedule.startDate : schedule.start,
		},
		exdate: [...event.recurrence.exceptionDates],
		duration: schedule.allDay
			? {
					days: dateDurationDays(
						schedule.startDate,
						schedule.endDateExclusive,
					),
				}
			: { minutes: durationMinutes(schedule.start, schedule.end) },
	};
}

export function calendarEventToFullCalendarInput(
	event: CalendarEvent,
	pending = false,
	conflict: CalendarConflict | null = null,
): EventInput {
	const scheduleInput: Partial<EventInput> = event.recurrence && !event.occurrenceId
		? recurrenceInput(event)
		: event.schedule.allDay
			? {
					start: event.schedule.startDate,
					end: event.schedule.endDateExclusive,
				}
			: { start: event.schedule.start, end: event.schedule.end };
	const classes = [
		"whale-event",
		`whale-event--${event.kind}`,
		`whale-event--${event.state}`,
		!event.schedule.allDay &&
		durationMinutes(event.schedule.start, event.schedule.end) <= 15
			? "whale-event--short"
			: "",
		!event.schedule.allDay &&
		durationMinutes(event.schedule.start, event.schedule.end) <= 30
			? "whale-event--compact"
			: "",
		conflict ? `whale-event--conflict-${conflict.severity}` : "",
		pending ? "whale-event--pending" : "",
	].filter(Boolean);

	return {
		id: event.id,
		groupId: event.recurrence?.seriesId ?? "",
		title: event.title,
		allDay: event.schedule.allDay,
		editable: event.editable && !pending,
		startEditable: event.editable && !pending,
		durationEditable: event.editable && !pending,
		interactive: true,
		className: classes.join(" "),
		extendedProps: {
			kind: event.kind,
			state: event.state,
			editable: event.editable,
			version: event.version,
			pending,
			conflictReason: conflict?.reason ?? null,
			conflictSeverity: conflict?.severity ?? null,
			seriesId: event.recurrence?.seriesId ?? null,
		},
		...scheduleInput,
	};
}

export function calendarChangeSnapshotToDomainEvent(
	snapshot: CalendarChangeSnapshot,
	before: CalendarEvent,
): CalendarEvent | null {
	if (before.schedule.allDay !== snapshot.allDay) return null;
	if (snapshot.allDay) {
		if (!snapshot.startStr || !snapshot.endStr) return null;
		return {
			...before,
			schedule: {
				allDay: true,
				startDate: snapshot.startStr.slice(0, 10),
				endDateExclusive: snapshot.endStr.slice(0, 10),
			},
			occurrenceId:
				before.recurrence && snapshot.oldStartStr
					? `${before.recurrence.seriesId}:${snapshot.oldStartStr}`
					: before.occurrenceId,
		};
	}
	if (!snapshot.startStr || !snapshot.endStr) return null;
	return {
		...before,
		schedule: {
			allDay: false,
			start: snapshot.startStr,
			end: snapshot.endStr,
			timeZone: before.schedule.allDay
				? snapshot.displayTimeZone
				: before.schedule.timeZone,
		},
		occurrenceId:
			before.recurrence && snapshot.oldStartStr
				? `${before.recurrence.seriesId}:${snapshot.oldStartStr}`
				: before.occurrenceId,
	};
}

function changedDomainEvent(
	info: EventDropInfo | EventResizeDoneInfo,
	before: CalendarEvent,
): CalendarEvent | null {
	return calendarChangeSnapshotToDomainEvent(
		{
			allDay: info.event.allDay,
			startStr: info.event.startStr,
			endStr: info.event.endStr,
			oldStartStr: info.oldEvent.startStr,
			displayTimeZone: info.view.calendar.getOption("timeZone") ?? "UTC",
		},
		before,
	);
}

function renderEventContent(info: EventDisplayInfo): ReactNode {
	const state = String(info.event.extendedProps.state);
	const kind = String(info.event.extendedProps.kind);
	const pending = Boolean(info.event.extendedProps.pending);
	const conflictReason = info.event.extendedProps.conflictReason;
	const status =
		conflictReason
			? "冲突"
			: state === "proposed"
			? "待确认"
			: kind === "manual-block"
				? "占用"
				: kind === "external"
					? "只读"
					: kind === "break"
						? "休息"
						: null;
	return (
		<div className="whale-event__content">
			<div className="whale-event__meta">
				{info.timeText ? <time>{info.timeText}</time> : null}
				{status ? <span>{status}</span> : null}
				{pending ? <span>保存中</span> : null}
			</div>
			<strong>{info.event.title}</strong>
		</div>
	);
}

function selectionDraft(
	info: DateSelectInfo,
	timeZone: string,
): CalendarSelectionDraft {
	return {
		schedule: info.allDay
			? {
					allDay: true,
					startDate: info.startStr.slice(0, 10),
					endDateExclusive: info.endStr.slice(0, 10),
				}
			: {
					allDay: false,
					start: info.startStr,
					end: info.endStr,
					timeZone,
				},
	};
}

function toCalendarView(type: string): CalendarView {
	if (type === "timeGridDay") return "day";
	if (type === "dayGridMonth") return "month";
	return "week";
}

export function scheduleToFormParts(
	event: CalendarEvent,
	timeZone: string,
	toParts: (instant: string, zone: string) => LocalDateTimeParts,
): {
	allDay: boolean;
	startDate: string;
	endDate: string;
	startTime: string;
	endTime: string;
} {
	if (event.schedule.allDay) {
		return {
			allDay: true,
			startDate: event.schedule.startDate,
			endDate: event.schedule.endDateExclusive,
			startTime: "09:00",
			endTime: "10:00",
		};
	}
	const start = toParts(event.schedule.start, timeZone);
	const end = toParts(event.schedule.end, timeZone);
	return {
		allDay: false,
		startDate: start.date,
		endDate: end.date,
		startTime: start.time,
		endTime: end.time,
	};
}

export const WhaleCalendar = forwardRef<
	WhaleCalendarHandle,
	WhaleCalendarProps
>(function WhaleCalendar(
	{
		events,
		view,
		timeZone,
		initialDate,
		pendingEventIds,
		onRangeChange,
		onSelect,
		onEventClick,
		onMove,
		onResize,
	},
	ref,
) {
	const calendarRef = useRef<CalendarRef>(null);
	const boardRef = useRef<HTMLDivElement>(null);
	const eventMap = useMemo(
		() => new Map(events.map((event) => [event.id, event])),
		[events],
	);
	const inputs = useMemo(
		() =>
			events.map((event) =>
				calendarEventToFullCalendarInput(
					event,
					pendingEventIds.has(event.id),
					event.kind === "plan"
						? detectCalendarConflict(event, events)
						: null,
				),
			),
		[events, pendingEventIds],
	);

	useImperativeHandle(
		ref,
		() => ({
			today: () => calendarRef.current?.getApi().today(),
			previous: () => calendarRef.current?.getApi().prev(),
			next: () => calendarRef.current?.getApi().next(),
			goToDate: (date) => calendarRef.current?.getApi().gotoDate(date),
			focusGrid: () =>
				boardRef.current
					?.querySelector<HTMLElement>(
						'[role="grid"], [role="gridcell"], button, [tabindex="0"]',
					)
					?.focus(),
		}),
		[],
	);

	useEffect(() => {
		const api = calendarRef.current?.getApi();
		if (api && api.view.type !== viewNames[view]) {
			api.changeView(viewNames[view]);
		}
	}, [view]);

	async function handleChange(
		info: EventDropInfo | EventResizeDoneInfo,
		operation: (
			before: CalendarEvent,
			after: CalendarEvent,
		) => Promise<CalendarMutationResult>,
	) {
		const before = eventMap.get(info.event.id);
		if (!before) {
			info.revert();
			return;
		}
		const after = changedDomainEvent(info, before);
		if (!after) {
			info.revert();
			return;
		}
		const result = await operation(before, after);
		if (!result.ok) info.revert();
	}

	return (
		<div className="calendar-fullcalendar" ref={boardRef} tabIndex={-1}>
			<FullCalendar
				ref={calendarRef}
				plugins={[
					dayGridPlugin,
					timeGridPlugin,
					interactionPlugin,
					rrulePlugin,
					breezyThemePlugin,
				]}
				className="whale-fullcalendar"
				colorScheme="dark"
				locale="zh-cn"
				timeZone={timeZone}
				initialDate={initialDate}
				initialView={viewNames[view]}
				headerToolbar={false}
				height="100%"
				expandRows
				allDayText="全天"
				allDaySlot
				nowIndicator
				nowIndicatorSnap="auto"
				editable
				selectable
				selectMirror
				selectMinDistance={4}
				slotDuration="00:30:00"
				snapDuration="00:15:00"
				slotMinTime="06:00:00"
				slotMaxTime="23:00:00"
				scrollTime="08:00:00"
				scrollTimeReset={false}
				eventMinHeight={18}
				eventShortHeight={26}
				eventMaxStack={4}
				dayMaxEvents={view === "month" ? 4 : false}
				weekends
				navLinks
				displayEventEnd
				eventTimeFormat={{
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				}}
				views={{
					dayGridMonth: {
						dayHeaderFormat: { weekday: "short" },
					},
					timeGridWeek: {
						dayHeaderFormat: {
							weekday: "short",
							month: "numeric",
							day: "numeric",
							omitCommas: true,
						},
					},
					timeGridDay: {
						dayHeaderFormat: {
							weekday: "long",
							month: "long",
							day: "numeric",
							omitCommas: true,
						},
					},
				}}
				events={inputs}
				eventContent={renderEventContent}
				select={(info) => onSelect(selectionDraft(info, timeZone))}
				eventClick={(info: EventClickInfo) =>
					onEventClick({
						eventId: info.event.id,
						occurrenceStart: info.event.startStr || null,
					})
				}
				eventDrop={(info) => void handleChange(info, onMove)}
				eventResize={(info) => void handleChange(info, onResize)}
				datesSet={(info: DatesSetInfo) =>
					onRangeChange({
						title: info.view.title,
						start: info.startStr,
						end: info.endStr,
						currentDate: info.view.calendar.formatIso(
							new Date((info.start.getTime() + info.end.getTime()) / 2),
							true,
						),
						view: toCalendarView(info.view.type),
					})
				}
			/>
		</div>
	);
});
