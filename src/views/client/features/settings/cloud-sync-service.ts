import type { DataCenterSyncStatus } from "../../../../shared/contracts";

export interface CloudSyncService {
	status(): Promise<DataCenterSyncStatus>;
	setEnabled(enabled: boolean): Promise<DataCenterSyncStatus>;
	refreshConsents(): Promise<DataCenterSyncStatus>;
}
