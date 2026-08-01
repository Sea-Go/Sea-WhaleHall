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

	test("keeps long Chinese labels and unknown activity values visible", async () => {
		const { controller, render } = setup();
		await controller.load();
		const markup = render();
		expect(markup).toContain(
			"设计与原型工具（个人作品集信息架构与交互验证）",
		);
		expect(markup).toContain("未归类应用");
		expect(markup).toContain("数据不足");
	});

	test("period controls expose tabs and a roving keyboard stop", async () => {
		const { controller, render } = setup();
		await controller.load();
		const markup = render();
		expect(markup).toContain('role="tablist"');
		expect(markup).toContain('role="tab"');
		expect(markup).toContain('aria-selected="true"');
		expect(markup).toContain('tabindex="-1"');
		expect(markup).toContain('aria-label="上一周期"');
		expect(markup).toContain('aria-label="下一周期"');
	});

	test("renders empty, error, offline, and period unavailable copy", async () => {
		for (const [mode, expected] of [
			["empty", "这一周期还没有形成成长报告"],
			["error", "这份报告暂时没有加载出来"],
			["offline", "无法读取最新成长报告"],
			["period-unavailable", "暂时无法查看这份报告"],
		] as const) {
			const { controller, render } = setup(mode);
			await controller.load();
			expect(render()).toContain(expected);
		}
	});

	test("renders the loading state before a deferred response", () => {
		const service = new MockReportService({ latencyMs: 10_000 });
		const controller = new ReportController(service, () => "2026-07-29");
		void controller.load();
		const markup = renderToStaticMarkup(
			<ReportsPage controller={controller} />,
		);
		expect(markup).toContain("正在加载报告");
		expect(markup).toContain("正在整理7月27日 — 8月2日的成长记录");
	});

	test("daily, weekly, and monthly reports keep the same report layout", async () => {
		const { controller, render } = setup();
		for (const period of ["day", "week", "month"] as const) {
			await controller.switchPeriod(period);
			const markup = render();
			expect(markup).toContain("本阶段总结");
			expect(markup).toContain("report-layout");
			expect(markup).toContain(`report-tab-${period}`);
		}
	});
});
