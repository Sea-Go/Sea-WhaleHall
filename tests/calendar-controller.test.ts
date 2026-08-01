import { describe, expect, test } from "bun:test";
import type {
	CalendarLoadResult,
	CalendarService,
} from "../src/views/client/features/calendar/calendar-service";
import { CalendarController } from "../src/views/client/features/calendar/CalendarController";
import { addMinutes } from "../src/views/client/features/calendar/date-time";
import type {
	CalendarBatchMutationResult,
	CalendarConflict,
	CalendarEvent,
	CalendarMutation,
	CalendarMutationResult,
} from "../src/views/client/features/calendar/domain";
import {
	calendarScenarioEvents,
	type CalendarScenarioId,
} from "../src/views/client/features/calendar/fixtures";
import { MockCalendarService } from "../src/views/client/infrastructure/calendar/MockCalendarService";

function idSequence() {
	let next = 0;
	return () => `mutation-${++next}`;
}

function unavailableConflict(message = "模拟同步失败"): CalendarConflict {
	return {
		reason: "service-unavailable",
		severity: "error",
		affectedEventIds: [],
		message,
		nextAction: "retry",
	};
}

function controlledPromise<T>() {
	let resolvePromise: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

class DeferredCalendarService implements CalendarService {
	readonly pending: Array<{
		mutation: CalendarMutation;
		deferred: ReturnType<typeof controlledPromise<CalendarMutationResult>>;
	}> = [];

	async load(scenario: CalendarScenarioId = "normal"): Promise<CalendarLoadResult> {
		return {
			events: calendarScenarioEvents(scenario),
			timeZone: "Asia/Shanghai",
			scenario,
		};
	}

	mutate(mutation: CalendarMutation): Promise<CalendarMutationResult> {
		const deferred = controlledPromise<CalendarMutationResult>();
		this.pending.push({ mutation, deferred });
		return deferred.promise;
	}

	async mutateBatch(
		batchId: string,
		_mutations: readonly CalendarMutation[],
	): Promise<CalendarBatchMutationResult> {
		return { ok: true, batchId, events: [], warnings: [] };
	}
}

describe("CalendarController CRUD and rollback", () => {
	test("creates, updates, deletes, and undoes an event", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const controller = new CalendarController(service, idSequence());
		await controller.load("empty");
		const created: CalendarEvent = {
			id: "created",
			title: "创建测试",
			kind: "plan",
			state: "committed",
			schedule: {
				allDay: false,
				start: "2026-07-29T01:00:00Z",
				end: "2026-07-29T02:00:00Z",
				timeZone: "Asia/Shanghai",
			},
			recurrence: null,
			occurrenceId: null,
			sourcePlanId: null,
			editable: true,
			version: 0,
		};
		expect((await controller.create(created)).ok).toBe(true);
		const authoritative = controller.getSnapshot().events[0];
		expect(authoritative?.version).toBe(1);

		const updated = { ...authoritative!, title: "更新测试" };
		expect((await controller.update(updated)).ok).toBe(true);
		expect(controller.getSnapshot().events[0]?.title).toBe("更新测试");
		expect(controller.getSnapshot().events[0]?.version).toBe(2);

		expect((await controller.delete("created")).ok).toBe(true);
		expect(controller.getSnapshot().events).toHaveLength(0);
		expect(controller.getSnapshot().undo?.event.title).toBe("更新测试");

		expect((await controller.undoDelete())?.ok).toBe(true);
		expect(controller.getSnapshot().events[0]?.title).toBe("更新测试");
		expect(controller.getSnapshot().undo).toBeNull();
	});

	test("rolls back a rejected drag and exposes a structured reason", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const controller = new CalendarController(service, idSequence());
		await controller.load("normal");
		const before = controller
			.getSnapshot()
			.events.find((event) => event.id === "design-system");
		if (!before || before.schedule.allDay) throw new Error("Missing event");
		service.failNextMutation(unavailableConflict("拖动同步失败"));
		const dragged = {
			...before,
			schedule: {
				...before.schedule,
				start: addMinutes(before.schedule.start, 15),
				end: addMinutes(before.schedule.end, 15),
			},
		};
		const request = controller.update(dragged);
		expect(
			controller.getSnapshot().events.find((event) => event.id === before.id)
				?.schedule,
		).toEqual(dragged.schedule);
		const result = await request;
		expect(result.ok).toBe(false);
		expect(
			controller.getSnapshot().events.find((event) => event.id === before.id)
				?.schedule,
		).toEqual(before.schedule);
		expect(controller.getSnapshot().conflict?.reason).toBe(
			"service-unavailable",
		);
	});

	test("rolls back a rejected resize", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const controller = new CalendarController(service, idSequence());
		await controller.load("short");
		const before = controller.getSnapshot().events[0];
		if (!before || before.schedule.allDay) throw new Error("Missing event");
		service.failNextMutation(unavailableConflict("缩放同步失败"));
		const resized = {
			...before,
			schedule: { ...before.schedule, end: addMinutes(before.schedule.end, 30) },
		};
		await controller.update(resized);
		expect(controller.getSnapshot().events[0]?.schedule).toEqual(
			before.schedule,
		);
	});

	test("ignores a stale drag response after a newer mutation owns the event", async () => {
		const service = new DeferredCalendarService();
		const controller = new CalendarController(service, idSequence());
		await controller.load("normal");
		const before = controller
			.getSnapshot()
			.events.find((event) => event.id === "design-system");
		if (!before) throw new Error("Missing event");
		const firstAfter = { ...before, title: "第一版" };
		const firstRequest = controller.update(firstAfter);
		const secondAfter = { ...firstAfter, title: "第二版" };
		const secondRequest = controller.update(secondAfter);
		const first = service.pending[0];
		const second = service.pending[1];
		if (!first || !second) throw new Error("Missing deferred mutation");

		first.deferred.resolve({
			ok: true,
			mutationId: first.mutation.mutationId,
			event: { ...firstAfter, version: 2 },
			warning: null,
		});
		await firstRequest;
		expect(
			controller.getSnapshot().events.find((event) => event.id === before.id)
				?.title,
		).toBe("第二版");

		second.deferred.resolve({
			ok: true,
			mutationId: second.mutation.mutationId,
			event: { ...secondAfter, version: 2 },
			warning: null,
		});
		await secondRequest;
		expect(
			controller.getSnapshot().events.find((event) => event.id === before.id)
				?.title,
		).toBe("第二版");
	});

	test("rejects committed overlap with a manual occupied block", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const controller = new CalendarController(service, idSequence());
		await controller.load("manual");
		const manual = controller.getSnapshot().events[0];
		if (!manual || manual.schedule.allDay) throw new Error("Missing manual");
		const candidate: CalendarEvent = {
			...manual,
			id: "conflicting-plan",
			title: "冲突计划",
			kind: "plan",
			sourcePlanId: "plan-conflict",
			version: 0,
		};
		const result = await controller.create(candidate);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.conflict.reason).toBe("overlaps-manual-block");
			expect(result.conflict.affectedEventIds).toContain(manual.id);
		}
		expect(
			controller.getSnapshot().events.some((event) => event.id === candidate.id),
		).toBe(false);
	});

	test("enforces external read-only behavior before calling the service", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const controller = new CalendarController(service, idSequence());
		await controller.load("external");
		const external = controller.getSnapshot().events[0];
		if (!external) throw new Error("Missing external");
		const result = await controller.update({ ...external, title: "不应修改" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.conflict.reason).toBe("read-only-event");
		expect(controller.getSnapshot().events[0]?.title).toBe(external.title);
	});
});

describe("CalendarController recurrence, batch, and load states", () => {
	test("confirms proposed events atomically and increments versions", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const controller = new CalendarController(service, idSequence());
		await controller.load("proposed");
		const proposed = controller.getSnapshot().events[0];
		if (!proposed) throw new Error("Missing proposed event");
		const result = await controller.confirmProposed([proposed.id]);
		expect(result.ok).toBe(true);
		expect(controller.getSnapshot().events[0]?.state).toBe("committed");
		expect(controller.getSnapshot().events[0]?.version).toBe(
			proposed.version + 1,
		);
	});

	test("creates a stable single-occurrence override and preserves the series", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const controller = new CalendarController(service, idSequence());
		await controller.load("recurrence");
		const series = controller.getSnapshot().events[0];
		if (!series || series.schedule.allDay) throw new Error("Missing series");
		const occurrenceStart = "2026-07-29T12:00:00Z";
		const edited = {
			...series,
			title: "仅本次改期",
			schedule: {
				...series.schedule,
				start: "2026-07-29T13:00:00Z",
				end: "2026-07-29T13:30:00Z",
			},
		};
		const result = await controller.updateOccurrence(
			series.id,
			occurrenceStart,
			edited,
		);
		expect(result.ok).toBe(true);
		const events = controller.getSnapshot().events;
		const updatedSeries = events.find((event) => event.id === series.id);
		const occurrence = events.find((event) => event.occurrenceId);
		expect(updatedSeries?.recurrence?.exceptionDates).toContain(occurrenceStart);
		expect(updatedSeries?.schedule).toEqual(series.schedule);
		expect(occurrence?.title).toBe("仅本次改期");
		expect(occurrence?.id).not.toBe(series.id);
	});

	test("exposes loading, error, offline, empty, and dense deterministic states", async () => {
		for (const [mode, expected] of [
			["error", "error"],
			["offline", "offline"],
		] as const) {
			const service = new MockCalendarService({
				latencyMs: 0,
				loadMode: mode,
			});
			const controller = new CalendarController(service, idSequence());
			await controller.load("normal");
			expect(controller.getSnapshot().loadState).toBe(expected);
		}
		const service = new MockCalendarService({ latencyMs: 0 });
		const controller = new CalendarController(service, idSequence());
		await controller.load("empty");
		expect(controller.getSnapshot().events).toHaveLength(0);
		await controller.load("dense");
		expect(controller.getSnapshot().events.length).toBeGreaterThan(10);
	});
});
