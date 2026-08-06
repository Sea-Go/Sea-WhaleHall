/**
 * Stable names for the two client-owned Mastra Skills used by one sealed
 * activity-window reflection. Keeping the names separate from their on-disk
 * paths lets the Bun prompt and Node Sidecar share the same contract.
 */
export const ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES = [
	"activity-reflection-analysis",
	"activity-reflection-scoring",
] as const;

/** Mastra-generated, local-only meta-tools made available by Agent `skills`. */
export const ACTIVITY_REFLECTION_NATIVE_SKILL_TOOL_NAMES = [
	"skill",
	"skill_read",
	"skill_search",
] as const;
