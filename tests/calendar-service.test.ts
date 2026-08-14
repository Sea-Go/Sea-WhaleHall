import { describe, expect, test } from "bun:test";
import type { PlanningCalendarMutationProjection } from "../src/shared/planning";
import type {
	CalendarEvent,
	CalendarMutation,
} from "../src/views/client/features/calendar/domain";
import {
	type CalendarRpcClient,
	ElectrobunCalendarService,
} from "../src/views/client/infrastructure/calendar/ElectrobunCalendarService";

function manualEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		id: "event-1",
		title: "专注时间",
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
		version: 0,
		...overrides,
	};
}

function mutation(
	kind: CalendarMutation["kind"],
	after: CalendarEvent | null,
	before: CalendarEvent | null = null,
): CalendarMutation {
	return {
		mutationId: `mutation-${kind}`,
		kind,
		eventId: after?.id ?? before?.id ?? "event-1",
		expectedVersion: before?.version ?? null,
		before,
		after,
		recurrenceScope: null,
	};
}

function rpcClient(
	captured: PlanningCalendarMutationProjection[],
	overrides: Partial<CalendarRpcClient> = {},
): CalendarRpcClient {
	return {
		loadPlanningCalendar: async () => ({
			events: [],
			timeZone: "Asia/Shanghai",
		}),
		mutatePlanningCalendar: async (input) => {
			captured.push(input);
			return {
				ok: true,
				mutationId: input.mutationId,
				event: input.after,
				warning: null,
			};
		},
		mutatePlanningCalendarBatch: async (batchId, inputs) => {
			captured.push(...inputs);
			return {
				ok: true,
				batchId,
				events: inputs.flatMap((input) => (input.after ? [input.after] : [])),
				warnings: [],
			};
		},
		onCalendarChanged: () => () => {},
		...overrides,
	};
}

describe("Electrobun calendar service", () => {
	test("normalizes native create and update versions", async () => {
		const captured: PlanningCalendarMutationProjection[] = [];
		const service = new ElectrobunCalendarService(async () =>
			rpcClient(captured),
		);
		const created = manualEvent();
		const before = manualEvent({ version: 4 });
		const after = manualEvent({ title: "新的专注时间", version: 4 });

		await service.mutate(mutation("create", created));
		await service.mutate(mutation("update", after, before));

		expect(captured[0]?.after?.version).toBe(1);
		expect(captured[0]?.expectedVersion).toBeNull();
		expect(captured[1]?.after?.version).toBe(5);
		expect(captured[1]?.expectedVersion).toBe(4);
	});

	test("restores a deleted model placement as a locked user placement at version one", async () => {
		const captured: PlanningCalendarMutationProjection[] = [];
		const service = new ElectrobunCalendarService(async () =>
			rpcClient(captured),
		);
		const deletedPlanEvent = manualEvent({
			kind: "plan",
			sourcePlanId: "plan-1",
			sourceTaskId: "task-1",
			scheduleOrigin: "model",
			version: 8,
		});

		await service.mutate(mutation("restore", deletedPlanEvent));

		expect(captured[0]?.after).toMatchObject({
			version: 1,
			scheduleOrigin: "user",
			userLocked: true,
		});
	});

	test("rejects an unowned plan event before native RPC", async () => {
		const captured: PlanningCalendarMutationProjection[] = [];
		const service = new ElectrobunCalendarService(async () =>
			rpcClient(captured),
		);
		const unownedPlan = manualEvent({ kind: "plan" });

		expect(service.mutate(mutation("create", unownedPlan))).rejects.toThrow(
			"计划来源、任务来源与锁定状态不一致",
		);
		expect(captured).toHaveLength(0);
	});

	test("turns calendarChanged into an authoritative reload invalidation", async () => {
		const captured: PlanningCalendarMutationProjection[] = [];
		const invalidations: Array<() => void> = [];
		const service = new ElectrobunCalendarService(async () =>
			rpcClient(captured, {
				onCalendarChanged: (listener) => {
					const invalidate = () => listener(9);
					invalidations.push(invalidate);
					return () => {
						invalidations.splice(invalidations.indexOf(invalidate), 1);
					};
				},
			}),
		);
		let reloads = 0;
		const stop = service.subscribe(() => {
			reloads += 1;
		});
		await Promise.resolve();

		invalidations[0]?.();

		expect(reloads).toBe(1);
		stop();
		expect(invalidations).toHaveLength(0);
	});
});
