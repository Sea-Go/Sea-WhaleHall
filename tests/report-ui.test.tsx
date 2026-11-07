import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportController } from "../src/views/client/features/reports/ReportController";
import { ReportsPage } from "../src/views/client/features/reports/ReportsPage";
import {
	MockReportService,
	type MockReportMode,
} from "../src/views/client/infrastructure/reports/MockReportService";

function setup(mode: MockReportMode = "auto") {
	const service = new MockReportService({ latencyMs: 0, mode });
	const controller = new ReportController(service, () => "2026-07-29");
	const render = () =>
		renderToStaticMarkup(<ReportsPage controller={controller} />);
	return { service, controller, render };
}

describe("growth report UI", () => {
	test("uses one layout for an honest partial weekly report", async () => {
		const { controller, render } = setup();
		await controller.load();
		const markup = render();
		expect(markup).toContain("本阶段总结");
		expect(markup).toContain("核心指标");
		expect(markup).toContain("计划完成趋势");
		expect(markup).toContain("计划时间与实际投入");
		expect(markup).toContain("时间分布");
		expect(markup).toContain("完成的里程碑");
		expect(markup).toContain("应用与活动投入");
		expect(markup).toContain("成长洞察");
		expect(markup).toContain("下一阶段建议");
		expect(markup).toContain("部分数据 · 中等可信度");
		expect(markup).toContain("未来日期不会计为零");
	});

	test("renders accessible charts, tooltips, and a data-table alternative", async () => {
		const { controller, render } = setup("populated");
		await controller.load();
		const markup = render();
		expect(markup).toContain('role="img"');
		expect(markup).toContain("查看趋势数据表");
		expect(markup).toContain("<title>");
		expect(markup).toContain('tabindex="0"');
		expect(markup).toContain("计划完成率口径");
	});





});
