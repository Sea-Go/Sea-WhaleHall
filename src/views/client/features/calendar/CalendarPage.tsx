import {
	AlertTriangle,
	CalendarDays,
	Check,
	ChevronLeft,
	ChevronRight,
	Clock3,
	CloudOff,
	LockKeyhole,
	Plus,
	RotateCcw,
	Search,
	SquarePen,
	Trash2,
	X,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import { CalendarController } from "./CalendarController";
import type { CalendarService } from "./calendar-service";
import {
	addMinutes,
	addMinutesToLocalDateTime,
	calendarRangeLabel,
	durationMinutes,
	instantToLocalParts,
	miniCalendarDays,
	monthLabel,
	moveMonth,
	resolveLocalDateTime,
	timeZoneOffsetLabel,
} from "./date-time";
import {
	type CalendarEvent,
	type CalendarEventKind,
	type CalendarEventState,
	canUserUnlockPlanEvent,
	cloneCalendarEvent,
	type RecurrenceScope,
	withOccurrenceException,
} from "./domain";
import {
	CALENDAR_REFERENCE_DATE,
	CALENDAR_SCENARIOS,
	type CalendarScenarioId,
} from "./fixtures";
import {
	type CalendarOccurrenceSelection,
	type CalendarRange,
	type CalendarSelectionDraft,
	type CalendarView,
	WhaleCalendar,
	type WhaleCalendarHandle,
} from "./fullcalendar-adapter";

const calendarViewLabels: Record<CalendarView, string> = {
	day: "日",
	week: "周",
	month: "月",
};
const calendarViews = ["day", "week", "month"] as const;
const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

const sourceOptions: ReadonlyArray<{
	id: CalendarEventKind;
	label: string;
	className: string;
}> = [
	{ id: "plan", label: "我的计划", className: "plan" },
	{ id: "manual-block", label: "手动占用", className: "manual" },
	{ id: "external", label: "外部日历", className: "external" },
	{ id: "break", label: "休息与恢复", className: "break" },
];

export interface EditorState {
	event: CalendarEvent | null;
	selection: CalendarSelectionDraft | null;
	occurrenceStart: string | null;
	presetKind: CalendarEventKind;
	returnFocus: HTMLElement | null;
}

interface EditorForm {
	title: string;
	kind: Exclude<CalendarEventKind, "external">;
	state: CalendarEventState;
	allDay: boolean;
	startDate: string;
	endDate: string;
	startTime: string;
	endTime: string;
	recurring: boolean;
	scope: RecurrenceScope;
	disambiguation: "earlier" | "later";
}

function initialEditorForm(editor: EditorState, timeZone: string): EditorForm {
	const event = editor.event;
	const schedule = event?.schedule ?? editor.selection?.schedule;
	let startDate = CALENDAR_REFERENCE_DATE;
	let endDate = CALENDAR_REFERENCE_DATE;
	let startTime = "09:00";
	let endTime = "10:00";
	let allDay = false;

	if (schedule?.allDay) {
		allDay = true;
		startDate = schedule.startDate;
		endDate = schedule.endDateExclusive;
	} else if (schedule) {
		const occurrenceStart = editor.occurrenceStart ?? schedule.start;
		const start = instantToLocalParts(occurrenceStart, timeZone);
		const duration = durationMinutes(schedule.start, schedule.end);
		const occurrenceEnd = addMinutes(occurrenceStart, Math.max(15, duration));
		const end = instantToLocalParts(occurrenceEnd, timeZone);
		startDate = start.date;
		startTime = start.time;
		endDate = end.date;
		endTime = end.time;
	}

	return {
		title: event?.title ?? "",
		kind:
			event?.kind === "external"
				? "manual-block"
				: (event?.kind ?? editor.presetKind) === "external"
					? "manual-block"
					: ((event?.kind ?? editor.presetKind) as EditorForm["kind"]),
		state: event?.state ?? "committed",
		allDay,
		startDate,
		endDate,
		startTime,
		endTime,
		recurring: Boolean(event?.recurrence),
		scope: editor.occurrenceStart ? "occurrence" : "series",
		disambiguation: "earlier",
	};
}

function createLocalId(prefix: string): string {
	const id =
		typeof crypto === "undefined"
			? `${Date.now()}-${Math.random().toString(16).slice(2)}`
			: crypto.randomUUID();
	return `${prefix}-${id}`;
}

interface EventEditorProps {
	editor: EditorState;
	timeZone: string;
	pending: boolean;
	onClose: () => void;
	onSave: (
		form: EditorForm,
		setError: (message: string) => void,
	) => Promise<void>;
	onDelete: (
		scope: RecurrenceScope,
		setError: (message: string) => void,
	) => Promise<void>;
	onUnlock?: (setError: (message: string) => void) => Promise<void>;
}

export function EventEditor({
	editor,
	timeZone,
	pending,
	onClose,
	onSave,
	onDelete,
	onUnlock,
}: EventEditorProps) {
	const [form, setForm] = useState(() => initialEditorForm(editor, timeZone));
	const [error, setError] = useState<string | null>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const readOnly = editor.event ? !editor.event.editable : false;
	const startResolution = form.allDay
		? null
		: resolveLocalDateTime(form.startDate, form.startTime, timeZone);
	const endResolution = form.allDay
		? null
		: resolveLocalDateTime(form.endDate, form.endTime, timeZone);
	const hasAmbiguousTime =
		startResolution?.status === "ambiguous" ||
		endResolution?.status === "ambiguous";

	useEffect(() => {
		titleRef.current?.focus();
	}, []);

	function shiftBoundary(boundary: "start" | "end", minutes: number) {
		const date = boundary === "start" ? form.startDate : form.endDate;
		const time = boundary === "start" ? form.startTime : form.endTime;
		const next = addMinutesToLocalDateTime(date, time, minutes);
		setForm((current) =>
			boundary === "start"
				? { ...current, startDate: next.date, startTime: next.time }
				: { ...current, endDate: next.date, endTime: next.time },
		);
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape" && !pending) {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key === "Tab") {
			const focusable = Array.from(
				dialogRef.current?.querySelectorAll<HTMLElement>(
					'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
				) ?? [],
			);
			const first = focusable[0];
			const last = focusable.at(-1);
			if (!first || !last) return;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		await onSave(form, setError);
	}

	return (
		<div className="calendar-dialog-backdrop" role="presentation">
			<div
				className="calendar-dialog"
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="calendar-editor-title"
				onKeyDown={handleKeyDown}
			>
				<header className="calendar-dialog__header">
					<div>
						<span>{editor.event ? "日程详情" : "新建时间安排"}</span>
						<h2 id="calendar-editor-title">
							{readOnly
								? "查看外部日程"
								: editor.event
									? "编辑日程"
									: "创建日程"}
						</h2>
					</div>
					<IconButton
						label="关闭编辑器"
						icon={<X size={17} />}
						disabled={pending}
						onClick={onClose}
					/>
				</header>

				{readOnly ? (
					<div className="calendar-dialog__readonly" role="note">
						<LockKeyhole size={16} aria-hidden="true" />
						<span>此日程来自外部日历，仅可查看。</span>
					</div>
				) : null}

				<form onSubmit={submit}>
					<label className="calendar-field calendar-field--wide">
						<span>标题</span>
						<input
							ref={titleRef}
							value={form.title}
							readOnly={readOnly}
							required
							maxLength={80}
							onChange={(event) =>
								setForm((current) => ({
									...current,
									title: event.target.value,
								}))
							}
						/>
					</label>

					<div className="calendar-form-grid">
						<label className="calendar-field">
							<span>类型</span>
							<select
								value={form.kind}
								disabled={readOnly || editor.event !== null}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										kind: event.target.value as EditorForm["kind"],
									}))
								}
							>
								{editor.event?.kind === "plan" ? (
									<option value="plan">计划日程</option>
								) : null}
								<option value="manual-block">手动占用</option>
								<option value="break">休息与恢复</option>
							</select>
						</label>
						<label className="calendar-field">
							<span>状态</span>
							<select
								value={form.state}
								disabled={readOnly || form.kind === "manual-block"}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										state: event.target.value as CalendarEventState,
									}))
								}
							>
								<option value="committed">已确认</option>
								<option value="proposed">待确认</option>
							</select>
						</label>
					</div>

					<label className="calendar-check">
						<input
							type="checkbox"
							checked={form.allDay}
							disabled={readOnly}
							onChange={(event) =>
								setForm((current) => ({
									...current,
									allDay: event.target.checked,
								}))
							}
						/>
						<span>全天日程</span>
					</label>

					<div className="calendar-form-grid">
						<label className="calendar-field">
							<span>开始日期</span>
							<input
								type="date"
								value={form.startDate}
								readOnly={readOnly}
								required
								onChange={(event) =>
									setForm((current) => ({
										...current,
										startDate: event.target.value,
									}))
								}
							/>
						</label>
						{!form.allDay ? (
							<label className="calendar-field">
								<span>开始时间</span>
								<input
									type="time"
									step={900}
									value={form.startTime}
									readOnly={readOnly}
									required
									onChange={(event) =>
										setForm((current) => ({
											...current,
											startTime: event.target.value,
										}))
									}
								/>
							</label>
						) : null}
						<label className="calendar-field">
							<span>{form.allDay ? "结束日期（不含）" : "结束日期"}</span>
							<input
								type="date"
								value={form.endDate}
								readOnly={readOnly}
								required
								onChange={(event) =>
									setForm((current) => ({
										...current,
										endDate: event.target.value,
									}))
								}
							/>
						</label>
						{!form.allDay ? (
							<label className="calendar-field">
								<span>结束时间</span>
								<input
									type="time"
									step={900}
									value={form.endTime}
									readOnly={readOnly}
									required
									onChange={(event) =>
										setForm((current) => ({
											...current,
											endTime: event.target.value,
										}))
									}
								/>
							</label>
						) : null}
					</div>

					{!form.allDay && !readOnly ? (
						<div
							className="calendar-nudge"
							role="toolbar"
							aria-label="键盘替代操作"
						>
							<span>15 分钟微调</span>
							<Button
								type="button"
								variant="ghost"
								size="small"
								onClick={() => {
									shiftBoundary("start", -15);
									shiftBoundary("end", -15);
								}}
							>
								整体提前
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="small"
								onClick={() => {
									shiftBoundary("start", 15);
									shiftBoundary("end", 15);
								}}
							>
								整体延后
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="small"
								onClick={() => shiftBoundary("end", -15)}
							>
								缩短
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="small"
								onClick={() => shiftBoundary("end", 15)}
							>
								延长
							</Button>
						</div>
					) : null}

					{!readOnly ? (
						<label className="calendar-check">
							<input
								type="checkbox"
								checked={form.recurring}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										recurring: event.target.checked,
									}))
								}
							/>
							<span>每天重复 5 次</span>
						</label>
					) : null}

					{hasAmbiguousTime && !readOnly ? (
						<label className="calendar-field calendar-field--wide">
							<span>夏令时重复小时</span>
							<select
								value={form.disambiguation}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										disambiguation: event.target
											.value as EditorForm["disambiguation"],
									}))
								}
							>
								<option value="earlier">采用第一次出现</option>
								<option value="later">采用第二次出现</option>
							</select>
						</label>
					) : null}

					{editor.event?.recurrence ? (
						<label className="calendar-field calendar-field--wide">
							<span>修改范围</span>
							<select
								value={form.scope}
								disabled={readOnly}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										scope: event.target.value as RecurrenceScope,
									}))
								}
							>
								<option value="occurrence">仅这一次</option>
								<option value="following" disabled>
									本次及以后（即将支持）
								</option>
								<option value="series">整个系列</option>
							</select>
						</label>
					) : null}

					{error ? (
						<div className="calendar-dialog__error" role="alert">
							<AlertTriangle size={15} aria-hidden="true" />
							<span>{error}</span>
						</div>
					) : null}

					<footer className="calendar-dialog__footer">
						<div className="calendar-dialog__footer-actions">
							{editor.event?.editable ? (
								<Button
									type="button"
									variant="danger"
									size="small"
									icon={<Trash2 size={15} aria-hidden="true" />}
									disabled={pending}
									onClick={() => void onDelete(form.scope, setError)}
								>
									删除
								</Button>
							) : (
								<span />
							)}
							{editor.event &&
							canUserUnlockPlanEvent(editor.event) &&
							onUnlock ? (
								<Button
									type="button"
									variant="secondary"
									size="small"
									disabled={pending}
									onClick={() => void onUnlock(setError)}
								>
									允许计划重新安排
								</Button>
							) : null}
						</div>
						<div>
							<Button
								type="button"
								variant="secondary"
								size="small"
								disabled={pending}
								onClick={onClose}
							>
								{readOnly ? "关闭" : "取消"}
							</Button>
							{!readOnly ? (
								<Button
									type="submit"
									variant="primary"
									size="small"
									disabled={pending}
								>
									{pending ? "保存中…" : "保存日程"}
								</Button>
							) : null}
						</div>
					</footer>
				</form>
			</div>
		</div>
	);
}

export interface CalendarPageProps {
	onNotify: (message: string) => void;
	service: CalendarService;
	controller?: CalendarController;
	initialScenario?: CalendarScenarioId | null;
	showScenarioControl?: boolean;
}

export function CalendarPage({
	onNotify,
	service,
	controller: suppliedController,
	initialScenario = "normal",
	showScenarioControl = false,
}: CalendarPageProps) {
	const controller = useMemo(
		() => suppliedController ?? new CalendarController(service),
		[service, suppliedController],
	);
	const calendar = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const calendarRef = useRef<WhaleCalendarHandle>(null);
	const createButtonRef = useRef<HTMLButtonElement>(null);
	const [view, setView] = useState<CalendarView>("week");
	const [range, setRange] = useState<CalendarRange>({
		title: "2026年7月27日 – 8月2日",
		start: CALENDAR_REFERENCE_DATE,
		end: "2026-08-03",
		currentDate: CALENDAR_REFERENCE_DATE,
		view: "week",
	});
	const [miniAnchor, setMiniAnchor] = useState(CALENDAR_REFERENCE_DATE);
	const [query, setQuery] = useState("");
	const [visibleKinds, setVisibleKinds] = useState<Set<CalendarEventKind>>(
		() => new Set(sourceOptions.map((source) => source.id)),
	);
	const [editor, setEditor] = useState<EditorState | null>(null);
	const [editorPending, setEditorPending] = useState(false);

	useEffect(() => {
		void controller.load(initialScenario ?? undefined);
	}, [controller, initialScenario]);

	useEffect(() => {
		if (!service.subscribe) return;
		return service.subscribe(() => {
			void controller.load();
		});
	}, [controller, service]);

	useEffect(() => {
		if (range.currentDate) setMiniAnchor(range.currentDate.slice(0, 10));
	}, [range.currentDate]);

	const miniDays = useMemo(() => miniCalendarDays(miniAnchor), [miniAnchor]);
	const filteredEvents = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase("zh-CN");
		return calendar.events.filter(
			(event) =>
				visibleKinds.has(event.kind) &&
				(!normalized ||
					event.title.toLocaleLowerCase("zh-CN").includes(normalized)),
		);
	}, [calendar.events, query, visibleKinds]);
	const proposedIds = calendar.events
		.filter((event) => event.state === "proposed")
		.map((event) => event.id);

	function openEditor(
		options: Partial<EditorState> & Pick<EditorState, "presetKind">,
	) {
		setEditor({
			event: null,
			selection: null,
			occurrenceStart: null,
			returnFocus:
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: createButtonRef.current,
			...options,
		});
	}

	function closeEditor() {
		const focusTarget = editor?.returnFocus ?? createButtonRef.current;
		setEditor(null);
		window.requestAnimationFrame(() => focusTarget?.focus());
	}

	function selectEvent(selection: CalendarOccurrenceSelection) {
		const event = calendar.events.find(
			(candidate) => candidate.id === selection.eventId,
		);
		if (!event) return;
		openEditor({
			presetKind: event.kind,
			event: cloneCalendarEvent(event),
			occurrenceStart:
				event.recurrence && !event.occurrenceId
					? selection.occurrenceStart
					: null,
		});
	}

	function resolveInstant(
		date: string,
		time: string,
		disambiguation: "earlier" | "later",
	): string | { error: string } {
		const resolution = resolveLocalDateTime(date, time, calendar.timeZone);
		if (resolution.status === "valid") return resolution.instant;
		if (resolution.status === "nonexistent") {
			return { error: "该本地时间处于夏令时跳时区间，请选择其他时间。" };
		}
		return resolution[disambiguation];
	}

	async function saveEditor(
		form: EditorForm,
		setError: (message: string) => void,
	) {
		if (!editor) return;
		const title = form.title.trim();
		if (!title) {
			setError("请输入日程标题。");
			return;
		}
		let schedule: CalendarEvent["schedule"];
		if (form.allDay) {
			if (form.startDate >= form.endDate) {
				setError("全天日程的结束日期（不含）必须晚于开始日期。");
				return;
			}
			schedule = {
				allDay: true,
				startDate: form.startDate,
				endDateExclusive: form.endDate,
			};
		} else {
			const start = resolveInstant(
				form.startDate,
				form.startTime,
				form.disambiguation,
			);
			const end = resolveInstant(
				form.endDate,
				form.endTime,
				form.disambiguation,
			);
			if (typeof start !== "string" || typeof end !== "string") {
				setError(
					typeof start !== "string"
						? start.error
						: (end as { error: string }).error,
				);
				return;
			}
			schedule = {
				allDay: false,
				start,
				end,
				timeZone: calendar.timeZone,
			};
		}

		const base = editor.event;
		const kind = base && base.kind !== "external" ? base.kind : form.kind;
		const eventId = base?.id ?? createLocalId("event");
		const next: CalendarEvent = {
			id: eventId,
			title,
			kind,
			state: kind === "manual-block" ? "committed" : form.state,
			schedule,
			recurrence: form.recurring
				? (base?.recurrence ?? {
						seriesId: createLocalId("series"),
						rrule: "FREQ=DAILY;COUNT=5",
						timeZone: calendar.timeZone,
						exceptionDates: [],
					})
				: null,
			occurrenceId: base?.occurrenceId ?? null,
			sourcePlanId: kind === "plan" ? (base?.sourcePlanId ?? null) : null,
			sourceTaskId: kind === "plan" ? (base?.sourceTaskId ?? null) : null,
			scheduleOrigin: kind === "plan" ? (base?.scheduleOrigin ?? "user") : null,
			userLocked:
				kind === "plan"
					? base?.scheduleOrigin === "model"
						? true
						: (base?.userLocked ?? false)
					: false,
			editable: true,
			version: base?.version ?? 0,
		};

		setEditorPending(true);
		try {
			const result =
				base &&
				editor.occurrenceStart &&
				base.recurrence &&
				form.scope === "occurrence"
					? await controller.updateOccurrence(
							base.id,
							editor.occurrenceStart,
							next,
						)
					: base
						? await controller.update(next, base.recurrence ? form.scope : null)
						: await controller.create(next);
			if (!result.ok) {
				const conflict =
					"conflict" in result ? result.conflict : result.conflicts[0];
				setError(conflict?.message ?? "日程未保存，请重试。");
				return;
			}
			closeEditor();
			onNotify(base ? "日程已更新。" : "日程已创建。");
		} finally {
			setEditorPending(false);
		}
	}

	async function deleteEditor(
		scope: RecurrenceScope,
		setError: (message: string) => void,
	) {
		if (!editor?.event) return;
		setEditorPending(true);
		try {
			const base = editor.event;
			const result =
				base.recurrence &&
				editor.occurrenceStart &&
				!base.occurrenceId &&
				scope === "occurrence"
					? await controller.update(
							withOccurrenceException(base, editor.occurrenceStart),
							"occurrence",
						)
					: await controller.delete(base.id, base.recurrence ? scope : null);
			if (!result.ok) {
				setError(result.conflict.message);
				return;
			}
			closeEditor();
			onNotify(
				base.recurrence && scope === "occurrence"
					? "已仅删除这一次。"
					: "日程已删除，可撤销。",
			);
		} finally {
			setEditorPending(false);
		}
	}

	async function unlockEditor(setError: (message: string) => void) {
		const event = editor?.event;
		if (!event) return;
		setEditorPending(true);
		try {
			const result = await controller.setPlanEventLocked(event.id, false);
			if (!result.ok) {
				setError(result.conflict.message || "暂时无法解除锁定，请重试。");
				return;
			}
			closeEditor();
			onNotify("已允许计划重新安排该时段。");
		} finally {
			setEditorPending(false);
		}
	}

	function toggleSource(kind: CalendarEventKind) {
		setVisibleKinds((current) => {
			const next = new Set(current);
			if (next.has(kind)) next.delete(kind);
			else next.add(kind);
			return next;
		});
	}

	function handleRangeChange(next: CalendarRange) {
		setRange({
			...next,
			title: calendarRangeLabel(
				next.view === "week" ? next.start : next.currentDate,
				next.view === "week" ? next.end : next.currentDate,
				next.view,
			),
		});
		if (next.view !== view) setView(next.view);
	}

	const boardState =
		calendar.loadState === "loading"
			? {
					icon: <Clock3 size={22} />,
					title: "正在同步日程",
					copy: "正在读取本地日历数据…",
				}
			: calendar.loadState === "offline"
				? {
						icon: <CloudOff size={22} />,
						title: "当前处于离线状态",
						copy: "恢复网络后可重试同步；已加载的数据不会被清除。",
					}
				: calendar.loadState === "error"
					? {
							icon: <AlertTriangle size={22} />,
							title: "日程加载失败",
							copy: "本次没有覆盖已有数据，请重试。",
						}
					: calendar.loadState === "ready" && filteredEvents.length === 0
						? {
								icon: <CalendarDays size={22} />,
								title: query ? "没有匹配的日程" : "这个范围还没有日程",
								copy: query
									? "尝试更换关键词或恢复日历来源。"
									: "拖选一段时间，或创建第一项安排。",
							}
						: null;

	return (
		<div className="calendar-page">
			<header className="calendar-toolbar">
				<div className="calendar-toolbar__title">
					<p>时间安排</p>
					<h1>日程</h1>
				</div>
				<nav className="calendar-toolbar__navigation" aria-label="日期导航">
					<Button
						variant="secondary"
						size="small"
						onClick={() => calendarRef.current?.today()}
					>
						今天
					</Button>
					<IconButton
						label="上一周期"
						icon={<ChevronLeft size={17} />}
						onClick={() => calendarRef.current?.previous()}
					/>
					<IconButton
						label="下一周期"
						icon={<ChevronRight size={17} />}
						onClick={() => calendarRef.current?.next()}
					/>
					<strong aria-live="polite">{range.title}</strong>
				</nav>
				<div className="calendar-toolbar__actions">
					<div
						className="segmented-control"
						role="toolbar"
						aria-label="日历视图"
					>
						{calendarViews.map((item) => (
							<button
								type="button"
								key={item}
								aria-pressed={view === item}
								onClick={() => setView(item)}
							>
								{calendarViewLabels[item]}
							</button>
						))}
					</div>
					<Button
						ref={createButtonRef}
						variant="primary"
						size="small"
						icon={<Plus size={16} aria-hidden="true" />}
						onClick={() => openEditor({ presetKind: "manual-block" })}
					>
						创建日程
					</Button>
				</div>
			</header>

			<div className="calendar-workspace">
				<aside className="calendar-sidebar" aria-label="日历工具栏">
					<section
						className="mini-calendar"
						aria-labelledby="mini-calendar-title"
					>
						<div className="mini-calendar__heading">
							<h2 id="mini-calendar-title">{monthLabel(miniAnchor)}</h2>
							<div>
								<IconButton
									label="上个月"
									icon={<ChevronLeft size={15} />}
									onClick={() => setMiniAnchor((date) => moveMonth(date, -1))}
								/>
								<IconButton
									label="下个月"
									icon={<ChevronRight size={15} />}
									onClick={() => setMiniAnchor((date) => moveMonth(date, 1))}
								/>
							</div>
						</div>
						<div className="mini-calendar__weekdays" aria-hidden="true">
							{weekdays.map((day) => (
								<span key={day}>{day}</span>
							))}
						</div>
						<div className="mini-calendar__days">
							{miniDays.map((day) => (
								<button
									type="button"
									key={day.date}
									className={[
										!day.inMonth ? "mini-calendar__adjacent" : "",
										day.date === CALENDAR_REFERENCE_DATE
											? "mini-calendar__today"
											: "",
										day.date === CALENDAR_REFERENCE_DATE
											? "mini-calendar__selected"
											: "",
									]
										.filter(Boolean)
										.join(" ")}
									aria-label={day.date}
									aria-current={
										day.date === CALENDAR_REFERENCE_DATE ? "date" : undefined
									}
									onClick={() => calendarRef.current?.goToDate(day.date)}
								>
									{day.day}
								</button>
							))}
						</div>
					</section>

					<div className="calendar-search">
						<label className="sr-only" htmlFor="calendar-search">
							搜索日程
						</label>
						<Search size={15} aria-hidden="true" />
						<input
							id="calendar-search"
							type="search"
							value={query}
							placeholder="搜索日程"
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>

					<section
						className="calendar-sources"
						aria-labelledby="calendar-sources-title"
					>
						<div className="calendar-sources__heading">
							<h2 id="calendar-sources-title">我的日历</h2>
							<IconButton
								label="创建手动占用"
								icon={<SquarePen size={14} />}
								onClick={() => openEditor({ presetKind: "manual-block" })}
							/>
						</div>
						{sourceOptions.map((source) => (
							<label key={source.id}>
								<input
									type="checkbox"
									checked={visibleKinds.has(source.id)}
									onChange={() => toggleSource(source.id)}
								/>
								<span
									className={`calendar-source-color calendar-source-color--${source.className}`}
								/>
								<span>{source.label}</span>
							</label>
						))}
					</section>

					{proposedIds.length > 0 ? (
						<section className="calendar-proposed" aria-label="待确认计划">
							<div>
								<Check size={15} aria-hidden="true" />
								<strong>{proposedIds.length} 项待确认</strong>
							</div>
							<p>虚线日程不会自动成为已确认安排。</p>
							<Button
								variant="secondary"
								size="small"
								disabled={proposedIds.some((id) =>
									calendar.pendingEventIds.has(id),
								)}
								onClick={() => void controller.confirmProposed(proposedIds)}
							>
								确认全部
							</Button>
						</section>
					) : null}

					{showScenarioControl ? (
						<label className="calendar-scenario">
							<span>视图数据</span>
							<select
								value={calendar.scenario}
								disabled={calendar.loadState === "loading"}
								onChange={(event) =>
									void controller.load(event.target.value as CalendarScenarioId)
								}
							>
								{CALENDAR_SCENARIOS.map((scenario) => (
									<option value={scenario.id} key={scenario.id}>
										{scenario.label}
									</option>
								))}
							</select>
						</label>
					) : null}

					<div className="calendar-sidebar__note">
						<CalendarDays size={15} aria-hidden="true" />
						<p>
							拖选创建；拖动和缩放按 15 分钟吸附。所有操作也可在表单中完成。
						</p>
					</div>
				</aside>

				<section
					className="calendar-board"
					aria-label={`${calendarViewLabels[view]}视图日历`}
				>
					<div className="calendar-board__timezone" title={calendar.timeZone}>
						{timeZoneOffsetLabel(calendar.timeZone, range.currentDate)}
					</div>
					<WhaleCalendar
						ref={calendarRef}
						events={filteredEvents}
						view={view}
						timeZone={calendar.timeZone}
						initialDate={CALENDAR_REFERENCE_DATE}
						pendingEventIds={calendar.pendingEventIds}
						onRangeChange={handleRangeChange}
						onSelect={(selection) =>
							openEditor({ presetKind: "manual-block", selection })
						}
						onEventClick={selectEvent}
						onMove={(_before, after) => controller.update(after)}
						onResize={(_before, after) => controller.update(after)}
					/>

					{boardState ? (
						<div
							className={[
								"calendar-board-state",
								calendar.loadState === "error" ||
								calendar.loadState === "offline"
									? "calendar-board-state--error"
									: "",
							]
								.filter(Boolean)
								.join(" ")}
							role="status"
						>
							{boardState.icon}
							<strong>{boardState.title}</strong>
							<span>{boardState.copy}</span>
							{calendar.loadState === "error" ||
							calendar.loadState === "offline" ? (
								<Button
									variant="secondary"
									size="small"
									onClick={() => void controller.load(calendar.scenario)}
								>
									重试
								</Button>
							) : calendar.loadState === "ready" && !query ? (
								<Button
									variant="secondary"
									size="small"
									onClick={() => openEditor({ presetKind: "manual-block" })}
								>
									创建第一项日程
								</Button>
							) : null}
						</div>
					) : null}

					{calendar.conflict ? (
						<div
							className={`calendar-conflict calendar-conflict--${calendar.conflict.severity}`}
							role="alert"
						>
							<AlertTriangle size={16} aria-hidden="true" />
							<div>
								<strong>
									{calendar.conflict.severity === "error"
										? "更改已撤销"
										: "请检查重叠安排"}
								</strong>
								<span>{calendar.conflict.message}</span>
							</div>
							<IconButton
								label="关闭冲突提示"
								icon={<X size={15} />}
								onClick={() => controller.clearFeedback()}
							/>
						</div>
					) : null}

					{calendar.undo ? (
						<div className="calendar-undo" role="status">
							<span>“{calendar.undo.event.title}”已删除</span>
							<Button
								variant="ghost"
								size="small"
								icon={<RotateCcw size={14} aria-hidden="true" />}
								onClick={() => void controller.undoDelete()}
							>
								撤销
							</Button>
						</div>
					) : null}
				</section>
			</div>

			{editor ? (
				<EventEditor
					key={`${editor.event?.id ?? "new"}-${editor.occurrenceStart ?? "base"}`}
					editor={editor}
					timeZone={calendar.timeZone}
					pending={editorPending}
					onClose={closeEditor}
					onSave={saveEditor}
					onDelete={deleteEditor}
					onUnlock={unlockEditor}
				/>
			) : null}
		</div>
	);
}
