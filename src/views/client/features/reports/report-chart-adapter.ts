import type { TrendPoint } from "./domain";

export interface LineChartCoordinate {
	key: string;
	label: string;
	value: number | null;
	x: number;
	y: number | null;
}

export interface LineChartSeries {
	id: "completed" | "planned";
	label: string;
	points: readonly LineChartCoordinate[];
	pathSegments: readonly string[];
}

export interface CompletionLineChartModel {
	width: number;
	height: number;
	maxValue: number;
	yTicks: readonly number[];
	series: readonly LineChartSeries[];
}

export interface HorizontalBarDatum {
	id: string;
	label: string;
	value: number | null;
	widthPercent: number | null;
}

function niceMaximum(value: number): number {
	if (value <= 5) return 5;
	if (value <= 10) return 10;
	return Math.ceil(value / 5) * 5;
}

function segmentPaths(
	points: readonly LineChartCoordinate[],
): readonly string[] {
	const segments: string[] = [];
	let current: string[] = [];
	for (const point of points) {
		if (point.y === null) {
			if (current.length > 0) segments.push(current.join(" "));
			current = [];
			continue;
		}
		current.push(`${current.length === 0 ? "M" : "L"} ${point.x} ${point.y}`);
	}
	if (current.length > 0) segments.push(current.join(" "));
	return segments;
}

export function trendPointsToLineChart(
	trend: readonly TrendPoint[],
): CompletionLineChartModel {
	const width = 640;
	const height = 220;
	const horizontalPadding = 34;
	const verticalPadding = 22;
	const values = trend.flatMap((point) =>
		[point.completedCount, point.plannedCount].filter(
			(value): value is number => value !== null,
		),
	);
	const maxValue = niceMaximum(Math.max(1, ...values));
	const usableWidth = width - horizontalPadding * 2;
	const usableHeight = height - verticalPadding * 2;
	const xFor = (index: number) =>
		trend.length <= 1
			? width / 2
			: horizontalPadding + (index / (trend.length - 1)) * usableWidth;
	const coordinates = (
		id: LineChartSeries["id"],
		label: string,
		valueFor: (point: TrendPoint) => number | null,
	): LineChartSeries => {
		const points = trend.map<LineChartCoordinate>((point, index) => {
			const value = valueFor(point);
			return {
				key: `${id}-${point.key}`,
				label: point.label,
				value,
				x: xFor(index),
				y:
					value === null
						? null
						: verticalPadding + (1 - value / maxValue) * usableHeight,
			};
		});
		return {
			id,
			label,
			points,
			pathSegments: segmentPaths(points),
		};
	};
	return {
		width,
		height,
		maxValue,
		yTicks: [maxValue, Math.round(maxValue / 2), 0],
		series: [
			coordinates("planned", "计划任务", (point) => point.plannedCount),
			coordinates("completed", "完成任务", (point) => point.completedCount),
		],
	};
}

export function valuesToHorizontalBars(
	items: readonly { id: string; label: string; value: number | null }[],
): readonly HorizontalBarDatum[] {
	const knownValues = items
		.map((item) => item.value)
		.filter((value): value is number => value !== null);
	const maxValue = Math.max(1, ...knownValues);
	return items.map((item) => ({
		...item,
		widthPercent:
			item.value === null ? null : Math.round((item.value / maxValue) * 100),
	}));
}
