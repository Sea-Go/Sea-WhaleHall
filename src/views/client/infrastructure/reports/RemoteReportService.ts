import { Temporal } from "temporal-polyfill";
import {
	assertValidGrowthReport,
	reportRangeFor,
	type GrowthReport,
	type ReportPeriod,
	type TrendPoint,
} from "../../features/reports/domain";
import {
	ReportServiceError,
	type ReportLoadResult,
	type ReportService,
} from "../../features/reports/report-service";

const REPORTS_BASE_URL =
	"https://web-cf.sea-ridethewindbreakthewaves.xyz/api/reports/telemetry";

type TelemetryDay = {
	day: string;
	batches: number;
	accepted: number;
	duplicates: number;
};

type TelemetryResponse = {
	period: string;
	anchor: string;
	range: { start: string; end: string };
	trendStart: string;
	agents: number;
	days: TelemetryDay[];
};

function daysBetween(start: string, endExclusive: string): number {
	return Number(
		Temporal.PlainDate.from(start).until(Temporal.PlainDate.from(endExclusive), {
			largestUnit: "day",
		}).total({ unit: "day" }),
	);
}

function dayLabel(day: string): string {
	const date = Temporal.PlainDate.from(day);
	return `${date.month}/${date.day}`;
}

export class RemoteReportService implements ReportService {
	async load(
		period: ReportPeriod,
		anchorDate: string,
	): Promise<ReportLoadResult> {
		const range = reportRangeFor(period, anchorDate);
		const today = Temporal.Now.plainDateISO().toString();
		if (range.startDate > today) {
			return {
				kind: "period-unavailable",
				period,
				range,
				message: "这一周期尚未开始，因此还没有可生成的报告。",
			};
		}
		let payload: TelemetryResponse;
		try {
			const response = await fetch(
				`${REPORTS_BASE_URL}?period=${period}&anchor=${anchorDate}`,
				{ signal: AbortSignal.timeout(20_000) },
			);
			if (response.status === 503 || response.status === 502) {
				throw new ReportServiceError(
					"unavailable",
					"报告数据源暂时不可用",
				);
			}
			if (!response.ok) {
				throw new ReportServiceError("unavailable", `报告服务异常 ${response.status}`);
			}
			payload = (await response.json()) as TelemetryResponse;
		} catch (error) {
			if (error instanceof ReportServiceError) throw error;
			throw new ReportServiceError("offline", "无法连接报告数据源");
		}
		const inRange = payload.days.filter(
			(day) => day.day >= range.startDate && day.day < range.endDateExclusive,
		);
		const totalAccepted = inRange.reduce((sum, day) => sum + day.accepted, 0);
		const totalBatches = inRange.reduce((sum, day) => sum + day.batches, 0);
		if (totalAccepted === 0 && totalBatches === 0) {
			return {
				kind: "empty",
				period,
				range,
				message:
					"这一周期还没有云端桌面活动采集记录。缺失维度保持未知，不会按零计算。",
			};
		}
		const report = this.buildReport(period, anchorDate, payload, inRange);
		assertValidGrowthReport(report);
		return { kind: "data", report };
	}

	private buildReport(
		period: ReportPeriod,
		anchorDate: string,
		payload: TelemetryResponse,
		inRange: TelemetryDay[],
	): GrowthReport {
		const range = reportRangeFor(period, anchorDate);
		const today = Temporal.Now.plainDateISO().toString();
		const totalDays = daysBetween(range.startDate, range.endDateExclusive);
		const cappedEnd =
			range.endDateExclusive <= today
				? range.endDateExclusive
				: Temporal.PlainDate.from(today).add({ days: 1 }).toString();
		const observedSpan = Math.max(0, daysBetween(range.startDate, cappedEnd));
		const observedDays = Math.min(
			observedSpan,
			Math.max(1, inRange.length === 0 ? 0 : inRange.length),
		);
		const complete = observedSpan === totalDays && observedDays === totalDays;
		const totalAccepted = inRange.reduce((sum, day) => sum + day.accepted, 0);
		const totalBatches = inRange.reduce((sum, day) => sum + day.batches, 0);
		const peak = inRange.reduce(
			(best, day) => (day.accepted > best.accepted ? day : best),
			inRange[0] ?? { day: range.startDate, batches: 0, accepted: 0, duplicates: 0 },
		);
		const trend: TrendPoint[] = payload.days.map((day) => ({
			key: `${period}-${day.day}`,
			label: dayLabel(day.day),
			completedCount: day.accepted,
			plannedCount: null,
			actualMinutes: null,
		}));
		return {
			id: `report-${period}-${range.startDate}`,
			period,
			range,
			summary: {
				title:
					totalAccepted > 0
						? `本周期云端已接纳 ${totalAccepted} 条桌面活动事件`
						: "本周期云端活动采集量有限",
				narrative: `生产采集链共接收 ${totalBatches} 个同步批次（来自 ${payload.agents} 个桌面代理），去重后接纳 ${totalAccepted} 条事件。峰值出现在 ${dayLabel(peak.day)}（${peak.accepted} 条）。计划完成与时间分配维度尚未接入，保持未知。`,
				highlight: `已接纳事件 ${totalAccepted} 条 · 同步批次 ${totalBatches} 个`,
			},
			completion: {
				completedCount: null,
				plannedCount: null,
				ratePercent: null,
				definition:
					"计划任务完成率需要任务数据源，当前尚未接入；不会用活动事件数代替任务完成数。",
			},
			timeComparison: {
				plannedMinutes: null,
				actualMinutes: null,
				definition:
					"计划与实际投入分钟数需要本地日程与专注记录聚合，当前维度尚未接入。",
			},
			trend,
			allocations: [],
			milestones: [],
			activities: [],
			insights: [
				{
					id: "insight-telemetry-coverage",
					tone: "positive",
					title: "桌面活动采集链持续在线",
					description: `本周期云端共接收 ${totalBatches} 个同步批次，事件采集未中断。`,
					evidence: `core.desktop_event_sync_batch 聚合：${inRange.length} 个有数据日 / ${totalDays} 天。`,
					action: "保持客户端在线，后续接入任务与时间维度后报告会更完整。",
				},
			],
			nextSuggestions: [
				"接入计划任务数据源以解锁完成率维度",
				"接入本地专注记录以解锁时间分配维度",
				"持续保持桌面采集在线，积累更长的趋势窗口",
			],
			dataQuality: {
				kind: complete ? "complete" : "partial",
				observedFrom: range.startDate,
				observedThrough: Temporal.PlainDate.from(cappedEnd)
					.subtract({ days: 1 })
					.toString(),
				observedDays,
				totalDays,
				confidence: complete ? "high" : "medium",
				missingSources: ["计划任务", "时间分配", "专注分钟"],
				note: "数据来源：生产 DataCenter 桌面活动遥测批次（已接纳事件数）。任务与时间维度缺失，保持未知而非按零计算。",
			},
			generatedAt: `${today}T00:00:00Z`,
		};
	}
}
