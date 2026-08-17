import {
	type ConversationRunEventEnvelope,
	type ConversationRunSnapshot,
	type ConversationService,
	ConversationServiceError,
} from "./conversation-service";
import type {
	ConversationDraft,
	ConversationMessage,
	ConversationRun,
	ConversationThread,
	CreateConversationInput,
} from "./domain";

export type ConversationTurnState =
	| { status: "idle" }
	| { status: "starting"; run: ConversationRun }
	| { status: "running"; run: ConversationRun }
	| { status: "suspended"; run: ConversationRun }
	| { status: "cancelling"; run: ConversationRun }
	| { status: "recovering"; run: ConversationRun; message: string }
	| {
			status: "interrupted";
			run: ConversationRun;
			message: string;
			restorable: boolean;
	  }
	| { status: "cancelled"; run: ConversationRun; message: string }
	| {
			status: "failed";
			run: ConversationRun;
			message: string;
			retryable: boolean;
	  };

export type ConversationPageState =
	| { status: "loading" }
	| { status: "empty"; message: string }
	| { status: "ready"; thread: ConversationThread; turn: ConversationTurnState }
	| {
			status: "error";
			message: string;
			retryable: boolean;
			thread: ConversationThread | null;
			turn?: ConversationTurnState;
	  }
	| {
			status: "offline";
			message: string;
			cachedThread: ConversationThread | null;
			turn?: ConversationTurnState;
	  }
	| {
			status: "unavailable";
			message: string;
			cachedThread?: ConversationThread | null;
			turn?: ConversationTurnState;
	  };

const MAX_BUFFERED_LOADING_EVENTS = 512;

interface BufferedRunEvents {
	requestSequence: number;
	events: ConversationRunEventEnvelope[];
	overflowed: boolean;
}

interface ResumeAttempt {
	runId: string;
	requestSequence: number;
}

export class ConversationController {
	private state: ConversationPageState = { status: "loading" };
	private readonly listeners = new Set<() => void>();
	private unsubscribeFromService: (() => void) | null = null;
	private requestSequence = 0;
	private loadingEventBuffer: BufferedRunEvents | null = null;
	private readonly recoveryEventBuffers = new Map<string, BufferedRunEvents>();
	private resumeAttempt: ResumeAttempt | null = null;

	constructor(private readonly service: ConversationService) {}

	getSnapshot = (): ConversationPageState => this.state;
	getServerSnapshot = (): ConversationPageState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	dispose(): void {
		this.unsubscribeFromService?.();
		this.unsubscribeFromService = null;
		this.requestSequence += 1;
		this.loadingEventBuffer = null;
		this.recoveryEventBuffers.clear();
		this.resumeAttempt = null;
		this.listeners.clear();
	}

	async load(): Promise<void> {
		this.ensureServiceSubscription();
		const requestSequence = ++this.requestSequence;
		this.recoveryEventBuffers.clear();
		this.resumeAttempt = null;
		this.loadingEventBuffer = {
			requestSequence,
			events: [],
			overflowed: false,
		};
		this.setState({ status: "loading" });
		let thread: ConversationThread | null = null;
		try {
			thread = await this.service.loadActiveConversation();
			if (requestSequence !== this.requestSequence) return;
			const restorableRuns = await this.service.listRestorableRuns(thread?.id);
			if (requestSequence !== this.requestSequence) return;
			const latest = [...restorableRuns].sort(
				(left, right) => right.updatedAtMs - left.updatedAtMs,
			)[0];
			if (latest) {
				const snapshot = await this.service.getRunSnapshot(latest.runId);
				if (requestSequence !== this.requestSequence) return;
				this.commitLoadedState(requestSequence, stateFromSnapshot(snapshot));
				return;
			}
			// The run may complete between the first thread read and the
			// restorable-run query. Read the durable thread again before
			// publishing an idle surface so its terminal messages are not lost.
			thread = await this.service.loadActiveConversation();
			if (requestSequence !== this.requestSequence) return;
			this.commitLoadedState(
				requestSequence,
				thread
					? { status: "ready", thread, turn: { status: "idle" } }
					: {
							status: "empty",
							message: "新建一段对话，告诉 WhaleHall 你想讨论什么。",
						},
			);
		} catch (reason) {
			if (requestSequence !== this.requestSequence) return;
			this.loadingEventBuffer = null;
			this.setLoadFailure(reason, thread);
		}
	}

	async createConversation(input: CreateConversationInput = {}): Promise<void> {
		++this.requestSequence;
		this.loadingEventBuffer = null;
		this.recoveryEventBuffers.clear();
		this.resumeAttempt = null;
		const now = Date.now();
		this.setState({
			status: "ready",
			thread: {
				id: `draft-${createRequestId()}`,
				title: input.title?.trim() || "新对话",
				updatedAtMs: now,
				messages: [],
				isDraft: true,
			},
			turn: { status: "idle" },
		});
	}

	async sendMessage(draft: ConversationDraft): Promise<void> {
		if (this.state.status !== "ready" || !canStartTurn(this.state.turn)) return;
		const text = draft.text.trim();
		if (!text) return;

		const now = Date.now();
		const requestId = createRequestId();
		const optimisticMessage: ConversationMessage = {
			id: draft.clientMessageId,
			role: "user",
			content: text,
			createdAtMs: now,
			state: "queued",
		};
		const optimisticThread: ConversationThread = {
			...this.state.thread,
			updatedAtMs: now,
			messages: [...this.state.thread.messages, optimisticMessage],
		};
		const pendingRun: ConversationRun = {
			id: `pending-${requestId}`,
			requestId,
			clientMessageId: draft.clientMessageId,
			status: "starting",
			revision: 0,
			lastSequence: 0,
			startedAtMs: now,
			updatedAtMs: now,
			toolCalls: [],
			pendingApproval: null,
			approvalDecisionPending: false,
		};
		this.setState({
			status: "ready",
			thread: optimisticThread,
			turn: { status: "starting", run: pendingRun },
		});

		try {
			const accepted = await this.service.startTurn({
				requestId,
				conversationId: optimisticThread.isDraft
					? undefined
					: optimisticThread.id,
				clientMessageId: draft.clientMessageId,
				text,
			});
			const surface = readySurface(this.state);
			if (!surface || surface.turn.status === "idle") return;
			if (surface.turn.run.requestId !== requestId) return;
			const currentRun = surface.turn.run;
			const run: ConversationRun = {
				...currentRun,
				id: currentRun.id.startsWith("pending-")
					? accepted.runId
					: currentRun.id,
				revision: Math.max(currentRun.revision, accepted.revision),
				startedAtMs: Math.min(currentRun.startedAtMs, accepted.acceptedAtMs),
				updatedAtMs: Math.max(currentRun.updatedAtMs, accepted.acceptedAtMs),
			};
			this.setState({
				status: "ready",
				thread: surface.thread,
				turn: withRun(surface.turn, run),
			});
		} catch (reason) {
			const surface = readySurface(this.state);
			if (!surface || surface.turn.status === "idle") return;
			if (surface.turn.run.requestId !== requestId) return;
			const failedThread = mapMessages(surface.thread, (message) =>
				message.id === draft.clientMessageId
					? { ...message, state: "failed" }
					: message,
			);
			const failedTurn: ConversationTurnState = {
				status: "failed",
				run: { ...surface.turn.run, status: "failed", updatedAtMs: Date.now() },
				message: serviceMessage(reason, "消息发送失败，请检查服务后重试。"),
				retryable: isRetryable(reason),
			};
			this.setOperationFailure(reason, failedThread, failedTurn);
		}
	}

	async stopRun(): Promise<void> {
		const surface = readySurface(this.state);
		if (!surface || !isActiveTurn(surface.turn)) return;
		if (surface.turn.status === "cancelling") return;
		const previousTurn = surface.turn;
		const requestId = createRequestId();
		const cancellingRun: ConversationRun = {
			...previousTurn.run,
			status: "cancelling",
			commandError: undefined,
			updatedAtMs: Date.now(),
		};
		this.setState({
			status: "ready",
			thread: surface.thread,
			turn: { status: "cancelling", run: cancellingRun },
		});
		try {
			const accepted = await this.service.cancelRun({
				requestId,
				runId: previousTurn.run.id,
				expectedRevision: previousTurn.run.revision,
			});
			this.updateCommandRevision(previousTurn.run.id, accepted.revision);
		} catch (reason) {
			if (isRevisionConflict(reason)) {
				await this.restoreRun(previousTurn.run.id);
				return;
			}
			this.restoreCommandTurn(previousTurn, reason, "停止请求未送达，请重试。");
		}
	}

	approveTool(): Promise<void> {
		return this.decideToolApproval("approve-once");
	}

	declineTool(): Promise<void> {
		return this.decideToolApproval("deny");
	}

	async restoreRun(runId: string): Promise<void> {
		if (this.recoveryEventBuffers.has(runId)) return;
		const requestSequence = this.requestSequence;
		const buffer: BufferedRunEvents = {
			requestSequence,
			events: [],
			overflowed: false,
		};
		this.recoveryEventBuffers.set(runId, buffer);
		const surface = readySurface(this.state);
		if (
			surface &&
			surface.turn.status !== "idle" &&
			surface.turn.run.id === runId
		) {
			this.setState({
				status: "ready",
				thread: surface.thread,
				turn: {
					status: "recovering",
					run: surface.turn.run,
					message: "正在同步 Agent 的最新状态…",
				},
			});
		}
		try {
			const snapshot = await this.service.getRunSnapshot(runId);
			if (
				requestSequence !== this.requestSequence ||
				this.recoveryEventBuffers.get(runId) !== buffer
			)
				return;
			this.setState(stateFromSnapshot(snapshot));
			let needsAnotherRestore = buffer.overflowed;
			for (const event of buffer.events) {
				needsAnotherRestore = this.handleRunEvent(event) || needsAnotherRestore;
			}
			this.recoveryEventBuffers.delete(runId);
			if (needsAnotherRestore && requestSequence === this.requestSequence) {
				void this.restoreRun(runId);
			}
		} catch (reason) {
			if (
				requestSequence !== this.requestSequence ||
				this.recoveryEventBuffers.get(runId) !== buffer
			)
				return;
			const current = readySurface(this.state);
			if (current && current.turn.status !== "idle") {
				this.setOperationFailure(reason, current.thread, {
					status: "interrupted",
					run: { ...current.turn.run, status: "interrupted" },
					message: serviceMessage(reason, "未能恢复这次运行，请稍后重试。"),
					restorable: isRetryable(reason),
				});
			} else {
				this.setLoadFailure(reason, threadForState(this.state));
			}
		} finally {
			if (this.recoveryEventBuffers.get(runId) === buffer) {
				this.recoveryEventBuffers.delete(runId);
			}
		}
	}

	async resumeInterruptedRun(runId: string): Promise<void> {
		if (this.resumeAttempt) return;
		const requestSequence = ++this.requestSequence;
		const attempt: ResumeAttempt = { runId, requestSequence };
		this.resumeAttempt = attempt;
		this.loadingEventBuffer = null;
		this.recoveryEventBuffers.clear();
		const initialSurface = readySurface(this.state);
		if (
			initialSurface &&
			initialSurface.turn.status === "interrupted" &&
			initialSurface.turn.run.id === runId
		) {
			this.setState({
				status: "ready",
				thread: initialSurface.thread,
				turn: {
					status: "recovering",
					run: initialSurface.turn.run,
					message: "正在准备恢复这次运行…",
				},
			});
		}
		let snapshot: ConversationRunSnapshot;
		try {
			snapshot = await this.service.getRunSnapshot(runId);
		} catch (reason) {
			if (!this.isCurrentResumeAttempt(attempt)) return;
			const surface = readySurface(this.state);
			if (surface && surface.turn.status !== "idle") {
				this.setOperationFailure(
					reason,
					surface.thread,
					initialSurface?.turn.status === "interrupted"
						? initialSurface.turn
						: surface.turn,
				);
			} else {
				this.setLoadFailure(reason, threadForState(this.state));
			}
			this.finishResumeAttempt(attempt);
			return;
		}
		if (!this.isCurrentResumeAttempt(attempt)) return;
		if (snapshot.run.status !== "interrupted") {
			this.setState(stateFromSnapshot(snapshot));
			this.finishResumeAttempt(attempt);
			return;
		}
		const userMessage = snapshot.conversation.messages.find(
			(message) =>
				message.role === "user" && message.id === snapshot.clientMessageId,
		);
		if (!userMessage) {
			this.setState(stateFromSnapshot(snapshot));
			this.finishResumeAttempt(attempt);
			return;
		}
		const requestId = createRequestId();
		const pendingRun: ConversationRun = {
			...snapshot.run,
			id: `pending-${requestId}`,
			requestId,
			status: "starting",
			revision: 0,
			lastSequence: 0,
			startedAtMs: Date.now(),
			updatedAtMs: Date.now(),
			toolCalls: [],
			pendingApproval: null,
			approvalDecisionPending: false,
			commandError: undefined,
		};
		this.setState({
			status: "ready",
			thread: snapshot.conversation,
			turn: { status: "starting", run: pendingRun },
		});
		try {
			const accepted = await this.service.startTurn({
				requestId,
				conversationId: snapshot.conversation.id,
				retryOfRunId: runId,
				clientMessageId: snapshot.clientMessageId,
				text: userMessage.content,
			});
			if (!this.isCurrentResumeAttempt(attempt)) return;
			const surface = readySurface(this.state);
			if (
				!surface ||
				surface.turn.status === "idle" ||
				surface.turn.run.requestId !== requestId
			)
				return;
			this.setState({
				status: "ready",
				thread: surface.thread,
				turn: withRun(surface.turn, {
					...surface.turn.run,
					id: accepted.runId,
					revision: accepted.revision,
					updatedAtMs: accepted.acceptedAtMs,
				}),
			});
		} catch (reason) {
			if (!this.isCurrentResumeAttempt(attempt)) return;
			this.setOperationFailure(reason, snapshot.conversation, {
				status: "interrupted",
				run: snapshot.run,
				message: serviceMessage(reason, "恢复运行失败，请稍后重试。"),
				restorable: isRetryable(reason),
			});
		} finally {
			this.finishResumeAttempt(attempt);
		}
	}

	retry(): Promise<void> {
		return this.load();
	}

	private ensureServiceSubscription(): void {
		if (this.unsubscribeFromService) return;
		this.unsubscribeFromService = this.service.subscribe((event) => {
			const recoveryBuffer = this.recoveryEventBuffers.get(event.runId);
			if (
				recoveryBuffer &&
				recoveryBuffer.requestSequence === this.requestSequence
			) {
				this.bufferRunEvent(recoveryBuffer, event);
				return;
			}
			const buffer = this.loadingEventBuffer;
			if (
				buffer &&
				buffer.requestSequence === this.requestSequence &&
				this.state.status === "loading"
			) {
				this.bufferRunEvent(buffer, event);
				return;
			}
			this.handleRunEvent(event);
		});
	}

	private bufferRunEvent(
		buffer: BufferedRunEvents,
		event: ConversationRunEventEnvelope,
	): void {
		if (buffer.events.length < MAX_BUFFERED_LOADING_EVENTS) {
			buffer.events.push(event);
			return;
		}
		buffer.overflowed = true;
	}

	private isCurrentResumeAttempt(attempt: ResumeAttempt): boolean {
		return (
			this.resumeAttempt === attempt &&
			attempt.requestSequence === this.requestSequence
		);
	}

	private finishResumeAttempt(attempt: ResumeAttempt): void {
		if (this.resumeAttempt === attempt) this.resumeAttempt = null;
	}

	private commitLoadedState(
		requestSequence: number,
		state: ConversationPageState,
	): void {
		if (requestSequence !== this.requestSequence) return;
		const buffer = this.loadingEventBuffer;
		this.loadingEventBuffer = null;
		this.setState(state);
		if (!buffer || buffer.requestSequence !== requestSequence) return;
		for (const event of buffer.events) this.handleRunEvent(event);
		if (!buffer.overflowed) return;
		const surface = readySurface(this.state);
		if (surface && surface.turn.status !== "idle") {
			void this.restoreRun(surface.turn.run.id);
			return;
		}
		void this.load();
	}

	private async decideToolApproval(
		decision: "approve-once" | "deny",
	): Promise<void> {
		const surface = readySurface(this.state);
		if (!surface || surface.turn.status !== "suspended") return;
		const approval = surface.turn.run.pendingApproval;
		if (!approval || surface.turn.run.approvalDecisionPending) return;
		const previousTurn = surface.turn;
		const requestId = createRequestId();
		this.setState({
			status: "ready",
			thread: surface.thread,
			turn: {
				...surface.turn,
				run: {
					...surface.turn.run,
					approvalDecisionPending: true,
					commandError: undefined,
				},
			},
		});
		try {
			const accepted = await this.service.decideToolApproval({
				requestId,
				runId: previousTurn.run.id,
				approvalId: approval.id,
				toolCallId: approval.toolCallId,
				inputDigest: approval.inputDigest,
				expectedRevision: previousTurn.run.revision,
				decision,
			});
			this.updateCommandRevision(previousTurn.run.id, accepted.revision);
		} catch (reason) {
			if (isRevisionConflict(reason)) {
				await this.restoreRun(previousTurn.run.id);
				return;
			}
			this.restoreCommandTurn(previousTurn, reason, "审批操作未生效，请重试。");
		}
	}

	private handleRunEvent(envelope: ConversationRunEventEnvelope): boolean {
		const surface = readySurface(this.state);
		if (!surface || surface.turn.status === "idle") return false;
		const currentRun = surface.turn.run;
		if (
			currentRun.id !== envelope.runId &&
			currentRun.requestId !== envelope.requestId
		)
			return false;
		if (envelope.sequence <= currentRun.lastSequence) {
			return this.reconcileRepeatedContentEvent(surface, envelope);
		}
		if (
			envelope.sequence !== currentRun.lastSequence + 1 ||
			envelope.revision < currentRun.revision
		) {
			void this.restoreRun(envelope.runId);
			return true;
		}

		const run: ConversationRun = {
			...currentRun,
			id: envelope.runId,
			revision: envelope.revision,
			lastSequence: envelope.sequence,
			updatedAtMs: envelope.emittedAtMs,
			commandError: undefined,
		};
		const applied = applyEvent(surface.thread, surface.turn, run, envelope);
		if (!applied) {
			void this.restoreRun(envelope.runId);
			return true;
		}
		this.setState({ status: "ready", ...applied });
		return false;
	}

	private reconcileRepeatedContentEvent(
		surface: { thread: ConversationThread; turn: ConversationTurnState },
		envelope: ConversationRunEventEnvelope,
	): boolean {
		const event = envelope.event;
		let thread: ConversationThread | null = null;
		switch (event.type) {
			case "message.started":
				thread = withConversationId(
					ensureAssistantMessageStarted(surface.thread, {
						id: event.messageId,
						role: "assistant",
						content: "",
						createdAtMs: event.createdAtMs,
						state: "streaming",
					}),
					event.conversationId,
				);
				break;
			case "message.delta": {
				const updated = updateAssistantDelta(
					surface.thread,
					event.messageId,
					event.startOffset,
					event.delta,
					envelope.emittedAtMs,
				);
				if (!updated) {
					void this.restoreRun(envelope.runId);
					return true;
				}
				thread = withConversationId(updated, event.conversationId);
				break;
			}
			case "message.completed":
				thread = withConversationId(
					upsertAssistantMessage(surface.thread, {
						id: event.messageId,
						role: "assistant",
						content: event.content,
						createdAtMs: event.createdAtMs,
						state: "complete",
					}),
					event.conversationId,
				);
				break;
			default:
				return false;
		}
		if (thread !== surface.thread) {
			this.setState({ status: "ready", thread, turn: surface.turn });
		}
		return false;
	}

	private updateCommandRevision(runId: string, revision: number): void {
		const surface = readySurface(this.state);
		if (
			!surface ||
			surface.turn.status === "idle" ||
			surface.turn.run.id !== runId
		)
			return;
		this.setState({
			status: "ready",
			thread: surface.thread,
			turn: withRun(surface.turn, {
				...surface.turn.run,
				revision: Math.max(surface.turn.run.revision, revision),
			}),
		});
	}

	private restoreCommandTurn(
		previousTurn: Exclude<ConversationTurnState, { status: "idle" }>,
		reason: unknown,
		fallback: string,
	): void {
		const surface = readySurface(this.state);
		if (!surface || surface.turn.status === "idle") return;
		if (surface.turn.run.id !== previousTurn.run.id) return;
		this.setState({
			status: "ready",
			thread: surface.thread,
			turn: withRun(previousTurn, {
				...previousTurn.run,
				approvalDecisionPending: false,
				commandError: serviceMessage(reason, fallback),
			}),
		});
	}

	private setLoadFailure(
		reason: unknown,
		cachedThread: ConversationThread | null,
	): void {
		if (reason instanceof ConversationServiceError) {
			if (reason.kind === "offline") {
				this.setState({
					status: "offline",
					message: reason.message,
					cachedThread,
				});
				return;
			}
			if (reason.kind === "unavailable") {
				this.setState({
					status: "unavailable",
					message: reason.message,
					cachedThread,
				});
				return;
			}
			this.setState({
				status: "error",
				message: reason.message,
				retryable: reason.retryable,
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

	private setOperationFailure(
		reason: unknown,
		thread: ConversationThread,
		turn: ConversationTurnState,
	): void {
		const message = serviceMessage(reason, "对话服务暂时不可用。");
		if (
			reason instanceof ConversationServiceError &&
			reason.kind === "offline"
		) {
			this.setState({ status: "offline", message, cachedThread: thread, turn });
			return;
		}
		if (
			reason instanceof ConversationServiceError &&
			reason.kind === "unavailable"
		) {
			this.setState({
				status: "unavailable",
				message,
				cachedThread: thread,
				turn,
			});
			return;
		}
		this.setState({
			status: "error",
			message,
			retryable: isRetryable(reason),
			thread,
			turn,
		});
	}

	private setState(state: ConversationPageState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
}

function applyEvent(
	thread: ConversationThread,
	previousTurn: Exclude<ConversationTurnState, { status: "idle" }>,
	run: ConversationRun,
	envelope: ConversationRunEventEnvelope,
): { thread: ConversationThread; turn: ConversationTurnState } | null {
	const event = envelope.event;
	switch (event.type) {
		case "run.started":
			return {
				thread: markMessageStates(thread, "queued", "complete"),
				turn: {
					status: "running",
					run: { ...run, status: "running", startedAtMs: event.startedAtMs },
				},
			};
		case "run.progress":
			return {
				thread,
				turn: {
					status: "running",
					run: {
						...run,
						status: "running",
						phase: event.phase,
						statusMessage: event.message,
					},
				},
			};
		case "message.started": {
			const nextThread = withConversationId(
				ensureAssistantMessageStarted(thread, {
					id: event.messageId,
					role: "assistant",
					content: "",
					createdAtMs: event.createdAtMs,
					state: "streaming",
				}),
				event.conversationId,
			);
			return {
				thread: nextThread,
				turn: { status: "running", run: { ...run, status: "running" } },
			};
		}
		case "message.delta": {
			const updatedThread = updateAssistantDelta(
				thread,
				event.messageId,
				event.startOffset,
				event.delta,
				envelope.emittedAtMs,
			);
			if (!updatedThread) return null;
			const nextThread = withConversationId(
				updatedThread,
				event.conversationId,
			);
			return {
				thread: nextThread,
				turn: { status: "running", run: { ...run, status: "running" } },
			};
		}
		case "message.completed": {
			const nextThread = withConversationId(
				upsertAssistantMessage(thread, {
					id: event.messageId,
					role: "assistant",
					content: event.content,
					createdAtMs: event.createdAtMs,
					state: "complete",
				}),
				event.conversationId,
			);
			return { thread: nextThread, turn: withRun(previousTurn, run) };
		}
		case "tool.updated":
			return {
				thread,
				turn: withRun(previousTurn, {
					...run,
					toolCalls: upsertToolCall(run.toolCalls, event.toolCall),
				}),
			};
		case "tool.progress":
			return {
				thread,
				turn: withRun(previousTurn, {
					...run,
					toolCalls: run.toolCalls.map((toolCall) =>
						toolCall.id === event.toolCallId
							? { ...toolCall, progress: event.message }
							: toolCall,
					),
				}),
			};
		case "approval.requested":
			return {
				thread,
				turn: {
					status: "suspended",
					run: {
						...run,
						status: "suspended",
						pendingApproval: event.approval,
						approvalDecisionPending: false,
					},
				},
			};
		case "approval.resolved":
			return {
				thread,
				turn: {
					status: "running",
					run: {
						...run,
						status: "running",
						pendingApproval: null,
						approvalDecisionPending: false,
					},
				},
			};
		case "run.suspended":
			return {
				thread,
				turn: { status: "suspended", run: { ...run, status: "suspended" } },
			};
		case "run.cancelling":
			return {
				thread,
				turn: { status: "cancelling", run: { ...run, status: "cancelling" } },
			};
		case "run.completed":
			return {
				thread: markTransientMessages(thread, "complete"),
				turn: { status: "idle" },
			};
		case "run.cancelled":
			return {
				thread: markCancelledMessages(thread),
				turn: {
					status: "cancelled",
					run: { ...run, status: "cancelled" },
					message: event.message || "已停止生成，已保留当前内容。",
				},
			};
		case "run.interrupted":
			return {
				thread: event.restorable
					? thread
					: markTransientMessages(thread, "failed"),
				turn: {
					status: "interrupted",
					run: { ...run, status: "interrupted" },
					message: event.message,
					restorable: event.restorable,
				},
			};
		case "run.failed":
			return {
				thread: markTransientMessages(thread, "failed"),
				turn: {
					status: "failed",
					run: { ...run, status: "failed" },
					message: event.message,
					retryable: event.retryable,
				},
			};
	}
}

function stateFromSnapshot(
	snapshot: ConversationRunSnapshot,
): ConversationPageState {
	const { run, conversation } = snapshot;
	switch (run.status) {
		case "completed":
			return {
				status: "ready",
				thread: conversation,
				turn: { status: "idle" },
			};
		case "cancelled":
			return {
				status: "ready",
				thread: conversation,
				turn: {
					status: "cancelled",
					run,
					message: "已停止生成，已保留当前内容。",
				},
			};
		case "interrupted":
			return {
				status: "ready",
				thread: conversation,
				turn: {
					status: "interrupted",
					run,
					message:
						snapshot.failure?.message || "这次运行已中断，可以尝试恢复。",
					restorable: true,
				},
			};
		case "failed":
			return {
				status: "ready",
				thread: conversation,
				turn: {
					status: "failed",
					run,
					message: snapshot.failure?.message || "这次运行未能完成。",
					retryable: snapshot.failure?.retryable ?? true,
				},
			};
		case "starting":
			return {
				status: "ready",
				thread: conversation,
				turn: { status: "starting", run },
			};
		case "running":
			return {
				status: "ready",
				thread: conversation,
				turn: { status: "running", run },
			};
		case "suspended":
			return {
				status: "ready",
				thread: conversation,
				turn: { status: "suspended", run },
			};
		case "cancelling":
			return {
				status: "ready",
				thread: conversation,
				turn: { status: "cancelling", run },
			};
	}
}

function readySurface(
	state: ConversationPageState,
): { thread: ConversationThread; turn: ConversationTurnState } | null {
	return state.status === "ready" ? state : null;
}

function threadForState(
	state: ConversationPageState,
): ConversationThread | null {
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

function canStartTurn(turn: ConversationTurnState): boolean {
	return (
		turn.status === "idle" ||
		turn.status === "cancelled" ||
		turn.status === "failed"
	);
}

function isActiveTurn(
	turn: ConversationTurnState,
): turn is Exclude<
	ConversationTurnState,
	{ status: "idle" | "cancelled" | "failed" | "interrupted" }
> {
	return [
		"starting",
		"running",
		"suspended",
		"cancelling",
		"recovering",
	].includes(turn.status);
}

function withRun(
	turn: Exclude<ConversationTurnState, { status: "idle" }>,
	run: ConversationRun,
): Exclude<ConversationTurnState, { status: "idle" }> {
	return { ...turn, run };
}

function withConversationId(
	thread: ConversationThread,
	conversationId: string,
): ConversationThread {
	return thread.id === conversationId && !thread.isDraft
		? thread
		: { ...thread, id: conversationId, isDraft: false };
}

function upsertAssistantMessage(
	thread: ConversationThread,
	message: ConversationMessage,
): ConversationThread {
	const exists = thread.messages.some((current) => current.id === message.id);
	return {
		...thread,
		updatedAtMs: Math.max(thread.updatedAtMs, message.createdAtMs),
		messages: exists
			? thread.messages.map((current) =>
					current.id === message.id ? message : current,
				)
			: [...thread.messages, message],
	};
}

function ensureAssistantMessageStarted(
	thread: ConversationThread,
	message: ConversationMessage,
): ConversationThread {
	return thread.messages.some((current) => current.id === message.id)
		? thread
		: upsertAssistantMessage(thread, message);
}

function updateAssistantDelta(
	thread: ConversationThread,
	messageId: string,
	startOffset: number,
	delta: string,
	createdAtMs: number,
): ConversationThread | null {
	if (!Number.isSafeInteger(startOffset) || startOffset < 0) return null;
	const existing = thread.messages.find((message) => message.id === messageId);
	if (!existing) {
		if (startOffset !== 0) return null;
		return upsertAssistantMessage(thread, {
			id: messageId,
			role: "assistant",
			content: delta,
			createdAtMs,
			state: "streaming",
		});
	}
	const endOffset = startOffset + delta.length;
	if (!Number.isSafeInteger(endOffset)) return null;
	if (existing.content.length > startOffset) {
		return existing.content.length >= endOffset &&
			existing.content.slice(startOffset, endOffset) === delta
			? thread
			: null;
	}
	if (existing.content.length !== startOffset) return null;
	return mapMessages(thread, (message) =>
		message.id === messageId
			? {
					...message,
					content: `${message.content}${delta}`,
					state: "streaming",
				}
			: message,
	);
}

function upsertToolCall(
	toolCalls: ConversationRun["toolCalls"],
	toolCall: ConversationRun["toolCalls"][number],
): readonly ConversationRun["toolCalls"][number][] {
	return toolCalls.some((current) => current.id === toolCall.id)
		? toolCalls.map((current) =>
				current.id === toolCall.id ? { ...current, ...toolCall } : current,
			)
		: [...toolCalls, toolCall];
}

function mapMessages(
	thread: ConversationThread,
	map: (message: ConversationMessage) => ConversationMessage,
): ConversationThread {
	return { ...thread, messages: thread.messages.map(map) };
}

function markMessageStates(
	thread: ConversationThread,
	from: ConversationMessage["state"],
	to: ConversationMessage["state"],
): ConversationThread {
	return mapMessages(thread, (message) =>
		message.state === from ? { ...message, state: to } : message,
	);
}

function markTransientMessages(
	thread: ConversationThread,
	state: Extract<ConversationMessage["state"], "complete" | "failed">,
): ConversationThread {
	return mapMessages(thread, (message) =>
		message.state === "queued" || message.state === "streaming"
			? { ...message, state }
			: message,
	);
}

function markCancelledMessages(thread: ConversationThread): ConversationThread {
	return mapMessages(thread, (message) => {
		if (message.state === "queued") return { ...message, state: "complete" };
		if (message.state === "streaming")
			return { ...message, state: "cancelled" };
		return message;
	});
}

function serviceMessage(reason: unknown, fallback: string): string {
	return reason instanceof Error && reason.message ? reason.message : fallback;
}

function isRetryable(reason: unknown): boolean {
	return reason instanceof ConversationServiceError ? reason.retryable : true;
}

function isRevisionConflict(reason: unknown): boolean {
	return (
		reason instanceof ConversationServiceError && reason.kind === "conflict"
	);
}

function createRequestId(): string {
	return `request-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
