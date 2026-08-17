import {
	AlertTriangle,
	Archive,
	Bot,
	CalendarClock,
	Check,
	CheckCircle2,
	CircleDashed,
	Clock3,
	History,
	ListTodo,
	LoaderCircle,
	LockKeyhole,
	MessageSquareText,
	Pause,
	Play,
	RefreshCw,
	RotateCcw,
	Send,
	Sparkles,
	Target,
	UserRound,
	WifiOff,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { Temporal } from "temporal-polyfill";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { PageHeader } from "../../shared/ui/PageHeader";
import {
	isPlanRevisionConfirmable,
	type PlanAdjustmentView,
	type PlanEstimateConfidence,
	type PlanningBusyWindow,
	type PlanningObservationView,
	type PlanningTaskSchedule,
	type PlanningTaskView,
	type PlanStatus,
	type PlanSummaryView,
	type PlanTaskStatus,
	type PlanType,
	type PlanView,
	type ProposedScheduleItem,
	planTaskProgress,
} from "./domain";
import type {
	PlanningContent,
	PlanningController,
	PlanningOperation,
	PlanningState,
} from "./PlanningController";

/** Kept while the app-level draft-calendar preview is retired. */
export interface PlanningSchedulePreviewProps {
	proposals: readonly ProposedScheduleItem[];
	busyWindows: readonly PlanningBusyWindow[];
	timeZone: string;
	initialDate: string;
	onChange: (
		proposalId: string,
		patch: Pick<ProposedScheduleItem, "title" | "start" | "end">,
	) => void;
	onEdit: (proposalId: string) => void;
}

export interface PlanningPageProps {
	controller: PlanningController;
	onNotify?: (message: string) => void;
	onOpenCalendar?: () => void;
	renderSchedulePreview?: (props: PlanningSchedulePreviewProps) => ReactNode;
}

const typeLabels: Record<PlanType, string> = {
	"short-term": "短期计划",
	"long-term": "长期计划",
	fuzzy: "模糊计划",
};

const statusLabels: Record<PlanStatus, string> = {
	draft: "对话完善中",
	"awaiting-confirmation": "等待确认",
	active: "执行中",
	paused: "已暂停",
	completed: "已完成",
	archived: "已归档",
};

const confidenceLabels: Record<PlanEstimateConfidence, string> = {
	high: "高置信度",
	medium: "中等置信度",
	low: "低置信度 · 仍需验证",
};

const weekdayLabels = [
	"",
	"周一",
	"周二",
	"周三",
	"周四",
	"周五",
	"周六",
	"周日",
] as const;

const operationLabels: Record<Exclude<PlanningOperation, "create">, string> = {
	"send-message": "正在保存消息并分析",
	"confirm-revision": "正在确认计划与未来 7 天安排",
	"set-task-status": "正在记录任务状态并重新估算",
	"confirm-observation": "正在确认观测归因",
	pause: "正在暂停计划",
	resume: "正在恢复计划",
	complete: "正在确认计划完成",
	archive: "正在归档计划",
	"undo-adjustment": "正在撤销上次自动调整",
	"retry-analysis": "正在重新请求计划分析服务",
};

function formatDate(date: string | null): string {
	if (!date) return "等待模型估算";
	const parsed = Temporal.PlainDate.from(date);
	return `${parsed.year}年${parsed.month}月${parsed.day}日`;
}

function formatInstant(instant: string, timeZone: string): string {
	const value = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
	return `${value.month}月${value.day}日 ${value
		.toPlainTime()
		.toString({ smallestUnit: "minute" })}`;
}

function formatEvidenceThrough(value: string, timeZone: string): string {
	return /^\d{4}-\d{2}-\d{2}$/.test(value)
		? formatDate(value)
		: formatInstant(value, timeZone);
}

function formatSession(schedule: PlanningTaskSchedule): string {
	const start = Temporal.Instant.from(schedule.start).toZonedDateTimeISO(
		schedule.timeZone,
	);
	const end = Temporal.Instant.from(schedule.end).toZonedDateTimeISO(
		schedule.timeZone,
	);
	return `${start.month}月${start.day}日 ${start
		.toPlainTime()
		.toString({ smallestUnit: "minute" })}–${end
		.toPlainTime()
		.toString({ smallestUnit: "minute" })}`;
}

function formatMinutes(minutes: number): string {
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.round((minutes / 60) * 10) / 10;
	return `${hours} 小时`;
}

function contentFromState(state: PlanningState): PlanningContent | null {
	if ("content" in state && state.content !== null) return state.content;
	if (
		(state.status === "loading" ||
			state.status === "offline" ||
			state.status === "error") &&
		state.cached
	) {
		return state.cached;
	}
	return null;
}

function stateBanner(state: PlanningState, onRetry: () => void): ReactNode {
	if (state.status === "updating") {
		return (
			<InlineNotice icon={<LoaderCircle className="planning-spin" size={17} />}>
				{operationLabels[state.operation]}。完成前请勿重复提交。
			</InlineNotice>
		);
	}
	if (state.status === "loading" && state.cached) {
		return (
			<InlineNotice icon={<LoaderCircle className="planning-spin" size={17} />}>
				正在载入计划的最新版本，当前内容仅供查看。
			</InlineNotice>
		);
	}
	if (state.status === "model-unavailable" && state.content) {
		return (
			<InlineNotice tone="warning" icon={<Bot size={17} />}>
				<span>{state.message}</span>
				{state.retryable ? (
					<Button size="small" onClick={onRetry}>
						重试分析
					</Button>
				) : null}
			</InlineNotice>
		);
	}
	if (state.status === "stale") {
		return (
			<InlineNotice tone="warning" icon={<RefreshCw size={17} />}>
				<span>{state.message}</span>
				<Button size="small" onClick={onRetry}>
					载入最新版本
				</Button>
			</InlineNotice>
		);
	}
	if (state.status === "offline" && state.cached) {
		return (
			<InlineNotice tone="warning" icon={<WifiOff size={17} />}>
				<span>{state.message}</span>
				{state.retryable ? (
					<Button size="small" onClick={onRetry}>
						重新连接
					</Button>
				) : null}
			</InlineNotice>
		);
	}
	if (state.status === "error" && state.cached) {
		return (
			<InlineNotice tone="error" icon={<AlertTriangle size={17} />}>
				<span>{state.message}</span>
				{state.retryable ? (
					<Button size="small" onClick={onRetry}>
						重试
					</Button>
				) : null}
			</InlineNotice>
		);
	}
	return null;
}

export function PlanningPage({
	controller,
	onOpenCalendar,
}: PlanningPageProps) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);

	useEffect(() => {
		void controller.initialize();
		return () => controller.dispose();
	}, [controller]);

	const content = contentFromState(state);
	const busy =
		state.status === "updating" ||
		state.status === "loading" ||
		state.status === "stale" ||
		state.status === "offline" ||
		state.status === "error" ||
		state.status === "model-unavailable";

	return (
		<section className="planning-page" aria-label="动态计划">
			<PageHeader
				eyebrow="LOCAL DYNAMIC PLANNING"
				title="动态计划"
				description="持续对话、执行与观测；每次只精排未来 7 天，并随真实进度更新预计完成日。"
				action={
					content &&
					state.status !== "create" &&
					state.status !== "creating" ? (
						<Button
							variant="primary"
							icon={<Sparkles size={16} />}
							onClick={() => controller.beginCreate()}
							disabled={busy}
						>
							新建计划
						</Button>
					) : undefined
				}
			/>

			<div className="planning-page__body">
				{state.status === "idle" ||
				(state.status === "loading" && !state.cached) ? (
					<LoadingPanel />
				) : null}

				{state.status === "empty" ||
				state.status === "create" ||
				state.status === "creating" ? (
					<CreatePlanPanel state={state} controller={controller} />
				) : null}

				{state.status === "model-unavailable" && !state.content ? (
					<FailurePanel
						icon={<Bot size={24} />}
						title="计划分析服务暂时不可用"
						message={state.message}
						retryable={state.retryable}
						onRetry={() => void controller.retry()}
					/>
				) : null}

				{state.status === "offline" && !state.cached ? (
					<FailurePanel
						icon={<WifiOff size={24} />}
						title="本地计划服务离线"
						message={state.message}
						retryable={state.retryable}
						retryLabel="重新连接"
						onRetry={() => void controller.retry()}
					/>
				) : null}

				{state.status === "error" && !state.cached ? (
					<FailurePanel
						icon={<AlertTriangle size={24} />}
						title="暂时无法载入计划"
						message={state.message}
						retryable={state.retryable}
						onRetry={() => void controller.retry()}
					/>
				) : null}

				{content ? (
					<>
						<div aria-live="polite">
							{stateBanner(state, () => void controller.retry())}
						</div>
						<PlanWorkspace
							content={content}
							controller={controller}
							disabled={busy}
							onOpenCalendar={onOpenCalendar}
						/>
					</>
				) : null}
			</div>
		</section>
	);
}

function LoadingPanel() {
	return (
		<div className="planning-feedback" role="status" aria-live="polite">
			<LoaderCircle className="planning-spin" size={26} aria-hidden="true" />
			<h2>正在载入本地计划</h2>
			<p>正在恢复对话、任务状态与最近一次动态估算。</p>
		</div>
	);
}

function CreatePlanPanel({
	state,
	controller,
}: {
	state: Extract<PlanningState, { status: "empty" | "create" | "creating" }>;
	controller: PlanningController;
}) {
	const submitting = state.status === "creating";
	const issue = state.status === "creating" ? null : state.issue;

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void controller.createPlanDraft();
	}

	function handleGoalKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			void controller.createPlanDraft();
		}
	}

	return (
		<div className="planning-create-shell">
			<EmptyState
				className="planning-create-empty"
				icon={<Target size={24} />}
				eyebrow="从一个目标开始"
				title="你想推进什么？"
				description="先说清目标即可。模型会在持续对话中询问可投入时间，并建议短期、长期或模糊计划。"
			/>
			<form className="planning-create-form" onSubmit={handleSubmit}>
				<div className="planning-field">
					<label htmlFor="planning-goal">目标描述</label>
					<textarea
						id="planning-goal"
						value={state.input.goal}
						placeholder="例如：完成一套可以用于求职的作品集"
						disabled={submitting}
						aria-invalid={issue ? "true" : undefined}
						aria-describedby={
							issue ? "planning-goal-error" : "planning-goal-help"
						}
						onChange={(event) =>
							controller.updateCreateInput({ goal: event.currentTarget.value })
						}
						onKeyDown={handleGoalKeyDown}
					/>
					{issue ? (
						<p id="planning-goal-error" className="planning-field__error">
							{issue.message}
						</p>
					) : (
						<small id="planning-goal-help">
							后续可以随时通过对话修正目标。
						</small>
					)}
				</div>

				<label className="planning-start-toggle">
					<input
						type="checkbox"
						checked={state.input.startToday}
						disabled={submitting}
						onChange={(event) =>
							controller.updateCreateInput({
								startToday: event.currentTarget.checked,
							})
						}
					/>
					<span aria-hidden="true">
						<Check size={13} />
					</span>
					<strong>今天开始</strong>
					<small>
						{state.input.startToday
							? "确认计划后，从今天开始安排。"
							: "默认关闭；确认计划后，从明天开始安排。"}
					</small>
				</label>

				<div className="planning-create-actions">
					{state.status === "create" ? (
						<Button
							variant="ghost"
							disabled={submitting}
							onClick={() => controller.cancelCreate()}
						>
							取消
						</Button>
					) : (
						<span />
					)}
					<Button
						variant="primary"
						type="submit"
						disabled={submitting}
						icon={
							submitting ? (
								<LoaderCircle className="planning-spin" size={16} />
							) : (
								<MessageSquareText size={16} />
							)
						}
					>
						{submitting ? "正在建立对话" : "开始对话"}
					</Button>
				</div>
			</form>
		</div>
	);
}

function FailurePanel({
	icon,
	title,
	message,
	retryable,
	retryLabel = "重试",
	onRetry,
}: {
	icon: ReactNode;
	title: string;
	message: string;
	retryable: boolean;
	retryLabel?: string;
	onRetry: () => void;
}) {
	return (
		<div className="planning-feedback" role="alert">
			<div className="planning-feedback__icon">{icon}</div>
			<h2>{title}</h2>
			<p>{message}</p>
			{retryable ? (
				<Button icon={<RefreshCw size={15} />} onClick={onRetry}>
					{retryLabel}
				</Button>
			) : null}
		</div>
	);
}

function InlineNotice({
	icon,
	children,
	tone = "info",
}: {
	icon: ReactNode;
	children: ReactNode;
	tone?: "info" | "warning" | "error";
}) {
	return (
		<div className={`planning-notice planning-notice--${tone}`}>
			<span aria-hidden="true">{icon}</span>
			<div className="planning-notice__content">{children}</div>
		</div>
	);
}

function PlanWorkspace({
	content,
	controller,
	disabled,
	onOpenCalendar,
}: {
	content: PlanningContent;
	controller: PlanningController;
	disabled: boolean;
	onOpenCalendar?: () => void;
}) {
	return (
		<div className="planning-workspace">
			<PlanRail
				plans={content.plans}
				selectedId={content.plan.id}
				disabled={disabled}
				onSelect={(planId) => void controller.selectPlan(planId)}
			/>
			<div className="planning-workspace__main">
				<PlanOverview
					plan={content.plan}
					controller={controller}
					disabled={disabled}
					onOpenCalendar={onOpenCalendar}
				/>
				<PersistentNotifications plan={content.plan} />
				<div className="planning-detail-grid">
					<div className="planning-detail-grid__primary">
						<RevisionPanel
							plan={content.plan}
							controller={controller}
							disabled={disabled}
						/>
						<TaskPanel
							plan={content.plan}
							controller={controller}
							disabled={disabled}
						/>
						<ObservationPanel
							plan={content.plan}
							controller={controller}
							disabled={disabled}
						/>
						<AdjustmentPanel
							adjustments={content.plan.adjustments}
							controller={controller}
							disabled={disabled}
						/>
					</div>
					<ConversationPanel
						plan={content.plan}
						controller={controller}
						disabled={disabled}
					/>
				</div>
			</div>
		</div>
	);
}

function PersistentNotifications({ plan }: { plan: PlanView }) {
	if (plan.notifications.length === 0) return null;
	return (
		<section
			className="planning-persistent-notifications"
			aria-label="计划通知"
		>
			{plan.notifications.map((notification) => (
				<InlineNotice
					key={notification.id}
					tone={notification.kind === "attention-required" ? "warning" : "info"}
					icon={
						notification.kind === "attention-required" ? (
							<AlertTriangle size={16} />
						) : notification.kind === "schedule-adjusted" ? (
							<History size={16} />
						) : (
							<Sparkles size={16} />
						)
					}
				>
					<strong>
						{notification.kind === "analysis-ready"
							? "新提案已就绪"
							: notification.kind === "schedule-adjusted"
								? "日程与预计完成日已检查"
								: "需要你留意"}
					</strong>
					<p>{notification.message}</p>
				</InlineNotice>
			))}
		</section>
	);
}

function PlanRail({
	plans,
	selectedId,
	disabled,
	onSelect,
}: {
	plans: readonly PlanSummaryView[];
	selectedId: string;
	disabled: boolean;
	onSelect: (planId: string) => void;
}) {
	return (
		<nav className="planning-rail" aria-label="计划列表">
			<div className="planning-panel-heading">
				<ListTodo size={17} aria-hidden="true" />
				<div>
					<h2>我的计划</h2>
					<p>{plans.length} 个本地计划</p>
				</div>
			</div>
			<ul>
				{plans.map((plan) => (
					<li key={plan.id}>
						<button
							type="button"
							aria-current={plan.id === selectedId ? "page" : undefined}
							disabled={disabled}
							onClick={() => onSelect(plan.id)}
						>
							<strong>{plan.title}</strong>
							<span>{statusLabels[plan.status]}</span>
							<small>
								{plan.estimatedCompletionDate
									? `预计 ${formatDate(plan.estimatedCompletionDate)}`
									: "等待估算"}
							</small>
						</button>
					</li>
				))}
			</ul>
		</nav>
	);
}

function PlanOverview({
	plan,
	controller,
	disabled,
	onOpenCalendar,
}: {
	plan: PlanView;
	controller: PlanningController;
	disabled: boolean;
	onOpenCalendar?: () => void;
}) {
	const progress = planTaskProgress(plan.tasks);
	return (
		<header className="planning-overview">
			<div className="planning-overview__title">
				<span className={`planning-status planning-status--${plan.status}`}>
					{statusLabels[plan.status]}
				</span>
				<h2>{plan.title}</h2>
				<p>{plan.goal}</p>
			</div>
			<div className="planning-overview__metrics">
				<div>
					<span>计划类型</span>
					<strong>{plan.type ? typeLabels[plan.type] : "等待模型建议"}</strong>
					<small>
						{plan.effectiveDate
							? `生效日 ${formatDate(plan.effectiveDate)}`
							: `确认时按${plan.startToday ? "今天" : "明天"}计算生效日`}
					</small>
				</div>
				<div>
					<span>动态预计完成</span>
					<strong>
						{formatDate(plan.estimate?.estimatedCompletionDate ?? null)}
					</strong>
					<small>
						{plan.estimate
							? confidenceLabels[plan.estimate.confidence]
							: "尚无有效估算"}
					</small>
				</div>
				<div>
					<span>任务进度</span>
					<strong>
						{progress.completed} / {progress.total}
					</strong>
					<small>完成只由你确认</small>
				</div>
			</div>
			<div className="planning-overview__actions">
				{onOpenCalendar ? (
					<Button
						variant="ghost"
						icon={<CalendarClock size={15} />}
						disabled={disabled}
						onClick={onOpenCalendar}
					>
						查看日历
					</Button>
				) : null}
				{plan.status === "active" ? (
					<>
						<Button
							variant="ghost"
							icon={<Pause size={15} />}
							disabled={disabled}
							onClick={() => void controller.pausePlan()}
						>
							暂停
						</Button>
						<Button
							icon={<CheckCircle2 size={15} />}
							disabled={disabled}
							onClick={() => void controller.completePlan()}
						>
							确认计划已完成
						</Button>
					</>
				) : null}
				{plan.status === "paused" ? (
					<>
						<Button
							variant="primary"
							icon={<Play size={15} />}
							disabled={disabled}
							onClick={() => void controller.resumePlan()}
						>
							恢复计划
						</Button>
						<Button
							icon={<CheckCircle2 size={15} />}
							disabled={disabled}
							onClick={() => void controller.completePlan()}
						>
							确认计划已完成
						</Button>
					</>
				) : null}
				{plan.status === "draft" || plan.status === "awaiting-confirmation" ? (
					<Button
						variant="ghost"
						icon={<Archive size={15} />}
						disabled={disabled}
						onClick={() => void controller.archivePlan()}
					>
						归档计划
					</Button>
				) : null}
				{plan.status === "completed" ? (
					<Button
						icon={<Archive size={15} />}
						disabled={disabled}
						onClick={() => void controller.archivePlan()}
					>
						归档
					</Button>
				) : null}
			</div>
		</header>
	);
}

function RevisionPanel({
	plan,
	controller,
	disabled,
}: {
	plan: PlanView;
	controller: PlanningController;
	disabled: boolean;
}) {
	const revision = plan.revision;
	if (!revision) return null;
	const canConfirm = isPlanRevisionConfirmable(plan);
	const isRunningProposal =
		revision.status === "proposed" &&
		(plan.status === "active" || plan.status === "paused");
	return (
		<section
			className="planning-card planning-revision"
			aria-labelledby="revision-title"
		>
			<div className="planning-panel-heading planning-panel-heading--row">
				<div className="planning-panel-heading__icon">
					<Sparkles size={17} />
				</div>
				<div>
					<h2 id="revision-title">
						{revision.status === "proposed" ? "模型建议" : "当前计划版本"}
					</h2>
					<p>
						修订 {revision.version} · {typeLabels[revision.planType]}
					</p>
				</div>
				<span
					className={`planning-confidence planning-confidence--${revision.estimate.confidence}`}
				>
					{confidenceLabels[revision.estimate.confidence]}
				</span>
			</div>
			<div className="planning-revision__eta">
				<div>
					<span>预计完成日期</span>
					<strong>
						{revision.estimate.confidence === "low" ? "约 " : ""}
						{formatDate(revision.estimate.estimatedCompletionDate)}
					</strong>
				</div>
				<div>
					<span>未来 7 天精排窗口</span>
					<strong>
						{formatDate(revision.scheduleWindow.startDate)} –{" "}
						{formatDate(revision.scheduleWindow.endDateInclusive)}
					</strong>
				</div>
			</div>
			<p className="planning-revision__summary">{revision.summary}</p>
			{revision.status === "proposed" && revision.goal !== plan.goal ? (
				<div className="planning-revision__new-goal">
					<strong>新目标</strong>
					<p>{revision.goal}</p>
				</div>
			) : null}
			<div className="planning-revision__reason">
				<strong>建议依据</strong>
				<p>{revision.reasoningSummary}</p>
				<p>{revision.estimate.basis}</p>
				<small>
					评估于 {formatInstant(revision.estimate.assessedAt, plan.timeZone)}
					{revision.estimate.evidenceThrough
						? ` · 证据截至 ${formatEvidenceThrough(revision.estimate.evidenceThrough, plan.timeZone)}`
						: " · 尚无执行证据"}
				</small>
			</div>
			<div className="planning-compact-list planning-revision__preferences">
				<strong>本提案采用的排程偏好</strong>
				<p>
					每周{" "}
					{formatMinutes(revision.schedulingPreferences.weeklyCapacityMinutes)}
					{" · "}单次{" "}
					{formatMinutes(revision.schedulingPreferences.sessionMinutes)}
				</p>
				{revision.schedulingPreferences.availableWindows.length > 0 ? (
					<ul>
						{revision.schedulingPreferences.availableWindows.map((window) => (
							<li
								key={`${window.dayOfWeek}-${window.startTime}-${window.endTime}`}
							>
								{weekdayLabels[window.dayOfWeek]} {window.startTime}–
								{window.endTime}
							</li>
						))}
					</ul>
				) : (
					<p>尚未提供可用时段，不能确认排程。</p>
				)}
				<small>这些偏好都可在下方对话中修改，确认后才会生效。</small>
			</div>
			{revision.assumptions.length > 0 ? (
				<div className="planning-compact-list">
					<strong>当前假设</strong>
					<ul>
						{revision.assumptions.map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</div>
			) : null}
			{revision.questions.length > 0 ? (
				<div className="planning-compact-list planning-compact-list--questions">
					<strong>需要你补充</strong>
					<ul>
						{revision.questions.map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</div>
			) : null}
			{revision.status === "proposed" ? (
				<div className="planning-revision__tasks">
					<h3>未来 7 天方案预览</h3>
					{revision.tasks.length > 0 ? (
						<ul className="planning-task-list">
							{revision.tasks.map((task) => (
								<TaskRow
									key={task.id}
									task={task}
									disabled
									readOnly
									onStatus={() => {}}
								/>
							))}
						</ul>
					) : (
						<p className="planning-card__empty">
							这版提案还没有可确认的七天任务。
						</p>
					)}
				</div>
			) : null}
			{revision.status === "proposed" ? (
				<footer className="planning-card__footer">
					<p>
						{isRunningProposal
							? "当前计划会继续执行；只有你确认后，才会应用这版类型、预计完成日和未来日程。"
							: "计划类型、预计完成日和日程都只是建议；只有你确认后才会开始执行。"}
					</p>
					<Button
						variant="primary"
						icon={<Check size={15} />}
						disabled={disabled || !canConfirm}
						onClick={() => void controller.confirmLatestRevision()}
					>
						{isRunningProposal ? "确认并应用" : "确认并开始"}
					</Button>
				</footer>
			) : null}
		</section>
	);
}

function TaskPanel({
	plan,
	controller,
	disabled,
}: {
	plan: PlanView;
	controller: PlanningController;
	disabled: boolean;
}) {
	const canUpdate = plan.status === "active" || plan.status === "paused";
	return (
		<section className="planning-card" aria-labelledby="tasks-title">
			<div className="planning-panel-heading planning-panel-heading--row">
				<div className="planning-panel-heading__icon">
					<ListTodo size={17} />
				</div>
				<div>
					<h2 id="tasks-title">未来 7 天任务</h2>
					<p>远期方向只做估算，不生成虚假的逐日安排</p>
				</div>
			</div>
			{plan.tasks.length === 0 ? (
				<p className="planning-card__empty">
					继续对话后，模型会在信息充分时给出任务建议。
				</p>
			) : (
				<ul className="planning-task-list">
					{plan.tasks.map((task) => (
						<TaskRow
							key={task.id}
							task={task}
							disabled={disabled || !canUpdate}
							onStatus={(status) =>
								void controller.setTaskStatus(task.id, status)
							}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function TaskRow({
	task,
	disabled,
	readOnly = false,
	onStatus,
}: {
	task: PlanningTaskView;
	disabled: boolean;
	readOnly?: boolean;
	onStatus: (status: PlanTaskStatus) => void;
}) {
	return (
		<li className={`planning-task planning-task--${task.status}`}>
			<div className="planning-task__state" aria-hidden="true">
				{task.status === "completed" ? (
					<Check size={15} />
				) : (
					<CircleDashed size={15} />
				)}
			</div>
			<div className="planning-task__body">
				<div className="planning-task__title">
					<strong>{task.title}</strong>
					{task.purpose === "validation" ? (
						<span className="planning-task__purpose">验证</span>
					) : task.purpose === "review" ? (
						<span className="planning-task__purpose">复盘</span>
					) : null}
				</div>
				{task.description ? <p>{task.description}</p> : null}
				<div className="planning-task__meta">
					<span>
						<Clock3 size={13} />
						{formatMinutes(task.estimatedMinutes)}
					</span>
					{task.schedules.map((schedule, index) => (
						<span className="planning-task__session" key={schedule.eventId}>
							<span>
								<CalendarClock size={13} />第 {index + 1} 次 ·{" "}
								{formatSession(schedule)}
							</span>
							{schedule.scheduleOrigin === "user" ? (
								<span>用户安排</span>
							) : null}
							{schedule.userLocked ? (
								<span>
									<LockKeyhole size={13} />
									用户已锁定
								</span>
							) : null}
						</span>
					))}
				</div>
				{task.unplanned ? (
					<p className="planning-task__unplanned">
						<AlertTriangle size={13} aria-hidden="true" />
						未排程：{task.unplanned.message}
					</p>
				) : null}
			</div>
			{readOnly ? null : (
				<div className="planning-task__actions">
					{task.status === "pending" ? (
						<>
							<Button
								size="small"
								disabled={disabled}
								onClick={() => onStatus("completed")}
							>
								完成
							</Button>
							<Button
								variant="ghost"
								size="small"
								disabled={disabled}
								onClick={() => onStatus("skipped")}
							>
								跳过
							</Button>
						</>
					) : (
						<Button
							variant="ghost"
							size="small"
							disabled={disabled}
							onClick={() => onStatus("pending")}
						>
							重新打开
						</Button>
					)}
				</div>
			)}
		</li>
	);
}

function ObservationPanel({
	plan,
	controller,
	disabled,
}: {
	plan: PlanView;
	controller: PlanningController;
	disabled: boolean;
}) {
	const pending = plan.pendingObservations;
	return (
		<section className="planning-card" aria-labelledby="observations-title">
			<div className="planning-panel-heading planning-panel-heading--row">
				<div className="planning-panel-heading__icon">
					<Target size={17} />
				</div>
				<div>
					<h2 id="observations-title">进度观测</h2>
					<p>观测只提供证据，绝不会自动完成任务</p>
				</div>
			</div>
			{!plan.monitoring.authorized || !plan.monitoring.enabled ? (
				<InlineNotice tone="warning" icon={<WifiOff size={16} />}>
					监测已关闭，仅使用手动进度。{plan.monitoring.message}
				</InlineNotice>
			) : plan.monitoring.coverage !== "complete" ? (
				<InlineNotice tone="warning" icon={<AlertTriangle size={16} />}>
					观测覆盖不完整，低置信证据不会触发自动调整。{plan.monitoring.message}
				</InlineNotice>
			) : (
				<p className="planning-observation-ready">
					观测已授权；歧义活动仍需你确认后才计入计划。
				</p>
			)}
			{pending.length > 0 ? (
				<div className="planning-observation-list">
					<h3>待确认归因 · {pending.length}</h3>
					{pending.map((observation) => (
						<ObservationRow
							key={observation.id}
							observation={observation}
							tasks={plan.tasks}
							disabled={disabled}
							onConfirm={(taskId) =>
								void controller.confirmObservationAttribution(
									observation.id,
									taskId,
								)
							}
						/>
					))}
				</div>
			) : null}
		</section>
	);
}

function ObservationRow({
	observation,
	tasks,
	disabled,
	onConfirm,
}: {
	observation: PlanningObservationView;
	tasks: readonly PlanningTaskView[];
	disabled: boolean;
	onConfirm: (taskId: string | null) => void;
}) {
	const candidates = useMemo(
		() =>
			tasks.filter((task) => observation.candidateTaskIds.includes(task.id)),
		[tasks, observation.candidateTaskIds],
	);
	return (
		<article className="planning-observation">
			<div>
				<strong>{observation.summary}</strong>
				<p>
					{formatMinutes(observation.durationMinutes)} ·{" "}
					{confidenceLabels[observation.confidence]}
				</p>
			</div>
			<div
				className="planning-observation__actions"
				role="toolbar"
				aria-label="确认观测归因"
			>
				{candidates.map((task) => (
					<Button
						key={task.id}
						size="small"
						disabled={disabled}
						onClick={() => onConfirm(task.id)}
					>
						计入“{task.title}”
					</Button>
				))}
				<Button
					variant="ghost"
					size="small"
					disabled={disabled}
					onClick={() => onConfirm(null)}
				>
					不计入计划
				</Button>
			</div>
		</article>
	);
}

function AdjustmentPanel({
	adjustments,
	controller,
	disabled,
}: {
	adjustments: readonly PlanAdjustmentView[];
	controller: PlanningController;
	disabled: boolean;
}) {
	if (adjustments.length === 0) return null;
	return (
		<section className="planning-card" aria-labelledby="adjustments-title">
			<div className="planning-panel-heading planning-panel-heading--row">
				<div className="planning-panel-heading__icon">
					<History size={17} />
				</div>
				<div>
					<h2 id="adjustments-title">动态调整记录</h2>
					<p>每次估时与未来日程变化都保留依据</p>
				</div>
			</div>
			<ul className="planning-adjustments">
				{adjustments.map((adjustment) => (
					<li key={adjustment.id}>
						<div>
							<strong>{adjustment.summary}</strong>
							<p>
								预计完成：
								{formatDate(adjustment.previousEstimatedCompletionDate)} →{" "}
								{formatDate(adjustment.nextEstimatedCompletionDate)}
							</p>
							<small>
								移动 {adjustment.movedCount} · 新增 {adjustment.addedCount} ·
								取消 {adjustment.cancelledCount}
							</small>
						</div>
						{adjustment.canUndo ? (
							<Button
								variant="ghost"
								size="small"
								icon={<RotateCcw size={14} />}
								disabled={disabled}
								onClick={() => void controller.undoAdjustment(adjustment.id)}
							>
								撤销
							</Button>
						) : (
							<span className="planning-adjustments__locked">
								{adjustment.undoneAt
									? "已撤销"
									: (adjustment.undoUnavailableReason ?? "不可撤销")}
							</span>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

function ConversationPanel({
	plan,
	controller,
	disabled,
}: {
	plan: PlanView;
	controller: PlanningController;
	disabled: boolean;
}) {
	const [message, setMessage] = useState("");
	const hasPending = plan.messages.some(
		(item) => item.status === "pending-analysis",
	);

	async function submitMessage() {
		const content = message.trim();
		if (!content || disabled) return;
		setMessage("");
		await controller.sendMessage(content);
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void submitMessage();
	}

	function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			void submitMessage();
		}
	}

	return (
		<aside
			className="planning-conversation"
			aria-labelledby="conversation-title"
		>
			<div className="planning-panel-heading planning-panel-heading--row">
				<div className="planning-panel-heading__icon">
					<MessageSquareText size={17} />
				</div>
				<div>
					<h2 id="conversation-title">计划对话</h2>
					<p>目标、约束与类型都可继续修正</p>
				</div>
			</div>
			<div className="planning-messages" aria-live="polite">
				{plan.messages.map((item) => (
					<article
						key={item.id}
						className={`planning-message planning-message--${item.role}`}
					>
						<div>
							{item.role === "user" ? (
								<UserRound size={14} />
							) : (
								<Bot size={14} />
							)}
							<strong>{item.role === "user" ? "你" : "计划助手"}</strong>
							{item.status === "pending-analysis" ? <span>待分析</span> : null}
							{item.status === "failed" ? <span>分析失败</span> : null}
						</div>
						<p>{item.content}</p>
					</article>
				))}
			</div>
			{hasPending ? (
				<div className="planning-conversation__pending">
					<span>消息已持久保存，正在等待计划分析服务。</span>
					<Button
						variant="ghost"
						size="small"
						icon={<RefreshCw size={14} />}
						disabled={disabled}
						onClick={() => void controller.retryPendingAnalysis()}
					>
						重试分析
					</Button>
				</div>
			) : null}
			<form className="planning-composer" onSubmit={handleSubmit}>
				<label htmlFor="planning-message">继续补充或修改计划</label>
				<textarea
					id="planning-message"
					value={message}
					placeholder="例如：我每周二和周四晚上各有 90 分钟"
					disabled={disabled || plan.status === "archived"}
					onChange={(event) => setMessage(event.currentTarget.value)}
					onKeyDown={handleKeyDown}
				/>
				<div>
					<small>按 ⌘/Ctrl + Enter 发送</small>
					<Button
						variant="primary"
						type="submit"
						icon={<Send size={14} />}
						disabled={disabled || !message.trim() || plan.status === "archived"}
					>
						发送
					</Button>
				</div>
			</form>
		</aside>
	);
}
