import { describe, expect, test } from "bun:test";
import {
	assertValidGrowthReport,
	canMoveToNextReport,
	completionMetric,
	moveReportAnchor,
	reportRangeFor,
	type GrowthReport,
} from "../src/views/client/features/reports/domain";

describe("report date ranges", () => {
	test("derives daily, Monday-based weekly, and monthly ranges", () => {
		expect(reportRangeFor("day", "2026-07-29")).toMatchObject({
			startDate: "2026-07-29",
			endDateExclusive: "2026-07-30",
			label: "2026年7月29日",
		});
		expect(reportRangeFor("week", "2026-07-29")).toMatchObject({
			startDate: "2026-07-27",
			endDateExclusive: "2026-08-03",
			label: "7月27日 — 8月2日",
		});
		expect(reportRangeFor("month", "2026-07-29")).toMatchObject({
			startDate: "2026-07-01",
			endDateExclusive: "2026-08-01",
			label: "2026年7月",
		});
	});

	test("moves anchors by the selected granularity and blocks future periods", () => {
		expect(moveReportAnchor("day", "2026-07-29", -1)).toBe("2026-07-28");
		expect(moveReportAnchor("week", "2026-07-29", -1)).toBe("2026-07-22");
		expect(moveReportAnchor("month", "2026-07-29", -1)).toBe("2026-06-29");
		expect(canMoveToNextReport("week", "2026-07-22", "2026-07-29")).toBe(
			true,
		);
		expect(canMoveToNextReport("week", "2026-07-29", "2026-07-29")).toBe(
			false,
		);
	});
});

describe("report metric honesty", () => {
	test("does not turn missing counts or an unknown denominator into zero", () => {
		expect(completionMetric(null, 5, "测试口径")).toEqual({
			completedCount: null,
			plannedCount: 5,
			ratePercent: null,
			definition: "测试口径",
		});
		expect(completionMetric(0, null, "测试口径").ratePercent).toBeNull();
		expect(completionMetric(4, 5, "测试口径").ratePercent).toBe(80);
	});

	test("validates partial coverage and permits null measurements", () => {
		const report = minimalReport();
		expect(() => assertValidGrowthReport(report)).not.toThrow();
		expect(() =>
			assertValidGrowthReport({
				...report,
				dataQuality: {
					...report.dataQuality,
					kind: "complete",
				},
			}),
		).toThrow("报告数据覆盖范围不一致");
	});
});

function minimalReport(): GrowthReport {
	return {
		id: "report",
		period: "week",
		range: reportRangeFor("week", "2026-07-29"),
		summary: { title: "总结", narrative: "叙述", highlight: "成果" },
		completion: completionMetric(null, 5, "口径"),
		timeComparison: {
			plannedMinutes: 300,
			actualMinutes: null,
			definition: "时间口径",
		},
		trend: [
			{
				key: "monday",
				label: "周一",
				completedCount: null,
				plannedCount: 2,
				actualMinutes: null,
			},
		],
		allocations: [
			{
				id: "unknown",
				label: "未归类",
				category: "unknown",
				minutes: null,
				sharePercent: null,
			},
		],
		milestones: [],
		activities: [],
		insights: [],
		nextSuggestions: [],
		dataQuality: {
			kind: "partial",
			observedFrom: "2026-07-27",
			observedThrough: "2026-07-29",
			observedDays: 3,
			totalDays: 7,
			confidence: "medium",
			missingSources: ["未来日期"],
			note: "只覆盖三天。",
		},
		generatedAt: "2026-07-29T08:00:00Z",
	};
}
