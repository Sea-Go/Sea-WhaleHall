import {
	Bot,
	CircleAlert,
	CloudOff,
	MessageCircle,
	Plus,
	Send,
	UserRound,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../../shared/ui/Button";
import { PageHeader } from "../../shared/ui/PageHeader";
import type { ConversationDraft, ConversationMessage, ConversationThread } from "./domain";
import type { ConversationPageState } from "./ConversationController";

export interface ConversationPageActions {
	onCreateConversation?: () => void;
	onSendMessage?: (draft: ConversationDraft) => void;
	onRetry?: () => void;
}

export interface ConversationPageProps {
	state: ConversationPageState;
	actions?: ConversationPageActions;
}

export function ConversationPage({ state, actions = {} }: ConversationPageProps) {
	const [draft, setDraft] = useState("");
	const visibleThread = threadFor(state);
	const canSend = state.status === "ready" && Boolean(actions.onSendMessage);

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const text = draft.trim();
		if (!canSend || !visibleThread || !text) return;
		actions.onSendMessage?.({
			conversationId: visibleThread.id,
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
						disabled={!actions.onCreateConversation || state.status === "loading"}
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
				{state.status === "unavailable" ? (
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
						draft={draft}
						onDraftChange={setDraft}
						onSubmit={submit}
						disabled={!canSend}
						sending={state.status === "sending"}
						notice={
							state.status === "error" || state.status === "offline"
								? state.message
								: null
						}
						onRetry={
							(state.status === "error" && state.retryable) ||
							state.status === "offline"
								? actions.onRetry
								: undefined
						}
					/>
				) : null}
			</div>
		</div>
	);
}

function ConversationWorkspace({
	thread,
	draft,
	onDraftChange,
	onSubmit,
	disabled,
	sending,
	notice,
	onRetry,
}: {
	thread: ConversationThread;
	draft: string;
	onDraftChange: (value: string) => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
	disabled: boolean;
	sending: boolean;
	notice: string | null;
	onRetry?: () => void;
}) {
	return (
		<section className="conversation-workspace" aria-label={thread.title}>
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
					{onRetry ? <Button variant="secondary" size="small" onClick={onRetry}>重新加载</Button> : null}
				</div>
			) : null}

			<div className="conversation-workspace__messages" aria-live="polite">
				{thread.messages.map((message) => (
					<ConversationMessageBubble key={message.id} message={message} />
				))}
				{sending ? <AssistantTypingIndicator /> : null}
			</div>

			<form className="conversation-composer" onSubmit={onSubmit}>
				<label htmlFor="conversation-draft">输入消息</label>
				<textarea
					id="conversation-draft"
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.shiftKey) return;
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}}
					placeholder={disabled ? "对话服务接入后即可发送消息" : "输入你想讨论的内容…"}
					disabled={disabled}
					rows={3}
				/>
				<div className="conversation-composer__footer">
					<span>{disabled ? "发送功能暂不可用" : "Enter 发送，Shift + Enter 换行"}</span>
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
				<p>{message.content}</p>
				{message.state === "streaming" ? <span>正在生成回复…</span> : null}
				{message.state === "failed" ? <span>这条消息未完成</span> : null}
			</div>
		</article>
	);
}

function AssistantTypingIndicator() {
	return (
		<div className="conversation-typing" role="status">
			<Bot size={16} aria-hidden="true" />
			<span>WhaleHall 正在整理回复</span>
			<i aria-hidden="true" />
			<i aria-hidden="true" />
			<i aria-hidden="true" />
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
		case "sending":
			return state.thread;
		case "error":
			return state.thread;
		case "offline":
			return state.cachedThread;
		default:
			return null;
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
