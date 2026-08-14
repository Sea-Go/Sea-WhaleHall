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
	return structuredClone(event) as CalendarEvent;
}

function toProjection(event: CalendarEvent): PlanningCalendarEventProjection {
	return structuredClone(event) as PlanningCalendarEventProjection;
}

function toMutationProjection(
	mutation: CalendarMutation,
): PlanningCalendarMutationProjection {
	return {
		...mutation,
		before: mutation.before ? toProjection(mutation.before) : null,
		after: mutation.after ? toProjection(mutation.after) : null,
	};
}
