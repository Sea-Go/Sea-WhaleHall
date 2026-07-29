import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import {
	WhaleCalendar,
	type CalendarEvent,
	type CalendarMutationResult,
	type WhaleCalendarHandle,
} from "../features/calendar/public";
import type { PlanningSchedulePreviewProps } from "../features/planning/public";

function proposalEvent(
	item: PlanningSchedulePreviewProps["proposals"][number],
): CalendarEvent {
	return {
		id: item.id,
		title: item.title,
		kind: "plan",
		state: "proposed",
		schedule: {
			allDay: false,
			start: item.start,
			end: item.end,
			timeZone: item.timeZone,
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: item.sourcePlanId,
		editable: true,
		version: item.version,
	};
}

function busyEvent(
	item: PlanningSchedulePreviewProps["busyWindows"][number],
): CalendarEvent {
	return {
		id: `busy:${item.id}`,
		title: item.title,
		kind:
			item.kind === "manual-block"
				? "manual-block"
				: item.kind === "external"
					? "external"
					: "plan",
		state: "committed",
		schedule: {
			allDay: false,
			start: item.start,
			end: item.end,
			timeZone: item.timeZone,
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: item.kind === "committed-plan" ? item.id : null,
		editable: false,
		version: 1,
	};
}

function successfulPreviewMutation(
	event: CalendarEvent,
): CalendarMutationResult {
	return {
		ok: true,
		mutationId: `preview:${event.id}:${event.version}`,
		event,
		warning: null,
	};
}

export function PlanningSchedulePreview({
	proposals,
	busyWindows,
	timeZone,
	initialDate,
	onChange,
	onEdit,
}: PlanningSchedulePreviewProps) {
	const calendarRef = useRef<WhaleCalendarHandle>(null);
	const [rangeLabel, setRangeLabel] = useState("当前安排周");
	const events = [
		...busyWindows.map(busyEvent),
		...proposals.map(proposalEvent),
	];

	async function handleChange(
		before: CalendarEvent,
		after: CalendarEvent,
	): Promise<CalendarMutationResult> {
		if (after.schedule.allDay) {
			return {
				ok: false,
				mutationId: `preview-rejected:${after.id}`,
				conflict: {
					reason: "service-unavailable",
					severity: "error",
					affectedEventIds: [after.id],
					message: "计划草案暂不支持改为全天安排。",
					nextAction: "edit",
				},
			};
		}
		onChange(after.id, {
			title: after.title,
			start: after.schedule.start,
			end: after.schedule.end,
		});
		return successfulPreviewMutation(after);
	}

	return (
		<div className="planning-calendar-preview" aria-label="计划草案周视图">
			<div className="planning-calendar-preview__toolbar">
				<div>
					<strong>{rangeLabel}</strong>
					<span>虚线为待确认安排</span>
				</div>
				<div role="group" aria-label="草案周导航">
					<button
						type="button"
						className="ui-icon-button"
						aria-label="上一周"
						onClick={() => calendarRef.current?.previous()}
					>
						<ChevronLeft size={15} />
					</button>
					<button
						type="button"
						className="ui-icon-button"
						aria-label="下一周"
						onClick={() => calendarRef.current?.next()}
					>
						<ChevronRight size={15} />
					</button>
				</div>
			</div>
			<div className="planning-calendar-preview__grid">
				<WhaleCalendar
					ref={calendarRef}
					events={events}
					view="week"
					timeZone={timeZone}
					initialDate={initialDate}
					pendingEventIds={new Set()}
					onRangeChange={(range) => setRangeLabel(range.title)}
					onSelect={() => {}}
					onEventClick={({ eventId }) => {
						if (!eventId.startsWith("busy:")) onEdit(eventId);
					}}
					onMove={handleChange}
					onResize={handleChange}
				/>
			</div>
		</div>
	);
}
