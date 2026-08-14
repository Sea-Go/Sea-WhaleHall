import type {
	PlanningCalendarEventProjection,
	PlanningCalendarMutationProjection,
} from "../../../../shared/planning";
import type {
	CalendarLoadResult,
	CalendarService,
} from "../../features/calendar/calendar-service";
import type {
	CalendarBatchMutationResult,
	CalendarEvent,
	CalendarMutation,
	CalendarMutationResult,
} from "../../features/calendar/domain";
import { assertValidCalendarEvent } from "../../features/calendar/domain";
import type { CalendarScenarioId } from "../../features/calendar/fixtures";

export type CalendarRpcClient = Pick<
	Awaited<ReturnType<typeof loadCalendarApi>>,
	| "loadPlanningCalendar"
	| "mutatePlanningCalendar"
	| "mutatePlanningCalendarBatch"
	| "onCalendarChanged"
>;

export type CalendarRpcLoader = () => Promise<CalendarRpcClient>;

/** Local-native calendar adapter. Domain and RPC projections stay serializable. */
export class ElectrobunCalendarService implements CalendarService {
	constructor(private readonly loadApi: CalendarRpcLoader = loadCalendarApi) {}

	subscribe(listener: () => void): () => void {
		let disposed = false;
		let stop: (() => void) | null = null;
		void this.loadApi()
			.then((api) => {
				if (disposed) return;
				stop = api.onCalendarChanged(() => listener());
			})
			.catch(() => {
				// The first authoritative load reports transport failures. A listener
				// setup failure must not become an unhandled renderer rejection.
			});
		return () => {
			disposed = true;
			stop?.();
		};
	}

	async load(_scenario?: CalendarScenarioId): Promise<CalendarLoadResult> {
		const result = await (await this.loadApi()).loadPlanningCalendar();
		return {
			events: result.events.map(fromProjection),
			timeZone: result.timeZone,
			scenario: "normal",
		};
	}

	async mutate(mutation: CalendarMutation): Promise<CalendarMutationResult> {
		const result = await (await this.loadApi()).mutatePlanningCalendar(
			toMutationProjection(mutation),
		);
		return result.ok
			? {
					...result,
					event: result.event ? fromProjection(result.event) : null,
				}
			: result;
	}

	async mutateBatch(
		batchId: string,
		mutations: readonly CalendarMutation[],
	): Promise<CalendarBatchMutationResult> {
		const result = await (await this.loadApi()).mutatePlanningCalendarBatch(
			batchId,
			mutations.map(toMutationProjection),
		);
		return result.ok
			? { ...result, events: result.events.map(fromProjection) }
			: result;
	}
}

async function loadCalendarApi() {
	return (await import("../../rpc")).clientApi;
}

function fromProjection(event: PlanningCalendarEventProjection): CalendarEvent {
	const calendarEvent = structuredClone(event) as CalendarEvent;
	assertValidCalendarEvent(calendarEvent);
	return calendarEvent;
}

function toProjection(event: CalendarEvent): PlanningCalendarEventProjection {
	assertValidCalendarEvent(event);
	return structuredClone(event) as PlanningCalendarEventProjection;
}

function toMutationProjection(
	mutation: CalendarMutation,
): PlanningCalendarMutationProjection {
	let after = mutation.after ? cloneForNativeMutation(mutation) : null;
	if (
		mutation.kind === "restore" &&
		after?.kind === "plan" &&
		after.scheduleOrigin === "model"
	) {
		// A user restore is a new user-owned placement for the same plan task. The
		// original model event was deleted, so native ownership validation requires
		// the recreated placement to stay locked until the user explicitly unlocks it.
		after = { ...after, scheduleOrigin: "user", userLocked: true };
	}
	return {
		...mutation,
		before: mutation.before ? toProjection(mutation.before) : null,
		after: after ? toProjection(after) : null,
	};
}

function cloneForNativeMutation(mutation: CalendarMutation): CalendarEvent {
	const after = mutation.after;
	if (!after) throw new Error("Calendar upsert requires an after event.");
	if (mutation.kind === "create" || mutation.kind === "restore") {
		return { ...structuredClone(after), version: 1 };
	}
	if (mutation.kind === "update") {
		if (mutation.expectedVersion === null) {
			throw new Error("Calendar update requires an expected version.");
		}
		return {
			...structuredClone(after),
			version: mutation.expectedVersion + 1,
		};
	}
	return structuredClone(after);
}
