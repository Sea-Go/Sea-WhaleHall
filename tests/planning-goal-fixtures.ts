/** Plans and calendar blocks as the planning store returns them. */
import type { LocalPlanningCalendarEvent } from "../src/agent/local-protocol";
import type {
	PlanningPlan,
	PlanRevision,
	PlanStatus,
	PlanTask,
	PlanTaskStatus,
} from "../src/agent/planning";

export const NOW_MS = Date.parse("2026-11-26T10:30:00+08:00");
export const at = (hour: number, minute = 0): string =>
	`2026-11-26T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`;

export function task(
	id: string,
	title: string,
	status: PlanTaskStatus = "pending",
): PlanTask {
	return {
		id,
		planId: "plan-1",
		sourceKey: id,
		purpose: "execution",
		title,
		description: "",
		estimatedMinutes: 45,
		dependencyTaskIds: [],
		status,
		statusChangedAt: null,
		statusChangedBy: "user",
	};
}

export function plan(input: {
	id?: string;
	status?: PlanStatus;
	tasks?: PlanTask[];
	scheduledTaskIds?: readonly string[];
	createdAt?: string;
}): PlanningPlan {
	const id = input.id ?? "plan-1";
	const tasks = input.tasks ?? [];
	const scheduledTaskIds = input.scheduledTaskIds ?? [];
	const createdAt = input.createdAt ?? "2026-11-26T09:00:00+08:00";
	const revision: PlanRevision = {
		id: `${id}-revision-1`,
		planId: id,
		number: 1,
		parentRevisionId: null,
		trigger: "confirmation",
		goal: "学会计算机网络",
		type: "long-term",
		rationaleSummary: "",
		assumptions: [],
		estimateId: `${id}-estimate-1`,
		schedulingPreferences: {
			weeklyCapacityMinutes: 300,
			sessionMinutes: 90,
			availableWindows: [],
		},
		tasks: [],
		scheduleWindow: { startDate: "2026-11-26", endDateExclusive: "2026-12-31" },
		schedule: scheduledTaskIds.map((taskId, index) => ({
			id: `${id}-event-${index}`,
			planId: id,
			taskId,
			title: "计划任务",
			start: at(20 + index),
			end: at(21, 30),
			timeZone: "Asia/Shanghai",
		})),
		unscheduledTaskIds: tasks
			.map((item) => item.id)
			.filter((taskId) => !scheduledTaskIds.includes(taskId)),
		createdAt: "2026-11-26T09:00:00+08:00",
	};
	return {
		id,
		goal: "学会计算机网络",
		requestedStartToday: false,
		timeZone: "Asia/Shanghai",
		effectiveStartDate: "2026-11-26",
		type: "long-term",
		status: input.status ?? "active",
		analysisState: "ready",
		analysisDiagnostic: null,
		pendingAnalysis: null,
		autoAdjustAuthorized: true,
		version: 1,
		createdAt,
		updatedAt: "2026-11-26T09:00:00+08:00",
		activeRevisionId: revision.id,
		proposedRevisionId: null,
		revisions: [revision],
		estimates: [],
		tasks: tasks.map((item) => ({ ...item, planId: id })),
		messages: [],
		observationEvidence: [],
		pendingObservationAttributions: [],
		adjustments: [],
		dailySummaryDates: [],
	};
}

export function block(
	input: {
		planId?: string;
		taskId?: string;
		state?: LocalPlanningCalendarEvent["state"];
		start?: string;
		end?: string;
	} = {},
): LocalPlanningCalendarEvent {
	return {
		schemaVersion: "calendar.v1",
		eventId: `event-${input.taskId ?? "task"}`,
		title: "计划任务",
		sealedContentRef: null,
		redactedContent: false,
		kind: "plan",
		state: input.state ?? "committed",
		schedule: {
			allDay: false,
			start: input.start ?? at(10),
			end: input.end ?? at(11, 30),
			timeZone: "Asia/Shanghai",
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: input.planId ?? "plan-1",
		sourceTaskId: input.taskId ?? "task-1",
		scheduleOrigin: "model",
		userLocked: false,
		editable: true,
		version: 1,
	};
}
