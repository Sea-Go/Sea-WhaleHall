import type {
	MonitoringConfiguration,
	MonitoringPermissionId,
	MonitoringSnapshot,
} from "./domain";

export interface MonitoringService {
	status(): Promise<MonitoringSnapshot>;
	configure(
		configuration: MonitoringConfiguration,
	): Promise<MonitoringSnapshot>;
	pause(): Promise<MonitoringSnapshot>;
	resume(): Promise<MonitoringSnapshot>;
	/**
	 * The only UI-authorized path that may ask macOS for the three required
	 * monitoring permissions. It must never be called by status polling.
	 */
	requestRequiredPermissions(): Promise<MonitoringSnapshot>;
	/** Silent preflight only; this must never display a system prompt. */
	refreshPermissions(): Promise<MonitoringSnapshot>;
	migrateContentVault(): Promise<MonitoringSnapshot>;
	openPermissionSettings(permission: MonitoringPermissionId): Promise<void>;
}

export function monitoringFailureMessage(reason: unknown): string {
	if (
		typeof reason === "object" &&
		reason !== null &&
		"message" in reason &&
		typeof reason.message === "string" &&
		reason.message.trim()
	) {
		return "暂时无法连接本机观察器，请稍后重试。";
	}
	return "暂时无法读取观察状态。";
}
