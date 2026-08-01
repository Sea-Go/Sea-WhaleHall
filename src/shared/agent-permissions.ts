export const AGENT_READ_PERMISSION_IDS = [
	"agent.calendar.read",
	"agent.planning.read",
] as const;

export type AgentReadPermission = (typeof AGENT_READ_PERMISSION_IDS)[number];

/**
 * Account identity is intentionally absent. Bun resolves the account from the
 * current authenticated session before reading or mutating these grants.
 */
export interface AgentReadPermissionsSnapshot {
	grants: readonly AgentReadPermission[];
	revision: number;
	updatedAtMs: number | null;
}

export interface SetAgentReadPermissionsRequest {
	enabled: boolean;
	expectedRevision: number;
}

export type AgentReadPermissionsFailureKind =
	| "offline"
	| "service-unavailable"
	| "version-conflict"
	| "unexpected";

export type AgentReadPermissionsRpcResult<T> =
	| { kind: "success"; data: T }
	| {
			kind: "error";
			failure: AgentReadPermissionsFailureKind;
			message: string;
			currentRevision?: number;
	  };

export function hasAgentReadPermission(
	snapshot: AgentReadPermissionsSnapshot,
	permission: AgentReadPermission,
): boolean {
	return snapshot.grants.includes(permission);
}

export function hasAllAgentReadPermissions(
	snapshot: AgentReadPermissionsSnapshot,
): boolean {
	return AGENT_READ_PERMISSION_IDS.every((permission) =>
		hasAgentReadPermission(snapshot, permission),
	);
}

export function hasAnyAgentReadPermission(
	snapshot: AgentReadPermissionsSnapshot,
): boolean {
	return AGENT_READ_PERMISSION_IDS.some((permission) =>
		hasAgentReadPermission(snapshot, permission),
	);
}

export function isAgentReadPermissionsSnapshot(
	value: unknown,
): value is AgentReadPermissionsSnapshot {
	if (!isRecord(value) || !Array.isArray(value.grants)) return false;
	if (
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0 ||
		(value.updatedAtMs !== null &&
			(typeof value.updatedAtMs !== "number" ||
				!Number.isFinite(value.updatedAtMs) ||
				value.updatedAtMs < 0))
	) {
		return false;
	}

	const seen = new Set<AgentReadPermission>();
	for (const permission of value.grants) {
		if (!isAgentReadPermission(permission) || seen.has(permission)) return false;
		seen.add(permission);
	}
	return true;
}

function isAgentReadPermission(value: unknown): value is AgentReadPermission {
	return (
		value === "agent.calendar.read" || value === "agent.planning.read"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
