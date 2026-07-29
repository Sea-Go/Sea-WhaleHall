import {
	ArrowLeft,
	ArrowRight,
	BarChart3,
	CloudOff,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
import {
	useEffect,
	useRef,
	useSyncExternalStore,
	type KeyboardEvent,
} from "react";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import { PageHeader } from "../../shared/ui/PageHeader";
import type { ReportController, ReportState } from "./ReportController";
import type { ReportPeriod } from "./domain";
import { ReportLayout } from "./ReportLayout";

const periodOptions: ReadonlyArray<{
	id: ReportPeriod;
	label: string;
}> = [
	{ id: "day", label: "日报" },
	{ id: "week", label: "周报" },
	{ id: "month", label: "月报" },
];

export interface ReportsPageProps {
	controller: ReportController;
}

export function ReportsPage({ controller }: ReportsPageProps) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

	useEffect(() => {
		if (state.status === "idle") void controller.load();
	}, [controller, state.status]);

	function activatePeriod(index: number) {
		const target = periodOptions[index];
		if (!target) return;
		void controller.switchPeriod(target.id);
		window.requestAnimationFrame(() => tabRefs.current[index]?.focus());
	}

	function handlePeriodKeyDown(
		event: KeyboardEvent<HTMLButtonElement>,
		currentIndex: number,
	) {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
			return;
		}
		event.preventDefault();
		const nextIndex =
			event.key === "Home"
				? 0
				: event.key === "End"
					? periodOptions.length - 1
					: event.key === "ArrowRight"
						? (currentIndex + 1) % periodOptions.length
						: (currentIndex - 1 + periodOptions.length) %
							periodOptions.length;
		activatePeriod(nextIndex);
	}

	const visibleReport =
		state.status === "populated" || state.status === "partial"
			? state.report
			: state.status === "offline"
				? state.cachedReport
				: null;

	return (
		<div className="reports-page">
			<PageHeader
				eyebrow="成长回顾"
				title="成长报告"
				description="先看最重要的成果，再理解时间去了哪里，以及下一阶段值得调整什么。"
			/>

			<div className="reports-page__content">
				<section className="report-toolbar" aria-label="报告筛选">
					<div className="report-period-tabs" role="tablist" aria-label="报告类型">
						{periodOptions.map((item, index) => (
							<button
								ref={(element) => {
									tabRefs.current[index] = element;
								}}
								type="button"
								role="tab"
								id={`report-tab-${item.id}`}
								aria-selected={state.period === item.id}
								aria-controls="report-content"
								tabIndex={state.period === item.id ? 0 : -1}
								key={item.id}
								onKeyDown={(event) => handlePeriodKeyDown(event, index)}
								onClick={() => void controller.switchPeriod(item.id)}
							>
								{item.label}
							</button>
						))}
					</div>
					<div className="report-range">
						<IconButton
							label="上一周期"
							icon={<ArrowLeft size={16} />}
							disabled={state.status === "loading"}
							onClick={() => void controller.previous()}
						/>
						<div aria-live="polite">
							<span>{state.range.contextLabel}</span>
							<strong>{state.range.label}</strong>
						</div>
						<IconButton
							label="下一周期"
							icon={<ArrowRight size={16} />}
							disabled={!state.canGoNext || state.status === "loading"}
							onClick={() => void controller.next()}
						/>
					</div>
				</section>

				<div
					id="report-content"
					role="tabpanel"
					aria-labelledby={`report-tab-${state.period}`}
					aria-busy={state.status === "loading"}
				>
					{state.status === "loading" ? <ReportLoading state={state} /> : null}
					{state.status === "empty" ? (
						<ReportFeedback
							icon={<BarChart3 size={22} />}
							eyebrow="暂无数据"
							title="这一周期还没有形成成长报告"
							description={state.message}
						/>
					) : null}
					{state.status === "period-unavailable" ? (
						<ReportFeedback
							icon={<BarChart3 size={22} />}
							eyebrow="周期尚未开始"
							title="暂时无法查看这份报告"
							description={state.message}
							action={
								<Button
									variant="secondary"
									onClick={() => void controller.switchPeriod(state.period)}
								>
									回到当前周期
								</Button>
							}
						/>
					) : null}
					{state.status === "error" ? (
						<ReportFeedback
							tone="error"
							icon={<TriangleAlert size={22} />}
							eyebrow="加载失败"
							title="这份报告暂时没有加载出来"
							description={state.message}
							action={
								<Button
									variant="primary"
									icon={<RefreshCw size={15} />}
									onClick={() => void controller.retry()}
								>
									重试
								</Button>
							}
						/>
					) : null}
					{state.status === "offline" && !visibleReport ? (
						<ReportFeedback
							icon={<CloudOff size={22} />}
							eyebrow="当前离线"
							title="无法读取最新成长报告"
							description={state.message}
							action={
								<Button
									variant="primary"
									icon={<RefreshCw size={15} />}
									onClick={() => void controller.retry()}
								>
									重新连接
								</Button>
							}
						/>
					) : null}
					{visibleReport ? (
						<ReportLayout
							report={visibleReport}
							showOfflineNotice={state.status === "offline"}
						/>
					) : null}
				</div>
			</div>
		</div>
	);
}

function ReportLoading({
	state,
}: {
	state: Extract<ReportState, { status: "loading" }>;
}) {
	return (
		<section className="report-loading" aria-label="正在加载报告">
			<div>
				<span />
				<span />
			</div>
			<div className="report-loading__metrics">
				<span />
				<span />
				<span />
			</div>
			<div className="report-loading__chart" />
			<p>正在整理{state.range.label}的成长记录…</p>
		</section>
	);
}

function ReportFeedback({
	icon,
	eyebrow,
	title,
	description,
	action,
	tone = "neutral",
}: {
	icon: React.ReactNode;
	eyebrow: string;
	title: string;
	description: string;
	action?: React.ReactNode;
	tone?: "neutral" | "error";
}) {
	return (
		<section className={`report-feedback report-feedback--${tone}`} aria-live="polite">
			<div>{icon}</div>
			<p>{eyebrow}</p>
			<h2>{title}</h2>
			<span>{description}</span>
			{action ? <div className="report-feedback__action">{action}</div> : null}
			<small>缺失记录不会被当成零，也不会生成伪精确指标。</small>
		</section>
	);
}
