import type {
	FiveMinuteAuditCaptureStatus,
	FiveMinuteAuditFileExportRequest,
	FiveMinuteAuditFileExportResult,
} from "../../../../shared/contracts";

export interface AuditExportService {
	exportFiveMinutes(
		request: FiveMinuteAuditFileExportRequest,
	): Promise<FiveMinuteAuditFileExportResult>;
	startCapture(): Promise<FiveMinuteAuditCaptureStatus>;
	getCaptureStatus(): Promise<FiveMinuteAuditCaptureStatus | null>;
	cancelCapture(
		captureId: string,
	): Promise<FiveMinuteAuditCaptureStatus | null>;
}

export function auditExportStatusMessage(
	result: FiveMinuteAuditFileExportResult,
): string {
	switch (result.status) {
		case "exported":
			return result.basename
				? `已导出 ${result.basename}`
				: "审计包已导出。";
		case "cancelled":
			return "已取消导出，没有创建文件。";
		case "invalid_range":
			return "导出时间范围无效，请校准系统时间后重试。";
		case "not_ready":
			return "本地时间线尚未就绪，请稍后重试。";
		case "failed":
			return "审计包导出失败，没有向界面返回内容或文件路径。";
	}
}
