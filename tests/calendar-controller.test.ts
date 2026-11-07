import { describe, expect, test } from "bun:test";
import { CalendarController } from "../src/views/client/features/calendar/CalendarController";
import type {
	CalendarLoadResult,
	CalendarService,
} from "../src/views/client/features/calendar/calendar-service";
import { addMinutes } from "../src/views/client/features/calendar/date-time";
import type {
	CalendarBatchMutationResult,
	CalendarConflict,
	CalendarEvent,
	CalendarMutation,
	CalendarMutationResult,
} from "../src/views/client/features/calendar/domain";
import {
	type CalendarScenarioId,
	calendarScenarioEvents,
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
	let rejectPromise: (reason?: unknown) => void = () => {};
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

class DeferredCalendarService implements CalendarService {
	readonly pending: Array<{
		mutation: CalendarMutation;
		deferred: ReturnType<typeof controlledPromise<CalendarMutationResult>>;
	}> = [];

	async load(
		scenario: CalendarScenarioId = "normal",
	): Promise<CalendarLoadResult> {
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

class DeferredLoadCalendarService implements CalendarService {
	readonly pendingLoads: Array<{
		scenario: CalendarScenarioId;
		deferred: ReturnType<typeof controlledPromise<CalendarLoadResult>>;
	}> = [];

	load(scenario: CalendarScenarioId = "normal"): Promise<CalendarLoadResult> {
		const deferred = controlledPromise<CalendarLoadResult>();
		this.pendingLoads.push({ scenario, deferred });
		return deferred.promise;
	}

	async mutate(mutation: CalendarMutation): Promise<CalendarMutationResult> {
		return {
			ok: false,
			mutationId: mutation.mutationId,
			conflict: unavailableConflict(),
		};
	}

	async mutateBatch(
		batchId: string,
		_mutations: readonly CalendarMutation[],
	): Promise<CalendarBatchMutationResult> {
		return { ok: false, batchId, conflicts: [unavailableConflict()] };
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
			kind: "manual-block",
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
			sourceTaskId: null,
			scheduleOrigin: null,
			userLocked: false,
			editable: true,
			version: 0,
		};
		expect((await controller.create(created)).ok).toBe(true);
		const authoritative = controller.getSnapshot().events[0];
		expect(authoritative?.version).toBe(1);
		if (!authoritative) throw new Error("Missing created event");

		const updated = { ...authoritative, title: "更新测试" };
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

	test("locks a model-created task after a user calendar edit", async () => {
		const service = new MockCalendarService({ latencyMs: 0 });
		const controller = new CalendarController(service, idSequence());
		await controller.load("normal");
		const before = controller
			.getSnapshot()
			.events.find((event) => event.scheduleOrigin === "model");
		if (!before) throw new Error("Missing model-created event");

		const result = await controller.update({
			...before,
			title: "用户固定的安排",
		});
		expect(result.ok).toBe(true);
		expect(
			controller.getSnapshot().events.find((event) => event.id === before.id)
				?.userLocked,
		).toBe(true);
	});







});

describe("CalendarController recurrence, batch, and load states", () => {
	test("change-notification background reload keeps the board populated without a loading flash", async () => {
		const service = new DeferredLoadCalendarService();
		const controller = new CalendarController(service, idSequence());
		const initial = controller.load("normal");
		service.pendingLoads[0]?.deferred.resolve({
			events: calendarScenarioEvents("normal"),
			timeZone: "Asia/Shanghai",
			scenario: "normal",
		});
		await initial;
		expect(controller.getSnapshot().loadState).toBe("ready");
		const beforeCount = controller.getSnapshot().events.length;
		expect(beforeCount).toBeGreaterThan(0);

		// 删除/计划调整推送触发的后台重载：不得先清空数据或翻回 loading。
		const background = controller.load(undefined, { background: true });
		expect(controller.getSnapshot().loadState).toBe("ready");
		expect(controller.getSnapshot().events).toHaveLength(beforeCount);
		service.pendingLoads[
			service.pendingLoads.length - 1
		]?.deferred.resolve({
			events: calendarScenarioEvents("empty"),
			timeZone: "Asia/Shanghai",
			scenario: "normal",
		});
		await background;
		expect(controller.getSnapshot().loadState).toBe("ready");
		expect(controller.getSnapshot().events).toHaveLength(0);
	});

	test("failed background reload preserves current data and state", async () => {
		const service = new DeferredLoadCalendarService();
		const controller = new CalendarController(service, idSequence());
		const initial = controller.load("normal");
		service.pendingLoads[0]?.deferred.resolve({
			events: calendarScenarioEvents("normal"),
			timeZone: "Asia/Shanghai",
			scenario: "normal",
		});
		await initial;
		const eventsBefore = controller.getSnapshot().events;

		const background = controller.load(undefined, { background: true });
		service.pendingLoads[
			service.pendingLoads.length - 1
		]?.deferred.reject(new Error("offline"));
		await background;
		expect(controller.getSnapshot().loadState).toBe("ready");
		expect(controller.getSnapshot().events).toEqual(eventsBefore);
	});
});
