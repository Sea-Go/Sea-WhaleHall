import type { PlanningCalendarMutationProjection } from "../shared/planning";

/**
 * Renderer edits to model events are locked by default. The sole exception is
 * an unlock-only write: every event field and expected version must be
 * unchanged except userLocked true -> false. This keeps renderer writes in the
 * user actor path and prevents them from impersonating model auto-adjustment.
 */
export function isExplicitRendererPlanUnlock(
	mutation: PlanningCalendarMutationProjection,
): boolean {
	const { before, after } = mutation;
	if (
		mutation.kind !== "update" ||
		!before ||
		!after ||
		before.kind !== "plan" ||
		before.scheduleOrigin !== "model" ||
		!before.userLocked ||
		after.userLocked ||
		mutation.expectedVersion !== before.version
	) {
		return false;
	}
	return JSON.stringify({ ...before, userLocked: false }) === JSON.stringify(after);
}

export function shouldForceRendererPlanLock(
	mutation: PlanningCalendarMutationProjection,
): boolean {
	return (
		mutation.kind === "update" &&
		mutation.before?.kind === "plan" &&
		mutation.before.scheduleOrigin === "model" &&
		!isExplicitRendererPlanUnlock(mutation)
	);
}
