export const MONITORING_PERMISSION_IDS = [
	"accessibility",
	"screenRecording",
	"inputMonitoring",
	"browserAutomation",
] as const;

export type MonitoringPermissionId = (typeof MONITORING_PERMISSION_IDS)[number];

/**
 * The full local-content setup. Input Monitoring remains in the status
 * protocol for compatibility, but keyboard and pointer activity is covered by
 * Accessibility and must not trigger a separate consent request. Browser
 * Automation is optional enrichment and must not block readiness either.
 */
export const MONITORING_SETUP_PERMISSION_IDS = [
	"accessibility",
	"screenRecording",
] as const satisfies readonly MonitoringPermissionId[];

export type MonitoringPermissionState =
	| "granted"
	| "unknown"
	| "notDetermined"
	| "denied"
	| "unavailable";

export interface MonitoringPermissionStatus {
	id: MonitoringPermissionId;
	state: MonitoringPermissionState;
	required: boolean;
	detail: string | null;
}

export type ContentVaultAvailability =
	| "available"
	| "migration_required"
	| "unavailable";

export type ContentVaultStorageMode =
	| "data_protection_keychain"
	| "local_login_keychain"
	| "legacy_development_keychain"
	| "custom";

export interface ContentVaultStatus {
	availability: ContentVaultAvailability;
	storageMode: ContentVaultStorageMode | null;
	interactiveMigrationAvailable: boolean;
}

export type MonitoringPermissionCheckState =
	| "unchecked"
	| "checking"
	| "current"
	| "failed";

export type MonitoringRunState =
	| "starting"
	| "running"
	| "paused"
	| "degraded"
	| "disabled"
	| "unavailable";

export interface MonitoringSnapshot {
	schemaVersion: "monitoring-status.v2";
	state: MonitoringRunState;
	enabled: boolean;
	captureContent: boolean;
	paused: boolean;
	observerConnected: boolean;
	permissions: MonitoringPermissionStatus[];
	contentVault: ContentVaultStatus;
	permissionCheckState: MonitoringPermissionCheckState;
	permissionsCheckedAtMs: number | null;
	permissionSetupAvailable: boolean;
	permissionSetupAttempted: boolean;
	excludedAppIds: string[];
	lastObservationAtMs: number | null;
	tapReady: boolean;
	lastCallbackAtMs: number | null;
	lastBucketAtMs: number | null;
	coverageGaps: string[];
}

export interface MonitoringConfiguration {
	enabled: boolean;
	captureContent: boolean;
	excludedAppIds: string[];
}

export type MonitoringSetupPhase =
	| "not_started"
	| "needs_permissions"
	| "needs_legacy_vault_migration"
	| "ready"
	| "unavailable";

export type MonitoringSetupStatus = {
	phase: MonitoringSetupPhase;
	permissions: MonitoringPermissionStatus[];
	missingPermissions: MonitoringPermissionStatus[];
	firstMissingPermission: MonitoringPermissionStatus | null;
	grantedPermissionCount: number;
	requiredPermissionCount: number;
};

export function monitoringSetupStatus(
	snapshot: MonitoringSnapshot,
): MonitoringSetupStatus {
	const permissionById = new Map(
		snapshot.permissions.map((permission) => [permission.id, permission]),
	);
	const permissions = MONITORING_SETUP_PERMISSION_IDS.map(
		(id): MonitoringPermissionStatus =>
			permissionById.get(id) ?? {
				id,
				state: "unknown",
				required: true,
				detail: null,
			},
	);
	const missingPermissions = permissions.filter(
		(permission) => permission.state !== "granted",
	);
	const common = {
		permissions,
		missingPermissions,
		firstMissingPermission: missingPermissions[0] ?? null,
		grantedPermissionCount: permissions.length - missingPermissions.length,
		requiredPermissionCount: permissions.length,
	};

	if (snapshot.state === "unavailable") {
		return { phase: "unavailable", ...common };
	}
	if (
		snapshot.contentVault.availability === "unavailable" ||
		(snapshot.contentVault.availability === "migration_required" &&
			!snapshot.contentVault.interactiveMigrationAvailable)
	) {
		return { phase: "unavailable", ...common };
	}
	if (!snapshot.enabled || !snapshot.captureContent) {
		return { phase: "not_started", ...common };
	}
	if (missingPermissions.length > 0) {
		return { phase: "needs_permissions", ...common };
	}
	if (snapshot.contentVault.availability === "available") {
		return { phase: "ready", ...common };
	}
	if (snapshot.contentVault.availability === "migration_required") {
		return {
			phase: "needs_legacy_vault_migration",
			...common,
		};
	}
	return { phase: "unavailable", ...common };
}

export function monitoringStatusLabel(snapshot: MonitoringSnapshot): string {
	switch (snapshot.state) {
		case "starting":
			return "正在启动观察器";
		case "running":
			return "观察中";
		case "paused":
			return "已暂停";
		case "degraded":
			if (snapshot.coverageGaps.includes("observer_disconnected")) {
				return "观察器正在重新连接";
			}
			if (snapshot.coverageGaps.includes("accessibility_permission_revoked")) {
				return "辅助功能权限已关闭";
			}
			if (snapshot.coverageGaps.includes("input_sensor_unavailable")) {
				return "键鼠活动传感器恢复中";
			}
			return "权限不完整";
		case "disabled":
			return "未启用";
		case "unavailable":
			return "观察器不可用";
	}
}

export function missingRequiredPermissions(
	snapshot: MonitoringSnapshot,
): MonitoringPermissionStatus[] {
	return snapshot.permissions.filter(
		(permission) =>
			permission.required &&
			(permission.state === "denied" || permission.state === "notDetermined"),
	);
}

export function isMonitoringSnapshot(
	value: unknown,
): value is MonitoringSnapshot {
	if (!isRecord(value) || value.schemaVersion !== "monitoring-status.v2") {
		return false;
	}
	if (
		!isRunState(value.state) ||
		typeof value.enabled !== "boolean" ||
		typeof value.captureContent !== "boolean" ||
		typeof value.paused !== "boolean" ||
		typeof value.observerConnected !== "boolean" ||
		!Array.isArray(value.permissions) ||
		!isContentVaultStatus(value.contentVault) ||
		!isPermissionCheckState(value.permissionCheckState) ||
		typeof value.permissionSetupAvailable !== "boolean" ||
		typeof value.permissionSetupAttempted !== "boolean" ||
		(value.permissionSetupAttempted && !value.permissionSetupAvailable) ||
		!(
			value.permissionsCheckedAtMs === null ||
			(typeof value.permissionsCheckedAtMs === "number" &&
				Number.isSafeInteger(value.permissionsCheckedAtMs) &&
				value.permissionsCheckedAtMs >= 0)
		) ||
		(value.permissionCheckState === "unchecked" &&
			value.permissionsCheckedAtMs !== null) ||
		(value.permissionCheckState === "current" &&
			value.permissionsCheckedAtMs === null) ||
		!Array.isArray(value.excludedAppIds) ||
		!Array.isArray(value.coverageGaps) ||
		typeof value.tapReady !== "boolean" ||
		!isNullableTimestamp(value.lastCallbackAtMs) ||
		!isNullableTimestamp(value.lastBucketAtMs) ||
		!(
			value.lastObservationAtMs === null ||
			(typeof value.lastObservationAtMs === "number" &&
				Number.isFinite(value.lastObservationAtMs) &&
				value.lastObservationAtMs >= 0)
		)
	) {
		return false;
	}
	return (
		value.permissions.every(isPermissionStatus) &&
		value.excludedAppIds.every((item) => typeof item === "string") &&
		value.coverageGaps.every((item) => typeof item === "string")
	);
}

function isNullableTimestamp(value: unknown): boolean {
	return (
		value === null ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
	);
}

function isContentVaultStatus(value: unknown): value is ContentVaultStatus {
	return (
		isRecord(value) &&
		(value.availability === "available" ||
			value.availability === "migration_required" ||
			value.availability === "unavailable") &&
		(value.storageMode === null ||
			value.storageMode === "data_protection_keychain" ||
			value.storageMode === "local_login_keychain" ||
			value.storageMode === "legacy_development_keychain" ||
			value.storageMode === "custom") &&
		typeof value.interactiveMigrationAvailable === "boolean"
	);
}

function isPermissionStatus(
	value: unknown,
): value is MonitoringPermissionStatus {
	return (
		isRecord(value) &&
		MONITORING_PERMISSION_IDS.includes(value.id as MonitoringPermissionId) &&
		(value.state === "granted" ||
			value.state === "unknown" ||
			value.state === "notDetermined" ||
			value.state === "denied" ||
			value.state === "unavailable") &&
		typeof value.required === "boolean" &&
		(value.detail === null || typeof value.detail === "string")
	);
}

function isPermissionCheckState(
	value: unknown,
): value is MonitoringPermissionCheckState {
	return (
		value === "unchecked" ||
		value === "checking" ||
		value === "current" ||
		value === "failed"
	);
}

function isRunState(value: unknown): value is MonitoringRunState {
	return (
		value === "starting" ||
		value === "running" ||
		value === "paused" ||
		value === "degraded" ||
		value === "disabled" ||
		value === "unavailable"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
