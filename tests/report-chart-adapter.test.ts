import { describe, expect, test } from "bun:test";
import {
	trendPointsToLineChart,
	valuesToHorizontalBars,
} from "../src/views/client/features/reports/report-chart-adapter";
import type { TrendPoint } from "../src/views/client/features/reports/domain";

describe("report chart adapter", () => {
	test("keeps unknown trend points as gaps instead of drawing them as zero", () => {
		const trend: TrendPoint[] = [
			{
				key: "one",
				label: "一个很长的中文时间标签",
				completedCount: 2,
				plannedCount: 3,
				actualMinutes: 60,
			},
			{
				key: "two",
				label: "数据缺失",
				completedCount: null,
				plannedCount: null,
				actualMinutes: null,
			},
			{
				key: "three",
				label: "恢复记录",
				completedCount: 4,
				plannedCount: 5,
				actualMinutes: 90,
			},
		];
		const chart = trendPointsToLineChart(trend);
		const completed = chart.series.find((series) => series.id === "completed");
		expect(completed?.points[1]?.y).toBeNull();
		expect(completed?.pathSegments).toHaveLength(2);
		expect(completed?.pathSegments.join(" ")).not.toContain("null");
		expect(completed?.points[0]?.label).toBe("一个很长的中文时间标签");
	});

	test("scales horizontal bars while preserving unknown values", () => {
		const bars = valuesToHorizontalBars([
			{ id: "a", label: "已知", value: 120 },
			{ id: "b", label: "较少", value: 60 },
			{ id: "c", label: "未知", value: null },
		]);
		expect(bars.map((bar) => bar.widthPercent)).toEqual([100, 50, null]);
	});
});
