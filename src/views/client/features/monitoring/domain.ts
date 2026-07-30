export const MONITORING_PERMISSION_IDS = [
	"accessibility",
	"screenRecording",
	"inputMonitoring",
	"browserAutomation",
] as const;

export type MonitoringPermissionId =
	(typeof MONITORING_PERMISSION_IDS)[number];

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
	excludedAppIds: string[];
	lastObservationAtMs: number | null;
	coverageGaps: string[];
}

export interface MonitoringConfiguration {
	enabled: boolean;
	captureContent: boolean;
	excludedAppIds: string[];
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
		(permission) => permission.required && permission.state !== "granted",
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
		!Array.isArray(value.excludedAppIds) ||
		!Array.isArray(value.coverageGaps) ||
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

function isPermissionStatus(value: unknown): value is MonitoringPermissionStatus {
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
