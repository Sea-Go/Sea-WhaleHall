import type {
	PlanningCalendarEventProjection,
	PlanningCalendarMutationProjection,
} from "../shared/planning";

export type DurableCalendarPostCommitStage =
	| "projection"
	| "outbox-flush"
	| "execution-reconciliation";

export type DurableCalendarMutationResult<TProjection> =
	| { committed: false; error: unknown }
	| { committed: true; projection: TProjection | null };

export interface DurableCalendarMutationOptions<TCommit, TProjection> {
	/** Must resolve only after the native calendar transaction is durable. */
	commit(): Promise<TCommit>;
	project(commit: TCommit): TProjection;
	followUps: ReadonlyArray<{
		stage: Exclude<DurableCalendarPostCommitStage, "projection">;
		run(): Promise<void>;
	}>;
	onDeferredFailure(
		stage: DurableCalendarPostCommitStage,
		error: unknown,
	): void;
}

/**
 * Keeps the durable commit boundary distinct from fallible projection and
 * notification work. Once `commit` resolves, no later failure may tell the
 * renderer that the persisted mutation was rejected. The native outbox keeps
 * failed notifications retryable so receivers can reload the authoritative
 * calendar snapshot.
 */
export async function runDurableCalendarMutation<TCommit, TProjection>(
	options: DurableCalendarMutationOptions<TCommit, TProjection>,
): Promise<DurableCalendarMutationResult<TProjection>> {
	let commit: TCommit;
	try {
		commit = await options.commit();
	} catch (error) {
		return { committed: false, error };
	}

	let projection: TProjection | null = null;
	try {
		projection = options.project(commit);
	} catch (error) {
		reportDeferredFailure(options, "projection", error);
	}

	for (const followUp of options.followUps) {
		try {
			await followUp.run();
		} catch (error) {
			reportDeferredFailure(options, followUp.stage, error);
		}
	}

	return { committed: true, projection };
}

/**
 * Prefer the native post-commit versions, while retaining optimistic upserts
 * if a committed result cannot be projected completely. A pending outbox
 * invalidation will replace these fallbacks on the next authoritative load.
 */
export function calendarEventsAfterDurableCommit(
	mutations: readonly PlanningCalendarMutationProjection[],
	projection: readonly PlanningCalendarEventProjection[] | null,
): PlanningCalendarEventProjection[] {
	const projectedById = new Map(
		(projection ?? []).map((event) => [event.id, event]),
	);
	return mutations.flatMap((mutation) => {
		if (mutation.kind === "delete" || mutation.after === null) return [];
		return [projectedById.get(mutation.eventId) ?? mutation.after];
	});
}

function reportDeferredFailure<TCommit, TProjection>(
	options: DurableCalendarMutationOptions<TCommit, TProjection>,
	stage: DurableCalendarPostCommitStage,
	error: unknown,
): void {
	try {
		options.onDeferredFailure(stage, error);
	} catch {
		// Observability must not cross the durable commit boundary either.
	}
}
