import type { PlanningProgressStep } from "../../../../shared/planning";
import {
	AlertTriangle,
	Bot,
	CheckCircle2,
	LoaderCircle,
	Pause,
	Play,
	RefreshCw,
	Send,
	Sparkles,
	Target,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Temporal } from "temporal-polyfill";
import { Button } from "../../shared/ui/Button";
import {
	isPlanRevisionConfirmable,
	type PlanStatus,
	type PlanView,
	type PlanningTaskSchedule,
	type PlanningTaskView,
} from "./domain";
import type {
	PlanningContent,
	PlanningController,
	PlanningState,
} from "./PlanningController";

const statusLabels: Record<PlanStatus, string> = {
	draft: "完善中",
	"awaiting-confirmation": "待确认",
	active: "进行中",
	paused: "已暂停",
	completed: "已完成",
	archived: "已归档",
};

const confidenceShortLabels: Record<string, string> = {
	high: "高把握",
	medium: "中把握",
	low: "低把握",
};

const angleLabels: Record<string, string> = {
	"goal-alignment": "目标对齐",
	"time-feasibility": "时间可行",
	"dependency-risk": "依赖风险",
	"load-recovery": "负荷恢复",
	"evidence-sufficiency": "证据充分",
};

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

function formatDate(date: string | null): string {
	if (!date) return "待估";
	const parsed = Temporal.PlainDate.from(date);
	return `${parsed.month}月${parsed.day}日`;
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

/** 计划控制器随登录会话长存，这里只订阅并在挂载时拉一次最新状态。 */
function usePlanningSnapshot(
	controller: PlanningController,
): PlanningState {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	useEffect(() => {
		void controller.initialize();
	}, [controller]);
	return state;
}

function truncate(text: string, limit: number): string {
	const chars = Array.from(text);
	return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}…`;
}

function taskTimeLabel(
	schedules: readonly PlanningTaskSchedule[],
	unplannedMessage: string | null,
): string {
	if (schedules.length > 0) {
		return schedules.map(formatSession).join("；");
	}
	return `未排程 · ${unplannedMessage ?? "待定"}`;
}

/** 任务投入进度文案：无证据返回空串，不伪造进度。 */
function taskProgressText(task: PlanningTaskView): string {
	if (task.actualMinutes <= 0 || task.estimatedMinutes <= 0) return "";
	const percent = Math.min(
		100,
		Math.round((task.actualMinutes / task.estimatedMinutes) * 100),
	);
	return `已投入 ${Math.round(task.actualMinutes)}m（${percent}%）`;
}

interface PlanTaskGrouping {
	active: PlanningTaskView[];
	completed: PlanningTaskView[];
	skipped: PlanningTaskView[];
}

/**
 * 任务清单分组：进行中按最近一次排期升序（接入实际投入进度后改为进度降序）；
 * 已完成、已跳过单独分组。投影已含任务状态与排期，纯前端派生。
 */
function groupPlanTasks(tasks: readonly PlanningTaskView[]): PlanTaskGrouping {
	const nextStart = (task: PlanningTaskView): string | null => {
		const starts = task.schedules.map((schedule) => schedule.start).sort();
		return starts[0] ?? null;
	};
	const progressRatio = (task: PlanningTaskView): number => {
		if (task.estimatedMinutes <= 0) {
			return task.actualMinutes > 0 ? 1 : 0;
		}
		return Math.min(task.actualMinutes / task.estimatedMinutes, 1);
	};
	const active = tasks
		.filter((task) => task.status === "pending")
		.sort((left, right) => {
			// 完成进度降序：投入占比最高的排最前（完成最多的在最上面）。
			const progressDelta = progressRatio(right) - progressRatio(left);
			if (progressDelta !== 0) return progressDelta;
			// 同进度按最近排期升序，未排程殿后。
			const leftStart = nextStart(left);
			const rightStart = nextStart(right);
			if (leftStart === null && rightStart === null) return 0;
			if (leftStart === null) return 1;
			if (rightStart === null) return -1;
			return leftStart.localeCompare(rightStart);
		});
	return {
		active,
		completed: tasks.filter((task) => task.status === "completed"),
		skipped: tasks.filter((task) => task.status === "skipped"),
	};
}

export interface SmartScheduleComposerProps {
	controller: PlanningController;
	/** 切回手动表单 */
	onOpenManual: () => void;
	/** 提案确认成功，日历事件已生成 */
	onPlanned: () => void;
}

/**
 * 「创建日程」对话框的智能安排主体：目标一句话 → 提案列表 → 确认或继续调整。
 * 复用 PlanningController 的完整状态机，不引入第二套计划逻辑。
 */
export function SmartScheduleComposer({
	controller,
	onOpenManual,
	onPlanned,
}: SmartScheduleComposerProps) {
	const state = usePlanningSnapshot(controller);
	const [adjustment, setAdjustment] = useState("");
	const content = contentFromState(state);
	const busy =
		state.status === "updating" ||
		state.status === "loading" ||
		state.status === "stale" ||
		state.status === "offline" ||
		state.status === "error" ||
		state.status === "model-unavailable";

	if (state.status === "empty" || state.status === "create") {
		return (
			<CreateGoalForm
				state={state}
				controller={controller}
				onOpenManual={onOpenManual}
			/>
		);
	}
	if (state.status === "creating") {
		return (
			<ThinkingPanel
				thinking={state.thinking}
				label="正在生成方案，思考与调研过程实时可见。"
			/>
		);
	}
	if (!content) {
		if (state.status === "loading") {
			return <ComposerLoading label="正在载入计划…" />;
		}
		if (
			state.status === "offline" ||
			state.status === "error" ||
			state.status === "model-unavailable"
		) {
			return (
				<ComposerFailure
					title={
						state.status === "offline"
							? "本地计划服务离线"
							: state.status === "model-unavailable"
								? "计划分析服务暂时不可用"
								: "暂时无法载入计划"
					}
					message={state.message}
					retryable={state.retryable}
					onRetry={() => void controller.retry()}
					onOpenManual={onOpenManual}
				/>
			);
		}
		return null;
	}

	const plan = content.plan;
	const revision = plan.revision;
	const proposing = revision !== null && revision.status === "proposed";
	const canConfirm = isPlanRevisionConfirmable(plan);
	const confirming =
		state.status === "updating" && state.operation === "confirm-revision";
	// 降级确认门：提案存在弱关联任务即提示；运行时对"强→弱降级"要求显式 ack。
	const demotedTaskCount =
		revision?.tasks.filter((task) => task.relevance === "weak").length ?? 0;
	const [acknowledgedDemotion, setAcknowledgedDemotion] = useState(false);
	// 已确认任务清单分组：进行中按最近排期升序；已完成/已跳过单独分组。
	// 实际投入进度（observationEvidence 聚合）接入后，进行中改为按进度降序。
	const settledTasks = proposing ? [] : (revision?.tasks ?? []);
	const {
		active: activeTasks,
		completed: completedTasks,
		skipped: skippedTasks,
	} = groupPlanTasks(settledTasks);
	const lastAssistantMessage = [...plan.messages]
		.reverse()
		.find((message) => message.role === "assistant");
	const hasPendingAnalysis = plan.messages.some(
		(message) => message.status === "pending-analysis",
	);
	// 分析已完成且模型提出了澄清问题：球在用户侧，问题必须完整可见。
	const awaitingUserAnswers =
		plan.status === "draft" &&
		!hasPendingAnalysis &&
		lastAssistantMessage !== undefined;

	async function confirmProposal() {
		const needsAck = demotedTaskCount > 0 && !acknowledgedDemotion;
		if (needsAck) {
			// 第一次点击：亮出降级警告，不发起确认。
			setAcknowledgedDemotion(true);
			return;
		}
		try {
			await controller.confirmLatestRevision(demotedTaskCount > 0);
		} catch {
			// 确认失败由状态横幅呈现；这里保持门可重试。
		}
		onPlanned();
	}

	function submitAdjustment(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const text = adjustment.trim();
		if (!text || busy) return;
		setAdjustment("");
		void controller.sendMessage(text);
	}

	function handleAdjustmentKeyDown(
		event: KeyboardEvent<HTMLInputElement>,
	): void {
		if (event.key === "Enter") {
			event.preventDefault();
			event.currentTarget.form?.requestSubmit();
		}
	}

	return (
		<div className="smart-composer">
			<div className="smart-composer__goal">
				<Target size={15} aria-hidden="true" />
				<strong>{truncate(plan.goal, 40)}</strong>
				<span
					className={`smart-composer__state smart-composer__state--${plan.status}`}
				>
					{statusLabels[plan.status]}
				</span>
			</div>

			{state.status === "updating" ? (
				<div>
					<p className="smart-composer__notice" role="status">
						<LoaderCircle className="planning-spin" size={15} aria-hidden="true" />
						正在处理上一步操作…
					</p>
					{state.thinking.length > 0 ? (
						<ThinkingStream steps={state.thinking} />
					) : null}
				</div>
			) : null}
			{state.status === "model-unavailable" ||
			state.status === "offline" ||
			state.status === "error" ? (
				<p className="smart-composer__notice smart-composer__notice--warning" role="alert">
					<AlertTriangle size={15} aria-hidden="true" />
					{state.message}
					{state.retryable ? (
						<button
							type="button"
							className="smart-composer__notice-action"
							onClick={() => void controller.retry()}
						>
							重试
						</button>
					) : null}
				</p>
			) : null}

			{proposing && revision ? (
				<section className="smart-composer__proposal">
					<p className="smart-composer__summary">{revision.summary}</p>
					<p className="smart-composer__eta">
						预计完成 {formatDate(revision.estimate.estimatedCompletionDate)} ·{" "}
						{confidenceShortLabels[revision.estimate.confidence] ??
							revision.estimate.confidence}
					</p>
					<ul className="smart-composer__list">
						{revision.tasks.map((task) => (
							<li
								key={task.id}
								className={
									task.relevance === "weak"
										? "smart-composer__item smart-composer__item--weak"
										: "smart-composer__item"
								}
							>
								<strong>
									<button
										type="button"
										className="smart-composer__relevance"
										data-relevance={task.relevance ?? "strong"}
										disabled={busy}
										aria-label={`改判「${task.title}」为${task.relevance === "weak" ? "强" : "弱"}关联`}
										onClick={() =>
											void controller.setTaskRelevance(
												task.id,
												task.relevance === "weak" ? "strong" : "weak",
											)
										}
									>
										{task.relevance === "weak" ? "◌" : "●"}
									</button>
									{task.title}
								</strong>
								<span>{taskTimeLabel(task.schedules, task.unplanned?.message ?? null)}</span>
							</li>
						))}
					</ul>
					{revision.evaluations && revision.evaluations.length > 0 ? (
						<div className="smart-composer__questions">
							<strong>五角度评定：</strong>
							<ul>
								{revision.evaluations.map((item) => (
									<li key={item.angle}>
										{angleLabels[item.angle] ?? item.angle}
										{item.verdict === "pass" ? "✓" : item.verdict === "adjust" ? "△" : "✕"}
										　{item.summary}
									</li>
								))}
							</ul>
						</div>
					) : null}
					{revision.questions.length > 0 ? (
						<div className="smart-composer__questions">
							<strong>待确认：</strong>
							<ul>
								{revision.questions.map((question) => (
									<li key={question}>{question}</li>
								))}
							</ul>
						</div>
					) : null}
					<div className="smart-composer__confirm">
						{demotedTaskCount > 0 && !acknowledgedDemotion ? (
							<p
								className="smart-composer__notice smart-composer__notice--warning"
								role="alert"
							>
								本版提案把 {demotedTaskCount} 个原强关联任务降为弱关联（可被压缩/舍弃）。确认降级请再点一次。
							</p>
						) : null}
						<Button
							variant="primary"
							icon={
								confirming ? (
									<LoaderCircle className="planning-spin" size={15} />
								) : (
									<CheckCircle2 size={15} />
								)
							}
							disabled={!canConfirm || busy}
							onClick={() => void confirmProposal()}
						>
							{demotedTaskCount > 0 && !acknowledgedDemotion
								? "仍要确认（含降级）"
								: "确认安排"}
						</Button>
						{!canConfirm ? (
							<small>回复上面的问题并发送后即可确认。</small>
						) : demotedTaskCount > 0 && !acknowledgedDemotion ? (
							<small>点 ●/◌ 可改判任务分级后再确认。</small>
						) : (
							<small>确认后，这些安排会写入日历。</small>
						)}
					</div>
				</section>
			) : (
				<>
					{revision ? (
						<section
							className="smart-composer__tasks"
							aria-label="计划任务清单"
						>
							<div className="smart-composer__tasks-head">
								<span>任务清单</span>
								<span aria-live="polite">
									已完成 {completedTasks.length}/{settledTasks.length}
								</span>
							</div>
							{activeTasks.length > 0 ? (
								<ul className="smart-composer__list">
									{activeTasks.map((task) => (
										<li
											key={task.id}
											className={
												task.relevance === "weak"
													? "smart-composer__item smart-composer__item--weak"
													: "smart-composer__item"
											}
										>
											<strong>
												<button
													type="button"
													className="smart-composer__relevance"
													data-relevance={task.relevance ?? "strong"}
													disabled={busy}
													aria-label={`改判「${task.title}」为${task.relevance === "weak" ? "强" : "弱"}关联`}
													onClick={() =>
														void controller.setTaskRelevance(
															task.id,
															task.relevance === "weak" ? "strong" : "weak",
														)
													}
												>
													{task.relevance === "weak" ? "◌" : "●"}
												</button>
												{task.title}
											</strong>
											<span>
												{taskTimeLabel(
													task.schedules,
													task.unplanned?.message ?? null,
												)}
												{taskProgressText(task)
													? ` · ${taskProgressText(task)}`
													: ""}
											</span>
										</li>
									))}
								</ul>
							) : null}
							{completedTasks.length > 0 ? (
								<div className="smart-composer__tasks-group">
									<p className="smart-composer__tasks-group-title">已完成</p>
									<ul className="smart-composer__list">
										{completedTasks.map((task) => (
											<li
												key={task.id}
												className="smart-composer__item smart-composer__item--completed"
											>
												<strong>
													<span
														className="smart-composer__relevance"
														data-relevance={task.relevance ?? "strong"}
														aria-hidden="true"
													>
														{task.relevance === "weak" ? "◌" : "●"}
													</span>
													{task.title}
												</strong>
												<span className="smart-composer__task-state">
													已完成
												</span>
											</li>
										))}
									</ul>
								</div>
							) : null}
							{skippedTasks.length > 0 ? (
								<div className="smart-composer__tasks-group">
									<p className="smart-composer__tasks-group-title">已跳过</p>
									<ul className="smart-composer__list">
										{skippedTasks.map((task) => (
											<li
												key={task.id}
												className="smart-composer__item smart-composer__item--skipped"
											>
												<strong>
													<span
														className="smart-composer__relevance"
														data-relevance="weak"
														aria-hidden="true"
													>
														◌
													</span>
													{task.title}
												</strong>
												<span className="smart-composer__task-state">已跳过</span>
											</li>
										))}
									</ul>
								</div>
							) : null}
						</section>
					) : null}
					<p className="smart-composer__settled">
						{revision
							? "当前版本已确认，调整会生成新的提案。"
							: awaitingUserAnswers
								? "在下方输入框回答上述问题（可一次性回答），随后生成完整排期。"
								: "正在理解你的目标，补充信息可加快进度。"}
					</p>
				</>
			)}

			{lastAssistantMessage ? (
				awaitingUserAnswers ? (
					<div
						className="smart-composer__questions"
						aria-label="待回答的澄清问题"
					>
						<p className="smart-composer__questions-title">
							<Bot size={15} aria-hidden="true" />
							需要你补充以下信息，回答后即生成完整提案：
						</p>
						<div className="smart-composer__questions-body">
							{lastAssistantMessage.content}
						</div>
					</div>
				) : (
					<p className="smart-composer__reply">
						<Bot size={15} aria-hidden="true" />
						{truncate(lastAssistantMessage.content, 90)}
					</p>
				)
			) : null}
			{hasPendingAnalysis ? (
				<p className="smart-composer__notice" role="status">
					<LoaderCircle className="planning-spin" size={15} aria-hidden="true" />
					消息已保存，正在等待计划分析。
					<button
						type="button"
						className="smart-composer__notice-action"
						disabled={busy}
						onClick={() => void controller.retryPendingAnalysis()}
					>
						重试分析
					</button>
				</p>
			) : null}

			<form className="smart-composer__adjust" onSubmit={submitAdjustment}>
				<input
					value={adjustment}
					placeholder="输入调整意见"
					disabled={busy}
					aria-label="调整计划"
					onChange={(event) => setAdjustment(event.currentTarget.value)}
					onKeyDown={handleAdjustmentKeyDown}
				/>
				<Button
					variant="ghost"
					type="submit"
					aria-label="发送调整"
					disabled={busy || !adjustment.trim()}
				>
					<Send size={15} />
				</Button>
			</form>
		</div>
	);
}

function CreateGoalForm({
	state,
	controller,
	onOpenManual,
}: {
	state: Extract<PlanningState, { status: "empty" | "create" }>;
	controller: PlanningController;
	onOpenManual: () => void;
}) {
	const issue = state.issue;
	return (
		<form
			className="smart-create"
			onSubmit={(event) => {
				event.preventDefault();
				void controller.createPlanDraft();
			}}
		>
			<label className="calendar-field calendar-field--wide" htmlFor="smart-goal">
				<span>安排什么？</span>
				<textarea
					id="smart-goal"
					value={state.input.goal}
					placeholder="例如：下个月想跑一次全马，帮我排个训练计划"
					aria-invalid={issue ? "true" : undefined}
					aria-describedby={issue ? "smart-goal-error" : undefined}
					onChange={(event) =>
						controller.updateCreateInput({ goal: event.currentTarget.value })
					}
				/>
			</label>
			{issue ? (
				<p id="smart-goal-error" className="smart-create__error">
					{issue.message}
				</p>
			) : null}
			<label className="smart-create__toggle">
				<input
					type="checkbox"
					checked={state.input.startToday}
					onChange={(event) =>
						controller.updateCreateInput({
							startToday: event.currentTarget.checked,
						})
					}
				/>
				<span>今天就开始（默认从明天排）</span>
			</label>
			<footer className="smart-create__actions">
				<Button variant="ghost" type="button" onClick={onOpenManual}>
					手动设置
				</Button>
				<Button variant="primary" type="submit" icon={<Sparkles size={15} />}>
					智能安排
				</Button>
			</footer>
		</form>
	);
}

export interface PlanStatusCardProps {
	controller: PlanningController;
}

/**
 * 日历侧栏「我的计划」下的小状态卡：目标、状态、一键确认与调整。
 * 替代已移除的多面板计划工作区。
 */
export function PlanStatusCard({ controller }: PlanStatusCardProps) {
	const state = usePlanningSnapshot(controller);
	const [adjustment, setAdjustment] = useState("");
	const content = contentFromState(state);
	if (!content) return null;
	const plan: PlanView = content.plan;
	if (plan.status === "archived" || plan.status === "completed") return null;
	const busy =
		state.status === "updating" ||
		state.status === "loading" ||
		state.status === "stale";
	const revision = plan.revision;
	const proposing = revision !== null && revision.status === "proposed";
	const canConfirm = isPlanRevisionConfirmable(plan);
	// 活跃计划的任务清单：进行中按最近排期升序；已完成/已跳过单独分组，
	// 让已确认的计划随时有地方查看任务与完成状态。
	const { active: activeTasks, completed: completedTasks, skipped: skippedTasks } =
		groupPlanTasks(proposing ? [] : (revision?.tasks ?? []));
	const settledTotal = proposing ? 0 : (revision?.tasks.length ?? 0);

	return (
		<div className="plan-status-card" aria-label="进行中的计划">
			<div className="plan-status-card__head">
				<Target size={14} aria-hidden="true" />
				<strong>{truncate(plan.goal, 16)}</strong>
				<span
					className={`plan-status-card__state plan-status-card__state--${plan.status}`}
				>
					{statusLabels[plan.status]}
				</span>
			</div>
			{proposing ? (
				<div className="plan-status-card__confirm">
					<Button
						size="small"
						variant="primary"
						disabled={!canConfirm || busy}
						onClick={() => void controller.confirmLatestRevision()}
					>
						确认安排
					</Button>
					<small>{revision.tasks.length} 项待确认</small>
				</div>
			) : null}
			{!proposing && revision ? (
				<section
					className="plan-status-card__tasks"
					aria-label="计划任务清单"
				>
					<div className="plan-status-card__tasks-head">
						<span>任务清单</span>
						<span aria-live="polite">
							已完成 {completedTasks.length}/{settledTotal}
						</span>
					</div>
					{activeTasks.length > 0 ? (
						<ul className="plan-status-card__tasks-list">
							{activeTasks.map((task) => (
								<li
									key={task.id}
									className={
										task.relevance === "weak"
											? "plan-status-card__task plan-status-card__task--weak"
											: "plan-status-card__task"
									}
								>
									<span
										className="plan-status-card__task-relevance"
										data-relevance={task.relevance ?? "strong"}
										aria-hidden="true"
									>
										{task.relevance === "weak" ? "◌" : "●"}
									</span>
									<span className="plan-status-card__task-title">
										{task.title}
									</span>
									<span className="plan-status-card__task-time">
										{taskTimeLabel(
											task.schedules,
											task.unplanned?.message ?? null,
										)}
										{taskProgressText(task)
											? ` · ${taskProgressText(task)}`
											: ""}
									</span>
								</li>
							))}
						</ul>
					) : null}
					{completedTasks.length > 0 ? (
						<div className="plan-status-card__tasks-group">
							<p className="plan-status-card__tasks-group-title">已完成</p>
							<ul className="plan-status-card__tasks-list">
								{completedTasks.map((task) => (
									<li
										key={task.id}
										className="plan-status-card__task plan-status-card__task--completed"
									>
										<span className="plan-status-card__task-title">
											{task.title}
										</span>
										<span className="plan-status-card__task-state">已完成</span>
									</li>
								))}
							</ul>
						</div>
					) : null}
					{skippedTasks.length > 0 ? (
						<div className="plan-status-card__tasks-group">
							<p className="plan-status-card__tasks-group-title">已跳过</p>
							<ul className="plan-status-card__tasks-list">
								{skippedTasks.map((task) => (
									<li
										key={task.id}
										className="plan-status-card__task plan-status-card__task--skipped"
									>
										<span className="plan-status-card__task-title">
											{task.title}
										</span>
										<span className="plan-status-card__task-state">已跳过</span>
									</li>
								))}
							</ul>
						</div>
					) : null}
				</section>
			) : null}
			{state.status === "updating" ? (
				<p className="plan-status-card__notice" role="status">
					<LoaderCircle className="planning-spin" size={13} aria-hidden="true" />
					正在处理…
				</p>
			) : null}
			<form
				className="plan-status-card__adjust"
				onSubmit={(event) => {
					event.preventDefault();
					const text = adjustment.trim();
					if (!text || busy) return;
					setAdjustment("");
					void controller.sendMessage(text);
				}}
			>
				<input
					value={adjustment}
					placeholder="输入调整意见"
					aria-label="调整计划"
					disabled={busy}
					onChange={(event) => setAdjustment(event.currentTarget.value)}
				/>
				<button
					type="submit"
					aria-label="发送调整"
					disabled={busy || !adjustment.trim()}
				>
					<Send size={13} />
				</button>
			</form>
			<div className="plan-status-card__actions">
				{plan.status === "active" ? (
					<button
						type="button"
						aria-label="暂停计划"
						disabled={busy}
						onClick={() => void controller.pausePlan()}
					>
						<Pause size={13} />
					</button>
				) : null}
				{plan.status === "paused" ? (
					<button
						type="button"
						aria-label="继续计划"
						disabled={busy}
						onClick={() => void controller.resumePlan()}
					>
						<Play size={13} />
					</button>
				) : null}
				{plan.status !== "draft" ? (
					<button
						type="button"
						aria-label="完成计划"
						disabled={busy}
						onClick={() => void controller.completePlan()}
					>
						<CheckCircle2 size={13} />
					</button>
				) : null}
			</div>
		</div>
	);
}

/**
 * Claude Code 式步骤时间线（DAG 排列）：
 * - ⏺ 工具调用行：`工具(参数)`，状态点 灰=执行中 → 绿=完成 → 红=失败
 * - ⎿ 结果行：缩进一级，如「4183 字结果」
 * - 思考块：默认折叠成「思考 N 字」，点击展开；最新一块流式时展开
 */
function ThinkingPanel({
	thinking,
	label,
}: {
	thinking: readonly PlanningProgressStep[];
	label: string;
}) {
	return (
		<div className="smart-composer__loading" role="status">
			<LoaderCircle className="planning-spin" size={20} aria-hidden="true" />
			<p>{label}</p>
			<ProgressSteps steps={thinking} live />
		</div>
	);
}

function ProgressSteps({
	steps,
	live = false,
}: {
	steps: readonly PlanningProgressStep[];
	live?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [steps]);
	const [expanded, setExpanded] = useState<Record<number, boolean>>({});
	return (
		<div className="progress-steps" ref={ref}>
			{steps.map((step, index) => {
				if (step.kind === "tool") {
					return (
						<div className="progress-step progress-step--tool" key={index}>
							<div className="progress-step__head">
								<span
									className={`progress-step__dot progress-step__dot--${step.status}`}
									aria-hidden="true"
								/>
								<span className="progress-step__glyph" aria-hidden="true">⏺</span>
								<strong className="progress-step__tool">{step.tool}</strong>
								{step.args !== "" ? (
									<code className="progress-step__args">{step.args}</code>
								) : null}
							</div>
							{step.status !== "running" ? (
								<div className="progress-step__result" aria-hidden="true">
									<span className="progress-step__branch">⎿</span>
									{step.status === "done" ? (
										<span>{step.result ?? "完成"}</span>
									) : (
										<span className="progress-step__result--failed">
											{step.result ?? "失败"}
										</span>
									)}
								</div>
							) : (
								<div className="progress-step__result">
									<span className="progress-step__branch" aria-hidden="true">⎿</span>
									<span className="progress-step__running">执行中…</span>
								</div>
							)}
						</div>
					);
				}
				const isLast = index === steps.length - 1;
				const open = live && isLast ? true : (expanded[index] ?? false);
				const chars = Array.from(step.text).length;
				return (
					<div className="progress-step progress-step--thinking" key={index}>
						<button
							type="button"
							className="progress-step__thinking-toggle"
							onClick={() =>
								setExpanded((current) => ({ ...current, [index]: !open }))
							}
						>
							<span aria-hidden="true">{open ? "▾" : "▸"}</span> 思考 {chars} 字
						</button>
						{open ? (
							<pre className="progress-step__thinking-text">{step.text}</pre>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function ThinkingStream({ steps }: { steps: readonly PlanningProgressStep[] }) {
	return <ProgressSteps steps={steps} live />;
}

function ComposerLoading({ label }: { label: string }) {
	return (
		<div className="smart-composer__loading" role="status">
			<LoaderCircle className="planning-spin" size={20} aria-hidden="true" />
			<p>{label}</p>
		</div>
	);
}

function ComposerFailure({
	title,
	message,
	retryable,
	onRetry,
	onOpenManual,
}: {
	title: string;
	message: string;
	retryable: boolean;
	onRetry: () => void;
	onOpenManual: () => void;
}) {
	return (
		<div className="smart-composer__failure" role="alert">
			<AlertTriangle size={18} aria-hidden="true" />
			<h3>{title}</h3>
			<p>{message}</p>
			<div>
				{retryable ? (
					<Button
						size="small"
						icon={<RefreshCw size={14} />}
						onClick={onRetry}
					>
						重试
					</Button>
				) : null}
				<Button size="small" variant="ghost" onClick={onOpenManual}>
					改用手动设置
				</Button>
			</div>
		</div>
	);
}
