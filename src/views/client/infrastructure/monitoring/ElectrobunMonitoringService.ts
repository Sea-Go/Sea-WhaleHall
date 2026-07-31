import type {
	LocalMonitoringConfigure,
	LocalMonitoringPermissionState,
	LocalMonitoringStatus,
	LocalVaultKeyStatus,
	LocalVaultLegacyMigrationResult,
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
	refreshPermissions(): Promise<LocalMonitoringStatus>;
	setupPermissions(): Promise<LocalMonitoringStatus>;
	vaultStatus(): Promise<LocalVaultKeyStatus>;
	migrateLegacyVault(): Promise<
		| { status: "cancelled"; vault: LocalVaultKeyStatus }
		| { status: "completed"; result: LocalVaultLegacyMigrationResult }
	>;
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
		return monitoringSnapshot(
			await transport.status(),
			await transport.vaultStatus(),
		);
	}

	async configure(
		configuration: MonitoringConfiguration,
	): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		return monitoringSnapshot(
			await transport.configure({
				enabled: configuration.enabled,
				captureContent: configuration.captureContent,
				excludedBundleIds: configuration.excludedAppIds,
			}),
			await transport.vaultStatus(),
		);
	}

	async pause(): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		return monitoringSnapshot(
			await transport.pause(),
			await transport.vaultStatus(),
		);
	}

	async resume(): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		return monitoringSnapshot(
			await transport.resume(),
			await transport.vaultStatus(),
		);
	}

	async requestRequiredPermissions(): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		// This is the sole prompt-capable path and is invoked only from the
		// user's explicit one-time setup action.
		return monitoringSnapshot(
			await transport.setupPermissions(),
			await transport.vaultStatus(),
		);
	}

	async refreshPermissions(): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		// Status refreshes are deliberately read-only. Permission prompts belong to
		// the user's one-time setup in macOS System Settings, never to polling or
		// the "重新检查" action.
		return monitoringSnapshot(
			await transport.refreshPermissions(),
			await transport.vaultStatus(),
		);
	}

	async migrateContentVault(): Promise<MonitoringSnapshot> {
		if (!this.runtimeAvailable()) return unavailableSnapshot();
		const transport = await this.loadTransport();
		await transport.migrateLegacyVault();
		return monitoringSnapshot(
			await transport.status(),
			await transport.vaultStatus(),
		);
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
	vault: LocalVaultKeyStatus = unavailableVaultStatus(),
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
		permissionSetupAvailable: status.permissionSetupAvailable,
		permissionSetupAttempted: status.permissionSetupAttempted,
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
				false,
			),
		],
		contentVault: {
			availability: vault.availability,
			storageMode: vault.storageMode,
			interactiveMigrationAvailable: vault.interactiveMigrationAvailable,
		},
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
		refreshPermissions: () =>
			clientApi.refreshMonitoringPermissions(),
		setupPermissions: () =>
			clientApi.setupMonitoringPermissions(),
		vaultStatus: () => clientApi.getContentVaultStatus(),
		migrateLegacyVault: () => clientApi.migrateLegacyContentVault(),
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
		permissionSetupAvailable: false,
		permissionSetupAttempted: false,
		permissions: [
			permission("accessibility", "unsupported", true),
			permission("screenRecording", "unsupported", true),
			permission("inputMonitoring", "unsupported", true),
			permission("browserAutomation", "unsupported", false),
		],
		contentVault: {
			availability: "unavailable",
			storageMode: null,
			interactiveMigrationAvailable: false,
		},
		excludedAppIds: [],
		lastObservationAtMs: null,
		coverageGaps: ["runtime_unavailable"],
	};
}

function monitoringSnapshot(
	status: LocalMonitoringStatus,
	vault: LocalVaultKeyStatus,
): MonitoringSnapshot {
	return toMonitoringSnapshot(status, vault);
}

function unavailableVaultStatus(): LocalVaultKeyStatus {
	return {
		availability: "unavailable",
		storageMode: null,
		keyVersion: null,
		interactiveMigrationAvailable: false,
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
