export const MAX_ACTIVE_GOAL_TEXT_LENGTH = 1_000;

export type ActiveGoalContextV1 = {
	schemaVersion: "active-goal.v1";
	goalId: string;
	planId: string | null;
	version: number;
	text: string;
	activatedAtMs: number;
};

export function cloneActiveGoalContext(
	goal: ActiveGoalContextV1 | null,
): ActiveGoalContextV1 | null {
	return goal ? { ...goal } : null;
}
