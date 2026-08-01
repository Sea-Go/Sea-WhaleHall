import type {
	ConversationDraft,
	ConversationMessage,
	ConversationThread,
	CreateConversationInput,
} from "./domain";
import {
	ConversationServiceError,
	type ConversationService,
} from "./conversation-service";

export type ConversationPageState =
	| { status: "loading" }
	| { status: "empty"; message: string }
	| { status: "ready"; thread: ConversationThread }
	| { status: "sending"; thread: ConversationThread }
	| {
			status: "error";
			message: string;
			retryable: boolean;
			thread: ConversationThread | null;
	  }
	| { status: "offline"; message: string; cachedThread: ConversationThread | null }
	| { status: "unavailable"; message: string };

export class ConversationController {
	private state: ConversationPageState = { status: "loading" };
	private readonly listeners = new Set<() => void>();
	private requestSequence = 0;

	constructor(private readonly service: ConversationService) {}

	getSnapshot = (): ConversationPageState => this.state;
	getServerSnapshot = (): ConversationPageState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	async load(): Promise<void> {
		const sequence = ++this.requestSequence;
		this.setState({ status: "loading" });
		try {
			const thread = await this.service.loadActiveConversation();
			if (sequence !== this.requestSequence) return;
			this.setState(
				thread
					? { status: "ready", thread }
					: { status: "empty", message: "新建一段对话，告诉 WhaleHall 你想讨论什么。" },
			);
		} catch (reason) {
			if (sequence !== this.requestSequence) return;
			this.setLoadFailure(reason, null);
		}
	}

	async createConversation(input: CreateConversationInput = {}): Promise<void> {
		const sequence = ++this.requestSequence;
		this.setState({ status: "loading" });
		try {
			const thread = await this.service.createConversation(input);
			if (sequence !== this.requestSequence) return;
			this.setState({ status: "ready", thread });
		} catch (reason) {
			if (sequence !== this.requestSequence) return;
			this.setLoadFailure(reason, null);
		}
	}

	async sendMessage(draft: ConversationDraft): Promise<void> {
		const thread = activeThread(this.state);
		if (!thread || this.state.status !== "ready") return;
		const sequence = ++this.requestSequence;
		const optimisticMessage: ConversationMessage = {
			id: draft.clientMessageId,
			role: "user",
			content: draft.text,
			createdAtMs: Date.now(),
			state: "streaming",
		};
		const optimisticThread: ConversationThread = {
			...thread,
			updatedAtMs: optimisticMessage.createdAtMs,
			messages: [...thread.messages, optimisticMessage],
		};
		this.setState({ status: "sending", thread: optimisticThread });

		try {
			const exchange = await this.service.sendMessage(draft);
			if (sequence !== this.requestSequence) return;
			this.setState({ status: "ready", thread: exchange.conversation });
		} catch (reason) {
			if (sequence !== this.requestSequence) return;
			const failedThread: ConversationThread = {
				...optimisticThread,
				messages: optimisticThread.messages.map((message) =>
					message.id === optimisticMessage.id ? { ...message, state: "failed" } : message,
				),
			};
			if (reason instanceof ConversationServiceError && reason.kind === "offline") {
				this.setState({
					status: "offline",
					message: "当前离线，消息尚未送达；恢复连接后请重新发送。",
					cachedThread: failedThread,
				});
				return;
			}
			if (reason instanceof ConversationServiceError && reason.kind === "unavailable") {
				this.setState({ status: "unavailable", message: reason.message });
				return;
			}
			this.setState({
				status: "error",
				message: "消息发送失败，请检查服务后重试。",
				retryable: true,
				thread: failedThread,
			});
		}
	}

	retry(): Promise<void> {
		return this.load();
	}

	private setLoadFailure(reason: unknown, cachedThread: ConversationThread | null): void {
		if (reason instanceof ConversationServiceError) {
			if (reason.kind === "offline") {
				this.setState({ status: "offline", message: reason.message, cachedThread });
				return;
			}
			if (reason.kind === "unavailable") {
				this.setState({ status: "unavailable", message: reason.message });
				return;
			}
			this.setState({
				status: "error",
				message: reason.message,
				retryable: true,
				thread: cachedThread,
			});
			return;
		}
		this.setState({
			status: "error",
			message: "对话加载失败，请稍后重试。",
			retryable: true,
			thread: cachedThread,
		});
	}

	private setState(state: ConversationPageState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

function activeThread(state: ConversationPageState): ConversationThread | null {
	return state.status === "ready" ? state.thread : null;
}
