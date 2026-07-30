import type {
	MonitoringConfiguration,
	MonitoringSnapshot,
} from "./domain";

export interface MonitoringService {
	status(): Promise<MonitoringSnapshot>;
	configure(
		configuration: MonitoringConfiguration,
	): Promise<MonitoringSnapshot>;
	pause(): Promise<MonitoringSnapshot>;
	resume(): Promise<MonitoringSnapshot>;
	refreshPermissions(): Promise<MonitoringSnapshot>;
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
