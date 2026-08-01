import {
	ArrowUpRight,
	Award,
	CalendarCheck2,
	CheckCircle2,
	Clock3,
	Info,
	Lightbulb,
	ListChecks,
	ShieldCheck,
	Sparkles,
	Target,
	TrendingUp,
} from "lucide-react";
import { Temporal } from "temporal-polyfill";
import type {
	GrowthReport,
	InsightTone,
} from "./domain";
import {
	AllocationChart,
	CompletionTrendChart,
	PlannedActualChart,
} from "./ReportCharts";
import { formatCount, formatMinutes, formatRate } from "./report-format";

const confidenceLabels = {
	high: "高可信度",
	medium: "中等可信度",
	low: "低可信度",
} as const;

const insightIcons: Record<InsightTone, typeof Lightbulb> = {
	positive: TrendingUp,
	watch: Info,
	opportunity: Lightbulb,
};

function formatDate(date: string): string {
	const parsed = Temporal.PlainDate.from(date);
	return `${parsed.month}月${parsed.day}日`;
}

function MetricDefinition({
	label,
	definition,
}: {
	label: string;
	definition: string;
}) {
	return (
		<button
			type="button"
			className="report-definition"
			aria-label={`${label}口径：${definition}`}
			title={definition}
		>
			<Info size={13} aria-hidden="true" />
		</button>
	);
}

export function ReportLayout({
	report,
	showOfflineNotice = false,
}: {
	report: GrowthReport;
	showOfflineNotice?: boolean;
}) {
	const comparisonGap =
		report.timeComparison.plannedMinutes === null ||
		report.timeComparison.actualMinutes === null
			? null
			: report.timeComparison.actualMinutes -
				report.timeComparison.plannedMinutes;
	return (
		<div className="report-layout">
			{showOfflineNotice ? (
				<div className="report-quality-banner report-quality-banner--offline" role="status">
					<Info size={17} aria-hidden="true" />
					<div>
						<strong>正在查看上次缓存的报告</strong>
						<span>当前离线，页面中的数据可能不是最新结果。</span>
					</div>
				</div>
			) : null}
			{report.dataQuality.kind === "partial" ? (
				<section className="report-quality-banner" aria-label="数据质量">
					<ShieldCheck size={17} aria-hidden="true" />
					<div>
						<strong>
							部分数据 · {confidenceLabels[report.dataQuality.confidence]}
						</strong>
						<span>
							{formatDate(report.dataQuality.observedFrom)}–{formatDate(
								report.dataQuality.observedThrough,
							)}
							。{report.dataQuality.note}
						</span>
					</div>
				</section>
			) : null}

			<section className="report-summary" aria-labelledby="report-summary-title">
				<div>
					<p>本阶段总结</p>
					<h2 id="report-summary-title">{report.summary.title}</h2>
					<span>{report.summary.narrative}</span>
				</div>
				<div className="report-summary__highlight">
					<Award size={18} aria-hidden="true" />
					<span>最重要成果</span>
					<strong>{report.summary.highlight}</strong>
				</div>
			</section>

			<section className="report-metrics" aria-label="核心指标">
				<article>
					<div>
						<span>计划完成率</span>
						<MetricDefinition
							label="计划完成率"
							definition={report.completion.definition}
						/>
					</div>
					<strong>{formatRate(report.completion.ratePercent)}</strong>
					<small>
						{formatCount(report.completion.completedCount)}完成 /{" "}
						{formatCount(report.completion.plannedCount)}到期
					</small>
				</article>
				<article>
					<div>
						<span>实际投入</span>
						<MetricDefinition
							label="实际投入"
							definition={report.timeComparison.definition}
						/>
					</div>
					<strong>{formatMinutes(report.timeComparison.actualMinutes)}</strong>
					<small>来自本地活动与专注记录</small>
				</article>
				<article>
					<div>
						<span>相对计划</span>
						<MetricDefinition
							label="相对计划"
							definition="实际投入减去计划时间，按分钟计算，不换算为效率分数。"
						/>
					</div>
					<strong>
						{comparisonGap === null
							? "数据不足"
							: comparisonGap === 0
								? "与计划一致"
								: `${comparisonGap > 0 ? "+" : "−"}${formatMinutes(
										Math.abs(comparisonGap),
									)}`}
					</strong>
					<small>计划时间 {formatMinutes(report.timeComparison.plannedMinutes)}</small>
				</article>
			</section>

			<div className="report-grid">
				<section className="report-card report-card--trend">
					<ReportCardHeading
						icon={<TrendingUp size={17} />}
						eyebrow="完成节奏"
						title="计划完成趋势"
						description="对比到期任务与已完成任务；缺失点不会被连成零值。"
					/>
					<CompletionTrendChart trend={report.trend} />
				</section>

				<section className="report-card report-card--comparison">
					<ReportCardHeading
						icon={<Clock3 size={17} />}
						eyebrow="时间投入"
						title="计划时间与实际投入"
						description="只比较可观测记录，不生成效率评分。"
					/>
					<PlannedActualChart comparison={report.timeComparison} />
				</section>

				<section className="report-card">
					<ReportCardHeading
						icon={<Target size={17} />}
						eyebrow="时间去向"
						title="时间分布"
						description="按个人目标活动分类；未知记录保持未归类。"
					/>
					<AllocationChart allocations={report.allocations} />
				</section>

				<section className="report-card">
					<ReportCardHeading
						icon={<CalendarCheck2 size={17} />}
						eyebrow="阶段成果"
						title="完成的里程碑"
						description="只列出本周期已确认完成的里程碑。"
					/>
					{report.milestones.length === 0 ? (
						<div className="report-module-empty">本周期没有完成的里程碑。</div>
					) : (
						<ul className="report-milestones">
							{report.milestones.map((milestone) => (
								<li key={milestone.id}>
									<CheckCircle2 size={16} aria-hidden="true" />
									<div>
										<strong>{milestone.title}</strong>
										<span>{milestone.sourcePlanTitle}</span>
									</div>
									<time dateTime={milestone.completedDate}>
										{formatDate(milestone.completedDate)}
									</time>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className="report-card">
					<ReportCardHeading
						icon={<ListChecks size={17} />}
						eyebrow="活动排行"
						title="应用与活动投入"
						description="仅显示聚合类别，不暴露窗口标题或输入内容。"
					/>
					<ol className="report-activity-list">
						{report.activities.map((activity, index) => (
							<li key={activity.id}>
								<span>{String(index + 1).padStart(2, "0")}</span>
								<div>
									<strong>{activity.label}</strong>
									<small>{activity.categoryLabel}</small>
								</div>
								<b>{formatMinutes(activity.minutes)}</b>
							</li>
						))}
					</ol>
				</section>

				<section className="report-card report-card--insights">
					<ReportCardHeading
						icon={<Sparkles size={17} />}
						eyebrow="成长洞察"
						title="从记录中发现"
						description="洞察同时给出证据与可执行动作，不做性格判断。"
					/>
					<div className="report-insights">
						{report.insights.map((insight) => {
							const Icon = insightIcons[insight.tone];
							return (
								<article
									key={insight.id}
									className={`report-insight report-insight--${insight.tone}`}
								>
									<Icon size={16} aria-hidden="true" />
									<div>
										<strong>{insight.title}</strong>
										<p>{insight.description}</p>
										<small>{insight.evidence}</small>
										<span>
											<ArrowUpRight size={13} aria-hidden="true" />
											{insight.action}
										</span>
									</div>
								</article>
							);
						})}
					</div>
				</section>

				<section className="report-card report-card--next">
					<ReportCardHeading
						icon={<Lightbulb size={17} />}
						eyebrow="下一阶段建议"
						title="接下来值得做什么"
						description="建议基于本报告的可观测结果，可由你决定是否采纳。"
					/>
					<ol>
						{report.nextSuggestions.map((suggestion, index) => (
							<li key={suggestion}>
								<span>{index + 1}</span>
								<strong>{suggestion}</strong>
							</li>
						))}
					</ol>
				</section>
			</div>
		</div>
	);
}

function ReportCardHeading({
	icon,
	eyebrow,
	title,
	description,
}: {
	icon: React.ReactNode;
	eyebrow: string;
	title: string;
	description: string;
}) {
	return (
		<header className="report-card__heading">
			<div aria-hidden="true">{icon}</div>
			<span>{eyebrow}</span>
			<h3>{title}</h3>
			<p>{description}</p>
		</header>
	);
}
