import type {
	CalendarBatchMutationResult,
	CalendarConflict,
	CalendarEvent,
	CalendarLoadResponse,
	CalendarMutation,
	CalendarMutationResult,
	CalendarSnapshot,
} from "../shared/calendar";
import {
	CalendarRevisionConflictError,
	type AgentCalendarEventRecord,
	type CalendarBatchCommit,
	type CalendarEventListOptions,
} from "./encrypted-agent-repository";
import {
	CalendarPolicyError,
	cloneCalendarEvent,
	detectAuthoritativeConflict,
	eventOccursInDateRange,
	validateOccurrenceOverride,
	validateCalendarMutation,
} from "./calendar-policy";

export interface CalendarRepositoryOptions {
	timeZone: () => string;
	now?: () => number;
}

export interface CalendarStorage {
	getCalendarRevision(accountId: string): Promise<number>;
	listCalendarEvents(
		accountId: string,
		options?: CalendarEventListOptions,
	): Promise<AgentCalendarEventRecord[]>;
	commitCalendarBatch(
		accountId: string,
		batch: CalendarBatchCommit,
	): Promise<{ revision: number }>;
}

export type PreparedCalendarMutationBatch =
	| {
			ok: true;
			batchId: string;
			events: readonly CalendarEvent[];
			warnings: readonly CalendarConflict[];
			commit: CalendarBatchCommit;
	  }
	| {
			ok: false;
			batchId: string;
			conflicts: readonly CalendarConflict[];
	  };

/** Bun-owned authoritative calendar with optimistic versions and atomic batch commit. */
export class CalendarRepository {
	private readonly now: () => number;

	constructor(
		private readonly storage: CalendarStorage,
		private readonly options: CalendarRepositoryOptions,
	) {
		this.now = options.now ?? Date.now;
	}

	async load(accountId: string): Promise<CalendarLoadResponse> {
		const { revision, records } = await this.readStableCalendar(accountId);
		return {
			revision,
			timeZone: this.options.timeZone(),
			events: records.map((record) => cloneCalendarEvent(record.event)),
		};
	}

	async snapshot(
		accountId: string,
		fromDate: string,
		toDateExclusive: string,
	): Promise<CalendarSnapshot> {
		// Decrypt the complete calendar set before filtering. A recurring series
		// can begin years before this window and therefore cannot be selected
		// safely from only its coarse base-occurrence dates.
		const { revision, records } = await this.readStableCalendar(accountId);
		const timeZone = this.options.timeZone();
		return {
			accountId,
			revision,
			timeZone,
			fromDate,
			toDateExclusive,
			events: records
				.map((record) => cloneCalendarEvent(record.event))
				.filter((event) => eventOccursInDateRange(event, fromDate, toDateExclusive, timeZone)),
		};
	}

	async mutate(accountId: string, mutation: CalendarMutation): Promise<CalendarMutationResult> {
		const batch = await this.mutateBatch(accountId, mutation.mutationId, [mutation]);
		if (!batch.ok) {
			return {
				ok: false,
				mutationId: mutation.mutationId,
				conflict: batch.conflicts[0] ?? serviceConflict(mutation.eventId),
			};
		}
		return {
			ok: true,
			mutationId: mutation.mutationId,
			event: batch.events.find((event) => event.id === mutation.eventId) ?? null,
			warning: batch.warnings[0] ?? null,
		};
	}

	async mutateBatch(
		accountId: string,
		batchId: string,
		mutations: readonly CalendarMutation[],
		expectedRevision?: number,
	): Promise<CalendarBatchMutationResult> {
		const prepared = await this.prepareMutationBatch(
			accountId,
			batchId,
			mutations,
			expectedRevision,
		);
		if (!prepared.ok) return prepared;
		try {
			const commit = await this.storage.commitCalendarBatch(
				accountId,
				prepared.commit,
			);
			return {
				ok: true,
				batchId,
				events: prepared.events,
				warnings: prepared.warnings,
				calendarRevision: commit.revision,
			};
		} catch (error) {
			if (error instanceof CalendarRevisionConflictError) {
				return { ok: false, batchId, conflicts: [revisionConflict()] };
			}
			throw error;
		}
	}

	async prepareMutationBatch(
		accountId: string,
		batchId: string,
		mutations: readonly CalendarMutation[],
		expectedRevision?: number,
	): Promise<PreparedCalendarMutationBatch> {
		if (mutations.length < 1 || mutations.length > 500) {
			throw new CalendarPolicyError("invalid-batch", "日历批量操作数量必须在 1 到 500 之间。");
		}
		const currentRevision = await this.storage.getCalendarRevision(accountId);
		if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
			return { ok: false, batchId, conflicts: [revisionConflict()] };
		}
		const records = await this.listAllCalendarEvents(accountId);
		const working = new Map(records.map((record) => [record.event.id, cloneCalendarEvent(record.event)]));
		const output: CalendarEvent[] = [];
		const warnings: CalendarConflict[] = [];
		const conflicts: CalendarConflict[] = [];
		const upserts: AgentCalendarEventRecord[] = [];
		const deletes: string[] = [];

		for (const mutation of mutations) {
			const current = working.get(mutation.eventId) ?? null;
			const invalid = validateCalendarMutation(mutation, current);
			if (invalid) {
				conflicts.push(invalid);
				continue;
			}
			if (mutation.kind === "delete") {
				working.delete(mutation.eventId);
				deletes.push(mutation.eventId);
				continue;
			}
			const after = mutation.after!;
			const next = cloneCalendarEvent({
				...after,
				version: current ? current.version + 1 : 0,
			});
			const occurrenceConflict = validateOccurrenceOverride(next, [...working.values()]);
			if (occurrenceConflict) {
				conflicts.push(occurrenceConflict);
				continue;
			}
			const conflict = detectAuthoritativeConflict(next, [...working.values()]);
			if (conflict?.severity === "error") {
				conflicts.push(conflict);
				continue;
			}
			if (conflict) warnings.push(conflict);
			working.set(next.id, next);
			output.push(cloneCalendarEvent(next));
			upserts.push({ accountId, event: next, updatedAtMs: this.now() });
		}
		if (conflicts.length > 0) return { ok: false, batchId, conflicts };
		return {
			ok: true,
			batchId,
			events: output,
			warnings,
			commit: {
				expectedRevision: currentRevision,
				upserts,
				deletes,
			},
		};
	}

	private async readStableCalendar(accountId: string): Promise<{
		revision: number;
		records: AgentCalendarEventRecord[];
	}> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const before = await this.storage.getCalendarRevision(accountId);
			const records = await this.listAllCalendarEvents(accountId);
			const after = await this.storage.getCalendarRevision(accountId);
			if (before === after) return { revision: after, records };
		}
		throw new CalendarPolicyError(
			"calendar-changed",
			"读取完整日历期间发生了并发更新，请重试。",
		);
	}

	private async listAllCalendarEvents(
		accountId: string,
	): Promise<AgentCalendarEventRecord[]> {
		const pageSize = 500;
		const records: AgentCalendarEventRecord[] = [];
		const ids = new Set<string>();
		for (let offset = 0; ; offset += pageSize) {
			const page = await this.storage.listCalendarEvents(accountId, {
				limit: pageSize,
				offset,
			});
			let added = 0;
			for (const record of page) {
				if (ids.has(record.event.id)) continue;
				ids.add(record.event.id);
				records.push(record);
				added += 1;
			}
			if (page.length < pageSize) return records;
			if (added === 0) {
				throw new CalendarPolicyError(
					"calendar-pagination-stalled",
					"日历存储分页没有前进，已阻止不完整快照。",
				);
			}
		}
	}
}

function revisionConflict(): CalendarConflict {
	return {
		reason: "stale-revision",
		severity: "error",
		affectedEventIds: [],
		message: "日历在操作期间发生变化，请刷新后重试。",
		nextAction: "retry",
	};
}

function serviceConflict(eventId: string): CalendarConflict {
	return {
		reason: "service-unavailable",
		severity: "error",
		affectedEventIds: [eventId],
		message: "日历服务暂时不可用。",
		nextAction: "retry",
	};
}
