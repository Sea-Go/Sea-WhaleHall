import type {
	CalendarConflict,
	CalendarEvent,
	CalendarMutation,
	CalendarService,
} from "../../features/calendar/public";
import type {
	Plan,
	PlanningBusyWindow,
	PlanningConflict,
	ProposedScheduleItem,
} from "../../features/planning/domain";
import type {
	PlanApplyResult,
	PlanningAvailabilityRequest,
	PlanningCalendarGateway,
} from "../../features/planning/planning-service";
import { Temporal } from "temporal-polyfill";

function eventToBusyWindow(
	event: CalendarEvent,
	displayTimeZone: string,
): PlanningBusyWindow | null {
	if (
		event.state !== "committed" ||
		event.kind === "break"
	) {
		return null;
	}
	const timed = event.schedule.allDay
		? {
				start: Temporal.PlainDate.from(event.schedule.startDate)
					.toZonedDateTime({
						timeZone: displayTimeZone,
						plainTime: "00:00",
					})
					.toInstant()
					.toString(),
				end: Temporal.PlainDate.from(event.schedule.endDateExclusive)
					.toZonedDateTime({
						timeZone: displayTimeZone,
						plainTime: "00:00",
					})
					.toInstant()
					.toString(),
				timeZone: displayTimeZone,
			}
		: event.schedule;
	return {
		id: event.id,
		title: event.title,
		kind:
			event.kind === "manual-block"
				? "manual-block"
				: event.kind === "external"
					? "external"
					: "committed-plan",
		start: timed.start,
		end: timed.end,
		timeZone: timed.timeZone,
	};
}

function calendarConflictToPlanning(
	conflict: CalendarConflict,
	proposalId: string | null,
): PlanningConflict {
	return {
		proposalId,
		busyWindowId: conflict.affectedEventIds[0] ?? null,
		reason:
			conflict.reason === "overlaps-manual-block"
				? "manual-block"
				: conflict.reason === "overlaps-external-event"
					? "external-event"
					: conflict.reason === "overlaps-committed-plan"
						? "committed-plan"
						: "invalid-duration",
		severity: conflict.severity,
		message: conflict.message,
		suggestions: ["move-session"],
	};
}

export class CalendarPlanningGateway implements PlanningCalendarGateway {
	private expectedRevision: number | undefined;
	constructor(
		private readonly service: CalendarService,
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	async loadAvailability(
		request: PlanningAvailabilityRequest,
	): Promise<readonly PlanningBusyWindow[]> {
		const result = await this.service.load();
		this.expectedRevision = result.revision;
		return result.events
			.map((event) => eventToBusyWindow(event, request.timeZone))
			.filter((item): item is PlanningBusyWindow => item !== null)
			.filter((item) => {
				const startDate = Temporal.Instant.from(item.start)
					.toZonedDateTimeISO(request.timeZone)
					.toPlainDate()
					.toString();
				return (
					startDate >= request.startDate &&
					startDate < request.endDateExclusive
				);
			});
	}

	async applyPlan(
		plan: Plan,
		proposals: readonly ProposedScheduleItem[],
		applyId: string,
	): Promise<PlanApplyResult> {
		const mutations = proposals.map<CalendarMutation>((proposal) => {
			const event: CalendarEvent = {
				id: proposal.id,
				title: proposal.title,
				kind: "plan",
				state: "committed",
				schedule: {
					allDay: false,
					start: proposal.start,
					end: proposal.end,
					timeZone: proposal.timeZone,
				},
				recurrence: null,
				occurrenceId: null,
				sourcePlanId: plan.id,
				sourceTaskId: proposal.taskId,
				scheduleOrigin: "model",
				userLocked: false,
				editable: true,
				version: 0,
			};
			return {
				mutationId: this.createId(),
				kind: "create",
				eventId: event.id,
				expectedVersion: null,
				before: null,
				after: event,
				recurrenceScope: null,
			};
		});
		try {
			const result = await this.service.mutateBatch(
				applyId,
				mutations,
				plan.calendarRevision ?? this.expectedRevision,
			);
			if (!result.ok) {
				return {
					ok: false,
					kind: "failure",
					applyId,
					committedCount: 0,
					failedProposalIds: proposals.map((item) => item.id),
					message:
						result.conflicts[0]?.message ??
						"写入未完成，所有草案都保留在计划中。",
				};
			}
			return {
				ok: true,
				kind: "success",
				applyId,
				committedCount: result.events.length,
				warnings: result.warnings.map((warning) =>
					calendarConflictToPlanning(
						warning,
						result.events.find((event) =>
							warning.affectedEventIds.includes(event.id),
						)?.id ?? null,
					),
				),
			};
		} catch {
			return {
				ok: false,
				kind: "failure",
				applyId,
				committedCount: 0,
				failedProposalIds: proposals.map((item) => item.id),
				message: "日历服务暂时不可用；没有任何草案被写入。",
			};
		}
	}
}
