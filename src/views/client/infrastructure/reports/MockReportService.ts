import { Temporal } from "temporal-polyfill";
import {
	assertValidGrowthReport,
	completionMetric,
	reportRangeFor,
	type ActivityInvestment,
	type DataQuality,
	type GrowthReport,
	type Insight,
	type MilestoneResult,
	type ReportPeriod,
	type TimeAllocation,
	type TrendPoint,
} from "../../features/reports/domain";
import {
	ReportServiceError,
	type ReportLoadResult,
	type ReportService,
} from "../../features/reports/report-service";

export type MockReportMode =
	| "auto"
	| "populated"
	| "partial"
	| "empty"
	| "error"
	| "offline"
	| "period-unavailable";

export interface MockReportServiceOptions {
	latencyMs?: number;
	today?: string;
	mode?: MockReportMode;
}

const periodLabels: Record<ReportPeriod, string> = {
	day: "今天",
	week: "本周",
	month: "本月",
};

const fullTrendValues: Record<
	ReportPeriod,
	ReadonlyArray<readonly [number, number, number]>
> = {
	day: [
		[0, 1, 35],
		[1, 1, 55],
		[1, 1, 70],
		[2, 2, 65],
		[3, 4, 45],
		[4, 5, 15],
	],
	week: [
		[4, 5, 260],
		[7, 8, 310],
		[10, 12, 285],
		[13, 15, 245],
		[16, 18, 280],
		[18, 20, 210],
		[19, 22, 125],
	],
	month: [
		[4, 5, 260],
		[9, 11, 540],
		[14, 17, 620],
		[20, 24, 710],
		[27, 33, 680],
	],
};

function dateLabels(
	period: ReportPeriod,
	rangeStart: string,
	count: number,
): string[] {
	if (period === "day") return ["08时", "10时", "12时", "15时", "18时", "21时"];
	if (period === "week") return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
	const start = Temporal.PlainDate.from(rangeStart);
	return Array.from({ length: count }, (_, index) => {
		const date = start.add({ days: index * 7 });
		return `${date.month}/${date.day}`;
	});
}

export class MockReportService implements ReportService {
	private readonly latencyMs: number;
	private readonly today: string;
	private mode: MockReportMode;

	constructor(options: MockReportServiceOptions = {}) {
		this.latencyMs = options.latencyMs ?? 110;
		this.today = options.today ?? "2026-07-29";
		this.mode = options.mode ?? "auto";
	}

	setMode(mode: MockReportMode): void {
		this.mode = mode;
	}

	async load(
		period: ReportPeriod,
		anchorDate: string,
	): Promise<ReportLoadResult> {
		await this.wait();
		const range = reportRangeFor(period, anchorDate);
		const mode = this.resolveMode(period, range.startDate, range.endDateExclusive);
		if (mode === "offline") {
			throw new ReportServiceError("offline", "offline");
		}
		if (mode === "error") {
			throw new ReportServiceError("unavailable", "report unavailable");
		}
		if (mode === "period-unavailable") {
			return {
				kind: "period-unavailable",
				period,
				range,
				message: "这一周期尚未开始，因此还没有可生成的报告。",
			};
		}
		if (mode === "empty") {
			return {
				kind: "empty",
				period,
				range,
				message:
					"这一周期没有足够的计划或活动记录。缺失数据保持未知，不会按零计算。",
			};
		}
		const report = this.buildReport(period, anchorDate, mode === "partial");
		assertValidGrowthReport(report);
		return { kind: "data", report };
	}

	private resolveMode(
		period: ReportPeriod,
		startDate: string,
		endDateExclusive: string,
	): Exclude<MockReportMode, "auto"> {
		if (this.mode !== "auto") return this.mode;
		if (startDate > this.today) return "period-unavailable";
		if (endDateExclusive <= "2026-07-20") return "empty";
		const currentRange = reportRangeFor(period, this.today);
		if (
			startDate === currentRange.startDate &&
			(period === "week" || period === "month")
		) {
			return "partial";
		}
		return "populated";
	}

	private buildReport(
		period: ReportPeriod,
		anchorDate: string,
		partial: boolean,
	): GrowthReport {
		const range = reportRangeFor(period, anchorDate);
		const source = fullTrendValues[period];
		const labels = dateLabels(period, range.startDate, source.length);
		const knownCount = partial
			? period === "week"
				? 3
				: Math.max(2, source.length - 2)
			: source.length;
		const trend: TrendPoint[] = source.map((values, index) => ({
			key: `${period}-${index}`,
			label: labels[index] ?? `第 ${index + 1} 段`,
			completedCount: !partial || index < knownCount ? values[0] : null,
			plannedCount: !partial || index < knownCount ? values[1] : null,
			actualMinutes: !partial || index < knownCount ? values[2] : null,
		}));
		const totals =
			period === "day"
				? { completed: 4, planned: 5, plannedMinutes: 300, actualMinutes: 285 }
				: period === "week"
					? {
							completed: partial ? 10 : 19,
							planned: partial ? 12 : 22,
							plannedMinutes: partial ? 840 : 1_320,
							actualMinutes: partial ? 835 : 1_510,
						}
					: {
							completed: partial ? 20 : 27,
							planned: partial ? 24 : 33,
							plannedMinutes: partial ? 2_400 : 3_960,
							actualMinutes: partial ? 2_210 : 4_090,
						};
		const quality = this.buildQuality(period, range.startDate, range.endDateExclusive, partial);
		return {
			id: `report-${period}-${range.startDate}`,
			period,
			range,
			summary: {
				title:
					period === "day"
						? "核心任务按计划推进，晚间还有收尾空间"
						: period === "week"
							? "作品集推进最稳定，计划节奏正在形成"
							: "阶段成果持续累积，深度投入比上月更集中",
				narrative:
					`${periodLabels[period]}最重要的进展来自连续的专注时段。` +
					(partial
						? "当前报告只覆盖已采集日期，后续结果仍保持未知。"
						: "完整记录显示，拆小任务后完成节奏更稳定。"),
				highlight:
					period === "day"
						? "完成作品集首页结构"
						: period === "week"
							? "连续 3 天完成核心任务"
							: "完成 2 个阶段里程碑",
			},
			completion: completionMetric(
				totals.completed,
				totals.planned,
				"完成率 = 已确认完成的计划任务数 ÷ 本周期已到期的计划任务数，四舍五入到整数。",
			),
			timeComparison: {
				plannedMinutes: totals.plannedMinutes,
				actualMinutes: totals.actualMinutes,
				definition:
					"计划时间来自已确认日程；实际投入来自本地活动与专注记录。缺失时不会按 0 分钟处理。",
			},
			trend,
			allocations: this.allocations(partial),
			milestones: this.milestones(period),
			activities: this.activities(partial),
			insights: this.insights(partial),
			nextSuggestions: [
				"继续把最重要的任务安排在晚间第一个完整时段",
				"为作品集复盘预留 30 分钟，不把检查留到截止日",
				"若连续两天实际投入低于计划，主动缩小本周范围",
			],
			dataQuality: quality,
			generatedAt: `${this.today}T08:00:00Z`,
		};
	}

	private buildQuality(
		period: ReportPeriod,
		startDate: string,
		endDateExclusive: string,
		partial: boolean,
	): DataQuality {
		const totalDays = Number(
			Temporal.PlainDate.from(startDate)
				.until(Temporal.PlainDate.from(endDateExclusive), {
					largestUnit: "day",
				})
				.total({ unit: "day" }),
		);
		const observedDays = partial
			? Math.min(
					totalDays,
					period === "week" ? 3 : period === "month" ? 20 : 1,
				)
			: totalDays;
		return {
			kind: partial ? "partial" : "complete",
			observedFrom: startDate,
			observedThrough: Temporal.PlainDate.from(startDate)
				.add({ days: Math.max(0, observedDays - 1) })
				.toString(),
			observedDays,
			totalDays,
			confidence: partial ? "medium" : "high",
			missingSources: partial ? ["部分活动记录", "未来日期"] : [],
			note: partial
				? `当前覆盖 ${observedDays}/${totalDays} 天；未采集与未来日期不会计为零。`
				: `已覆盖本周期全部 ${totalDays} 天。`,
		};
	}

	private allocations(partial: boolean): TimeAllocation[] {
		return [
			{
				id: "allocation-building",
				label: "作品与项目",
				category: "building",
				minutes: 420,
				sharePercent: 50,
			},
			{
				id: "allocation-planning",
				label: "规划与复盘",
				category: "planning",
				minutes: 160,
				sharePercent: 19,
			},
			{
				id: "allocation-learning",
				label: "学习研究",
				category: "learning",
				minutes: 145,
				sharePercent: 17,
			},
			{
				id: "allocation-recovery",
				label: "恢复与休息",
				category: "recovery",
				minutes: 110,
				sharePercent: 13,
			},
			{
				id: "allocation-unknown",
				label: "未归类活动",
				category: "unknown",
				minutes: partial ? null : 15,
				sharePercent: partial ? null : 1,
			},
		];
	}

	private milestones(period: ReportPeriod): MilestoneResult[] {
		if (period === "day") {
			return [
				{
					id: "milestone-wireframe",
					title: "作品集首页结构确认",
					sourcePlanTitle: "个人作品集",
					completedDate: this.today,
				},
			];
		}
		return [
			{
				id: "milestone-calendar",
				title: "日历核心交互完成",
				sourcePlanTitle: "WhaleHall 客户端",
				completedDate: "2026-07-28",
			},
			{
				id: "milestone-portfolio",
				title: "作品集信息架构确认",
				sourcePlanTitle: "个人作品集",
				completedDate: "2026-07-26",
			},
		];
	}

	private activities(partial: boolean): ActivityInvestment[] {
		return [
			{
				id: "activity-editor",
				label: "代码编辑器",
				categoryLabel: "项目推进",
				minutes: 315,
			},
			{
				id: "activity-design",
				label: "设计与原型工具（个人作品集信息架构与交互验证）",
				categoryLabel: "作品制作",
				minutes: 190,
			},
			{
				id: "activity-browser",
				label: "浏览器研究",
				categoryLabel: "学习研究",
				minutes: 145,
			},
			{
				id: "activity-unclassified",
				label: "未归类应用",
				categoryLabel: "数据待确认",
				minutes: partial ? null : 35,
			},
		];
	}

	private insights(partial: boolean): Insight[] {
		return [
			{
				id: "insight-consistency",
				tone: "positive",
				title: "连续投入比单次冲刺更有效",
				description: "最近三个已采集日都有核心任务完成记录。",
				evidence: "3 个连续观察日；每天至少完成 2 项计划任务。",
				action: "下周继续保护同一时段，先维持节奏。",
			},
			{
				id: "insight-gap",
				tone: partial ? "watch" : "opportunity",
				title: partial ? "部分活动记录仍缺失" : "复盘时间可以再提前",
				description: partial
					? "当前结论只基于已采集日期，不能代表整个周期。"
					: "两次复盘都发生在任务结束后较晚的时段。",
				evidence: partial
					? "数据覆盖范围和可信度已在报告顶部标明。"
					: "平均延后约 40 分钟，按半小时粒度表达。",
				action: partial
					? "先补齐数据，再比较完整周期趋势。"
					: "把复盘直接接在核心任务之后。",
			},
		];
	}

	private async wait(): Promise<void> {
		if (this.latencyMs <= 0) return;
		await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
	}
}
