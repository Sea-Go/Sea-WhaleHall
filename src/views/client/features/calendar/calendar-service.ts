import type {
	CalendarEvent,
	CalendarBatchMutationResult,
	CalendarMutation,
	CalendarMutationResult,
} from "./domain";
import type { CalendarScenarioId } from "./fixtures";

export type CalendarLoadState = "idle" | "loading" | "ready" | "error" | "offline";

export interface CalendarLoadResult {
	events: readonly CalendarEvent[];
	timeZone: string;
	scenario: CalendarScenarioId;
	revision?: number;
}

export interface CalendarService {
	load(scenario?: CalendarScenarioId): Promise<CalendarLoadResult>;
	mutate(mutation: CalendarMutation): Promise<CalendarMutationResult>;
	mutateBatch(
		batchId: string,
		mutations: readonly CalendarMutation[],
		expectedRevision?: number,
	): Promise<CalendarBatchMutationResult>;
}
