import { describe, expect, test } from "bun:test";
import {
	calendarEventsAfterDurableCommit,
	type DurableCalendarPostCommitStage,
	runDurableCalendarMutation,
} from "../src/bun/durable-calendar-mutation";
import type {
	PlanningCalendarEventProjection,
	PlanningCalendarMutationProjection,
} from "../src/shared/planning";

const optimisticEvent: PlanningCalendarEventProjection = {
	id: "event-1",
	title: "optimistic",
	kind: "manual-block",
	state: "committed",
	schedule: {
		allDay: false,
		start: "2026-08-15T01:00:00Z",
		end: "2026-08-15T02:00:00Z",
		timeZone: "Asia/Shanghai",
	},
	recurrence: null,
	occurrenceId: null,
	sourcePlanId: null,
	sourceTaskId: null,
	scheduleOrigin: null,
	userLocked: false,
	editable: true,
	version: 1,
};

const upsertMutation: PlanningCalendarMutationProjection = {
	mutationId: "mutation-1",
	kind: "update",
	eventId: optimisticEvent.id,
	expectedVersion: 1,
	before: optimisticEvent,
	after: { ...optimisticEvent, title: "updated" },
	recurrenceScope: null,
};

describe("durable calendar mutation boundary", () => {
	test("reports a commit failure and does not run post-commit work", async () => {
		const commitError = new Error("commit failed");
		const calls: string[] = [];
		const result = await runDurableCalendarMutation({
			commit: async () => {
				calls.push("commit");
				throw commitError;
			},
			project: () => {
				calls.push("project");
				return ["event"];
			},
			followUps: [
				{
					stage: "outbox-flush",
					run: async () => {
						calls.push("flush");
					},
				},
			],
			onDeferredFailure: () => calls.push("observe"),
		});

		expect(result).toEqual({ committed: false, error: commitError });
		expect(calls).toEqual(["commit"]);
	});

	test("keeps a durable success when projection and notification work fail", async () => {
		const calls: string[] = [];
		const failures: DurableCalendarPostCommitStage[] = [];
		const result = await runDurableCalendarMutation({
			commit: async () => {
				calls.push("commit");
				return { revision: 2 };
			},
			project: () => {
				calls.push("project");
				throw new TypeError("projection failed");
			},
			followUps: [
				{
					stage: "outbox-flush",
					run: async () => {
						calls.push("flush");
						throw new Error("notification failed");
					},
				},
				{
					stage: "execution-reconciliation",
					run: async () => {
						calls.push("reconcile");
					},
				},
			],
			onDeferredFailure: (stage) => failures.push(stage),
		});

		expect(result).toEqual({ committed: true, projection: null });
		expect(calls).toEqual(["commit", "project", "flush", "reconcile"]);
		expect(failures).toEqual(["projection", "outbox-flush"]);
	});
});
