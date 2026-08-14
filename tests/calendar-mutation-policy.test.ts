import { describe, expect, test } from "bun:test";
import {
	isExplicitRendererPlanUnlock,
	shouldForceRendererPlanLock,
} from "../src/bun/calendar-mutation-policy";
import type {
	PlanningCalendarEventProjection,
	PlanningCalendarMutationProjection,
} from "../src/shared/planning";

const lockedModelEvent: PlanningCalendarEventProjection = {
	id: "event-1",
	title: "本地计划任务",
	kind: "plan",
	state: "committed",
	schedule: {
		allDay: false,
		start: "2026-08-15T01:00:00Z",
		end: "2026-08-15T02:00:00Z",
		timeZone: "Asia/Shanghai",
	},
	recurrence: null,
	occurrenceId: null,
	sourcePlanId: "plan-1",
	sourceTaskId: "task-1",
	scheduleOrigin: "model",
	userLocked: true,
	editable: true,
	version: 4,
};

function updateMutation(
	after: PlanningCalendarEventProjection,
): PlanningCalendarMutationProjection {
	return {
		mutationId: "mutation-1",
		kind: "update",
		eventId: lockedModelEvent.id,
		expectedVersion: lockedModelEvent.version,
		before: lockedModelEvent,
		after,
		recurrenceScope: null,
	};
}

describe("renderer planning-calendar actor policy", () => {
	test("accepts only the exact user unlock without forcing the lock back on", () => {
		const unlock = updateMutation({ ...lockedModelEvent, userLocked: false });
		expect(isExplicitRendererPlanUnlock(unlock)).toBe(true);
		expect(shouldForceRendererPlanLock(unlock)).toBe(false);
	});

	test("compares unlock payloads semantically instead of trusting key order", () => {
		const reordered: PlanningCalendarEventProjection = {
			version: 4,
			editable: true,
			userLocked: false,
			scheduleOrigin: "model",
			sourceTaskId: "task-1",
			sourcePlanId: "plan-1",
			occurrenceId: null,
			recurrence: null,
			schedule: {
				timeZone: "Asia/Shanghai",
				end: "2026-08-15T02:00:00Z",
				start: "2026-08-15T01:00:00Z",
				allDay: false,
			},
			state: "committed",
			kind: "plan",
			title: "本地计划任务",
			id: "event-1",
		};
		expect(isExplicitRendererPlanUnlock(updateMutation(reordered))).toBe(true);
	});

	test("forces every model-event edit other than the exact unlock to stay locked", () => {
		const edit = updateMutation({
			...lockedModelEvent,
			title: "用户改过的标题",
			userLocked: false,
		});
		expect(isExplicitRendererPlanUnlock(edit)).toBe(false);
		expect(shouldForceRendererPlanLock(edit)).toBe(true);
	});

	test("does not claim model-actor policy for user-origin or non-update writes", () => {
		const userEvent = {
			...lockedModelEvent,
			scheduleOrigin: "user" as const,
		};
		expect(
			shouldForceRendererPlanLock({
				...updateMutation(userEvent),
				before: userEvent,
			}),
		).toBe(false);
		expect(
			shouldForceRendererPlanLock({
				...updateMutation(lockedModelEvent),
				kind: "create",
				before: null,
			}),
		).toBe(false);
	});
});
