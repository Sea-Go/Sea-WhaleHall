import {
	compareInstants,
	intervalsOverlap,
	localDateTimeToInstant,
} from "./time";
import type {
	CalendarApplyResult,
	PlanningCalendarPort,
	PlanningCalendarQuery,
	PlanningObservationPort,
	PlanningObservationQuery,
	PlanningRepository,
	PlanningWriteResult,
} from "./ports";
import {
	PlanOperationConflictError,
	PlanVersionConflictError,
} from "./ports";
import type {
	CalendarChangeSet,
	PlanningCalendarEvent,
	PlanningObservationSummary,
	PlanningPlan,
} from "./types";

interface RecordedWrite {
	planId: string;
	requestedVersion: number;
	result: PlanningPlan;
}

export class InMemoryPlanningRepository implements PlanningRepository {
	private readonly plans = new Map<string, PlanningPlan>();
	private readonly operations = new Map<string, RecordedWrite>();

	async listPlans(): Promise<readonly PlanningPlan[]> {
		return [...this.plans.values()]
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map(clone);
	}

	async getPlan(planId: string): Promise<PlanningPlan | null> {
		return clone(this.plans.get(planId) ?? null);
	}

	async getOperationResult(operationId: string): Promise<PlanningPlan | null> {
		return clone(this.operations.get(operationId)?.result ?? null);
	}

	async createPlan(
		plan: PlanningPlan,
		operationId: string,
	): Promise<PlanningWriteResult> {
		const replay = this.replay(operationId, plan);
		if (replay) return replay;
		if (this.plans.has(plan.id)) {
			throw new PlanVersionConflictError(0, this.plans.get(plan.id)?.version ?? null);
		}
		if (plan.version !== 1) {
			throw new PlanVersionConflictError(0, plan.version);
		}
		const saved = clone(plan);
		this.plans.set(plan.id, saved);
		this.operations.set(operationId, {
			planId: plan.id,
			requestedVersion: plan.version,
			result: clone(saved),
		});
		return { plan: clone(saved), replayed: false };
	}

	async savePlan(
		plan: PlanningPlan,
		options: { operationId: string; expectedVersion: number },
	): Promise<PlanningWriteResult> {
		const replay = this.replay(options.operationId, plan);
		if (replay) return replay;
		const current = this.plans.get(plan.id);
		if (!current || current.version !== options.expectedVersion) {
			throw new PlanVersionConflictError(
				options.expectedVersion,
				current?.version ?? null,
			);
		}
		if (plan.version !== options.expectedVersion + 1) {
			throw new PlanVersionConflictError(options.expectedVersion + 1, plan.version);
		}
		const saved = clone(plan);
		this.plans.set(plan.id, saved);
		this.operations.set(options.operationId, {
			planId: plan.id,
			requestedVersion: plan.version,
			result: clone(saved),
		});
		return { plan: clone(saved), replayed: false };
	}

	private replay(
		operationId: string,
		requested: PlanningPlan,
	): PlanningWriteResult | null {
		const recorded = this.operations.get(operationId);
		if (!recorded) return null;
		if (
			recorded.planId !== requested.id ||
			recorded.requestedVersion !== requested.version
		) {
			throw new PlanOperationConflictError(operationId);
		}
		return { plan: clone(recorded.result), replayed: true };
	}
}

export class InMemoryPlanningCalendar implements PlanningCalendarPort {
	private readonly events = new Map<string, PlanningCalendarEvent>();
	private readonly applied = new Map<string, CalendarApplyResult>();

	constructor(seed: readonly PlanningCalendarEvent[] = []) {
		for (const event of seed) {
			assertCalendarEvent(event);
			if (this.events.has(event.id)) {
				throw new Error("Duplicate in-memory planning calendar event ID.");
			}
			this.events.set(event.id, clone(event));
		}
	}

	async listEvents(
		query: PlanningCalendarQuery,
	): Promise<readonly PlanningCalendarEvent[]> {
		const start = localDateTimeToInstant(
			query.startDate,
			"00:00",
			query.timeZone,
		);
		const end = localDateTimeToInstant(
			query.endDateExclusive,
			"00:00",
			query.timeZone,
		);
		return [...this.events.values()]
			.filter((event) => intervalsOverlap(event.start, event.end, start, end))
			.sort((left, right) => compareInstants(left.start, right.start))
			.map(clone);
	}

	async applyChangeSet(changeSet: CalendarChangeSet): Promise<CalendarApplyResult> {
		const replay = this.applied.get(changeSet.operationId);
		if (replay) {
			if (replay.changeSetId !== changeSet.id) {
				throw new PlanOperationConflictError(changeSet.operationId);
			}
			return clone({ ...replay, ...(replay.ok ? { replayed: true } : {}) });
		}
		const staged = new Map(
			[...this.events].map(([id, event]) => [id, clone(event)]),
		);
		const conflicts: Array<{
			code: "stale-version" | "read-only" | "invalid-event" | "overlap";
			affectedEventIds: string[];
		}> = [];
		for (const mutation of changeSet.changes) {
			const current = staged.get(mutation.eventId) ?? null;
			if (mutation.kind === "create") {
				if (current || mutation.expectedVersion !== null || !mutation.after) {
					conflicts.push({ code: "stale-version", affectedEventIds: [mutation.eventId] });
					continue;
				}
				try {
					assertCalendarEvent(mutation.after);
				} catch {
					conflicts.push({ code: "invalid-event", affectedEventIds: [mutation.eventId] });
					continue;
				}
				staged.set(mutation.eventId, { ...clone(mutation.after), version: 1 });
				continue;
			}
			if (!current || current.version !== mutation.expectedVersion) {
				conflicts.push({ code: "stale-version", affectedEventIds: [mutation.eventId] });
				continue;
			}
			if (
				current.kind !== "plan" ||
				current.scheduleOrigin !== "model" ||
				current.userLocked
			) {
				conflicts.push({ code: "read-only", affectedEventIds: [mutation.eventId] });
				continue;
			}
			if (mutation.kind === "delete") {
				if (mutation.after !== null) {
					conflicts.push({ code: "invalid-event", affectedEventIds: [mutation.eventId] });
					continue;
				}
				staged.delete(mutation.eventId);
				continue;
			}
			if (!mutation.after) {
				conflicts.push({ code: "invalid-event", affectedEventIds: [mutation.eventId] });
				continue;
			}
			try {
				assertCalendarEvent(mutation.after);
			} catch {
				conflicts.push({ code: "invalid-event", affectedEventIds: [mutation.eventId] });
				continue;
			}
			staged.set(mutation.eventId, {
				...clone(mutation.after),
				version: current.version + 1,
			});
		}
		if (conflicts.length === 0) {
			const committed = [...staged.values()].filter(
				(event) => event.state === "committed",
			);
			for (let leftIndex = 0; leftIndex < committed.length; leftIndex += 1) {
				const left = committed[leftIndex];
				if (!left) continue;
				for (let rightIndex = leftIndex + 1; rightIndex < committed.length; rightIndex += 1) {
					const right = committed[rightIndex];
					if (!right) continue;
					if (intervalsOverlap(left.start, left.end, right.start, right.end)) {
						conflicts.push({
							code: "overlap",
							affectedEventIds: [left.id, right.id],
						});
					}
				}
			}
		}
		if (conflicts.length > 0) {
			const failed: CalendarApplyResult = {
				ok: false,
				changeSetId: changeSet.id,
				conflicts,
			};
			this.applied.set(changeSet.operationId, clone(failed));
			return failed;
		}
		this.events.clear();
		for (const [id, event] of staged) this.events.set(id, clone(event));
		const result: CalendarApplyResult = {
			ok: true,
			changeSetId: changeSet.id,
			events: changeSet.changes
				.map((change) => this.events.get(change.eventId))
				.filter((event): event is PlanningCalendarEvent => event !== undefined)
				.map(clone),
			replayed: false,
		};
		this.applied.set(changeSet.operationId, clone(result));
		return result;
	}

	/** Test and local-composition helper; it behaves like a user edit. */
	upsertUserEvent(event: PlanningCalendarEvent): void {
		assertCalendarEvent(event);
		this.events.set(event.id, clone(event));
	}
}

export class InMemoryPlanningObservations implements PlanningObservationPort {
	private summaries: PlanningObservationSummary[];

	constructor(seed: readonly PlanningObservationSummary[] = []) {
		this.summaries = seed.map(clone);
	}

	setSummaries(summaries: readonly PlanningObservationSummary[]): void {
		this.summaries = summaries.map(clone);
	}

	async listSummaries(
		query: PlanningObservationQuery,
	): Promise<readonly PlanningObservationSummary[]> {
		return this.summaries
			.filter(
				(summary) =>
					compareInstants(summary.startedAt, query.to) < 0 &&
					compareInstants(query.from, summary.endedAt) < 0,
			)
			.map(clone);
	}
}

function assertCalendarEvent(event: PlanningCalendarEvent): void {
	if (!event.id.trim() || !event.title.trim()) throw new Error("Invalid calendar event.");
	if (compareInstants(event.start, event.end) >= 0) {
		throw new Error("Invalid calendar event range.");
	}
	if (!Number.isSafeInteger(event.version) || event.version < 0) {
		throw new Error("Invalid calendar event version.");
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
