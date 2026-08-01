import { describe, expect, test } from "bun:test";
import {
	CalendarRepository,
	type CalendarStorage,
} from "../src/bun/calendar-repository";
import {
	CalendarRevisionConflictError,
	type AgentCalendarEventRecord,
	type CalendarBatchCommit,
	type CalendarEventListOptions,
} from "../src/bun/encrypted-agent-repository";
import type { CalendarEvent, CalendarMutation } from "../src/shared/calendar";

class MemoryCalendarStorage implements CalendarStorage {
	revision = 0;
	events = new Map<string, AgentCalendarEventRecord>();
	failRevision = false;
	async getCalendarRevision(): Promise<number> {
		return this.revision;
	}
	async listCalendarEvents(
		_accountId: string,
		options: CalendarEventListOptions = {},
	): Promise<AgentCalendarEventRecord[]> {
		const offset = options.offset ?? 0;
		const limit = options.limit ?? 500;
		return [...this.events.values()]
			.sort((left, right) => left.event.id.localeCompare(right.event.id))
			.slice(offset, offset + limit)
			.map((item) => structuredClone(item));
	}
	async commitCalendarBatch(accountId: string, batch: CalendarBatchCommit): Promise<{ revision: number }> {
		if (this.failRevision || batch.expectedRevision !== this.revision) {
			throw new CalendarRevisionConflictError(batch.expectedRevision, this.revision + 1);
		}
		const next = new Map(this.events);
		for (const item of batch.upserts) next.set(item.event.id, structuredClone(item));
		for (const id of batch.deletes) next.delete(id);
		this.events = next;
		this.revision += 1;
		return { revision: this.revision };
	}
}

function calendarEvent(id: string, start: string, end: string): CalendarEvent {
	return {
		id,
		title: id,
		kind: "plan",
		state: "proposed",
		schedule: { allDay: false, start, end, timeZone: "Asia/Shanghai" },
		recurrence: null,
		occurrenceId: null,
		sourcePlanId: "plan-1",
		editable: true,
		version: 0,
	};
}

function createMutation(event: CalendarEvent): CalendarMutation {
	return {
		mutationId: `mutation-${event.id}`,
		kind: "create",
		eventId: event.id,
		expectedVersion: null,
		before: null,
		after: event,
		recurrenceScope: null,
	};
}

describe("CalendarRepository", () => {
	test("commits a validated batch with one calendar revision", async () => {
		const storage = new MemoryCalendarStorage();
		const repository = new CalendarRepository(storage, { timeZone: () => "Asia/Shanghai", now: () => 10 });
		const result = await repository.mutateBatch("account-1", "batch-1", [
			createMutation(calendarEvent("one", "2026-08-03T01:00:00Z", "2026-08-03T02:00:00Z")),
			createMutation(calendarEvent("two", "2026-08-03T03:00:00Z", "2026-08-03T04:00:00Z")),
		], 0);
		expect(result).toEqual(expect.objectContaining({ ok: true, calendarRevision: 1 }));
		expect(storage.events.size).toBe(2);
	});

	test("does not partially write a conflicting batch", async () => {
		const storage = new MemoryCalendarStorage();
		const repository = new CalendarRepository(storage, { timeZone: () => "Asia/Shanghai" });
		const blocker = calendarEvent("blocker", "2026-08-03T01:30:00Z", "2026-08-03T02:30:00Z");
		blocker.kind = "manual-block";
		blocker.state = "committed";
		storage.events.set(blocker.id, { accountId: "account-1", event: blocker, updatedAtMs: 1 });
		const result = await repository.mutateBatch("account-1", "batch-2", [
			createMutation(calendarEvent("safe", "2026-08-03T04:00:00Z", "2026-08-03T05:00:00Z")),
			createMutation(calendarEvent("conflict", "2026-08-03T02:00:00Z", "2026-08-03T03:00:00Z")),
		]);
		expect(result.ok).toBe(false);
		expect(storage.events.has("safe")).toBe(false);
		expect(storage.revision).toBe(0);
	});

	test("returns stale revision instead of replaying writes", async () => {
		const storage = new MemoryCalendarStorage();
		storage.failRevision = true;
		const repository = new CalendarRepository(storage, { timeZone: () => "Asia/Shanghai" });
		const result = await repository.mutateBatch("account-1", "batch-3", [
			createMutation(calendarEvent("one", "2026-08-03T01:00:00Z", "2026-08-03T02:00:00Z")),
		]);
		expect(result).toEqual(expect.objectContaining({ ok: false }));
		if (!result.ok) expect(result.conflicts[0]?.reason).toBe("stale-revision");
		expect(storage.events.size).toBe(0);
	});

	test("snapshot includes an old recurring series but excludes unrelated events", async () => {
		const storage = new MemoryCalendarStorage();
		const repository = new CalendarRepository(storage, { timeZone: () => "Asia/Shanghai" });
		const recurring = calendarEvent("old-series", "2026-01-05T01:00:00Z", "2026-01-05T02:00:00Z");
		recurring.state = "committed";
		recurring.recurrence = {
			seriesId: "old-series",
			rrule: "FREQ=WEEKLY",
			timeZone: "Asia/Shanghai",
			exceptionDates: [],
		};
		const unrelated = calendarEvent("unrelated", "2026-04-01T01:00:00Z", "2026-04-01T02:00:00Z");
		storage.events.set(recurring.id, { accountId: "account-1", event: recurring, updatedAtMs: 1 });
		storage.events.set(unrelated.id, { accountId: "account-1", event: unrelated, updatedAtMs: 1 });

		const snapshot = await repository.snapshot("account-1", "2026-08-03", "2026-08-10");

		expect(snapshot.events.map((item) => item.id)).toEqual(["old-series"]);
	});

	test("does not truncate a planning snapshot after one thousand events", async () => {
		const storage = new MemoryCalendarStorage();
		const repository = new CalendarRepository(storage, { timeZone: () => "Asia/Shanghai" });
		for (let index = 0; index < 1_005; index += 1) {
			const item = calendarEvent(
				`event-${String(index).padStart(4, "0")}`,
				"2026-08-03T01:00:00Z",
				"2026-08-03T02:00:00Z",
			);
			storage.events.set(item.id, {
				accountId: "account-1",
				event: item,
				updatedAtMs: index,
			});
		}

		const snapshot = await repository.snapshot("account-1", "2026-08-03", "2026-08-04");

		expect(snapshot.events).toHaveLength(1_005);
		expect(snapshot.events.at(-1)?.id).toBe("event-1004");
	});

	test("stores an occurrence override only after the series records its exception", async () => {
		const storage = new MemoryCalendarStorage();
		const repository = new CalendarRepository(storage, { timeZone: () => "Asia/Shanghai" });
		const series = calendarEvent("series-event", "2026-08-03T01:00:00Z", "2026-08-03T02:00:00Z");
		series.recurrence = {
			seriesId: "series-1",
			rrule: "FREQ=WEEKLY",
			timeZone: "Asia/Shanghai",
			exceptionDates: [],
		};
		storage.events.set(series.id, { accountId: "account-1", event: series, updatedAtMs: 1 });
		const anchor = "2026-08-10T01:00:00Z";
		const seriesAfter = {
			...series,
			recurrence: { ...series.recurrence, exceptionDates: [anchor] },
		};
		const occurrence = {
			...series,
			id: "series-event::2026-08-10T01:00:00Z",
			occurrenceId: `series-1:${anchor}`,
			schedule: {
				allDay: false as const,
				start: "2026-08-10T03:00:00Z",
				end: "2026-08-10T04:00:00Z",
				timeZone: "Asia/Shanghai",
			},
		};
		const result = await repository.mutateBatch("account-1", "occurrence-batch", [
			{
				mutationId: "record-exception",
				kind: "update",
				eventId: series.id,
				expectedVersion: 0,
				before: series,
				after: seriesAfter,
				recurrenceScope: "occurrence",
			},
			{
				mutationId: "create-override",
				kind: "create",
				eventId: occurrence.id,
				expectedVersion: null,
				before: null,
				after: occurrence,
				recurrenceScope: "occurrence",
			},
		], 0);

		expect(result).toEqual(expect.objectContaining({ ok: true, calendarRevision: 1 }));
		expect(storage.events.get(series.id)?.event.recurrence?.exceptionDates).toEqual([anchor]);
		expect(storage.events.get(occurrence.id)?.event.occurrenceId).toBe(`series-1:${anchor}`);
	});
});
