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




});
