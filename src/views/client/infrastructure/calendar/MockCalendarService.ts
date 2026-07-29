import type {
	CalendarLoadResult,
	CalendarService,
} from "../../features/calendar/calendar-service";
import {
	assertValidCalendarEvent,
	cloneCalendarEvent,
	detectCalendarConflict,
	type CalendarBatchMutationResult,
	type CalendarConflict,
	type CalendarEvent,
	type CalendarMutation,
	type CalendarMutationResult,
} from "../../features/calendar/domain";
import {
	CALENDAR_TIME_ZONE,
	calendarScenarioEvents,
	type CalendarScenarioId,
} from "../../features/calendar/fixtures";
import { systemTimeZone } from "../../features/calendar/date-time";

export type MockCalendarLoadMode = "ready" | "error" | "offline";

export interface MockCalendarServiceOptions {
	latencyMs?: number;
	loadMode?: MockCalendarLoadMode;
	displayTimeZone?: string;
}

function staleConflict(eventId: string): CalendarConflict {
	return {
		reason: "stale-version",
		severity: "error",
		affectedEventIds: [eventId],
		message: "日程已在其他操作中更新，请刷新后重试。",
		nextAction: "retry",
	};
}

function recurrenceConflict(eventId: string): CalendarConflict {
	return {
		reason: "recurrence-restriction",
		severity: "error",
		affectedEventIds: [eventId],
		message: "修改重复日程前，请明确选择作用范围。",
		nextAction: "edit",
	};
}

function readOnlyConflict(eventId: string): CalendarConflict {
	return {
		reason: "read-only-event",
		severity: "error",
		affectedEventIds: [eventId],
		message: "外部日程为只读，不能修改。",
		nextAction: "inspect",
	};
}

export class MockCalendarService implements CalendarService {
	private readonly latencyMs: number;
	private readonly displayTimeZone: string;
	private loadMode: MockCalendarLoadMode;
	private events = new Map<string, CalendarEvent>();
	private currentScenario: CalendarScenarioId = "normal";
	private nextFailure: CalendarConflict | null = null;

	constructor(options: MockCalendarServiceOptions = {}) {
		this.latencyMs = options.latencyMs ?? 90;
		this.loadMode = options.loadMode ?? "ready";
		this.displayTimeZone = options.displayTimeZone ?? systemTimeZone();
		this.events = new Map(
			calendarScenarioEvents("normal").map((event) => [
				event.id,
				cloneCalendarEvent(event),
			]),
		);
	}

	setLoadMode(mode: MockCalendarLoadMode): void {
		this.loadMode = mode;
	}

	failNextMutation(conflict: CalendarConflict): void {
		this.nextFailure = conflict;
	}

	async load(scenario?: CalendarScenarioId): Promise<CalendarLoadResult> {
		await this.wait();
		if (this.loadMode === "offline") throw new Error("offline");
		if (this.loadMode === "error") throw new Error("load failed");
		if (scenario) {
			this.currentScenario = scenario;
			const scenarioEvents = calendarScenarioEvents(scenario);
			this.events = new Map(
				scenarioEvents.map((event) => [event.id, cloneCalendarEvent(event)]),
			);
		}
		const events = [...this.events.values()].map(cloneCalendarEvent);
		return {
			events: events.map(cloneCalendarEvent),
			timeZone: this.displayTimeZone || CALENDAR_TIME_ZONE,
			scenario: this.currentScenario,
		};
	}

	async mutate(mutation: CalendarMutation): Promise<CalendarMutationResult> {
		await this.wait();
		if (this.nextFailure) {
			const conflict = this.nextFailure;
			this.nextFailure = null;
			return { ok: false, mutationId: mutation.mutationId, conflict };
		}
		const result = this.previewMutation(this.events, mutation);
		if (!result.ok) return result;
		this.applyResult(this.events, mutation, result.event);
		return result;
	}

	async mutateBatch(
		batchId: string,
		mutations: readonly CalendarMutation[],
	): Promise<CalendarBatchMutationResult> {
		await this.wait();
		const working = new Map(
			[...this.events].map(([id, event]) => [id, cloneCalendarEvent(event)]),
		);
		const events: CalendarEvent[] = [];
		const warnings: CalendarConflict[] = [];
		const conflicts: CalendarConflict[] = [];
		for (const mutation of mutations) {
			const result = this.previewMutation(working, mutation);
			if (!result.ok) {
				conflicts.push(result.conflict);
				continue;
			}
			this.applyResult(working, mutation, result.event);
			if (result.event) events.push(result.event);
			if (result.warning) warnings.push(result.warning);
		}
		if (conflicts.length > 0) return { ok: false, batchId, conflicts };
		this.events = working;
		return { ok: true, batchId, events, warnings };
	}

	private previewMutation(
		store: ReadonlyMap<string, CalendarEvent>,
		mutation: CalendarMutation,
	): CalendarMutationResult {
		const current = store.get(mutation.eventId) ?? null;
		if (
			(mutation.kind === "update" || mutation.kind === "delete") &&
			(!current || current.version !== mutation.expectedVersion)
		) {
			return {
				ok: false,
				mutationId: mutation.mutationId,
				conflict: staleConflict(mutation.eventId),
			};
		}
		if (current && !current.editable) {
			return {
				ok: false,
				mutationId: mutation.mutationId,
				conflict: readOnlyConflict(mutation.eventId),
			};
		}
		if (
			current?.recurrence &&
			(mutation.kind === "update" || mutation.kind === "delete") &&
			!mutation.recurrenceScope
		) {
			return {
				ok: false,
				mutationId: mutation.mutationId,
				conflict: recurrenceConflict(mutation.eventId),
			};
		}
		if (!mutation.after) {
			return {
				ok: true,
				mutationId: mutation.mutationId,
				event: null,
				warning: null,
			};
		}
		assertValidCalendarEvent(mutation.after);
		const conflict = detectCalendarConflict(mutation.after, [...store.values()]);
		if (
			conflict?.severity === "error" &&
			mutation.after.state === "committed"
		) {
			return { ok: false, mutationId: mutation.mutationId, conflict };
		}
		const authoritative = {
			...cloneCalendarEvent(mutation.after),
			version:
				mutation.kind === "create" || mutation.kind === "restore"
					? Math.max(1, mutation.after.version + 1)
					: (current?.version ?? mutation.after.version) + 1,
		};
		return {
			ok: true,
			mutationId: mutation.mutationId,
			event: authoritative,
			warning: conflict
				? { ...conflict, severity: "warning", nextAction: "keep-proposed" }
				: null,
		};
	}

	private applyResult(
		store: Map<string, CalendarEvent>,
		mutation: CalendarMutation,
		event: CalendarEvent | null,
	): void {
		if (mutation.kind === "delete" || !event) {
			store.delete(mutation.eventId);
			return;
		}
		store.set(event.id, cloneCalendarEvent(event));
	}

	private async wait(): Promise<void> {
		if (this.latencyMs <= 0) return;
		await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
	}
}
