import { Temporal } from "temporal-polyfill";
import {
	addDays,
	addInstantMinutes,
	compareDates,
	compareInstants,
	durationMinutes,
	intervalsOverlap,
	localDateTimeToInstant,
} from "./time";
import type {
	PlanScheduleItem,
	PlanTask,
	PlanningCalendarEvent,
	RevisionTask,
	SchedulingPreferences,
} from "./types";

export interface DeterministicScheduleRequest {
	planId: string;
	timeZone: string;
	window: {
		startDate: string;
		endDateExclusive: string;
	};
	/** Auto-adjustments pass tomorrow; direct confirmation passes window.startDate. */
	mutableStartDate: string;
	tasks: readonly RevisionTask[];
	taskStates: readonly Pick<PlanTask, "id" | "status">[];
	preferences: SchedulingPreferences;
	busyEvents: readonly PlanningCalendarEvent[];
	nowMs: number;
	createId: () => string;
}

export interface DeterministicScheduleResult {
	schedule: PlanScheduleItem[];
	unscheduledTaskIds: string[];
}

interface FreeInterval {
	start: string;
	end: string;
}

export function buildDeterministicSevenDaySchedule(
	request: DeterministicScheduleRequest,
): DeterministicScheduleResult {
	if (
		compareDates(request.window.endDateExclusive, request.window.startDate) <= 0 ||
		Temporal.PlainDate.from(request.window.startDate)
			.until(Temporal.PlainDate.from(request.window.endDateExclusive), {
				largestUnit: "day",
			})
			.total({ unit: "day" }) !== 7
	) {
		throw new Error("Planning schedule window must contain exactly seven dates.");
	}
	const mutableStartDate =
		compareDates(request.mutableStartDate, request.window.startDate) < 0
			? request.window.startDate
			: request.mutableStartDate;
	const statusByTask = new Map(
		request.taskStates.map(({ id, status }) => [id, status]),
	);
	const pendingTasks = topologicalTasks(request.tasks).filter(
		(task) => statusByTask.get(task.taskId) === "pending",
	);
	const pendingIds = new Set(pendingTasks.map((task) => task.taskId));
	const completedOrAbsent = new Set(
		request.taskStates
			.filter(({ status }) => status === "completed")
			.map(({ id }) => id),
	);
	const busy: FreeInterval[] = request.busyEvents.map(({ start, end }) => ({
		start,
		end,
	}));
	const allocatedByTask = new Map<string, { minutes: number; lastEnd: string }>();
	for (const event of request.busyEvents) {
		if (
			event.planId !== request.planId ||
			event.sourceTaskId === null ||
			!pendingIds.has(event.sourceTaskId)
		) {
			continue;
		}
		const current = allocatedByTask.get(event.sourceTaskId);
		allocatedByTask.set(event.sourceTaskId, {
			minutes:
				(current?.minutes ?? 0) + Math.max(0, durationMinutes(event.start, event.end)),
			lastEnd:
				current && compareInstants(current.lastEnd, event.end) >= 0
					? current.lastEnd
					: event.end,
		});
	}
	const alreadyAllocated = request.busyEvents
		.filter(
			(event) =>
				event.planId === request.planId &&
				event.sourceTaskId !== null &&
				pendingIds.has(event.sourceTaskId),
		)
		.reduce((total, event) => total + Math.max(0, durationMinutes(event.start, event.end)), 0);
	let remainingCapacity = Math.max(
		0,
		request.preferences.weeklyCapacityMinutes - alreadyAllocated,
	);
	const schedule: PlanScheduleItem[] = [];
	const unscheduled = new Set<string>();
	const finalEndByTask = new Map<string, string>();

	for (const task of pendingTasks) {
		const dependencyEnds: string[] = [];
		let dependenciesAvailable = true;
		for (const dependencyId of task.dependencyTaskIds) {
			if (completedOrAbsent.has(dependencyId)) continue;
			const end = finalEndByTask.get(dependencyId);
			if (!end) {
				dependenciesAvailable = false;
				break;
			}
			dependencyEnds.push(end);
		}
		if (!dependenciesAvailable) {
			unscheduled.add(task.taskId);
			continue;
		}
		const existingAllocation = allocatedByTask.get(task.taskId);
		let remainingMinutes = Math.max(
			0,
			task.estimatedMinutes - (existingAllocation?.minutes ?? 0),
		);
		let earliest = dependencyEnds.sort(compareInstants).at(-1) ?? null;
		if (
			existingAllocation &&
			(earliest === null || compareInstants(earliest, existingAllocation.lastEnd) < 0)
		) {
			earliest = existingAllocation.lastEnd;
		}
		while (remainingMinutes > 0 && remainingCapacity > 0) {
			const chunk = Math.min(
				request.preferences.sessionMinutes,
				remainingMinutes,
				remainingCapacity,
			);
			if (chunk < 15 || chunk % 15 !== 0) break;
			const slot = findFirstSlot(
				request,
				mutableStartDate,
				chunk,
				earliest,
				busy,
			);
			if (!slot) break;
			const item: PlanScheduleItem = {
				id: request.createId(),
				planId: request.planId,
				taskId: task.taskId,
				title: task.title,
				start: slot.start,
				end: slot.end,
				timeZone: request.timeZone,
			};
			schedule.push(item);
			busy.push(slot);
			remainingMinutes -= chunk;
			remainingCapacity -= chunk;
			earliest = slot.end;
		}
		if (remainingMinutes > 0) {
			unscheduled.add(task.taskId);
		} else if (earliest !== null) {
			finalEndByTask.set(task.taskId, earliest);
		} else if (existingAllocation) {
			finalEndByTask.set(task.taskId, existingAllocation.lastEnd);
		}
	}

	return {
		schedule: schedule.sort((left, right) => compareInstants(left.start, right.start)),
		unscheduledTaskIds: [...unscheduled],
	};
}

function findFirstSlot(
	request: DeterministicScheduleRequest,
	mutableStartDate: string,
	duration: number,
	earliest: string | null,
	busy: readonly FreeInterval[],
): FreeInterval | null {
	for (
		let date = mutableStartDate;
		compareDates(date, request.window.endDateExclusive) < 0;
		date = addDays(date, 1)
	) {
		const dayOfWeek = Temporal.PlainDate.from(date).dayOfWeek;
		const preferences = request.preferences.availableWindows
			.filter((window) => window.dayOfWeek === dayOfWeek)
			.sort((left, right) => left.startTime.localeCompare(right.startTime));
		for (const preference of preferences) {
			let windowStart: string;
			let windowEnd: string;
			try {
				windowStart = localDateTimeToInstant(
					date,
					preference.startTime,
					request.timeZone,
				);
				windowEnd = localDateTimeToInstant(
					date,
					preference.endTime,
					request.timeZone,
				);
			} catch {
				// A DST gap or fold is never guessed. Another explicit local window
				// can still be considered.
				continue;
			}
			let cursor = windowStart;
			const now = Temporal.Instant.fromEpochMilliseconds(Math.trunc(request.nowMs));
			if (compareInstants(cursor, now.toString()) < 0) {
				const rounded = Math.ceil(now.epochMilliseconds / (15 * 60_000)) * 15 * 60_000;
				cursor = Temporal.Instant.fromEpochMilliseconds(rounded).toString();
			}
			if (earliest && compareInstants(cursor, earliest) < 0) cursor = earliest;
			const relevantBusy = busy
				.filter((item) => intervalsOverlap(cursor, windowEnd, item.start, item.end))
				.sort((left, right) => compareInstants(left.start, right.start));
			for (const occupied of relevantBusy) {
				const candidateEnd = addInstantMinutes(cursor, duration);
				if (compareInstants(candidateEnd, occupied.start) <= 0) {
					return { start: cursor, end: candidateEnd };
				}
				if (compareInstants(cursor, occupied.end) < 0) cursor = occupied.end;
				if (earliest && compareInstants(cursor, earliest) < 0) cursor = earliest;
			}
			const candidateEnd = addInstantMinutes(cursor, duration);
			if (compareInstants(candidateEnd, windowEnd) <= 0) {
				return { start: cursor, end: candidateEnd };
			}
		}
	}
	return null;
}

function topologicalTasks(tasks: readonly RevisionTask[]): RevisionTask[] {
	const byId = new Map(tasks.map((task) => [task.taskId, task]));
	const result: RevisionTask[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (task: RevisionTask): void => {
		if (visited.has(task.taskId)) return;
		if (visiting.has(task.taskId)) {
			throw new Error("Planning task dependency graph contains a cycle.");
		}
		visiting.add(task.taskId);
		for (const dependencyId of task.dependencyTaskIds) {
			const dependency = byId.get(dependencyId);
			if (!dependency) {
				throw new Error("Planning task dependency references an unknown task.");
			}
			visit(dependency);
		}
		visiting.delete(task.taskId);
		visited.add(task.taskId);
		result.push(task);
	};
	for (const task of [...tasks].sort((left, right) => {
		const purposeOrder = { validation: 0, review: 1, execution: 2 } as const;
		return purposeOrder[left.purpose] - purposeOrder[right.purpose];
	})) {
		visit(task);
	}
	return result;
}
