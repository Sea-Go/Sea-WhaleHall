import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AuditExportControl,
	type AuditExportService,
	auditExportStatusMessage,
	privateTrainingExportStatusMessage,
	recentCompleteFiveMinuteStart,
} from "../src/views/client/features/audit-export/public";

describe("audit export UI", () => {
	test("defaults to a redacted export and never renders audit content or a path", () => {
		const service: AuditExportService = {
			async exportFiveMinutes() {
				throw new Error("not invoked while rendering");
			},
			async startCapture() {
				throw new Error("not invoked while rendering");
			},
			async getCaptureStatus() {
				return null;
			},
			async cancelCapture() {
				return null;
			},
			async startPrivateTrainingExport() {
				throw new Error("not invoked while rendering");
			},
			async getPrivateTrainingExportStatus() {
				return idlePrivateTrainingStatus();
			},
		};
		const markup = renderToStaticMarkup(
			<AuditExportControl service={service} nowMs={() => 600_000} />,
		);
		expect(markup).toContain("五分钟审计包");
		expect(markup).toContain("默认隐藏可见文本与网址");
		expect(markup).toContain("episode slice");
		expect(markup).toContain("timeline slice");
		expect(markup).toContain("包含可解密的文本内容");
		expect(markup).toContain("开始采满五分钟");
		expect(markup).toContain("取消");
		expect(markup).toContain("刷新");
		expect(markup).toContain("导出本次范围");
		expect(markup).toContain("导出过去五分钟");
		expect(markup).toContain("导出用于本地训练");
		expect(markup).toContain("最近一个已完成窗口");
		expect(markup).toContain("最近 24 小时已完成窗口");
		expect(markup).toContain("全部仍保留的已完成窗口");
		expect(markup).toContain("只需一次原生确认");
		expect(markup).toContain("生产分析仍只来自按 64 条/5 分钟或边界自然封窗");
		expect(markup).toContain("audit-only 确定性投影");
		expect(markup).toContain("不会写回生产时间线");
		expect(markup).toContain("不会调用模型服务");
		expect(markup).toContain('type="checkbox"');
		expect(markup).not.toContain("checked");
		expect(markup).not.toContain("/Users/");
		expect(markup).not.toContain("rawObservations");
	});

	test("maps private training progress without exposing ids or absolute paths", () => {
		const message = privateTrainingExportStatusMessage({
			state: "exporting",
			jobId: "training_export_internal",
			scope: "all_committed",
			windowCount: 12,
			completedWindowCount: 5,
			basename: null,
			failureCode: null,
			updatedAtMs: 1,
		});
		expect(message).toContain("5/12");
		expect(message).not.toContain("training_export_internal");
		expect(message).not.toContain("/Users/");
	});

	test("maps success, cancellation, and failures to bounded UI messages", () => {
		expect(
			auditExportStatusMessage({
				status: "exported",
				basename: "whalehall-audit-safe.json",
			}),
		).toBe("已导出 whalehall-audit-safe.json");
		expect(
			auditExportStatusMessage({ status: "cancelled", basename: null }),
		).toContain("已取消");
		for (const status of ["invalid_range", "not_ready", "failed"] as const) {
			const message = auditExportStatusMessage({
				status,
				basename: null,
			});
			expect(message.length).toBeGreaterThan(0);
			expect(message).not.toContain("/");
		}
	});

	test("aligns the exact five-minute range to complete input activity buckets", () => {
		expect(recentCompleteFiveMinuteStart(603_499)).toBe(300_000);
		expect(recentCompleteFiveMinuteStart(604_999)).toBe(300_000);
		expect(recentCompleteFiveMinuteStart(605_000)).toBe(305_000);
		expect(() => recentCompleteFiveMinuteStart(-1)).toThrow();
	});
});

function idlePrivateTrainingStatus() {
	return {
		state: "idle" as const,
		jobId: null,
		scope: null,
		windowCount: 0,
		completedWindowCount: 0,
		basename: null,
		failureCode: null,
		updatedAtMs: null,
	};
}
