import { Temporal } from "temporal-polyfill";

export type ReportPeriod = "day" | "week" | "month";

export interface ReportRange {
	startDate: string;
	endDateExclusive: string;
	anchorDate: string;
	label: string;
	contextLabel: string;
}

export interface ReportSummary {
	title: string;
	narrative: string;
	highlight: string;
}

export interface CompletionMetric {
	completedCount: number | null;
	plannedCount: number | null;
	ratePercent: number | null;
	definition: string;
}

export interface TimeComparison {
	plannedMinutes: number | null;
	actualMinutes: number | null;
	definition: string;
}

export type TimeAllocationCategory =
	| "planning"
	| "building"
	| "learning"
	| "communication"
	| "recovery"
	| "unknown";

export interface TimeAllocation {
	id: string;
	label: string;
	category: TimeAllocationCategory;
	minutes: number | null;
	sharePercent: number | null;
}

export interface TrendPoint {
	key: string;
	label: string;
	completedCount: number | null;
	plannedCount: number | null;
	actualMinutes: number | null;
}

export interface MilestoneResult {
	id: string;
	title: string;
	sourcePlanTitle: string;
	completedDate: string;
}

export interface ActivityInvestment {
	id: string;
	label: string;
	categoryLabel: string;
	minutes: number | null;
}

export type InsightTone = "positive" | "watch" | "opportunity";

export interface Insight {
	id: string;
	tone: InsightTone;
	title: string;
	description: string;
	evidence: string;
	action: string;
}

export type DataConfidence = "high" | "medium" | "low";

export interface DataQuality {
	kind: "complete" | "partial";
	observedFrom: string;
	observedThrough: string;
	observedDays: number;
	totalDays: number;
	confidence: DataConfidence;
	missingSources: readonly string[];
	note: string;
}

export interface GrowthReport {
	id: string;
	period: ReportPeriod;
	range: ReportRange;
	summary: ReportSummary;
	completion: CompletionMetric;
	timeComparison: TimeComparison;
	trend: readonly TrendPoint[];
	allocations: readonly TimeAllocation[];
	milestones: readonly MilestoneResult[];
	activities: readonly ActivityInvestment[];
	insights: readonly Insight[];
	nextSuggestions: readonly string[];
	dataQuality: DataQuality;
	generatedAt: string;
}

export class ReportDomainError extends Error {
	constructor(
		public readonly code:
			| "invalid-count"
			| "invalid-rate"
			| "invalid-minutes"
			| "invalid-data-quality"
			| "invalid-range",
		message: string,
	) {
		super(message);
		this.name = "ReportDomainError";
	}
}

const weekdayLabels = ["一", "二", "三", "四", "五", "六", "日"];

function monthEnd(date: Temporal.PlainDate): Temporal.PlainDate {
	return date.with({ day: 1 }).add({ months: 1 }).subtract({ days: 1 });
}

export function reportRangeFor(
	period: ReportPeriod,
	anchorDate: string,
): ReportRange {
	const anchor = Temporal.PlainDate.from(anchorDate);
	if (period === "day") {
		return {
			startDate: anchor.toString(),
			endDateExclusive: anchor.add({ days: 1 }).toString(),
			anchorDate: anchor.toString(),
			label: `${anchor.year}年${anchor.month}月${anchor.day}日`,
			contextLabel: `周${weekdayLabels[anchor.dayOfWeek - 1]}`,
		};
	}
	if (period === "week") {
		const start = anchor.subtract({ days: anchor.dayOfWeek - 1 });
		const end = start.add({ days: 7 });
		const last = end.subtract({ days: 1 });
		return {
			startDate: start.toString(),
			endDateExclusive: end.toString(),
			anchorDate: anchor.toString(),
			label:
				start.month === last.month
					? `${start.month}月${start.day}日 — ${last.day}日`
					: `${start.month}月${start.day}日 — ${last.month}月${last.day}日`,
			contextLabel: "周一至周日",
		};
	}
	const start = anchor.with({ day: 1 });
	return {
		startDate: start.toString(),
		endDateExclusive: start.add({ months: 1 }).toString(),
		anchorDate: anchor.toString(),
		label: `${start.year}年${start.month}月`,
		contextLabel: `${start.month}月1日 — ${monthEnd(start).month}月${monthEnd(start).day}日`,
	};
}

export function moveReportAnchor(
	period: ReportPeriod,
	anchorDate: string,
	offset: number,
): string {
	const anchor = Temporal.PlainDate.from(anchorDate);
	if (period === "day") return anchor.add({ days: offset }).toString();
	if (period === "week") return anchor.add({ weeks: offset }).toString();
	return anchor.add({ months: offset }).toString();
}

export function canMoveToNextReport(
	period: ReportPeriod,
	anchorDate: string,
	today: string,
): boolean {
	const next = reportRangeFor(period, moveReportAnchor(period, anchorDate, 1));
	return Temporal.PlainDate.compare(
		Temporal.PlainDate.from(next.startDate),
		Temporal.PlainDate.from(today),
	) <= 0;
}

export function completionMetric(
	completedCount: number | null,
	plannedCount: number | null,
	definition: string,
): CompletionMetric {
	for (const value of [completedCount, plannedCount]) {
		if (value !== null && (!Number.isInteger(value) || value < 0)) {
			throw new ReportDomainError(
				"invalid-count",
				"完成指标必须是非负整数或未知值。",
			);
		}
	}
	const ratePercent =
		completedCount === null || plannedCount === null || plannedCount === 0
			? null
			: Math.round((completedCount / plannedCount) * 100);
	return { completedCount, plannedCount, ratePercent, definition };
}

export function assertValidGrowthReport(report: GrowthReport): void {
	const range = report.range;
	if (range.startDate >= range.endDateExclusive) {
		throw new ReportDomainError("invalid-range", "报告时间范围无效。");
	}
	if (
		report.completion.ratePercent !== null &&
		(!Number.isInteger(report.completion.ratePercent) ||
			report.completion.ratePercent < 0 ||
			report.completion.ratePercent > 100)
	) {
		throw new ReportDomainError("invalid-rate", "完成率必须是 0–100 的整数。");
	}
	for (const value of [
		report.timeComparison.plannedMinutes,
		report.timeComparison.actualMinutes,
		...report.allocations.map((item) => item.minutes),
		...report.activities.map((item) => item.minutes),
	]) {
		if (value !== null && (!Number.isFinite(value) || value < 0)) {
			throw new ReportDomainError(
				"invalid-minutes",
				"时间指标必须是非负分钟数或未知值。",
			);
		}
	}
	const quality = report.dataQuality;
	if (
		quality.observedDays < 0 ||
		quality.totalDays < 1 ||
		quality.observedDays > quality.totalDays ||
		(quality.kind === "complete" &&
			quality.observedDays !== quality.totalDays)
	) {
		throw new ReportDomainError(
			"invalid-data-quality",
			"报告数据覆盖范围不一致。",
		);
	}
}

export function cloneGrowthReport(report: GrowthReport): GrowthReport {
	return {
		...report,
		range: { ...report.range },
		summary: { ...report.summary },
		completion: { ...report.completion },
		timeComparison: { ...report.timeComparison },
		trend: report.trend.map((item) => ({ ...item })),
		allocations: report.allocations.map((item) => ({ ...item })),
		milestones: report.milestones.map((item) => ({ ...item })),
		activities: report.activities.map((item) => ({ ...item })),
		insights: report.insights.map((item) => ({ ...item })),
		nextSuggestions: [...report.nextSuggestions],
		dataQuality: {
			...report.dataQuality,
			missingSources: [...report.dataQuality.missingSources],
		},
	};
}
