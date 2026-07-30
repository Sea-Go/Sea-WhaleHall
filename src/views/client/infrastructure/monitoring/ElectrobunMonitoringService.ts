import type {
	LocalMonitoringConfigure,
	LocalMonitoringPermissionState,
	LocalMonitoringStatus,
} from "../../../../shared/contracts";
import type {
	MonitoringConfiguration,
	MonitoringPermissionId,
	MonitoringPermissionState,
	MonitoringService,
	MonitoringSnapshot,
} from "../../features/monitoring/public";

export interface MonitoringTransport {
	status(): Promise<LocalMonitoringStatus>;
	configure(
		configuration: LocalMonitoringConfigure,
	): Promise<LocalMonitoringStatus>;
	pause(): Promise<LocalMonitoringStatus>;
	resume(): Promise<LocalMonitoringStatus>;
	refreshPermissions(prompt: boolean): Promise<LocalMonitoringStatus>;
	openPermissionSettings(
		permission: MonitoringPermissionId,
	): Promise<{ opened: boolean }>;
}

export interface ElectrobunMonitoringServiceOptions {
	loadTransport?: () => Promise<MonitoringTransport>;
	runtimeAvailable?: () => boolean;
}

export class ElectrobunMonitoringService implements MonitoringService {
	private readonly loadTransport: () => Promise<MonitoringTransport>;
	private readonly runtimeAvailable: () => boolean;

	constructor(options: ElectrobunMonitoringServiceOptions = {}) {
		this.loadTransport = options.loadTransport ?? loadClientTransport;
		this.runtimeAvailable = options.runtimeAvailable ?? hasElectrobunRuntime;
	}

	async status(): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		return toMonitoringSnapshot(await transport.status());
	}

	async configure(
		configuration: MonitoringConfiguration,
	): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		return toMonitoringSnapshot(
			await transport.configure({
				enabled: configuration.enabled,
				captureContent: configuration.captureContent,
				excludedBundleIds: configuration.excludedAppIds,
			}),
		);
	}

	async pause(): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		return toMonitoringSnapshot(await transport.pause());
	}

	async resume(): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		return toMonitoringSnapshot(await transport.resume());
	}

	async refreshPermissions(): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		return toMonitoringSnapshot(await transport.refreshPermissions(true));
	}

	async openPermissionSettings(
		permission: MonitoringPermissionId,
	): Promise<void> {
		if (!this.runtimeAvailable()) {
			throw new Error("macOS System Settings is unavailable.");
		}
		const transport = await this.loadTransport();
		const result = await transport.openPermissionSettings(permission);
		if (!result.opened) {
			throw new Error("Unable to open macOS System Settings.");
		}
	}
}

export function toMonitoringSnapshot(
	status: LocalMonitoringStatus,
): MonitoringSnapshot {
	const state =
		status.state === "stopped"
			? status.enabled
				? "unavailable"
				: "disabled"
			: status.state;
	const observerConnected =
		status.helperPid !== null &&
		status.bootId !== null &&
		status.state !== "disabled" &&
		status.state !== "stopped";
	const coverageGaps: string[] = status.coverage.filter(
		(level) => level !== "content" && level !== "metadata",
	);
	if (!status.helperPathAvailable) coverageGaps.push("observer_unavailable");
	if (status.lastError !== null) coverageGaps.push("observer_error");

	return {
		schemaVersion: "monitoring-status.v2",
		state,
		enabled: status.enabled,
		captureContent: status.captureContent,
		paused: status.state === "paused",
		observerConnected,
		permissionCheckState: status.permissionCheckState,
		permissionsCheckedAtMs: status.permissionsCheckedAtMs,
		permissions: [
			permission(
				"accessibility",
				status.permissions.accessibility,
				true,
			),
			permission(
				"screenRecording",
				status.permissions.screenRecording,
				status.captureContent,
			),
			permission(
				"inputMonitoring",
				status.permissions.inputMonitoring,
				true,
			),
			permission(
				"browserAutomation",
				status.permissions.automation,
				status.captureContent,
			),
		],
		excludedAppIds: [...status.excludedBundleIds],
		// The native status currently reports its heartbeat, not the time of the
		// last accepted observation. Keep this honest until that field exists.
		lastObservationAtMs: null,
		coverageGaps: [...new Set(coverageGaps)],
	};
}

async function loadClientTransport(): Promise<MonitoringTransport> {
	const { clientApi } = await import("../../rpc");
	return {
		status: () => clientApi.getMonitoringStatus(),
		configure: (configuration) =>
			clientApi.configureMonitoring(configuration),
		pause: () => clientApi.pauseMonitoring(),
		resume: () => clientApi.resumeMonitoring(),
		refreshPermissions: (prompt) =>
			clientApi.refreshMonitoringPermissions(prompt),
		openPermissionSettings: (permission) =>
			clientApi.openMonitoringPermissionSettings(permission),
	};
}

function unavailableSnapshot(): MonitoringSnapshot {
	return {
		schemaVersion: "monitoring-status.v2",
		state: "unavailable",
		enabled: false,
		captureContent: false,
		paused: false,
		observerConnected: false,
		permissionCheckState: "unchecked",
		permissionsCheckedAtMs: null,
		permissions: [
			permission("accessibility", "unsupported", true),
			permission("screenRecording", "unsupported", true),
			permission("inputMonitoring", "unsupported", true),
			permission("browserAutomation", "unsupported", true),
		],
		excludedAppIds: [],
		lastObservationAtMs: null,
		coverageGaps: ["runtime_unavailable"],
	};
}

function permission(
	id: MonitoringPermissionId,
	state: LocalMonitoringPermissionState,
	required: boolean,
) {
	const mapped = permissionState(state);
	return {
		id,
		state: mapped,
		required,
		detail:
			mapped === "denied"
				? "需要在 macOS 系统设置中授权"
				: mapped === "unavailable"
					? "当前系统不支持此权限"
					: null,
	};
}

function permissionState(
	state: LocalMonitoringPermissionState,
): MonitoringPermissionState {
	switch (state) {
		case "unknown":
			return "unknown";
		case "granted":
			return "granted";
		case "denied":
			return "denied";
		case "not_determined":
			return "notDetermined";
		case "unsupported":
			return "unavailable";
	}
}

function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}
