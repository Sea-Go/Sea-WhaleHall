import type {
	TimeAllocation,
	TimeComparison,
	TrendPoint,
} from "./domain";
import {
	trendPointsToLineChart,
	valuesToHorizontalBars,
} from "./report-chart-adapter";
import { formatMinutes } from "./report-format";

export function CompletionTrendChart({
	trend,
}: {
	trend: readonly TrendPoint[];
}) {
	const model = trendPointsToLineChart(trend);
	const knownPoints = trend.filter(
		(point) =>
			point.completedCount !== null || point.plannedCount !== null,
	);
	if (knownPoints.length === 0) {
		return (
			<div className="report-chart-empty" role="status">
				<strong>暂无趋势数据</strong>
				<span>这一周期还没有可绘制的完成记录。</span>
			</div>
		);
	}
	const summary = `完成趋势覆盖 ${knownPoints.length} 个时间点；缺失时间点不会连接成连续趋势。`;
	return (
		<figure className="report-line-chart" aria-labelledby="completion-chart-title">
			<figcaption id="completion-chart-title">
				<span>{summary}</span>
				<div className="report-chart-legend" aria-label="图例">
					<span className="report-chart-legend__planned">计划任务</span>
					<span className="report-chart-legend__completed">完成任务</span>
				</div>
			</figcaption>
			<svg
				viewBox={`0 0 ${model.width} ${model.height}`}
				role="img"
				aria-label={summary}
				preserveAspectRatio="none"
			>
				{model.yTicks.map((tick, index) => {
					const y = 22 + (index / Math.max(1, model.yTicks.length - 1)) * 176;
					return (
						<g key={tick}>
							<line
								className="report-line-chart__grid"
								x1="34"
								x2="606"
								y1={y}
								y2={y}
							/>
							<text x="2" y={y + 4}>
								{tick}
							</text>
						</g>
					);
				})}
				{model.series.map((series) => (
					<g
						key={series.id}
						className={`report-line-chart__series report-line-chart__series--${series.id}`}
					>
						{series.pathSegments.map((path, index) => (
							<path key={`${series.id}-${index}`} d={path} />
						))}
						{series.points.map((point) =>
							point.y === null || point.value === null ? null : (
								<circle
									key={point.key}
									cx={point.x}
									cy={point.y}
									r="4"
									tabIndex={0}
									aria-label={`${point.label}，${series.label} ${point.value} 项`}
								>
									<title>{`${point.label} · ${series.label} ${point.value} 项`}</title>
								</circle>
							),
						)}
					</g>
				))}
				{trend.map((point, index) => {
					const x =
						trend.length <= 1
							? model.width / 2
							: 34 + (index / (trend.length - 1)) * 572;
					return (
						<text
							className="report-line-chart__x-label"
							key={point.key}
							x={x}
							y="216"
							textAnchor="middle"
						>
							{point.label}
						</text>
					);
				})}
			</svg>
			<details className="report-data-table">
				<summary>查看趋势数据表</summary>
				<table>
					<thead>
						<tr>
							<th scope="col">时间</th>
							<th scope="col">计划</th>
							<th scope="col">完成</th>
						</tr>
					</thead>
					<tbody>
						{trend.map((point) => (
							<tr key={point.key}>
								<th scope="row">{point.label}</th>
								<td>{point.plannedCount ?? "数据不足"}</td>
								<td>{point.completedCount ?? "数据不足"}</td>
							</tr>
						))}
					</tbody>
				</table>
			</details>
		</figure>
	);
}

export function PlannedActualChart({
	comparison,
}: {
	comparison: TimeComparison;
}) {
	const bars = valuesToHorizontalBars([
		{ id: "planned", label: "计划时间", value: comparison.plannedMinutes },
		{ id: "actual", label: "实际投入", value: comparison.actualMinutes },
	]);
	return (
		<div className="report-comparison-chart">
			{bars.map((bar) => (
				<div key={bar.id} className={`report-comparison-chart__row is-${bar.id}`}>
					<div>
						<span>{bar.label}</span>
						<strong>{formatMinutes(bar.value)}</strong>
					</div>
					<div
						className="report-horizontal-track"
						title={
							bar.value === null
								? `${bar.label}：数据不足`
								: `${bar.label}：${formatMinutes(bar.value)}`
						}
					>
						{bar.widthPercent === null ? (
							<span className="report-horizontal-track__unknown">
								数据不足
							</span>
						) : (
							<i style={{ width: `${bar.widthPercent}%` }} />
						)}
					</div>
				</div>
			))}
			<p>{comparison.definition}</p>
		</div>
	);
}

export function AllocationChart({
	allocations,
}: {
	allocations: readonly TimeAllocation[];
}) {
	const bars = valuesToHorizontalBars(
		allocations.map((item) => ({
			id: item.id,
			label: item.label,
			value: item.minutes,
		})),
	);
	return (
		<div className="report-allocation-chart">
			{bars.map((bar) => {
				const source = allocations.find((item) => item.id === bar.id);
				return (
					<div key={bar.id} className="report-allocation-chart__row">
						<div>
							<span>{bar.label}</span>
							<strong>
								{source?.sharePercent === null || source?.sharePercent === undefined
									? "占比未知"
									: `${source.sharePercent}%`}
							</strong>
						</div>
						<div
							className={`report-horizontal-track report-horizontal-track--${source?.category ?? "unknown"}`}
							title={`${bar.label}：${formatMinutes(bar.value)}`}
						>
							{bar.widthPercent === null ? (
								<span className="report-horizontal-track__unknown">
									数据不足
								</span>
							) : (
								<i style={{ width: `${bar.widthPercent}%` }} />
							)}
						</div>
						<small>{formatMinutes(bar.value)}</small>
					</div>
				);
			})}
		</div>
	);
}
