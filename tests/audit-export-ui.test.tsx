import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AuditExportControl,
	auditExportStatusMessage,
	recentCompleteFiveMinuteStart,
	type AuditExportService,
} from "../src/views/client/features/audit-export/public";

describe("audit export UI", () => {
	test("defaults to a redacted export and never renders audit content or a path", () => {
		const service: AuditExportService = {
			async exportFiveMinutes() {
				throw new Error("not invoked while rendering");
			},
		};
		const markup = renderToStaticMarkup(
			<AuditExportControl service={service} nowMs={() => 600_000} />,
		);
		expect(markup).toContain("最近五分钟审计包");
		expect(markup).toContain("默认隐藏可见文本与网址");
		expect(markup).toContain("episode slice");
		expect(markup).toContain("timeline slice");
		expect(markup).toContain("包含可解密的文本内容");
		expect(markup).toContain("选择文件夹并导出");
		expect(markup).toContain('type="checkbox"');
		expect(markup).not.toContain("checked");
		expect(markup).not.toContain("/Users/");
		expect(markup).not.toContain("rawObservations");
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
