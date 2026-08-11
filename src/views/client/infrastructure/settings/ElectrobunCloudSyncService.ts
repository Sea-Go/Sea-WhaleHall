import type {
	DataCenterAuthSessionProjection,
	DataCenterSyncStatus,
} from "../../../../shared/contracts";
import type { CloudSyncService } from "../../features/settings/cloud-sync-service";

export interface CloudSyncTransport {
	datacenterSyncStatus(): Promise<{ status: DataCenterSyncStatus }>;
	datacenterSetSyncEnabled(
		enabled: boolean,
	): Promise<{ status: DataCenterSyncStatus }>;
	datacenterRefreshConsents(): Promise<{ status: DataCenterSyncStatus }>;
}

export interface ElectrobunCloudSyncServiceOptions {
	loadTransport?: () => Promise<CloudSyncTransport>;
	runtimeAvailable?: () => boolean;
}

export class ElectrobunCloudSyncService implements CloudSyncService {
	private readonly loadTransport: () => Promise<CloudSyncTransport>;
	private readonly runtimeAvailable: () => boolean;

	constructor(options: ElectrobunCloudSyncServiceOptions = {}) {
		this.loadTransport = options.loadTransport ?? loadClientTransport;
		this.runtimeAvailable = options.runtimeAvailable ?? hasElectrobunRuntime;
	}

	async status(): Promise<DataCenterSyncStatus> {
		if (!this.runtimeAvailable()) return unavailableSyncStatus();
		const transport = await this.loadTransport();
		return (await transport.datacenterSyncStatus()).status;
	}

	async setEnabled(enabled: boolean): Promise<DataCenterSyncStatus> {
		if (!this.runtimeAvailable()) return unavailableSyncStatus();
		const transport = await this.loadTransport();
		return (await transport.datacenterSetSyncEnabled(enabled)).status;
	}

	async refreshConsents(): Promise<DataCenterSyncStatus> {
		if (!this.runtimeAvailable()) return unavailableSyncStatus();
		const transport = await this.loadTransport();
		return (await transport.datacenterRefreshConsents()).status;
	}
}

export function unavailableSyncStatus(): DataCenterSyncStatus {
	return {
		state: "disabled",
		enabled: false,
		signedIn: false,
		agentRegistered: false,
		baseUrl: "",
		lastSyncAtMs: null,
		lastErrorCode: null,
		lastErrorMessage: null,
		pendingEventCount: 0,
		blockedCursor: null,
		blockedReason: null,
		updatedAtMs: 0,
	};
}

export function hasElectrobunRuntime(): boolean {
	return (
		typeof window !== "undefined" &&
		"__electrobun" in window &&
		"__electrobunBunBridge" in window
	);
}

async function loadClientTransport(): Promise<CloudSyncTransport> {
	const { clientApi } = await import("../../rpc");
	return {
		datacenterSyncStatus: () => clientApi.datacenterSyncStatus(),
		datacenterSetSyncEnabled: (enabled: boolean) =>
			clientApi.datacenterSetSyncEnabled(enabled),
		datacenterRefreshConsents: () => clientApi.datacenterRefreshConsents(),
	};
}
