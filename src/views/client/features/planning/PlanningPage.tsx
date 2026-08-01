import {
	AlertTriangle,
	ArrowLeft,
	ArrowRight,
	CalendarCheck2,
	Check,
	CheckCircle2,
	Clock3,
	Flag,
	LoaderCircle,
	Pencil,
	RefreshCw,
	Sparkles,
	Target,
	Trash2,
	X,
} from "lucide-react";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type KeyboardEvent,
	type FormEvent,
	type ReactNode,
} from "react";
import { Temporal } from "temporal-polyfill";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { PageHeader } from "../../shared/ui/PageHeader";
import type { PlanningController, PlanningState } from "./PlanningController";
import {
	planHasBlockingConflicts,
	type PlanInput,
	type PlanningBusyWindow,
	type ProposedScheduleItem,
	type Weekday,
} from "./domain";
import type { TaskPlanningAnswer } from "../../../../shared/task-planning";

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
	onNotify: (message: string) => void;
	onOpenCalendar: () => void;
	renderSchedulePreview: (props: PlanningSchedulePreviewProps) => ReactNode;
}

const steps = [
	{ id: "describe", label: "描述目标" },
	{ id: "type", label: "选择类型" },
	{ id: "constraints", label: "补充约束" },
	{ id: "clarify", label: "补充信息" },
	{ id: "generate", label: "生成计划" },
	{ id: "structure", label: "审阅结构" },
	{ id: "schedule", label: "调整日程" },
	{ id: "confirm", label: "确认写入" },
] as const;

const generationStatusLabels = {
	understood: "已理解目标",
	"split-phases": "正在拆分阶段",
	"checking-calendar": "正在检查日历",
	arranging: "正在安排可执行时段",
	ready: "草案已就绪",
} as const;

const weekdayOptions: ReadonlyArray<{ id: Weekday; label: string }> = [
	{ id: "monday", label: "周一" },
	{ id: "tuesday", label: "周二" },
	{ id: "wednesday", label: "周三" },
	{ id: "thursday", label: "周四" },
	{ id: "friday", label: "周五" },
	{ id: "saturday", label: "周六" },
	{ id: "sunday", label: "周日" },
];

function currentStep(state: PlanningState): (typeof steps)[number]["id"] {
	if (state.status === "initial" || state.status === "cancelled") return "describe";
	if (state.status === "success") return "confirm";
	return state.step;
}

function issueFor(state: PlanningState, field: string): string | null {
	if (state.status !== "drafting") return null;
	return state.issues.find((issue) => issue.field === field)?.message ?? null;
}

function formatMinutes(minutes: number): string {
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.round((minutes / 60) * 10) / 10;
	return `${hours} 小时`;
}

function formatDate(date: string): string {
	const parsed = Temporal.PlainDate.from(date);
	return `${parsed.month}月${parsed.day}日`;
}

function formatSchedule(
	item: ProposedScheduleItem,
): { date: string; time: string } {
	const start = Temporal.Instant.from(item.start).toZonedDateTimeISO(item.timeZone);
	const end = Temporal.Instant.from(item.end).toZonedDateTimeISO(item.timeZone);
	return {
		date: `${start.month}月${start.day}日 周${["一", "二", "三", "四", "五", "六", "日"][start.dayOfWeek - 1]}`,
		time: `${start.toPlainTime().toString({ smallestUnit: "minute" })}–${end
			.toPlainTime()
			.toString({ smallestUnit: "minute" })}`,
	};
}

function proposalForm(item: ProposedScheduleItem) {
	const start = Temporal.Instant.from(item.start).toZonedDateTimeISO(item.timeZone);
	const end = Temporal.Instant.from(item.end).toZonedDateTimeISO(item.timeZone);
	return {
		title: item.title,
		date: start.toPlainDate().toString(),
		startTime: start.toPlainTime().toString({ smallestUnit: "minute" }),
		endTime: end.toPlainTime().toString({ smallestUnit: "minute" }),
	};
}

function toInstant(date: string, time: string, timeZone: string): string {
	return Temporal.PlainDateTime.from(`${date}T${time}`)
		.toZonedDateTime(timeZone, { disambiguation: "reject" })
		.toInstant()
		.toString();
}

export function PlanningPage({
	controller,
	onNotify,
	onOpenCalendar,
	renderSchedulePreview,
}: PlanningPageProps) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const [editingId, setEditingId] = useState<string | null>(null);
	const notifiedSuccessRef = useRef<string | null>(null);
	const activeStep = currentStep(state);
	const activeStepIndex = steps.findIndex((step) => step.id === activeStep);

	useEffect(() => {
		if (
			state.status === "success" &&
			notifiedSuccessRef.current !==
				`${state.planTitle}:${state.committedCount}`
		) {
			notifiedSuccessRef.current = `${state.planTitle}:${state.committedCount}`;
			onNotify(`已把 ${state.committedCount} 项安排写入日历。`);
		}
	}, [onNotify, state]);

	const currentDraft =
		state.status === "review" ||
		state.status === "applying" ||
		state.status === "partial-failure"
			? state.draft
			: null;
	const editingItem =
		currentDraft?.proposals.find((item) => item.id === editingId) ?? null;

	return (
		<div className="planning-page">
			<PageHeader
				eyebrow="计划工作台"
				title="制定计划"
				description="先说出目标，再逐步补充约束。所有安排都会以草案形式预览，由你确认后才进入日历。"
				action={
					state.status === "initial" ? (
						<Button
							variant="primary"
							icon={<Sparkles size={16} aria-hidden="true" />}
							onClick={() => controller.start()}
						>
							制定计划
						</Button>
					) : null
				}
			/>

			{state.status === "initial" ? (
				<InitialPlanning onStart={() => controller.start()} />
			) : (
				<div className="planning-workspace">
					<ol className="planning-progress" aria-label="制定计划进度">
						{steps.map((step, index) => (
							<li
								key={step.id}
								className={[
									index === activeStepIndex ? "is-active" : "",
									index < activeStepIndex ? "is-complete" : "",
								]
									.filter(Boolean)
									.join(" ")}
								aria-current={index === activeStepIndex ? "step" : undefined}
							>
								<span className="planning-progress__index" aria-hidden="true">
									{index < activeStepIndex ? <Check size={13} /> : index + 1}
								</span>
								<span>{step.label}</span>
							</li>
						))}
					</ol>

					<div className="planning-stage" aria-live="polite">
						{state.status === "drafting" ? (
							<DraftingStage state={state} controller={controller} />
						) : null}
						{state.status === "generating" ? (
							<GeneratingStage state={state} onCancel={() => controller.cancel()} />
						) : null}
						{state.status === "generation-error" ? (
							<GenerationErrorStage
								message={state.message}
								onRetry={() => void controller.retryGeneration()}
								onAdjust={() => controller.editConstraints()}
								onCancel={() => controller.cancel()}
							/>
						) : null}
						{state.status === "restore-error" ? (
							<RestoreErrorStage
								message={state.message}
								onRetry={() => void controller.retryRestore()}
							/>
						) : null}
						{state.status === "clarifying" ? (
							<ClarificationStage state={state} controller={controller} />
						) : null}
						{state.status === "empty-draft" ? (
							<EmptyDraftStage
								message={state.message}
								suggestions={state.suggestions}
								onAdjust={() => controller.editConstraints()}
								onRetry={() => void controller.retryGeneration()}
								onCancel={() => controller.cancel()}
							/>
						) : null}
						{state.status === "review" && state.step === "structure" ? (
							<StructureStage
								state={state}
								onContinue={() => controller.openSchedule()}
								onRegenerate={() => void controller.generate()}
								onCancel={() => controller.cancel()}
							/>
						) : null}
						{state.status === "review" && state.step === "schedule" ? (
							<ScheduleStage
								state={state}
								renderSchedulePreview={renderSchedulePreview}
								onBack={() => controller.back()}
								onChange={(id, patch) => controller.updateProposal(id, patch)}
								onEdit={setEditingId}
								onDelete={(id) => controller.deleteProposal(id)}
								onRegenerate={() => void controller.generate()}
								onContinue={() => controller.openConfirm()}
								onCancel={() => controller.cancel()}
							/>
						) : null}
						{state.status === "review" && state.step === "confirm" ? (
							<ConfirmStage
								state={state}
								onBack={() => controller.back()}
								onApply={() => void controller.apply()}
								onCancel={() => controller.cancel()}
							/>
						) : null}
						{state.status === "applying" ? <ApplyingStage state={state} /> : null}
						{state.status === "partial-failure" ? (
							<ApplyFailureStage
								state={state}
								onRetry={() => void controller.retryApply()}
								onAdjust={() => controller.returnToSchedule()}
							/>
						) : null}
						{state.status === "success" ? (
							<SuccessStage
								state={state}
								onOpenCalendar={onOpenCalendar}
								onStartNew={() => controller.start()}
							/>
						) : null}
						{state.status === "cancelled" ? (
							<CancelledStage
								message={state.message}
								onStart={() => controller.start()}
								onClose={() => controller.reset()}
							/>
						) : null}
					</div>
				</div>
			)}

			{editingItem ? (
				<ProposalEditor
					item={editingItem}
					onClose={() => setEditingId(null)}
					onDelete={() => {
						controller.deleteProposal(editingItem.id);
						setEditingId(null);
					}}
					onSave={(patch) => {
						controller.updateProposal(editingItem.id, patch);
						setEditingId(null);
					}}
				/>
			) : null}
		</div>
	);
}

function ClarificationStage({
	state,
	controller,
}: {
	state: Extract<PlanningState, { status: "clarifying" }>;
	controller: PlanningController;
}) {
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [showErrors, setShowErrors] = useState(false);

	useEffect(() => {
		setAnswers({});
		setShowErrors(false);
	}, [state.sessionId]);

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (state.questions.some((question) => question.required && !answers[question.key]?.trim())) {
			setShowErrors(true);
			return;
		}
		const payload: TaskPlanningAnswer[] = state.questions
			.map((question) => ({ questionKey: question.key, answerText: answers[question.key]?.trim() ?? "" }))
			.filter((answer) => answer.answerText.length > 0);
		void controller.submitClarificationAnswers(payload);
	}

	return (
		<section className="planning-card planning-card--form" aria-labelledby="planning-clarification-title">
			<div className="planning-card__heading">
				<span>补充</span>
				<div>
					<p>任务拆分 Agent 还需要一点上下文</p>
					<h2 id="planning-clarification-title">补充这些信息后，我就开始拆分</h2>
				</div>
			</div>
			<form onSubmit={submit}>
				<div className="planning-clarification-fields">
					{state.questions.map((question) => {
						const id = `planning-question-${question.key}`;
						const invalid = showErrors && question.required && !answers[question.key]?.trim();
						return (
							<div className="planning-field" key={question.key}>
								<label htmlFor={id}>{question.text}{question.required ? "（必填）" : "（可选）"}</label>
								<textarea
									id={id}
									rows={3}
									value={answers[question.key] ?? ""}
									aria-invalid={invalid}
									onChange={(event) => {
										const value = event.currentTarget.value;
										setAnswers((current) => ({ ...current, [question.key]: value }));
									}}
								/>
								{invalid ? <p className="planning-field__error">请先回答这个问题。</p> : null}
							</div>
						);
					})}
				</div>
				<div className="planning-card__actions">
					<Button variant="ghost" type="button" onClick={() => controller.editConstraints()}>返回调整约束</Button>
					<Button variant="primary" type="submit" icon={<Sparkles size={16} aria-hidden="true" />}>继续拆分</Button>
				</div>
			</form>
		</section>
	);
}

function InitialPlanning({ onStart }: { onStart: () => void }) {
	return (
		<div className="planning-page__content">
			<section className="planning-empty-panel" aria-label="计划空状态">
				<EmptyState
					className="planning-empty-state"
					icon={<Target size={22} />}
					eyebrow="自然语言开始"
					title="你想完成什么？"
					description="不用先面对一张长表。告诉 WhaleHall 一个目标，我们再一起确认类型、截止日期和可投入时间。"
					action={
						<Button
							variant="primary"
							icon={<ArrowRight size={16} aria-hidden="true" />}
							onClick={onStart}
						>
							制定第一个计划
						</Button>
					}
				/>
			</section>
			<section className="planning-principles" aria-label="计划方式">
				<div>
					<Target size={17} aria-hidden="true" />
					<strong>一句目标</strong>
					<span>先说清想达成的结果</span>
				</div>
				<div>
					<Clock3 size={17} aria-hidden="true" />
					<strong>逐步补充</strong>
					<span>只在需要时询问约束</span>
				</div>
				<div>
					<CalendarCheck2 size={17} aria-hidden="true" />
					<strong>确认后写入</strong>
					<span>草案永远不会自动污染日历</span>
				</div>
			</section>
		</div>
	);
}

function DraftingStage({
	state,
	controller,
}: {
	state: Extract<PlanningState, { status: "drafting" }>;
	controller: PlanningController;
}) {
	const stepNumber =
		state.step === "describe" ? "01" : state.step === "type" ? "02" : "03";
	return (
		<section className="planning-card planning-card--form">
			<div className="planning-card__heading">
				<span>{stepNumber}</span>
				<div>
					<p>{state.step === "describe" ? "从自然语言开始" : "只补充必要信息"}</p>
					<h2>
						{state.step === "describe"
							? "你想完成什么？"
							: state.step === "type"
								? "这是长期目标，还是近期任务？"
								: "告诉我可以怎样安排"}
					</h2>
				</div>
			</div>

			{state.step === "describe" ? (
				<div className="planning-field">
					<label htmlFor="plan-goal">目标描述</label>
					<textarea
						id="plan-goal"
						rows={5}
						autoFocus
						value={state.input.goal}
						placeholder="例如：在 9 月前完成个人作品集并准备好求职材料"
						aria-describedby="plan-goal-help plan-goal-error"
						aria-invalid={Boolean(issueFor(state, "goal"))}
						onChange={(event) =>
							controller.updateInput({ goal: event.currentTarget.value })
						}
						onKeyDown={(event) => {
							if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
								controller.next();
							}
						}}
					/>
					<small id="plan-goal-help">按 Ctrl/⌘ Enter 继续。先描述结果，不必自己拆任务。</small>
					{issueFor(state, "goal") ? (
						<p id="plan-goal-error" className="planning-field__error">
							{issueFor(state, "goal")}
						</p>
					) : null}
				</div>
			) : null}

			{state.step === "type" ? (
				<div className="planning-type-options" role="radiogroup" aria-label="计划类型">
					<button
						type="button"
						role="radio"
						aria-checked={state.input.type === "long-term"}
						onClick={() => controller.updateInput({ type: "long-term" })}
					>
						<Flag size={19} aria-hidden="true" />
						<span>
							<strong>长期计划</strong>
							<small>先拆阶段与里程碑，只精排接下来 1–2 周。</small>
						</span>
						<CheckCircle2 size={17} aria-hidden="true" />
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={state.input.type === "short-term"}
						onClick={() => controller.updateInput({ type: "short-term" })}
					>
						<Clock3 size={19} aria-hidden="true" />
						<span>
							<strong>短期计划</strong>
							<small>直接拆成近期任务，并检查日历中的可用时间。</small>
						</span>
						<CheckCircle2 size={17} aria-hidden="true" />
					</button>
					{issueFor(state, "type") ? (
						<p className="planning-field__error">{issueFor(state, "type")}</p>
					) : null}
				</div>
			) : null}

			{state.step === "constraints" ? (
				<ConstraintsForm
					input={state.input}
					deadlineError={issueFor(state, "deadline")}
					capacityError={issueFor(state, "weeklyCapacityHours")}
					onChange={(patch) => controller.updateInput(patch)}
				/>
			) : null}

			<div className="planning-card__actions">
				<Button
					variant="ghost"
					icon={<X size={15} aria-hidden="true" />}
					onClick={() => controller.cancel()}
				>
					取消
				</Button>
				<div>
					{state.step !== "describe" ? (
						<Button
							variant="secondary"
							icon={<ArrowLeft size={15} aria-hidden="true" />}
							onClick={() => controller.back()}
						>
							上一步
						</Button>
					) : null}
					<Button
						variant="primary"
						icon={
							state.step === "constraints" ? (
								<Sparkles size={15} aria-hidden="true" />
							) : (
								<ArrowRight size={15} aria-hidden="true" />
							)
						}
						onClick={() => controller.next()}
					>
						{state.step === "constraints" ? "生成计划草案" : "继续"}
					</Button>
				</div>
			</div>
		</section>
	);
}

function ConstraintsForm({
	input,
	deadlineError,
	capacityError,
	onChange,
}: {
	input: PlanInput;
	deadlineError: string | null;
	capacityError: string | null;
	onChange: (patch: Partial<PlanInput>) => void;
}) {
	return (
		<div className="planning-constraints">
			<div className="planning-field">
				<label htmlFor="plan-deadline">截止日期</label>
				<input
					id="plan-deadline"
					type="date"
					value={input.deadline}
					aria-invalid={Boolean(deadlineError)}
					onChange={(event) => onChange({ deadline: event.currentTarget.value })}
				/>
				{deadlineError ? (
					<p className="planning-field__error">{deadlineError}</p>
				) : null}
			</div>
			<div className="planning-field">
				<label htmlFor="plan-capacity">每周可投入（小时）</label>
				<input
					id="plan-capacity"
					type="number"
					min={1}
					max={40}
					value={input.weeklyCapacityHours}
					aria-invalid={Boolean(capacityError)}
					onChange={(event) =>
						onChange({ weeklyCapacityHours: Number(event.currentTarget.value) })
					}
				/>
				{capacityError ? (
					<p className="planning-field__error">{capacityError}</p>
				) : null}
			</div>
			<div className="planning-field">
				<label htmlFor="plan-priority">优先级</label>
				<select
					id="plan-priority"
					value={input.priority}
					onChange={(event) =>
						onChange({
							priority: event.currentTarget.value as PlanInput["priority"],
						})
					}
				>
					<option value="high">高 · 优先保护时间</option>
					<option value="medium">中 · 平衡安排</option>
					<option value="low">低 · 有空再推进</option>
				</select>
			</div>
			<div className="planning-field">
				<label htmlFor="plan-session">单次专注时长</label>
				<select
					id="plan-session"
					value={input.preferredSessionMinutes}
					onChange={(event) =>
						onChange({
							preferredSessionMinutes: Number(
								event.currentTarget.value,
							) as PlanInput["preferredSessionMinutes"],
						})
					}
				>
					<option value={30}>30 分钟</option>
					<option value={45}>45 分钟</option>
					<option value={60}>60 分钟</option>
					<option value={90}>90 分钟</option>
				</select>
			</div>
			<fieldset className="planning-choice-group">
				<legend>偏好时段</legend>
				<div>
					{[
						["morning", "上午"],
						["afternoon", "下午"],
						["evening", "晚上"],
						["flexible", "灵活"],
					].map(([value, label]) => (
						<label key={value}>
							<input
								type="radio"
								name="preferred-day-part"
								value={value}
								checked={input.preferredDayPart === value}
								onChange={() =>
									onChange({
										preferredDayPart:
											value as PlanInput["preferredDayPart"],
									})
								}
							/>
							<span>{label}</span>
						</label>
					))}
				</div>
			</fieldset>
			<fieldset className="planning-choice-group planning-choice-group--days">
				<legend>不安排的日期</legend>
				<div>
					{weekdayOptions.map((weekday) => {
						const checked = input.unavailableDays.includes(weekday.id);
						return (
							<label key={weekday.id}>
								<input
									type="checkbox"
									checked={checked}
									onChange={() =>
										onChange({
											unavailableDays: checked
												? input.unavailableDays.filter(
														(item) => item !== weekday.id,
													)
												: [...input.unavailableDays, weekday.id],
										})
									}
								/>
								<span>{weekday.label}</span>
							</label>
						);
					})}
				</div>
			</fieldset>
		</div>
	);
}

function GeneratingStage({
	state,
	onCancel,
}: {
	state: Extract<PlanningState, { status: "generating" }>;
	onCancel: () => void;
}) {
	return (
		<section className="planning-card planning-generation" aria-busy="true">
			<div className="planning-generation__mark">
				<LoaderCircle size={24} aria-hidden="true" />
			</div>
			<p>正在形成计划草案</p>
			<h2>从目标到可以开始的安排</h2>
			<ul>
				{Object.entries(generationStatusLabels).map(([status, label]) => {
					const completed = state.completedStatuses.includes(
						status as keyof typeof generationStatusLabels,
					);
					const active = state.activeStatus === status;
					return (
						<li
							key={status}
							className={completed ? "is-complete" : active ? "is-active" : ""}
						>
							<span>{completed ? <Check size={13} /> : null}</span>
							{label}
							{active ? <small>进行中</small> : null}
						</li>
					);
				})}
			</ul>
			<p className="planning-generation__note">
				这里展示的是产品进度，不会暴露模型的内部推理过程。
			</p>
			<Button variant="ghost" onClick={onCancel}>
				取消生成
			</Button>
		</section>
	);
}

function GenerationErrorStage({
	message,
	onRetry,
	onAdjust,
	onCancel,
}: {
	message: string;
	onRetry: () => void;
	onAdjust: () => void;
	onCancel: () => void;
}) {
	return (
		<FeedbackStage
			tone="error"
			icon={<AlertTriangle size={22} />}
			eyebrow="生成失败"
			title="这次没有得到可用草案"
			description={message}
			actions={
				<>
					<Button variant="primary" icon={<RefreshCw size={15} />} onClick={onRetry}>
						重试生成
					</Button>
					<Button onClick={onAdjust}>调整约束</Button>
					<Button variant="ghost" onClick={onCancel}>
						取消
					</Button>
				</>
			}
		/>
	);
}

function EmptyDraftStage({
	message,
	suggestions,
	onAdjust,
	onRetry,
	onCancel,
}: {
	message: string;
	suggestions: readonly string[];
	onAdjust: () => void;
	onRetry: () => void;
	onCancel: () => void;
}) {
	return (
		<section className="planning-card planning-feedback">
			<div className="planning-feedback__icon">
				<Clock3 size={22} aria-hidden="true" />
			</div>
			<p>暂无可安排草案</p>
			<h2>{message}</h2>
			<ul className="planning-suggestions">
				{suggestions.map((suggestion) => (
					<li key={suggestion}>{suggestion}</li>
				))}
			</ul>
			<div className="planning-feedback__actions">
				<Button variant="primary" onClick={onAdjust}>
					调整约束
				</Button>
				<Button onClick={onRetry}>重新尝试</Button>
				<Button variant="ghost" onClick={onCancel}>
					取消
				</Button>
			</div>
		</section>
	);
}

function StructureStage({
	state,
	onContinue,
	onRegenerate,
	onCancel,
}: {
	state: Extract<PlanningState, { status: "review" }>;
	onContinue: () => void;
	onRegenerate: () => void;
	onCancel: () => void;
}) {
	const { plan } = state.draft;
	return (
		<section className="planning-review">
			<div className="planning-review__header">
				<div>
					<p>计划结构 · 草案</p>
					<h2>{plan.title}</h2>
					<span>
						{plan.type === "long-term"
							? `长期计划 · 截止 ${formatDate(plan.deadline)}`
							: `短期计划 · 截止 ${formatDate(plan.deadline)}`}
					</span>
				</div>
				<div className="planning-review__actions">
					<Button variant="ghost" onClick={onCancel}>
						取消
					</Button>
					<Button
						variant="secondary"
						icon={<RefreshCw size={15} />}
						onClick={onRegenerate}
					>
						重新生成
					</Button>
					<Button
						variant="primary"
						icon={<ArrowRight size={15} />}
						onClick={onContinue}
					>
						审阅日程
					</Button>
				</div>
			</div>

			{plan.type === "long-term" ? (
				<div className="planning-long-summary">
					<div>
						<span>总目标</span>
						<strong>{plan.goal}</strong>
					</div>
					<div>
						<span>阶段</span>
						<strong>{plan.phases.length} 个阶段</strong>
					</div>
					<div>
						<span>当前精排窗口</span>
						<strong>
							{formatDate(plan.scheduleWindow.startDate)}–{formatDate(
								Temporal.PlainDate.from(plan.scheduleWindow.endDateExclusive)
									.subtract({ days: 1 })
									.toString(),
							)}
						</strong>
					</div>
				</div>
			) : null}

			<div className="planning-phase-list">
				{plan.phases.map((phase) => {
					const milestone = plan.milestones.find(
						(item) => item.phaseId === phase.id,
					);
					const tasks = plan.tasks.filter((task) => task.phaseId === phase.id);
					return (
						<article key={phase.id}>
							<div className="planning-phase-list__rail">
								<span>{String(phase.order).padStart(2, "0")}</span>
							</div>
							<div>
								<div className="planning-phase-list__heading">
									<div>
										<h3>{phase.title}</h3>
										<p>{phase.objective}</p>
									</div>
									{milestone ? (
										<span className="planning-milestone">
											<Flag size={13} /> {milestone.title} ·{" "}
											{formatDate(milestone.targetDate)}
										</span>
									) : null}
								</div>
								<ul>
									{tasks.map((task) => (
										<li key={task.id}>
											<Check size={13} aria-hidden="true" />
											<span>{task.title}</span>
											<small>{formatMinutes(task.estimatedMinutes)}</small>
										</li>
									))}
								</ul>
							</div>
						</article>
					);
				})}
			</div>
			{plan.type === "long-term" ? (
				<p className="planning-rolling-note">
					后续阶段会按实际进度滚动安排，不会一次生成数月的僵硬日程。
				</p>
			) : null}
		</section>
	);
}

function ScheduleStage({
	state,
	renderSchedulePreview,
	onBack,
	onChange,
	onEdit,
	onDelete,
	onRegenerate,
	onContinue,
	onCancel,
}: {
	state: Extract<PlanningState, { status: "review" }>;
	renderSchedulePreview: PlanningPageProps["renderSchedulePreview"];
	onBack: () => void;
	onChange: PlanningSchedulePreviewProps["onChange"];
	onEdit: (id: string) => void;
	onDelete: (id: string) => void;
	onRegenerate: () => void;
	onContinue: () => void;
	onCancel: () => void;
}) {
	const blocking = planHasBlockingConflicts(state.draft.conflicts);
	const blockingCount = state.draft.conflicts.filter(
		(conflict) => conflict.severity === "error",
	).length;
	const warningCount = state.draft.conflicts.filter(
		(conflict) => conflict.severity === "warning",
	).length;
	return (
		<section className="planning-review planning-review--schedule">
			<div className="planning-review__header">
				<div>
					<p>日程草案 · 尚未写入</p>
					<h2>调整接下来可以开始的安排</h2>
					<span>拖动改时间，拖拽底边改时长；点击日程可精确编辑。</span>
				</div>
				<div className="planning-review__actions">
					<Button variant="ghost" onClick={onCancel}>
						取消
					</Button>
					<Button
						variant="secondary"
						icon={<RefreshCw size={15} />}
						onClick={onRegenerate}
					>
						重新生成
					</Button>
				</div>
			</div>

			{state.message ? (
				<div className="planning-inline-notice" role="status">
					<AlertTriangle size={15} aria-hidden="true" />
					<span>{state.message}</span>
				</div>
			) : null}
			{state.draft.conflicts.length > 0 ? (
				<div
					className={[
						"planning-conflicts",
						blocking ? "planning-conflicts--blocking" : "",
					]
						.filter(Boolean)
						.join(" ")}
					role="alert"
				>
					<AlertTriangle size={17} aria-hidden="true" />
					<div>
						<strong>
							{blocking
								? `发现 ${blockingCount} 项不可用时间冲突`
								: `有 ${warningCount} 项与已确认计划重叠`}
						</strong>
						{state.draft.conflicts.map((conflict) => (
							<p key={`${conflict.proposalId}:${conflict.busyWindowId}`}>
								{conflict.message}
							</p>
						))}
					</div>
				</div>
			) : null}

			<div className="planning-schedule-layout">
				<div className="planning-schedule-list" aria-label="计划草案列表">
					<div className="planning-schedule-list__heading">
						<strong>{state.draft.proposals.length} 项待确认安排</strong>
						<span>删除只影响草案</span>
					</div>
					{state.draft.proposals.map((item) => {
						const schedule = formatSchedule(item);
						const conflict = state.draft.conflicts.find(
							(entry) => entry.proposalId === item.id,
						);
						return (
							<article key={item.id}>
								<div>
									<strong>{item.title}</strong>
									<span>{schedule.date}</span>
									<small>{schedule.time}</small>
									{conflict ? <em>{conflict.message}</em> : null}
								</div>
								<div>
									<button
										type="button"
										className="ui-icon-button"
										aria-label={`编辑 ${item.title}`}
										onClick={() => onEdit(item.id)}
									>
										<Pencil size={15} />
									</button>
									<button
										type="button"
										className="ui-icon-button"
										aria-label={`从草案删除 ${item.title}`}
										onClick={() => onDelete(item.id)}
									>
										<Trash2 size={15} />
									</button>
								</div>
							</article>
						);
					})}
				</div>
				{renderSchedulePreview({
					proposals: state.draft.proposals,
					busyWindows: state.draft.busyWindows,
					timeZone:
						state.draft.proposals[0]?.timeZone ??
						state.draft.busyWindows[0]?.timeZone ??
						"Asia/Shanghai",
					initialDate: state.draft.plan.scheduleWindow.startDate,
					onChange,
					onEdit,
				})}
			</div>

			<div className="planning-review__footer">
				<Button icon={<ArrowLeft size={15} />} onClick={onBack}>
					返回结构
				</Button>
				<div>
					<span>此刻正式日历仍未改变</span>
					<Button
						variant="primary"
						icon={<ArrowRight size={15} />}
						disabled={blocking || state.draft.proposals.length === 0}
						onClick={onContinue}
					>
						进入确认
					</Button>
				</div>
			</div>
		</section>
	);
}

function ConfirmStage({
	state,
	onBack,
	onApply,
	onCancel,
}: {
	state: Extract<PlanningState, { status: "review" }>;
	onBack: () => void;
	onApply: () => void;
	onCancel: () => void;
}) {
	return (
		<section className="planning-card planning-confirm">
			<div className="planning-confirm__icon">
				<CalendarCheck2 size={23} aria-hidden="true" />
			</div>
			<p>最后确认</p>
			<h2>将 {state.draft.proposals.length} 项草案写入正式日历？</h2>
			<span>
				计划“{state.draft.plan.title}”会保留来源标记。写入将作为一次完整操作执行，
				失败时不会留下半套安排。
			</span>
			<div className="planning-confirm__summary">
				<div>
					<Clock3 size={16} />
					<span>近期安排</span>
					<strong>{state.draft.proposals.length} 项</strong>
				</div>
				<div>
					<Target size={16} />
					<span>预计投入</span>
					<strong>
						{formatMinutes(
							state.draft.proposals.reduce((total, item) => {
								return (
									total +
									Number(
										Temporal.Instant.from(item.start)
											.until(Temporal.Instant.from(item.end), {
												largestUnit: "minute",
											})
											.total({ unit: "minute" }),
									)
								);
							}, 0),
						)}
					</strong>
				</div>
			</div>
			{state.draft.conflicts.some(
				(conflict) => conflict.severity === "warning",
			) ? (
				<div className="planning-inline-notice">
					<AlertTriangle size={15} />
					<span>包含与已确认计划重叠的提醒；你仍可决定写入。</span>
				</div>
			) : null}
			<div className="planning-confirm__actions">
				<Button variant="ghost" onClick={onCancel}>
					取消计划
				</Button>
				<Button icon={<ArrowLeft size={15} />} onClick={onBack}>
					返回调整
				</Button>
				<Button
					variant="primary"
					icon={<CalendarCheck2 size={15} />}
					onClick={onApply}
				>
					确认并写入日历
				</Button>
			</div>
		</section>
	);
}

function ApplyingStage({
	state,
}: {
	state: Extract<PlanningState, { status: "applying" }>;
}) {
	return (
		<section className="planning-card planning-generation" aria-busy="true">
			<div className="planning-generation__mark">
				<LoaderCircle size={24} aria-hidden="true" />
			</div>
			<p>正在写入日历</p>
			<h2>正在原子确认 {state.draft.proposals.length} 项安排</h2>
			<span>请稍候。完成前不会显示为已确认日程。</span>
		</section>
	);
}

function ApplyFailureStage({
	state,
	onRetry,
	onAdjust,
}: {
	state: Extract<PlanningState, { status: "partial-failure" }>;
	onRetry: () => void;
	onAdjust: () => void;
}) {
	return (
		<FeedbackStage
			tone="error"
			icon={<AlertTriangle size={22} />}
			eyebrow={
				state.result.calendarState === "unknown"
					? "提交结果待恢复"
					: state.result.kind === "partial"
						? "部分写入失败"
						: "写入失败"
			}
			title={
				state.result.calendarState === "unknown"
					? "本地提交状态已经保留"
					: state.result.kind === "partial"
					? `已写入 ${state.result.committedCount} 项，另有 ${state.result.failedProposalIds.length} 项失败`
					: "正式日历没有改变"
			}
			description={state.result.message}
			actions={
				<>
					<Button variant="primary" onClick={onRetry}>
						重试写入
					</Button>
					<Button onClick={onAdjust}>返回调整</Button>
				</>
			}
		/>
	);
}

function SuccessStage({
	state,
	onOpenCalendar,
	onStartNew,
}: {
	state: Extract<PlanningState, { status: "success" }>;
	onOpenCalendar: () => void;
	onStartNew: () => void;
}) {
	return (
		<FeedbackStage
			tone="success"
			icon={<CheckCircle2 size={23} />}
			eyebrow="计划已确认"
			title={`“${state.planTitle}”已进入日历`}
			description={state.effectWarning
				? `成功写入 ${state.committedCount} 项安排。${state.effectWarning}`
				: `成功写入 ${state.committedCount} 项安排。你可以在日历中继续移动、缩放或编辑。`}
			actions={
				<>
					<Button
						variant="primary"
						icon={<CalendarCheck2 size={15} />}
						onClick={onOpenCalendar}
					>
						查看日历
					</Button>
					<Button onClick={onStartNew}>再制定一个计划</Button>
				</>
			}
		/>
	);
}

function RestoreErrorStage({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<FeedbackStage
			tone="error"
			icon={<AlertTriangle size={22} />}
			eyebrow="本地计划暂不可用"
			title="没有丢弃任何草案或提交状态"
			description={message}
			actions={
				<Button variant="primary" onClick={onRetry}>重试恢复</Button>
			}
		/>
	);
}

function CancelledStage({
	message,
	onStart,
	onClose,
}: {
	message: string;
	onStart: () => void;
	onClose: () => void;
}) {
	return (
		<FeedbackStage
			tone="neutral"
			icon={<X size={22} />}
			eyebrow="已取消"
			title="正式日历保持原样"
			description={message}
			actions={
				<>
					<Button variant="primary" onClick={onStart}>
						重新制定
					</Button>
					<Button variant="ghost" onClick={onClose}>
						返回计划首页
					</Button>
				</>
			}
		/>
	);
}

function FeedbackStage({
	tone,
	icon,
	eyebrow,
	title,
	description,
	actions,
}: {
	tone: "error" | "success" | "neutral";
	icon: ReactNode;
	eyebrow: string;
	title: string;
	description: string;
	actions: ReactNode;
}) {
	return (
		<section
			className={`planning-card planning-feedback planning-feedback--${tone}`}
		>
			<div className="planning-feedback__icon">{icon}</div>
			<p>{eyebrow}</p>
			<h2>{title}</h2>
			<span>{description}</span>
			<div className="planning-feedback__actions">{actions}</div>
		</section>
	);
}

export function ProposalEditor({
	item,
	onClose,
	onDelete,
	onSave,
}: {
	item: ProposedScheduleItem;
	onClose: () => void;
	onDelete: () => void;
	onSave: (
		patch: Pick<ProposedScheduleItem, "title" | "start" | "end">,
	) => void;
}) {
	const [form, setForm] = useState(() => proposalForm(item));
	const [error, setError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const titleId = useMemo(() => `proposal-editor-${item.id}`, [item.id]);

	useEffect(() => {
		closeButtonRef.current?.focus();
	}, []);

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== "Tab") return;
		const focusable = Array.from(
			dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
			) ?? [],
		);
		if (focusable.length === 0) return;
		const first = focusable[0]!;
		const last = focusable[focusable.length - 1]!;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function save() {
		try {
			const start = toInstant(form.date, form.startTime, item.timeZone);
			const end = toInstant(form.date, form.endTime, item.timeZone);
			if (!form.title.trim()) {
				setError("标题不能为空。");
				return;
			}
			if (
				Temporal.Instant.compare(
					Temporal.Instant.from(start),
					Temporal.Instant.from(end),
				) >= 0
			) {
				setError("结束时间必须晚于开始时间。");
				return;
			}
			onSave({ title: form.title.trim(), start, end });
		} catch {
			setError("这个本地时间无效，请检查日期或夏令时切换。");
		}
	}

	return (
		<div className="planning-dialog-scrim" onMouseDown={onClose}>
			<div
				className="planning-dialog"
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				onKeyDown={handleKeyDown}
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div className="planning-dialog__header">
					<div>
						<p>日程草案</p>
						<h2 id={titleId}>精确调整安排</h2>
					</div>
					<button
						ref={closeButtonRef}
						type="button"
						className="ui-icon-button"
						aria-label="关闭编辑"
						onClick={onClose}
					>
						<X size={17} />
					</button>
				</div>
				<div className="planning-dialog__body">
					<div className="planning-field">
						<label htmlFor="proposal-title">标题</label>
						<input
							id="proposal-title"
							value={form.title}
							onChange={(event) =>
								setForm({ ...form, title: event.currentTarget.value })
							}
						/>
					</div>
					<div className="planning-field">
						<label htmlFor="proposal-date">日期</label>
						<input
							id="proposal-date"
							type="date"
							value={form.date}
							onChange={(event) =>
								setForm({ ...form, date: event.currentTarget.value })
							}
						/>
					</div>
					<div className="planning-dialog__time-grid">
						<div className="planning-field">
							<label htmlFor="proposal-start">开始</label>
							<input
								id="proposal-start"
								type="time"
								value={form.startTime}
								onChange={(event) =>
									setForm({ ...form, startTime: event.currentTarget.value })
								}
							/>
						</div>
						<div className="planning-field">
							<label htmlFor="proposal-end">结束</label>
							<input
								id="proposal-end"
								type="time"
								value={form.endTime}
								onChange={(event) =>
									setForm({ ...form, endTime: event.currentTarget.value })
								}
							/>
						</div>
					</div>
					{error ? (
						<p className="planning-field__error" role="alert">
							{error}
						</p>
					) : null}
					<p className="planning-dialog__note">
						保存只更新草案；正式日历仍要在下一步确认。
					</p>
				</div>
				<div className="planning-dialog__actions">
					<Button
						variant="danger"
						icon={<Trash2 size={15} />}
						onClick={onDelete}
					>
						从草案删除
					</Button>
					<div>
						<Button variant="ghost" onClick={onClose}>
							取消
						</Button>
						<Button variant="primary" onClick={save}>
							保存草案
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
