import type { CalendarService } from "./calendar-service";
import type { CalendarScenarioId } from "./fixtures";
import {
	assertValidCalendarEvent,
	canUserUnlockPlanEvent,
	cloneCalendarEvent,
	createOccurrenceOverride,
	type CalendarBatchMutationResult,
	type CalendarConflict,
	type CalendarEvent,
	type CalendarMutation,
	type CalendarMutationKind,
	type CalendarMutationResult,
	type RecurrenceScope,
} from "./domain";

export interface DeletedCalendarEvent {
	event: CalendarEvent;
	deletedAt: number;
}

export interface CalendarControllerState {
	loadState: "idle" | "loading" | "ready" | "error" | "offline";
	events: readonly CalendarEvent[];
	timeZone: string;
	scenario: CalendarScenarioId;
	pendingEventIds: ReadonlySet<string>;
	conflict: CalendarConflict | null;
	message: string | null;
	undo: DeletedCalendarEvent | null;
}

const defaultState: CalendarControllerState = {
	loadState: "idle",
	events: [],
	timeZone: "Asia/Shanghai",
	scenario: "normal",
	pendingEventIds: new Set(),
	conflict: null,
	message: null,
	undo: null,
};

function unavailableConflict(message: string): CalendarConflict {
	return {
		reason: "service-unavailable",
		severity: "error",
		affectedEventIds: [],
		message,
		nextAction: "retry",
	};
}

export class CalendarController {
	private state: CalendarControllerState = defaultState;
	private readonly listeners = new Set<() => void>();
	private readonly mutationOwners = new Map<string, string>();
	private loadSequence = 0;

	constructor(
		private readonly service: CalendarService,
		private readonly createId: () => string = () => crypto.randomUUID(),
	) {}

	getSnapshot = (): CalendarControllerState => this.state;
	getServerSnapshot = (): CalendarControllerState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	async load(scenario?: CalendarScenarioId): Promise<void> {
		const sequence = ++this.loadSequence;
		const requestedScenario = scenario ?? this.state.scenario;
		this.patch({
			loadState: "loading",
			scenario: requestedScenario,
			conflict: null,
			message: null,
		});
		try {
			const result = await this.service.load(scenario);
			if (sequence !== this.loadSequence) return;
			this.patch({
				loadState: "ready",
				events: result.events.map(cloneCalendarEvent),
				timeZone: result.timeZone,
				scenario: result.scenario,
				pendingEventIds: new Set(),
				undo: null,
			});
		} catch (error) {
			if (sequence !== this.loadSequence) return;
			const offline =
				error instanceof Error && error.message.toLowerCase().includes("offline");
			this.patch({
				loadState: offline ? "offline" : "error",
				message: offline
					? "当前处于离线状态，日程暂时无法同步。"
					: "日程加载失败，请重试。",
			});
		}
	}

	clearFeedback(): void {
		this.patch({ conflict: null, message: null });
	}

	async create(event: CalendarEvent): Promise<CalendarMutationResult> {
		assertValidCalendarEvent(event);
		return this.runMutation("create", null, event, null);
	}

	async update(
		event: CalendarEvent,
		recurrenceScope: RecurrenceScope | null = null,
	): Promise<CalendarMutationResult> {
		const before = this.state.events.find((item) => item.id === event.id) ?? null;
		if (!before?.editable) {
			return this.rejectLocally(
				event.id,
				"read-only-event",
				"该日程来自外部日历，当前只能查看。",
			);
		}
		if (before.recurrence && !recurrenceScope) {
			return this.rejectLocally(
				event.id,
				"recurrence-restriction",
				"请先选择修改本次、后续或整个系列。",
			);
		}
		const userEdited =
			before.kind === "plan" && before.scheduleOrigin === "model"
				? { ...event, userLocked: true }
				: event;
		assertValidCalendarEvent(userEdited);
		return this.runMutation("update", before, userEdited, recurrenceScope);
	}

	async setPlanEventLocked(
		eventId: string,
		userLocked: boolean,
	): Promise<CalendarMutationResult> {
		const before = this.state.events.find((event) => event.id === eventId) ?? null;
		if (!before || (!userLocked && !canUserUnlockPlanEvent(before))) {
			return this.rejectLocally(
				eventId,
				"read-only-event",
				"只有可编辑的模型计划日程可以更改自动排程锁定。",
			);
		}
		const after = { ...before, userLocked };
		assertValidCalendarEvent(after);
		return this.runMutation("update", before, after, null);
	}

	async delete(
		eventId: string,
		recurrenceScope: RecurrenceScope | null = null,
	): Promise<CalendarMutationResult> {
		const before = this.state.events.find((event) => event.id === eventId) ?? null;
		if (!before) {
			return this.rejectLocally(
				eventId,
				"stale-version",
				"该日程已经不存在，请刷新后重试。",
			);
		}
		if (!before.editable) {
			return this.rejectLocally(
				eventId,
				"read-only-event",
				"外部日程为只读，不能删除。",
			);
		}
		if (before.recurrence && !recurrenceScope) {
			return this.rejectLocally(
				eventId,
				"recurrence-restriction",
				"删除重复日程前，请选择作用范围。",
			);
		}
		return this.runMutation("delete", before, null, recurrenceScope);
	}

	async undoDelete(): Promise<CalendarMutationResult | null> {
		const deleted = this.state.undo;
		if (!deleted) return null;
		const restored = {
			...cloneCalendarEvent(deleted.event),
			version: deleted.event.version,
		};
		this.patch({ undo: null });
		return this.runMutation("restore", null, restored, null);
	}

	async confirmProposed(
		eventIds: readonly string[],
	): Promise<CalendarBatchMutationResult> {
		const proposed = this.state.events.filter(
			(event) => eventIds.includes(event.id) && event.state === "proposed",
		);
		const batchId = this.createId();
		const mutations = proposed.map<CalendarMutation>((event) => ({
			mutationId: this.createId(),
			kind: "update",
			eventId: event.id,
			expectedVersion: event.version,
			before: cloneCalendarEvent(event),
			after: { ...cloneCalendarEvent(event), state: "committed" },
			recurrenceScope: null,
		}));
		const optimistic = this.state.events.map((event) =>
			eventIds.includes(event.id) && event.state === "proposed"
				? { ...event, state: "committed" as const }
				: event,
		);
		this.patch({
			events: optimistic,
			pendingEventIds: new Set([
				...this.state.pendingEventIds,
				...proposed.map((event) => event.id),
			]),
		});
		try {
			const result = await this.service.mutateBatch(batchId, mutations);
			if (result.ok) {
				const authoritative = new Map(result.events.map((event) => [event.id, event]));
				this.patch({
					events: this.state.events.map(
						(event) => authoritative.get(event.id) ?? event,
					),
					pendingEventIds: this.withoutPending(
						proposed.map((event) => event.id),
					),
					conflict: result.warnings[0] ?? null,
					message: `已确认 ${result.events.length} 项计划。`,
				});
			} else {
				this.patch({
					events: this.restoreEvents(proposed),
					pendingEventIds: this.withoutPending(
						proposed.map((event) => event.id),
					),
					conflict: result.conflicts[0] ?? null,
					message: "确认未完成，所有待确认计划均已恢复。",
				});
			}
			return result;
		} catch {
			const conflict = unavailableConflict("同步失败，所有待确认计划均已恢复。");
			this.patch({
				events: this.restoreEvents(proposed),
				pendingEventIds: this.withoutPending(proposed.map((event) => event.id)),
				conflict,
			});
			return { ok: false, batchId, conflicts: [conflict] };
		}
	}

	async updateOccurrence(
		seriesId: string,
		occurrenceStart: string,
		edited: CalendarEvent,
	): Promise<CalendarBatchMutationResult> {
		const series = this.state.events.find((event) => event.id === seriesId);
		if (!series?.recurrence) {
			const conflict: CalendarConflict = {
				reason: "recurrence-restriction",
				severity: "error",
				affectedEventIds: [seriesId],
				message: "重复系列已经变化，请刷新后重试。",
				nextAction: "retry",
			};
			this.patch({ conflict });
			return { ok: false, batchId: this.createId(), conflicts: [conflict] };
		}
		const { series: seriesAfter, occurrence } = createOccurrenceOverride(
			series,
			occurrenceStart,
			edited.schedule,
			edited.title,
		);
		const batchId = this.createId();
		const mutations: CalendarMutation[] = [
			{
				mutationId: this.createId(),
				kind: "update",
				eventId: series.id,
				expectedVersion: series.version,
				before: cloneCalendarEvent(series),
				after: seriesAfter,
				recurrenceScope: "occurrence",
			},
			{
				mutationId: this.createId(),
				kind: "create",
				eventId: occurrence.id,
				expectedVersion: null,
				before: null,
				after: occurrence,
				recurrenceScope: "occurrence",
			},
		];
		this.patch({
			events: [
				...this.state.events.map((event) =>
					event.id === series.id ? seriesAfter : event,
				),
				occurrence,
			],
			pendingEventIds: new Set([
				...this.state.pendingEventIds,
				series.id,
				occurrence.id,
			]),
		});
		try {
			const result = await this.service.mutateBatch(batchId, mutations);
			if (result.ok) {
				const authoritative = new Map(
					result.events.map((event) => [event.id, event]),
				);
				this.patch({
					events: this.state.events.map(
						(event) => authoritative.get(event.id) ?? event,
					),
					pendingEventIds: this.withoutPending([series.id, occurrence.id]),
					conflict: result.warnings[0] ?? null,
					message: "已仅修改这一次，其他重复日程保持不变。",
				});
			} else {
				this.patch({
					events: this.state.events
						.filter((event) => event.id !== occurrence.id)
						.map((event) => (event.id === series.id ? series : event)),
					pendingEventIds: this.withoutPending([series.id, occurrence.id]),
					conflict: result.conflicts[0] ?? null,
					message: "单次修改未保存，重复系列已恢复。",
				});
			}
			return result;
		} catch {
			const conflict = unavailableConflict("同步失败，单次修改已撤销。");
			this.patch({
				events: this.state.events
					.filter((event) => event.id !== occurrence.id)
					.map((event) => (event.id === series.id ? series : event)),
				pendingEventIds: this.withoutPending([series.id, occurrence.id]),
				conflict,
			});
			return { ok: false, batchId, conflicts: [conflict] };
		}
	}

	private async runMutation(
		kind: CalendarMutationKind,
		before: CalendarEvent | null,
		after: CalendarEvent | null,
		recurrenceScope: RecurrenceScope | null,
	): Promise<CalendarMutationResult> {
		const eventId = after?.id ?? before?.id;
		if (!eventId) throw new Error("Calendar mutation requires an event ID.");
		const mutationId = this.createId();
		const mutation: CalendarMutation = {
			mutationId,
			kind,
			eventId,
			expectedVersion: before?.version ?? null,
			before: before ? cloneCalendarEvent(before) : null,
			after: after ? cloneCalendarEvent(after) : null,
			recurrenceScope,
		};
		this.mutationOwners.set(eventId, mutationId);
		const optimisticEvents =
			kind === "delete"
				? this.state.events.filter((event) => event.id !== eventId)
				: this.replaceEvent(after as CalendarEvent);
		this.patch({
			events: optimisticEvents,
			pendingEventIds: new Set([...this.state.pendingEventIds, eventId]),
			conflict: null,
			message: null,
		});

		try {
			const result = await this.service.mutate(mutation);
			if (this.mutationOwners.get(eventId) !== mutationId) return result;
			this.mutationOwners.delete(eventId);
			if (result.ok) {
				this.patch({
					events: result.event
						? this.replaceEvent(result.event)
						: this.state.events.filter((event) => event.id !== eventId),
					pendingEventIds: this.withoutPending([eventId]),
					conflict: result.warning,
					message:
						kind === "delete"
							? "日程已删除，可撤销。"
							: kind === "restore"
								? "已恢复日程。"
								: "日程已保存。",
					undo:
						kind === "delete" && before
							? { event: cloneCalendarEvent(before), deletedAt: Date.now() }
							: this.state.undo,
				});
			} else {
				this.rollback(eventId, before, result.conflict);
			}
			return result;
		} catch {
			const conflict = unavailableConflict("同步失败，刚才的更改已撤销。");
			if (this.mutationOwners.get(eventId) === mutationId) {
				this.mutationOwners.delete(eventId);
				this.rollback(eventId, before, conflict);
			}
			return { ok: false, mutationId, conflict };
		}
	}

	private rejectLocally(
		eventId: string,
		reason: CalendarConflict["reason"],
		message: string,
	): CalendarMutationResult {
		const conflict: CalendarConflict = {
			reason,
			severity: "error",
			affectedEventIds: [eventId],
			message,
			nextAction: "inspect",
		};
		this.patch({ conflict, message });
		return {
			ok: false,
			mutationId: this.createId(),
			conflict,
		};
	}

	private rollback(
		eventId: string,
		before: CalendarEvent | null,
		conflict: CalendarConflict,
	): void {
		this.patch({
			events: before
				? this.replaceEvent(before)
				: this.state.events.filter((event) => event.id !== eventId),
			pendingEventIds: this.withoutPending([eventId]),
			conflict,
			message: "更改未保存，已恢复原来的日程。",
		});
	}

	private replaceEvent(event: CalendarEvent): CalendarEvent[] {
		const exists = this.state.events.some((item) => item.id === event.id);
		return exists
			? this.state.events.map((item) =>
					item.id === event.id ? cloneCalendarEvent(event) : item,
				)
			: [...this.state.events, cloneCalendarEvent(event)];
	}

	private restoreEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
		const restored = new Map(events.map((event) => [event.id, event]));
		return this.state.events.map((event) => restored.get(event.id) ?? event);
	}

	private withoutPending(eventIds: readonly string[]): ReadonlySet<string> {
		const next = new Set(this.state.pendingEventIds);
		for (const eventId of eventIds) next.delete(eventId);
		return next;
	}

	private patch(patch: Partial<CalendarControllerState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
}
