import { Temporal } from "temporal-polyfill";
import type { CalendarSnapshot, CalendarEvent } from "../shared/calendar";
import type { TaskPlanningDraft, TaskPlanningInput } from "../shared/task-planning";
import {
	detectAuthoritativeConflict,
	eventsOverlap,
	validateCalendarEvent,
} from "./calendar-policy";

export interface PlanningValidationIssue {
	code:
		| "stale-calendar-revision"
		| "duplicate-id"
		| "invalid-reference"
		| "invalid-schedule"
		| "outside-window"
		| "unavailable-day"
		| "weekly-capacity"
		| "duration-mismatch"
		| "calendar-conflict"
		| "proposal-conflict";
	message: string;
	proposalId?: string;
	busyEventIds?: readonly string[];
}

export interface PlanningValidationResult {
	ok: boolean;
	issues: readonly PlanningValidationIssue[];
}

export function validatePlanningDraft(
	draft: TaskPlanningDraft,
	input: TaskPlanningInput,
	calendar: CalendarSnapshot,
): PlanningValidationResult {
	const issues: PlanningValidationIssue[] = [];
	if (draft.calendarRevision !== calendar.revision) {
		issues.push({
			code: "stale-calendar-revision",
			message: `生成依据的日历版本 ${draft.calendarRevision} 已落后于 ${calendar.revision}。`,
		});
	}
	const phaseIds = collectUniqueIds(draft.phases, "阶段", issues);
	const milestoneIds = collectUniqueIds(draft.milestones, "里程碑", issues);
	const taskIds = collectUniqueIds(draft.tasks, "任务", issues);
	collectUniqueIds(draft.schedule, "排程", issues);
	const phaseOrders = new Set<number>();
	for (const phase of draft.phases) {
		if (!Number.isSafeInteger(phase.order) || phase.order < 1 || phaseOrders.has(phase.order)) {
			issues.push({ code: "duplicate-id", message: `阶段顺序必须是互不重复的正整数：${phase.order}。` });
		}
		phaseOrders.add(phase.order);
	}
	for (const milestone of draft.milestones) {
		if (!phaseIds.has(milestone.phaseId)) {
			invalidReference(issues, `里程碑“${milestone.title}”引用了不存在的阶段。`);
		}
	}
	for (const task of draft.tasks) {
		if (!milestoneIds.has(task.milestoneId)) invalidReference(issues, `任务“${task.title}”引用了不存在的里程碑。`);
		for (const dependency of task.dependencies) {
			if (!taskIds.has(dependency) || dependency === task.id) invalidReference(issues, `任务“${task.title}”的依赖 ${dependency} 无效。`);
		}
	}
	for (const taskId of draft.unscheduledTaskIds) {
		if (!taskIds.has(taskId)) invalidReference(issues, `未安排任务 ${taskId} 不存在。`);
	}

	const taskById = new Map(draft.tasks.map((task) => [task.id, task]));
	const scheduledMinutes = new Map<string, number>();
	const weekMinutes = new Map<string, number>();
	const proposalEvents: CalendarEvent[] = [];
	const deadlineExclusive = Temporal.PlainDate.from(input.deadline).add({ days: 1 });
	for (const proposal of draft.schedule) {
		const task = taskById.get(proposal.taskId);
		if (!task) {
			invalidReference(issues, `排程“${proposal.title}”引用了不存在的任务。`, proposal.id);
			continue;
		}
		try {
			const event = proposalEvent(draft.id, proposal);
			validateCalendarEvent(event);
			if (proposal.timeZone !== input.timeZone) {
				throw new Error("排程时区必须与规划时区一致。");
			}
			const start = Temporal.Instant.from(proposal.start);
			const end = Temporal.Instant.from(proposal.end);
			const startDate = start.toZonedDateTimeISO(proposal.timeZone).toPlainDate();
			const endDate = end.subtract({ nanoseconds: 1 }).toZonedDateTimeISO(proposal.timeZone).toPlainDate();
			if (
				Temporal.PlainDate.compare(startDate, Temporal.PlainDate.from(calendar.fromDate)) < 0 ||
				Temporal.PlainDate.compare(endDate, deadlineExclusive) >= 0
			) {
				issues.push({ code: "outside-window", proposalId: proposal.id, message: `“${proposal.title}”超出规划窗口或截止日期。` });
			}
			const weekday = weekdayName(startDate.dayOfWeek);
			if (input.unavailableDays.includes(weekday)) {
				issues.push({ code: "unavailable-day", proposalId: proposal.id, message: `“${proposal.title}”安排在用户设为不可用的日期。` });
			}
			const minutes = Math.round(start.until(end).total("minutes"));
			scheduledMinutes.set(task.id, (scheduledMinutes.get(task.id) ?? 0) + minutes);
			const week = startDate.subtract({ days: startDate.dayOfWeek - 1 }).toString();
			weekMinutes.set(week, (weekMinutes.get(week) ?? 0) + minutes);
			const conflict = detectAuthoritativeConflict(event, calendar.events);
			if (conflict) {
				issues.push({
					code: "calendar-conflict",
					proposalId: proposal.id,
					busyEventIds: conflict.affectedEventIds,
					message: conflict.message,
				});
			}
			const overlappingProposals = proposalEvents.filter((existing) =>
				eventsOverlap(event, existing),
			);
			if (overlappingProposals.length > 0) {
				issues.push({
					code: "proposal-conflict",
					proposalId: proposal.id,
					busyEventIds: overlappingProposals.map((existing) => existing.id),
					message: `“${proposal.title}”与同一草案中的其他排程重叠。`,
				});
			}
			proposalEvents.push(event);
		} catch (error) {
			issues.push({
				code: "invalid-schedule",
				proposalId: proposal.id,
				message: error instanceof Error ? error.message : `排程“${proposal.title}”无效。`,
			});
		}
	}

	for (const task of draft.tasks) {
		const minutes = scheduledMinutes.get(task.id) ?? 0;
		const explicitlyUnscheduled = draft.unscheduledTaskIds.includes(task.id);
		if (minutes === 0 && !explicitlyUnscheduled) {
			issues.push({ code: "duration-mismatch", message: `任务“${task.title}”既没有排程，也未列入未安排任务。` });
		}
		if (minutes > 0 && explicitlyUnscheduled) {
			issues.push({ code: "duration-mismatch", message: `任务“${task.title}”同时被安排和标记为未安排。` });
		}
		if (minutes > task.estimatedMinutes) {
			issues.push({ code: "duration-mismatch", message: `任务“${task.title}”的排程时长超过估算。` });
		}
	}
	const weeklyLimit = input.weeklyCapacityHours * 60;
	for (const [week, minutes] of weekMinutes) {
		if (minutes > weeklyLimit) {
			issues.push({ code: "weekly-capacity", message: `${week} 所在周安排 ${minutes} 分钟，超过每周容量 ${weeklyLimit} 分钟。` });
		}
	}
	return { ok: issues.length === 0, issues };
}

function proposalEvent(
	planId: string,
	proposal: TaskPlanningDraft["schedule"][number],
): CalendarEvent {
	return {
		id: proposal.id,
		title: proposal.title,
		kind: "plan",
		state: "proposed",
		schedule: {
			allDay: false,
			start: proposal.start,
			end: proposal.end,
			timeZone: proposal.timeZone,
		},
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: planId,
		editable: true,
		version: 0,
	};
}

function collectUniqueIds<T extends { id: string }>(
	items: readonly T[],
	label: string,
	issues: PlanningValidationIssue[],
): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		if (!item.id || ids.has(item.id)) {
			issues.push({ code: "duplicate-id", message: `${label} ID 为空或重复：${item.id || "(empty)"}。` });
		}
		ids.add(item.id);
	}
	return ids;
}

function invalidReference(
	issues: PlanningValidationIssue[],
	message: string,
	proposalId?: string,
): void {
	issues.push({ code: "invalid-reference", message, ...(proposalId ? { proposalId } : {}) });
}

function weekdayName(dayOfWeek: number): TaskPlanningInput["unavailableDays"][number] {
	return (["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const)[dayOfWeek - 1]!;
}
