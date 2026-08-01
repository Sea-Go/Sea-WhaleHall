import {
	Bot,
	CircleAlert,
	CloudOff,
	MessageCircle,
	Plus,
	RotateCcw,
	Send,
	ShieldCheck,
	ShieldX,
	Square,
	UserRound,
	Wrench,
} from "lucide-react";
import {
	useEffect,
	useRef,
	useState,
	type FormEvent,
	type ReactNode,
	type Ref,
} from "react";
import { Button } from "../../shared/ui/Button";
import { PageHeader } from "../../shared/ui/PageHeader";
import type {
	ConversationDraft,
	ConversationMessage,
	ConversationRun,
	ConversationThread,
	ConversationToolCall,
} from "./domain";
import type {
	ConversationPageState,
	ConversationTurnState,
} from "./ConversationController";

export interface ConversationPageActions {
	onCreateConversation?: () => void;
	onSendMessage?: (draft: ConversationDraft) => void;
	onRetry?: () => void;
	onStopRun?: () => void;
	onApproveTool?: () => void;
	onDeclineTool?: () => void;
	onRestoreRun?: (runId: string) => void;
}

export interface ConversationPageProps {
	state: ConversationPageState;
	actions?: ConversationPageActions;
}

export function ConversationPage({ state, actions = {} }: ConversationPageProps) {
	const [draft, setDraft] = useState("");
	const visibleThread = threadFor(state);
	const turn = turnFor(state);
	const canSend =
		state.status === "ready" &&
		turnAllowsNewMessage(turn) &&
		Boolean(actions.onSendMessage);
	const newConversationDisabled =
		!actions.onCreateConversation ||
		state.status === "loading" ||
		Boolean(turn && isActiveTurn(turn));

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const text = draft.trim();
		if (!canSend || !visibleThread || !text) return;
		actions.onSendMessage?.({
			conversationId: visibleThread.isDraft ? undefined : visibleThread.id,
			clientMessageId: createClientMessageId(),
			text,
		});
		setDraft("");
	}

	return (
		<div className="conversation-page">
			<PageHeader
				eyebrow="陪伴与协作"
				title="对话"
				description="在这里和 WhaleHall 沟通想法、计划与下一步。"
				action={
					<Button
						variant="secondary"
						size="small"
						icon={<Plus size={15} />}
						disabled={newConversationDisabled}
						onClick={actions.onCreateConversation}
					>
						新建对话
					</Button>
				}
			/>

			<div className="conversation-page__content">
				{state.status === "loading" ? <ConversationLoading /> : null}
				{state.status === "empty" ? (
					<ConversationFeedback
						icon={<MessageCircle size={24} />}
						eyebrow="还没有对话"
						title="从一个问题开始"
						description={state.message}
						action={
							actions.onCreateConversation ? (
								<Button icon={<Plus size={15} />} onClick={actions.onCreateConversation}>
									新建对话
								</Button>
							) : undefined
						}
					/>
				) : null}
				{state.status === "unavailable" && !visibleThread ? (
					<ConversationFeedback
						icon={<CloudOff size={24} />}
						eyebrow="服务尚未接入"
						title="对话功能正在准备中"
						description={state.message}
					/>
				) : null}
				{state.status === "error" && !visibleThread ? (
					<ConversationFeedback
						tone="error"
						icon={<CircleAlert size={24} />}
						eyebrow="加载失败"
						title="暂时无法打开对话"
						description={state.message}
						action={
							state.retryable && actions.onRetry ? (
								<Button onClick={actions.onRetry}>重试</Button>
							) : undefined
						}
					/>
				) : null}
				{state.status === "offline" && !visibleThread ? (
					<ConversationFeedback
						icon={<CloudOff size={24} />}
						eyebrow="当前离线"
						title="没有可用的本地对话副本"
						description={state.message}
						action={
							actions.onRetry ? (
								<Button onClick={actions.onRetry}>重新加载</Button>
							) : undefined
						}
					/>
				) : null}

				{visibleThread ? (
					<ConversationWorkspace
						thread={visibleThread}
						turn={turn}
						draft={draft}
						onDraftChange={setDraft}
						onSubmit={submit}
						disabled={!canSend}
						notice={noticeFor(state)}
						onRetry={canRetrySurface(state) ? actions.onRetry : undefined}
						actions={actions}
					/>
				) : null}
			</div>
		</div>
	);
}

function ConversationWorkspace({
	thread,
	turn,
	draft,
	onDraftChange,
	onSubmit,
	disabled,
	notice,
	onRetry,
	actions,
}: {
	thread: ConversationThread;
	turn: ConversationTurnState | null;
	draft: string;
	onDraftChange: (value: string) => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
	disabled: boolean;
	notice: string | null;
	onRetry?: () => void;
	actions: ConversationPageActions;
}) {
	const workspaceRef = useRef<HTMLElement>(null);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const runStatusRef = useRef<HTMLDivElement>(null);
	const approvalCardRef = useRef<HTMLElement>(null);
	const approvalFocusReturnArmedRef = useRef(false);
	const showTyping =
		Boolean(turn && (turn.status === "starting" || turn.status === "running")) &&
		!thread.messages.some(
			(message) => message.role === "assistant" && message.state === "streaming",
		);
	const run = turn && turn.status !== "idle" ? turn.run : null;
	const pendingApprovalId =
		turn?.status === "suspended" ? run?.pendingApproval?.id ?? null : null;
	const previousApprovalIdRef = useRef<string | null>(pendingApprovalId);

	useEffect(() => {
		if (!pendingApprovalId) return;
		const handlePointerDown = (event: PointerEvent) => {
			const approvalCard = approvalCardRef.current;
			if (
				approvalCard &&
				event.target instanceof Node &&
				!approvalCard.contains(event.target)
			) {
				approvalFocusReturnArmedRef.current = false;
			}
		};
		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => document.removeEventListener("pointerdown", handlePointerDown, true);
	}, [pendingApprovalId]);

	useEffect(() => {
		const previousApprovalId = previousApprovalIdRef.current;
		previousApprovalIdRef.current = pendingApprovalId;

		if (pendingApprovalId && pendingApprovalId !== previousApprovalId) {
			approvalFocusReturnArmedRef.current = false;
			return;
		}
		if (
			!previousApprovalId ||
			pendingApprovalId ||
			!approvalFocusReturnArmedRef.current
		) {
			return;
		}

		approvalFocusReturnArmedRef.current = false;
		const activeElement = document.activeElement;
		if (
			activeElement &&
			activeElement !== document.body &&
			activeElement.isConnected
		) {
			return;
		}

		const composer = composerRef.current;
		const focusTarget =
			composer && !composer.disabled
				? composer
				: runStatusRef.current ?? workspaceRef.current;
		focusTarget?.focus({ preventScroll: true });
	}, [pendingApprovalId, disabled]);

	return (
		<section
			ref={workspaceRef}
			className="conversation-workspace"
			aria-label={thread.title}
			tabIndex={-1}
		>
			<header className="conversation-workspace__header">
				<div>
					<span>当前对话</span>
					<h2>{thread.title}</h2>
				</div>
				<small>{thread.messages.length} 条消息</small>
			</header>

			{notice ? (
				<div className="conversation-workspace__notice">
					<span>{notice}</span>
					{onRetry ? (
						<Button variant="secondary" size="small" onClick={onRetry}>
							重新加载
						</Button>
					) : null}
				</div>
			) : null}

			{turn && turn.status !== "idle" ? (
				<ConversationRunBanner
					turn={turn}
					actions={actions}
					focusRef={runStatusRef}
				/>
			) : null}

			<div className="conversation-workspace__messages">
				{thread.messages.map((message) => (
					<ConversationMessageBubble key={message.id} message={message} />
				))}
				{showTyping ? <AssistantTypingIndicator /> : null}
				{run?.toolCalls.length ? <ToolTimeline run={run} /> : null}
				{turn?.status === "suspended" && run?.pendingApproval ? (
					<ToolApprovalCard
						run={run}
						actions={actions}
						focusRef={approvalCardRef}
						onFocusWithin={() => {
							approvalFocusReturnArmedRef.current = true;
						}}
						onFocusLeave={(nextTarget) => {
							if (
								nextTarget instanceof Node &&
								nextTarget.isConnected &&
								nextTarget !== document.body
							) {
								approvalFocusReturnArmedRef.current = false;
							}
						}}
					/>
				) : null}
			</div>

			<form className="conversation-composer" onSubmit={onSubmit}>
				<label htmlFor="conversation-draft">输入消息</label>
				<textarea
					ref={composerRef}
					id="conversation-draft"
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.shiftKey) return;
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}}
					placeholder={composerPlaceholder(turn, disabled)}
					disabled={disabled}
					rows={3}
				/>
				<div className="conversation-composer__footer">
					<span>{disabled ? "等待当前操作结束后可继续发送" : "Enter 发送，Shift + Enter 换行"}</span>
					<Button
						type="submit"
						icon={<Send size={15} />}
						disabled={disabled || !draft.trim()}
					>
						发送
					</Button>
				</div>
			</form>
		</section>
	);
}

function ConversationRunBanner({
	turn,
	actions,
	focusRef,
}: {
	turn: Exclude<ConversationTurnState, { status: "idle" }>;
	actions: ConversationPageActions;
	focusRef: Ref<HTMLDivElement>;
}) {
	const active = isActiveTurn(turn);
	return (
		<div
			ref={focusRef}
			className={`conversation-run-banner conversation-run-banner--${turn.status}`}
			role="status"
			aria-live="polite"
			tabIndex={-1}
		>
			<div>
				<strong>{runStatusTitle(turn)}</strong>
				<span>{runStatusDescription(turn)}</span>
			</div>
			<div className="conversation-run-banner__actions">
				{turn.status === "failed" && turn.retryable && actions.onRetry ? (
					<Button
						variant="secondary"
						size="small"
						icon={<RotateCcw size={14} />}
						onClick={actions.onRetry}
					>
						重新同步
					</Button>
				) : null}
				{turn.status === "interrupted" && turn.restorable ? (
					<Button
						variant="secondary"
						size="small"
						icon={<RotateCcw size={14} />}
						disabled={!actions.onRestoreRun}
						onClick={() => actions.onRestoreRun?.(turn.run.id)}
					>
						恢复运行
					</Button>
				) : null}
				{active ? (
					<Button
						variant="danger"
						size="small"
						icon={<Square size={13} />}
						disabled={!actions.onStopRun || turn.status === "cancelling" || turn.status === "recovering"}
						onClick={actions.onStopRun}
					>
						{turn.status === "cancelling" ? "正在停止" : "停止"}
					</Button>
				) : null}
			</div>
			{turn.run.commandError ? <p>{turn.run.commandError}</p> : null}
		</div>
	);
}

function ToolTimeline({ run }: { run: ConversationRun }) {
	return (
		<section className="conversation-tools" aria-label="工具执行记录">
			<header>
				<Wrench size={15} aria-hidden="true" />
				<strong>工具执行</strong>
			</header>
			{run.toolCalls.map((toolCall) => (
				<ToolCallCard key={toolCall.id} toolCall={toolCall} />
			))}
		</section>
	);
}

function ToolCallCard({ toolCall }: { toolCall: ConversationToolCall }) {
	return (
		<article className={`conversation-tool-card conversation-tool-card--${toolCall.status}`}>
			<div>
				<strong>{toolCall.label}</strong>
				<span>{toolStatusLabel(toolCall.status)}</span>
			</div>
			<small>{toolRiskLabel(toolCall.risk)}</small>
			{toolCall.progress ? <p>{toolCall.progress}</p> : null}
			{toolCall.summary ? <p>{toolCall.summary}</p> : null}
		</article>
	);
}

function ToolApprovalCard({
	run,
	actions,
	focusRef,
	onFocusWithin,
	onFocusLeave,
}: {
	run: ConversationRun;
	actions: ConversationPageActions;
	focusRef: Ref<HTMLElement>;
	onFocusWithin: () => void;
	onFocusLeave: (nextTarget: EventTarget | null) => void;
}) {
	const approval = run.pendingApproval;
	if (!approval) return null;
	const disabled = run.approvalDecisionPending;
	return (
		<section
			ref={focusRef}
			className="conversation-approval"
			aria-labelledby={`approval-${approval.id}`}
			onFocusCapture={onFocusWithin}
			onBlurCapture={(event) => onFocusLeave(event.relatedTarget)}
		>
			<div className="conversation-approval__icon" aria-hidden="true">
				<ShieldCheck size={18} />
			</div>
			<div>
				<p>需要你的确认 · {toolRiskLabel(approval.risk)}</p>
				<h3 id={`approval-${approval.id}`}>{approval.title}</h3>
				<span>{approval.description}</span>
			</div>
			<div className="conversation-approval__actions">
				<Button
					variant="secondary"
					size="small"
					icon={<ShieldX size={14} />}
					disabled={disabled || !actions.onDeclineTool}
					onClick={actions.onDeclineTool}
				>
					拒绝
				</Button>
				<Button
					size="small"
					icon={<ShieldCheck size={14} />}
					disabled={disabled || !actions.onApproveTool}
					onClick={actions.onApproveTool}
				>
					{disabled ? "正在提交" : "仅本次允许"}
				</Button>
			</div>
		</section>
	);
}

function ConversationMessageBubble({ message }: { message: ConversationMessage }) {
	const assistant = message.role === "assistant";
	return (
		<article className={`conversation-message conversation-message--${message.role}`}>
			<div className="conversation-message__avatar" aria-hidden="true">
				{assistant ? <Bot size={16} /> : <UserRound size={16} />}
			</div>
			<div className="conversation-message__body">
				<div className="conversation-message__meta">
					<strong>{assistant ? "WhaleHall" : "你"}</strong>
					<time dateTime={new Date(message.createdAtMs).toISOString()}>
						{formatMessageTime(message.createdAtMs)}
					</time>
				</div>
				{message.content ? <p>{message.content}</p> : null}
				{message.state !== "complete" ? (
					<span>{messageStateLabel(message.state)}</span>
				) : null}
			</div>
		</article>
	);
}

function AssistantTypingIndicator() {
	return (
		<div className="conversation-typing" aria-hidden="true">
			<Bot size={16} />
			<span>WhaleHall 正在整理回复</span>
			<i />
			<i />
			<i />
		</div>
	);
}

function ConversationLoading() {
	return (
		<section className="conversation-loading" aria-label="正在加载对话">
			<div className="conversation-loading__header" />
			<div className="conversation-loading__message" />
			<div className="conversation-loading__message conversation-loading__message--user" />
			<div className="conversation-loading__composer" />
		</section>
	);
}

function ConversationFeedback({
	icon,
	eyebrow,
	title,
	description,
	action,
	tone = "neutral",
}: {
	icon: ReactNode;
	eyebrow: string;
	title: string;
	description: string;
	action?: ReactNode;
	tone?: "neutral" | "error";
}) {
	return (
		<section className={`conversation-feedback conversation-feedback--${tone}`} aria-live="polite">
			<div>{icon}</div>
			<p>{eyebrow}</p>
			<h2>{title}</h2>
			<span>{description}</span>
			{action ? <div className="conversation-feedback__action">{action}</div> : null}
		</section>
	);
}

function threadFor(state: ConversationPageState): ConversationThread | null {
	switch (state.status) {
		case "ready":
			return state.thread;
		case "error":
			return state.thread;
		case "offline":
			return state.cachedThread;
		case "unavailable":
			return state.cachedThread ?? null;
		default:
			return null;
	}
}

function turnFor(state: ConversationPageState): ConversationTurnState | null {
	if (state.status === "ready") return state.turn;
	if (state.status === "error" || state.status === "offline" || state.status === "unavailable") {
		return state.turn ?? null;
	}
	return null;
}

function noticeFor(state: ConversationPageState): string | null {
	return state.status === "error" || state.status === "offline" || state.status === "unavailable"
		? state.message
		: null;
}

function canRetrySurface(state: ConversationPageState): boolean {
	return (
		(state.status === "error" && state.retryable) ||
		state.status === "offline" ||
		state.status === "unavailable"
	);
}

function turnAllowsNewMessage(turn: ConversationTurnState | null): boolean {
	return !turn || turn.status === "idle" || turn.status === "cancelled" || turn.status === "failed";
}

function isActiveTurn(turn: ConversationTurnState): boolean {
	return ["starting", "running", "suspended", "cancelling", "recovering"].includes(turn.status);
}

function runStatusTitle(turn: Exclude<ConversationTurnState, { status: "idle" }>): string {
	switch (turn.status) {
		case "starting": return "正在开始";
		case "running": return "WhaleHall 正在处理";
		case "suspended": return "等待你的确认";
		case "cancelling": return "正在停止";
		case "recovering": return "正在恢复运行";
		case "interrupted": return "运行已中断";
		case "cancelled": return "已停止生成";
		case "failed": return "本次回复未完成";
	}
}

function runStatusDescription(turn: Exclude<ConversationTurnState, { status: "idle" }>): string {
	if ("message" in turn) return turn.message;
	if (turn.run.statusMessage) return turn.run.statusMessage;
	if (turn.status === "suspended") return "请审阅下面的工具操作，再决定是否继续。";
	if (turn.status === "cancelling") return "正在安全结束当前运行，已有内容会保留。";
	return "你可以随时停止；当前已生成的内容会保留。";
}

function composerPlaceholder(turn: ConversationTurnState | null, disabled: boolean): string {
	if (!disabled) return "输入你想讨论的内容…";
	if (turn && isActiveTurn(turn)) return "当前回复完成或停止后可继续发送";
	return "对话服务恢复后即可发送消息";
}

function messageStateLabel(state: ConversationMessage["state"]): string {
	switch (state) {
		case "queued": return "等待 Agent 接收…";
		case "streaming": return "正在生成回复…";
		case "failed": return "这条消息未完成，已保留部分内容";
		case "cancelled": return "生成已停止，已保留部分内容";
		case "complete": return "";
	}
}

function toolStatusLabel(status: ConversationToolCall["status"]): string {
	switch (status) {
		case "queued": return "等待执行";
		case "awaiting-approval": return "等待确认";
		case "running": return "执行中";
		case "succeeded": return "已完成";
		case "failed": return "执行失败";
		case "cancelled": return "已取消";
	}
}

function toolRiskLabel(risk: ConversationToolCall["risk"]): string {
	switch (risk) {
		case "read": return "只读操作";
		case "write": return "会修改数据";
		case "control": return "会控制本机功能";
	}
}

function createClientMessageId(): string {
	return `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatMessageTime(createdAtMs: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
	}).format(createdAtMs);
}
