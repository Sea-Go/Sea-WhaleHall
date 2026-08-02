import type {
	FiveMinuteAuditCaptureStatus,
	FiveMinuteAuditFileExportRequest,
	FiveMinuteAuditFileExportResult,
	PrivateTrainingWindowExportScope,
	PrivateTrainingWindowExportStatus,
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
	startPrivateTrainingExport(
		scope: PrivateTrainingWindowExportScope,
	): Promise<PrivateTrainingWindowExportStatus>;
	getPrivateTrainingExportStatus(): Promise<PrivateTrainingWindowExportStatus>;
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

export function privateTrainingExportStatusMessage(
	status: PrivateTrainingWindowExportStatus,
): string {
	switch (status.state) {
		case "idle":
			return "尚未开始本地训练导出。";
		case "preparing":
			return "正在查找符合范围的已完成窗口…";
		case "awaiting_confirmation":
			return `已找到 ${status.windowCount} 个窗口，正在等待原生确认。`;
		case "choosing_directory":
			return "已确认，正在等待选择本机文件夹。";
		case "exporting":
			return `正在导出 ${status.completedWindowCount}/${status.windowCount} 个窗口…`;
		case "exported":
			return status.basename
				? `已导出 ${status.basename}（${status.windowCount} 个窗口）。`
				: `已导出 ${status.windowCount} 个窗口。`;
		case "cancelled":
			return "已取消本地训练导出，没有创建完整数据包。";
		case "failed":
			switch (status.failureCode) {
				case "not_ready":
					return "本地时间线尚未就绪，请稍后重试。";
				case "no_committed_windows":
					return "所选范围内还没有已完成的分析窗口。";
				case "too_many_windows":
					return "符合范围的窗口超过单次导出上限，请先导出最近 24 小时。";
				case "invalid_destination":
					return "所选文件夹不符合仅当前用户可写的安全要求。";
				case "invalid_request":
					return "本地训练导出范围无效。";
				default:
					return "本地训练导出失败；界面未接收文本、窗口编号或完整路径。";
			}
	}
}
