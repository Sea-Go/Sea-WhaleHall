import type { AppUpdateSnapshot } from "../../../../shared/app-update";

export type AppUpdateStatusListener = (snapshot: AppUpdateSnapshot) => void;

/** Client-owned port. Electrobun details stay in the infrastructure adapter. */
export interface AppUpdateService {
	getStatus(): Promise<AppUpdateSnapshot>;
	check(): Promise<AppUpdateSnapshot>;
	download(): Promise<AppUpdateSnapshot>;
	installAndRestart(): Promise<AppUpdateSnapshot>;
	subscribe(listener: AppUpdateStatusListener): () => void;
}
