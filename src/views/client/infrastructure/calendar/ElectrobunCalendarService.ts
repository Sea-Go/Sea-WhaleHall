import type {
	CalendarLoadResult,
	CalendarService,
} from "../../features/calendar/calendar-service";
import type {
	CalendarBatchMutationResult,
	CalendarMutation,
	CalendarMutationResult,
} from "../../features/calendar/domain";
import type { CalendarScenarioId } from "../../features/calendar/fixtures";

/** Production calendar adapter. Account identity is resolved only in Bun. */
export class ElectrobunCalendarService implements CalendarService {
	async load(_scenario?: CalendarScenarioId): Promise<CalendarLoadResult> {
		const { clientApi } = await import("../../rpc");
		const result = await clientApi.loadCalendar();
		return {
			events: result.events,
			timeZone: result.timeZone,
			scenario: "normal",
			revision: result.revision,
		};
	}

	async mutate(mutation: CalendarMutation): Promise<CalendarMutationResult> {
		const { clientApi } = await import("../../rpc");
		return clientApi.mutateCalendar(mutation);
	}

	async mutateBatch(
		batchId: string,
		mutations: readonly CalendarMutation[],
		expectedRevision?: number,
	): Promise<CalendarBatchMutationResult> {
		const { clientApi } = await import("../../rpc");
		return clientApi.mutateCalendarBatch({ batchId, mutations, expectedRevision });
	}
}
