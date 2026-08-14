import type { PlanningCalendarMutationProjection } from "../shared/planning";

/**
 * Renderer edits to model events are locked by default. The sole exception is
 * an unlock-only write: every event field must be unchanged except
 * userLocked true -> false and the required optimistic version increment.
 * This keeps renderer writes in the user actor path and prevents them from
 * impersonating model auto-adjustment.
 */
export function isExplicitRendererPlanUnlock(
	mutation: PlanningCalendarMutationProjection,
): boolean {
	const { before, after } = mutation;
	if (
		mutation.kind !== "update" ||
		!before ||
		!after ||
		before.kind !== "plan" ||
		before.scheduleOrigin !== "model" ||
		!before.userLocked ||
		after.userLocked ||
		mutation.expectedVersion !== before.version ||
		after.version !== before.version + 1
	) {
		return false;
	}
	return (
		JSON.stringify(canonicalUnlockEvent(before)) ===
		JSON.stringify(canonicalUnlockEvent(after))
	);
}

export function shouldForceRendererPlanLock(
	mutation: PlanningCalendarMutationProjection,
): boolean {
	return (
		mutation.kind === "update" &&
		mutation.before?.kind === "plan" &&
		mutation.before.scheduleOrigin === "model" &&
		!isExplicitRendererPlanUnlock(mutation)
	);
}

function canonicalUnlockEvent(
	event: NonNullable<PlanningCalendarMutationProjection["after"]>,
) {
	return {
		id: event.id,
		title: event.title,
		kind: event.kind,
		state: event.state,
		schedule: event.schedule.allDay
			? {
					allDay: true as const,
					startDate: event.schedule.startDate,
					endDateExclusive: event.schedule.endDateExclusive,
				}
			: {
					allDay: false as const,
					start: event.schedule.start,
					end: event.schedule.end,
					timeZone: event.schedule.timeZone,
				},
		recurrence: event.recurrence
			? {
					seriesId: event.recurrence.seriesId,
					rrule: event.recurrence.rrule,
					timeZone: event.recurrence.timeZone,
					exceptionDates: [...event.recurrence.exceptionDates],
				}
			: null,
		occurrenceId: event.occurrenceId,
		sourcePlanId: event.sourcePlanId,
		sourceTaskId: event.sourceTaskId,
		scheduleOrigin: event.scheduleOrigin,
		userLocked: false,
		editable: event.editable,
	};
}
