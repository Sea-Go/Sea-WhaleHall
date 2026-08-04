import { randomUUID } from "node:crypto";
import type {
	AgentHostMethod,
	AgentRunEventFrame as SidecarRunEventFrame,
} from "../agent/mastra-host/protocol";
import {
	type ActivityAnalysisWorkerResult,
	isActivityAnalysisWorkerResult,
	MAXIMUM_ACTIVITY_ANALYSIS_PROMPT_CHARACTERS,
	MAXIMUM_ACTIVITY_ANALYSIS_RESULTS,
	serializedActivityAnalysisLength,
} from "../shared/activity-analysis-contract";
import {
	AGENT_RUN_EVENT_SCHEMA_VERSION,
	AGENT_RUN_SNAPSHOT_SCHEMA_VERSION,
	type AgentRunAccepted,
	type AgentRunCommandAccepted,
	type AgentRunEvent,
	type AgentRunFailure,
	type AgentRunRestorableSummary,
	type AgentRunRpcResult,
	type AgentRunSnapshot,
	type AgentToolCallSummary,
	type CancelAgentRunRequest,
	type DecideAgentToolApprovalRequest,
	type InternalAgentRunEventEnvelope,
	type ListRestorableAgentRunsRequest,
	type StartConversationTurnRequest,
	type StartTaskPlanningRunRequest,
	type SubmitPlanningClarificationRequest,
} from "../shared/agent-runs";
import type {
	ConversationRpcMessage,
	ConversationRpcResult,
	ConversationRpcThread,
} from "../shared/conversation";
import type { TaskPlanningSession } from "../shared/task-planning";
import {
	type AgentToolName,
	type AgentToolPolicy,
	digestArguments,
	type PendingToolApproval,
} from "./agent-tool-policy";
import type { AuthSessionIdentity } from "./auth-session";
import type {
	AgentConversationRecord,
	AgentMessageRecord,
	AgentRunRecord,
	EncryptedAgentRepository,
} from "./encrypted-agent-repository";
import type {
	AgentToolHost,
	ConversationMemoryService,
} from "./mastra-host-services";

const DELTA_FLUSH_MS = 75;
const PARTIAL_PERSIST_MS = 250;
const PARTIAL_PERSIST_CHARACTERS = 512;
const MAX_MESSAGE_CHARACTERS = 64 * 1024;

class AgentSessionChangedError extends Error {
	constructor(message = "登录会话已在本地 Agent 操作期间发生变化。") {
		super(message);
		this.name = "AgentSessionChangedError";
	}
}

export interface AgentSidecar {
	request<TResult = unknown>(
		method: AgentHostMethod,
		params: Record<string, unknown>,
		options?: { requestId?: string; timeoutMs?: number },
	): Promise<TResult>;
	trackRun(runId: string): void;
	untrackRun(runId: string): void;
}

function messageProjection(
	message: AgentMessageRecord,
): ConversationRpcMessage {
	return {
		id:
			message.role === "user" && message.clientMessageId
				? message.clientMessageId
				: message.id,
		role: message.role as "user" | "assistant",
		content: message.content,
		createdAtMs: message.createdAtMs,
		state:
			message.status === "complete"
				? "complete"
				: message.status === "partial" || message.status === "interrupted"
					? "streaming"
					: message.status === "cancelled"
						? "cancelled"
						: "failed",
	};
}

function parsePlanningSession(
	value: unknown,
	fallbackId?: string,
): TaskPlanningSession | null {
	if (!isRecord(value)) return null;
	const status = value.status;
	const id =
		typeof value.sessionId === "string"
			? value.sessionId
			: typeof value.id === "string"
				? value.id
				: fallbackId;
	if (!id) return null;
	if (status === "clarifying" && Array.isArray(value.questions)) {
		const questions = value.questions.filter(
			(item): item is { key: never; text: string; required: boolean } =>
				isRecord(item) &&
				typeof item.key === "string" &&
				typeof item.text === "string" &&
				typeof item.required === "boolean",
		);
		if (
			questions.length !== value.questions.length ||
			questions.length < 1 ||
			questions.length > 3
		)
			return null;
		return { id, status: "clarifying", questions };
	}
	const draft =
		(status === "draft" || status === "conflict") && isRecord(value.draft)
			? value.draft
			: isRecord(value.result) &&
					value.result.status === "draft" &&
					isRecord(value.result.draft)
				? value.result.draft
				: null;
	if (draft && status === "conflict") {
		const validationIssues = Array.isArray(value.validationIssues)
			? value.validationIssues.filter(
					(
						issue,
					): issue is {
						code: string;
						message: string;
						proposalId?: string;
						busyEventIds?: readonly string[];
					} =>
						isRecord(issue) &&
						typeof issue.code === "string" &&
						typeof issue.message === "string",
				)
			: [];
		return {
			id,
			status: "conflict",
			draft: structuredClone(draft) as never,
			validationIssues: structuredClone(validationIssues),
		};
	}
	if (draft)
		return { id, status: "draft", draft: structuredClone(draft) as never };
	return null;
}

function parsePersistedSnapshot(value: unknown): AgentRunSnapshot | null {
	if (
		!isRecord(value) ||
		value.schemaVersion !== AGENT_RUN_SNAPSHOT_SCHEMA_VERSION ||
		typeof value.runId !== "string" ||
		(value.kind !== "conversation-turn" &&
			value.kind !== "task-planning" &&
			value.kind !== "activity-analysis")
	)
		return null;
	return structuredClone(value) as unknown as AgentRunSnapshot;
}

function accepted(snapshot: AgentRunSnapshot, now: number): AgentRunAccepted {
	return {
		runId: snapshot.runId,
		requestId: snapshot.requestId,
		kind: snapshot.kind,
		revision: snapshot.revision,
		acceptedAtMs: now,
	};
}

function commandAccepted(
	snapshot: AgentRunSnapshot,
	requestId: string,
	now: number,
): AgentRunCommandAccepted {
	return {
		runId: snapshot.runId,
		requestId,
		revision: snapshot.revision,
		acceptedAtMs: now,
	};
}

function conversationResultText(value: unknown): string | null {
	if (!isRecord(value)) return null;
	if (isRecord(value.message) && typeof value.message.content === "string")
		return value.message.content;
	return typeof value.text === "string" ? value.text : null;
}

function activityResultText(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const candidate =
		typeof value.summary === "string"
			? value.summary
			: typeof value.text === "string"
				? value.text
				: null;
	if (candidate === null || candidate.length > MAX_MESSAGE_CHARACTERS)
		return null;
	return candidate;
}

function terminal(status: AgentRunSnapshot["status"]): boolean {
	return (
		status === "completed" ||
		status === "cancelled" ||
		status === "interrupted" ||
		status === "failed"
	);
}

function isRecoverableSuspension(snapshot: AgentRunSnapshot): boolean {
	if (snapshot.status !== "suspended") return false;
	return snapshot.kind === "task-planning"
		? snapshot.session?.status === "clarifying"
		: snapshot.pendingApproval !== null;
}

function appendRecoveryNotice(content: string, notice: string): string {
	const trimmed = content.trim();
	return trimmed ? `${trimmed}\n\n${notice}` : notice;
}

function isRestorableRunStatus(
	status: AgentRunSnapshot["status"],
): status is AgentRunRestorableSummary["status"] {
	return [
		"starting",
		"running",
		"suspended",
		"cancelling",
		"interrupted",
	].includes(status);
}

function conflict<T = never>(
	message: string,
	currentRevision: number,
): AgentRunRpcResult<T> {
	return { kind: "conflict", message, currentRevision };
}

function agentError<T = never>(error: unknown): AgentRunRpcResult<T> {
	const message =
		error instanceof Error ? error.message : "本地 Agent 发生未知错误。";
	if (/登录/.test(message)) return { kind: "unavailable", message };
	return { kind: "error", message, retryable: false };
}

function conversationError<T = never>(
	error: unknown,
): ConversationRpcResult<T> {
	const message =
		error instanceof Error ? error.message : "本地对话存储不可用。";
	return /登录/.test(message)
		? { kind: "unavailable", message }
		: { kind: "error", message };
}

function modelFailure(error: unknown): AgentRunFailure {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "MODEL_RELAY_UNAVAILABLE"
	) {
		return {
			code: "unavailable",
			message:
				error instanceof Error
					? error.message
					: "当前账号没有可用的模型转发能力。",
			retryable: false,
		};
	}
	return {
		code: "model-failed",
		message: error instanceof Error ? error.message : "模型请求失败。",
		retryable: true,
	};
}

function internalFailure(error: unknown): AgentRunFailure {
	return {
		code: "internal",
		message:
			error instanceof Error ? error.message : "本地 Agent 状态处理失败。",
		retryable: false,
	};
}

function validateConversationStart(input: StartConversationTurnRequest): void {
	validateRequestId(input.requestId);
	requiredId(input.clientMessageId, "clientMessageId");
	if (input.conversationId !== undefined)
		requiredId(input.conversationId, "conversationId");
	if (input.retryOfRunId !== undefined)
		requiredId(input.retryOfRunId, "retryOfRunId");
	if (
		typeof input.text !== "string" ||
		!input.text.trim() ||
		input.text.length > MAX_MESSAGE_CHARACTERS
	) {
		throw new Error("消息必须包含 1 到 65536 个字符。");
	}
}

function validateRequestId(value: string): void {
	requiredId(value, "requestId");
}

function validateActivityAnalysisStart(input: StartActivityAnalysisRun): void {
	requiredId(input.jobId, "activityJobId");
	requiredId(input.runId, "runId");
	validateRequestId(input.requestId);
	if (
		!Number.isFinite(input.consumedScore) ||
		input.consumedScore < 0 ||
		input.consumedScore > 10_000 ||
		!Array.isArray(input.analyses) ||
		input.analyses.length < 1 ||
		input.analyses.length > MAXIMUM_ACTIVITY_ANALYSIS_RESULTS
	) {
		throw new Error("Activity analysis job is invalid.");
	}
	for (const analysis of input.analyses) {
		if (!isActivityAnalysisWorkerResult(analysis)) {
			throw new Error(
				"Activity analysis payload must contain Worker results only.",
			);
		}
	}
	if (
		serializedActivityAnalysisLength(input.analyses) >
		MAXIMUM_ACTIVITY_ANALYSIS_PROMPT_CHARACTERS
	) {
		throw new Error(
			"Activity analysis payload exceeds the prompt safety limit.",
		);
	}
}

function requiredId(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256) {
		throw new Error(`${field} 无效。`);
	}
	return value;
}

function requiredRecord(
	value: unknown,
	field: string,
): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${field} 必须是对象。`);
	return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const readToolNames = new Set<AgentToolName>([
	"calendar.list_events",
	"planning.get_active_plan",
	"planning.get_active_goal",
]);
const writeToolNames = new Set<AgentToolName>([
	"planning.save_draft",
	"calendar.create_event",
	"calendar.update_event",
	"calendar.delete_event",
	"calendar.commit_plan_schedule",
]);

function requiredToolName(value: unknown): AgentToolName {
	if (
		typeof value !== "string" ||
		(!readToolNames.has(value as AgentToolName) &&
			!writeToolNames.has(value as AgentToolName))
	) {
		throw new Error("Tool 不在本地 Agent allowlist 中。");
	}
	return value as AgentToolName;
}

function isReadToolName(value: AgentToolName): boolean {
	return readToolNames.has(value);
}

function isWriteToolName(value: AgentToolName): boolean {
	return writeToolNames.has(value);
}

function toolSummary(
	name: AgentToolName,
	id: string,
	status: AgentToolCallSummary["status"],
	now: number,
): AgentToolCallSummary {
	const risk = isReadToolName(name)
		? "read"
		: name === "calendar.delete_event" ||
				name === "calendar.commit_plan_schedule"
			? "control"
			: "write";
	return {
		id,
		name,
		label: toolLabels[name],
		risk,
		status,
		startedAtMs: status === "running" ? now : undefined,
	};
}

const toolLabels: Record<AgentToolName, string> = {
	"calendar.list_events": "读取日历",
	"planning.get_active_plan": "读取当前计划",
	"planning.get_active_goal": "读取当前目标",
	"planning.save_draft": "保存计划草案",
	"calendar.create_event": "新建日程",
	"calendar.update_event": "修改日程",
	"calendar.delete_event": "删除日程",
	"calendar.commit_plan_schedule": "提交计划排程",
};

function toolKey(runId: string, toolCallId: string): string {
	return `${runId}:${toolCallId}`;
}

export interface LocalAgentToolExecutor {
	execute(input: {
		accountId: string;
		runId: string;
		toolCallId: string;
		name: AgentToolName;
		arguments: Record<string, unknown>;
	}): Promise<unknown>;
	cancel?(accountId: string, toolCallId: string): Promise<boolean>;
}

export interface AgentRunCoordinatorOptions {
	sessionIdentity: () => AuthSessionIdentity | null;
	repository: EncryptedAgentRepository;
	sidecar: AgentSidecar;
	abortModelRelay(runId: string): boolean;
	toolPolicy: AgentToolPolicy;
	toolExecutor: LocalAgentToolExecutor;
	onEvent(event: InternalAgentRunEventEnvelope): void;
	/** Runs after an internal activity analysis has been durably persisted. */
	onActivityRunTerminal?(input: {
		jobId: string;
		runId: string;
		accountId: string;
		status: "completed" | "failed" | "cancelled" | "interrupted";
		failure: AgentRunFailure | null;
	}): void | Promise<void>;
	now?: () => number;
}

export type StartActivityAnalysisRun = {
	jobId: string;
	runId: string;
	requestId: string;
	analyses: readonly ActivityAnalysisWorkerResult[];
	consumedScore: number;
};

interface ActiveRun {
	accountId: string;
	sessionIdentity: AuthSessionIdentity;
	recordInput: Record<string, unknown>;
	snapshot: AgentRunSnapshot;
	assistantContent: string;
	pendingDelta: string;
	deltaTimer: ReturnType<typeof setTimeout> | null;
	lastPartialPersistAtMs: number;
	lastPartialPersistLength: number;
	lastSidecarSequence: number;
	chain: Promise<void>;
	recoveredFromPersistence: boolean;
	criticalOperation: ActiveRunCriticalOperation | null;
	hostCalls: Set<Promise<void>>;
	sidecarPlanningVersion?: number;
}

interface ActiveRunCriticalOperation {
	kind:
		| "approval-decision"
		| "recovered-approval-resolution"
		| "tool-execution";
	readonly settled: Promise<void>;
	readonly settle: () => void;
}

interface PendingStart {
	identity: AuthSessionIdentity;
	settled: Promise<void>;
	settle(): void;
}

export class AgentRunCoordinator
	implements ConversationMemoryService, AgentToolHost
{
	private readonly repository: EncryptedAgentRepository;
	private readonly sessionIdentityProvider: () => AuthSessionIdentity | null;
	private readonly sidecar: AgentSidecar;
	private readonly abortModelRelay: (runId: string) => boolean;
	private readonly toolPolicy: AgentToolPolicy;
	private readonly toolExecutor: LocalAgentToolExecutor;
	private readonly onEvent: (event: InternalAgentRunEventEnvelope) => void;
	private readonly onActivityRunTerminal: NonNullable<
		AgentRunCoordinatorOptions["onActivityRunTerminal"]
	>;
	private readonly now: () => number;
	private readonly active = new Map<string, ActiveRun>();
	private readonly pendingStarts = new Set<PendingStart>();
	private readonly approvedToolCalls = new Map<string, PendingToolApproval>();

	constructor(options: AgentRunCoordinatorOptions) {
		this.sessionIdentityProvider = options.sessionIdentity;
		this.repository = options.repository;
		this.sidecar = options.sidecar;
		this.abortModelRelay = options.abortModelRelay;
		this.toolPolicy = options.toolPolicy;
		this.toolExecutor = options.toolExecutor;
		this.onEvent = options.onEvent;
		this.onActivityRunTerminal = options.onActivityRunTerminal ?? (() => {});
		this.now = options.now ?? Date.now;
	}

	async getActiveConversation(): Promise<
		ConversationRpcResult<ConversationRpcThread | null>
	> {
		try {
			const identity = this.requireSession();
			const accountId = identity.accountId;
			const conversation = (
				await this.inSession(identity, () =>
					this.repository.listConversations(accountId, 1),
				)
			)[0];
			return {
				kind: "success",
				data: conversation
					? await this.inSession(identity, () =>
							this.buildConversation(accountId, conversation),
						)
					: null,
			};
		} catch (error) {
			return conversationError(error);
		}
	}

	async startConversationTurn(
		input: StartConversationTurnRequest,
	): Promise<AgentRunRpcResult<AgentRunAccepted>> {
		let pendingStart: PendingStart | null = null;
		try {
			validateConversationStart(input);
			const identity = this.requireSession();
			pendingStart = this.beginPendingStart(identity);
			const accountId = identity.accountId;
			const existingMessage = await this.inSession(identity, () =>
				this.repository.getMessageByClientMessageId(
					accountId,
					input.clientMessageId,
				),
			);
			if (existingMessage && !input.retryOfRunId) {
				const existingRun = existingMessage.runId
					? await this.inSession(identity, () =>
							this.repository.getRun(accountId, existingMessage.runId!),
						)
					: null;
				const snapshot = existingRun
					? parsePersistedSnapshot(existingRun.output)
					: null;
				if (snapshot)
					return { kind: "success", data: accepted(snapshot, this.now()) };
				return conflict("该 clientMessageId 已写入，拒绝重复创建用户消息。", 0);
			}
			if (input.retryOfRunId) {
				if (!existingMessage || existingMessage.runId !== input.retryOfRunId) {
					return {
						kind: "not-found",
						message: "找不到与 retryOfRunId 对应的用户消息。",
					};
				}
				if (existingMessage.content !== input.text) {
					return conflict("重试必须使用原始用户消息内容。", 0);
				}
				const previous = await this.inSession(identity, () =>
					this.repository.getRun(accountId, input.retryOfRunId!),
				);
				if (
					!previous ||
					!["failed", "cancelled", "interrupted"].includes(previous.status)
				) {
					return conflict(
						"只有失败、取消或中断的运行可以显式重试。",
						parsePersistedSnapshot(previous?.output)?.revision ?? 0,
					);
				}
			}

			const now = this.now();
			const runId = `run-${randomUUID()}`;
			const conversation = await this.inSession(identity, () =>
				this.resolveConversation(accountId, input, now, existingMessage),
			);
			const busy = (
				await this.inSession(identity, () =>
					this.repository.listRuns(accountId, 1_000),
				)
			).find(
				(record) =>
					record.conversationId === conversation.id &&
					["starting", "running", "suspended", "cancelling"].includes(
						record.status,
					) &&
					!this.active.has(record.id),
			);
			const activeBusy = [...this.active.values()].find(
				(run) =>
					run.accountId === accountId &&
					run.snapshot.kind === "conversation-turn" &&
					run.snapshot.conversationId === conversation.id,
			);
			if (busy || activeBusy)
				return conflict(
					"该对话已有一个进行中的 turn。",
					activeBusy?.snapshot.revision ?? 0,
				);

			const userMessage: AgentMessageRecord = existingMessage ?? {
				accountId,
				id: `message-${randomUUID()}`,
				conversationId: conversation.id,
				clientMessageId: input.clientMessageId,
				runId,
				role: "user",
				status: "complete",
				content: input.text,
				createdAtMs: now,
			};
			if (!existingMessage || existingMessage.runId !== runId) {
				await this.inSession(identity, () =>
					this.repository.putMessage({ ...userMessage, runId }),
				);
			}
			const assistantMessage: AgentMessageRecord = {
				accountId,
				id: `message-${randomUUID()}`,
				conversationId: conversation.id,
				clientMessageId: null,
				runId,
				role: "assistant",
				status: "partial",
				content: "",
				createdAtMs: now + 1,
			};
			await this.inSession(identity, () =>
				this.repository.putMessage(assistantMessage),
			);
			conversation.updatedAtMs = now;
			await this.inSession(identity, () =>
				this.repository.putConversation(conversation),
			);

			const thread = await this.inSession(identity, () =>
				this.buildConversation(accountId, conversation),
			);
			const snapshot: AgentRunSnapshot = {
				schemaVersion: AGENT_RUN_SNAPSHOT_SCHEMA_VERSION,
				runId,
				requestId: input.requestId,
				kind: "conversation-turn",
				status: "starting",
				revision: 1,
				lastSequence: 0,
				startedAtMs: now,
				updatedAtMs: now,
				toolCalls: [],
				pendingApproval: null,
				conversationId: conversation.id,
				clientMessageId: input.clientMessageId,
				assistantMessageId: assistantMessage.id,
				conversation: thread,
			};
			const recordInput = {
				kind: "conversation-turn",
				requestId: input.requestId,
				clientMessageId: input.clientMessageId,
				text: input.text,
				...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
			};
			const run = this.activate(identity, snapshot, recordInput);
			await this.persistRun(run);
			this.assertRunSession(run);
			this.sidecar.trackRun(runId);
			await this.emit(run, {
				type: "conversation.message.started",
				conversationId: conversation.id,
				messageId: assistantMessage.id,
				createdAtMs: assistantMessage.createdAtMs,
			});
			this.assertRunSession(run);
			void this.sidecar
				.request(
					"conversation.start",
					{
						runId,
						conversationId: conversation.id,
						resourceId: accountId,
						message: input.text,
						history: [],
					},
					{ requestId: input.requestId },
				)
				.catch((error) => this.failRun(runId, modelFailure(error)));
			return { kind: "success", data: accepted(snapshot, now) };
		} catch (error) {
			return agentError(error);
		} finally {
			pendingStart?.settle();
		}
	}

	async startTaskPlanningRun(
		input: StartTaskPlanningRunRequest,
	): Promise<AgentRunRpcResult<AgentRunAccepted>> {
		let pendingStart: PendingStart | null = null;
		try {
			validateRequestId(input.requestId);
			const identity = this.requireSession();
			pendingStart = this.beginPendingStart(identity);
			const accountId = identity.accountId;
			await this.inSession(identity, () =>
				this.toolPolicy.assertReadAllowed(accountId, "calendar.list_events"),
			);
			await this.inSession(identity, () =>
				this.toolPolicy.assertReadAllowed(
					accountId,
					"planning.get_active_plan",
				),
			);
			const now = this.now();
			const runId = `run-${randomUUID()}`;
			const sessionId = `planning-${randomUUID()}`;
			const snapshot: AgentRunSnapshot = {
				schemaVersion: AGENT_RUN_SNAPSHOT_SCHEMA_VERSION,
				runId,
				requestId: input.requestId,
				kind: "task-planning",
				status: "starting",
				revision: 1,
				lastSequence: 0,
				startedAtMs: now,
				updatedAtMs: now,
				toolCalls: [],
				pendingApproval: null,
				input: structuredClone(input.input),
				session: null,
			};
			const run = this.activate(identity, snapshot, {
				kind: "task-planning",
				requestId: input.requestId,
				sessionId,
				input: structuredClone(input.input),
			});
			await this.persistRun(run);
			this.assertRunSession(run);
			this.sidecar.trackRun(runId);
			this.assertRunSession(run);
			void this.sidecar
				.request(
					"planning.start",
					{
						runId,
						sessionId,
						input: structuredClone(input.input),
					},
					{ requestId: input.requestId },
				)
				.catch((error) => this.failRun(runId, modelFailure(error)));
			return { kind: "success", data: accepted(snapshot, now) };
		} catch (error) {
			return agentError(error);
		} finally {
			pendingStart?.settle();
		}
	}

	/**
	 * Starts the non-interactive activity sidecar. There is intentionally no RPC
	 * endpoint for this method: only the durable local activity dispatcher may
	 * invoke it after it has claimed a Worker-result job.
	 */
	async startActivityAnalysis(input: StartActivityAnalysisRun): Promise<void> {
		let pendingStart: PendingStart | null = null;
		try {
			validateActivityAnalysisStart(input);
			const identity = this.requireSession();
			pendingStart = this.beginPendingStart(identity);
			const existing = await this.inSession(identity, () =>
				this.repository.getRun(identity.accountId, input.runId),
			);
			if (existing !== null) {
				throw new Error(
					"Activity analysis run id already exists for this account.",
				);
			}
			const now = this.now();
			const snapshot: AgentRunSnapshot = {
				schemaVersion: AGENT_RUN_SNAPSHOT_SCHEMA_VERSION,
				runId: input.runId,
				requestId: input.requestId,
				kind: "activity-analysis",
				status: "starting",
				revision: 1,
				lastSequence: 0,
				startedAtMs: now,
				updatedAtMs: now,
				toolCalls: [],
				pendingApproval: null,
				activityJobId: input.jobId,
				analysisCount: input.analyses.length,
				consumedScore: input.consumedScore,
				result: null,
			};
			const run = this.activate(identity, snapshot, {
				kind: "activity-analysis",
				jobId: input.jobId,
				requestId: input.requestId,
				consumedScore: input.consumedScore,
				analyses: structuredClone(input.analyses),
			});
			await this.persistRun(run);
			this.assertRunSession(run);
			this.sidecar.trackRun(input.runId);
			void this.sidecar
				.request(
					"activity.start",
					{
						runId: input.runId,
						activityJobId: input.jobId,
						consumedScore: input.consumedScore,
						analyses: structuredClone(input.analyses),
					},
					{ requestId: input.requestId },
				)
				.catch((error) => this.failRun(input.runId, modelFailure(error)));
		} finally {
			pendingStart?.settle();
		}
	}

	async submitPlanningClarification(
		input: SubmitPlanningClarificationRequest,
	): Promise<AgentRunRpcResult<AgentRunCommandAccepted>> {
		const run = await this.requireMutableRun(
			input.runId,
			input.expectedRevision,
			"task-planning",
		);
		if ("kind" in run) return run;
		if (run.snapshot.kind !== "task-planning") {
			return conflict("该运行不是规划运行。", run.snapshot.revision);
		}
		const snapshot = run.snapshot;
		if (
			snapshot.status !== "suspended" ||
			!snapshot.session ||
			snapshot.session.status !== "clarifying"
		) {
			return conflict("该规划运行当前不等待澄清答案。", run.snapshot.revision);
		}
		try {
			await this.toolPolicy.assertReadAllowed(
				run.accountId,
				"calendar.list_events",
			);
			await this.toolPolicy.assertReadAllowed(
				run.accountId,
				"planning.get_active_plan",
			);
			this.assertRunSession(run);
		} catch (error) {
			return agentError(error);
		}
		snapshot.revision += 1;
		snapshot.status = "running";
		await this.persistRun(run);
		this.sidecar.trackRun(input.runId);
		void this.sidecar
			.request(
				"planning.answer",
				{
					runId: input.runId,
					sessionId: snapshot.session.id,
					answers: input.answers,
					...(run.sidecarPlanningVersion !== undefined
						? { expectedVersion: run.sidecarPlanningVersion }
						: {}),
				},
				{ requestId: input.requestId },
			)
			.catch((error) => this.failRun(input.runId, modelFailure(error)));
		return {
			kind: "success",
			data: commandAccepted(snapshot, input.requestId, this.now()),
		};
	}

	async cancelAgentRun(
		input: CancelAgentRunRequest,
	): Promise<AgentRunRpcResult<AgentRunCommandAccepted>> {
		const run = await this.requireMutableRun(
			input.runId,
			input.expectedRevision,
		);
		if ("kind" in run) return run;
		if (terminal(run.snapshot.status))
			return conflict("该运行已经结束。", run.snapshot.revision);
		if (run.criticalOperation) {
			return conflict(
				"审批决定或已批准的本地操作正在收敛，当前不可取消。",
				run.snapshot.revision,
			);
		}
		this.abortRelayForRun(input.runId);
		run.snapshot.revision += 1;
		run.snapshot.status = "cancelling";
		await this.emit(run, { type: "run.cancelling" });
		this.sidecar.trackRun(input.runId);
		void this.sidecar
			.request(
				"run.cancel",
				{ runId: input.runId, reason: "user" },
				{
					requestId: input.requestId,
					timeoutMs: 10_000,
				},
			)
			.catch(() => this.finishCancelled(run, "已停止本地 Agent 运行。"));
		return {
			kind: "success",
			data: commandAccepted(run.snapshot, input.requestId, this.now()),
		};
	}

	async decideAgentToolApproval(
		input: DecideAgentToolApprovalRequest,
	): Promise<AgentRunRpcResult<AgentRunCommandAccepted>> {
		const run = await this.requireMutableRun(
			input.runId,
			input.expectedRevision,
			"conversation-turn",
		);
		if ("kind" in run) return run;
		if (run.criticalOperation) {
			return conflict(
				"该运行已有一个审批决定正在处理。",
				run.snapshot.revision,
			);
		}
		const criticalOperation = this.beginCriticalOperation(
			run,
			"approval-decision",
		);
		let handedOffToRecoveredResolution = false;
		try {
			const approval = await this.toolPolicy.decide({
				accountId: run.accountId,
				approvalId: input.approvalId,
				runId: input.runId,
				toolCallId: input.toolCallId,
				inputDigest: input.inputDigest,
				runRevision: input.expectedRevision,
				decision: input.decision,
			});
			this.assertRunSession(run);
			run.snapshot.revision += 1;
			run.snapshot.status = "running";
			run.snapshot.pendingApproval = null;
			if (input.decision === "approve-once" && !run.recoveredFromPersistence) {
				this.approvedToolCalls.set(
					toolKey(input.runId, input.toolCallId),
					approval,
				);
			}
			await this.emit(run, {
				type: "tool.approval.resolved",
				approvalId: input.approvalId,
				decision: input.decision,
			});
			if (run.recoveredFromPersistence) {
				criticalOperation.kind = "recovered-approval-resolution";
				const resolution = this.resolveRecoveredApproval(
					run,
					approval,
					input.decision,
				).catch((error) => this.failRun(input.runId, internalFailure(error)));
				handedOffToRecoveredResolution = true;
				void resolution.then(
					() => this.endCriticalOperation(run, criticalOperation),
					() => this.endCriticalOperation(run, criticalOperation),
				);
				return {
					kind: "success",
					data: commandAccepted(run.snapshot, input.requestId, this.now()),
				};
			}
			const method =
				input.decision === "approve-once"
					? "agent.approveTool"
					: "agent.declineTool";
			this.sidecar.trackRun(input.runId);
			void this.sidecar
				.request(
					method,
					{
						runId: input.runId,
						toolCallId: input.toolCallId,
						resumeData:
							input.decision === "approve-once"
								? { approvalId: input.approvalId }
								: { denied: true },
					},
					{ requestId: input.requestId },
				)
				.catch((error) => this.failRun(input.runId, modelFailure(error)));
			return {
				kind: "success",
				data: commandAccepted(run.snapshot, input.requestId, this.now()),
			};
		} catch (error) {
			return agentError(error);
		} finally {
			if (!handedOffToRecoveredResolution) {
				this.endCriticalOperation(run, criticalOperation);
			}
		}
	}

	async getAgentRunSnapshot(
		runId: string,
	): Promise<AgentRunRpcResult<AgentRunSnapshot>> {
		try {
			const identity = this.requireSession();
			const accountId = identity.accountId;
			const active = this.active.get(runId);
			if (
				active?.accountId === accountId &&
				sameSessionIdentity(active.sessionIdentity, identity)
			) {
				if (active.snapshot.kind === "activity-analysis") {
					return { kind: "not-found", message: "找不到该本地 Agent 运行。" };
				}
				return {
					kind: "success",
					data: await this.hydrateSnapshot(identity, active.snapshot),
				};
			}
			const record = await this.inSession(identity, () =>
				this.repository.getRun(accountId, runId),
			);
			if (!record)
				return { kind: "not-found", message: "找不到该本地 Agent 运行。" };
			const snapshot = parsePersistedSnapshot(record.output);
			if (!snapshot)
				return {
					kind: "error",
					message: "本地 Agent 运行快照损坏。",
					retryable: false,
				};
			if (snapshot.kind === "activity-analysis") {
				return { kind: "not-found", message: "找不到该本地 Agent 运行。" };
			}
			return {
				kind: "success",
				data: await this.hydrateSnapshot(identity, snapshot),
			};
		} catch (error) {
			return agentError(error);
		}
	}

	async listRestorableAgentRuns(
		input: ListRestorableAgentRunsRequest,
	): Promise<
		AgentRunRpcResult<{ runs: readonly AgentRunRestorableSummary[] }>
	> {
		try {
			const identity = this.requireSession();
			const accountId = identity.accountId;
			await this.markOrphanedRunsInterrupted(identity);
			const records = await this.inSession(identity, () =>
				this.repository.listRuns(accountId, 1_000),
			);
			const runs: AgentRunRestorableSummary[] = [];
			for (const record of records) {
				const snapshot = parsePersistedSnapshot(record.output);
				if (!snapshot || !isRestorableRunStatus(snapshot.status)) continue;
				if (snapshot.kind === "activity-analysis") continue;
				if (input.kind && snapshot.kind !== input.kind) continue;
				if (
					input.conversationId &&
					(snapshot.kind !== "conversation-turn" ||
						snapshot.conversationId !== input.conversationId)
				)
					continue;
				runs.push({
					runId: snapshot.runId,
					requestId: snapshot.requestId,
					kind: snapshot.kind,
					status: snapshot.status,
					revision: snapshot.revision,
					lastSequence: snapshot.lastSequence,
					updatedAtMs: snapshot.updatedAtMs,
					...(snapshot.kind === "conversation-turn"
						? {
								conversationId: snapshot.conversationId,
								title: snapshot.conversation.title,
							}
						: snapshot.session?.status === "draft"
							? { title: snapshot.session.draft.title }
							: {}),
				});
			}
			return { kind: "success", data: { runs } };
		} catch (error) {
			return agentError(error);
		}
	}

	acceptSidecarEvent(frame: SidecarRunEventFrame): void {
		const run = this.active.get(frame.runId);
		if (!run || !this.isRunSessionCurrent(run)) return;
		run.chain = run.chain
			.then(async () => {
				if (!this.isRunSessionCurrent(run)) return;
				if (frame.sequence !== run.lastSidecarSequence + 1) {
					await this.interruptRun(
						run,
						"本地 Agent 协议事件出现序列缺口。",
						false,
					);
					return;
				}
				run.lastSidecarSequence = frame.sequence;
				await this.applySidecarEvent(run, frame);
			})
			.catch((error) =>
				this.failRun(run.snapshot.runId, internalFailure(error)),
			);
	}

	async interruptRuns(
		runIds: readonly string[],
		reason: string,
	): Promise<void> {
		await Promise.all(
			runIds.map(async (runId) => {
				const run = this.active.get(runId);
				if (!run) return;
				if (run.criticalOperation) {
					await run.criticalOperation.settled;
					if (this.active.get(runId) !== run || terminal(run.snapshot.status))
						return;
				}
				if (isRecoverableSuspension(run.snapshot)) {
					run.lastSidecarSequence = 0;
					run.recoveredFromPersistence = true;
					await this.persistRun(run);
					return;
				}
				await this.interruptRun(run, reason, true);
			}),
		);
	}

	async cancelAllForAccount(accountId: string): Promise<void> {
		for (;;) {
			const starts = [...this.pendingStarts]
				.filter((start) => start.identity.accountId === accountId)
				.map((start) => start.settled);
			if (starts.length === 0) break;
			await Promise.allSettled(starts);
		}
		const runs = [...this.active.values()].filter(
			(run) => run.accountId === accountId,
		);
		await Promise.all(
			runs.map(async (run) => {
				await run.chain.catch(() => undefined);
				if (this.active.get(run.snapshot.runId) !== run) return;
				for (;;) {
					const hostCalls = [...run.hostCalls];
					if (hostCalls.length === 0) break;
					await Promise.allSettled(hostCalls);
				}
				if (run.criticalOperation) {
					await run.criticalOperation.settled;
					if (
						this.active.get(run.snapshot.runId) !== run ||
						terminal(run.snapshot.status)
					)
						return;
				}
				if (terminal(run.snapshot.status)) {
					await this.finishRun(run, run.snapshot.failure ?? null, true);
					return;
				}
				this.abortRelayForRun(run.snapshot.runId);
				await Promise.all(
					run.snapshot.toolCalls
						.filter(
							(toolCall) =>
								toolCall.status === "running" ||
								toolCall.status === "awaiting-approval",
						)
						.map((toolCall) =>
							this.toolExecutor
								.cancel?.(accountId, toolCall.id)
								.catch(() => false),
						),
				);
				await this.sidecar
					.request(
						"run.cancel",
						{ runId: run.snapshot.runId, reason: "logout" },
						{
							requestId: `logout-${randomUUID()}`,
							timeoutMs: 3_000,
						},
					)
					.catch(() => undefined);
				await this.finishCancelledForLogout(run);
			}),
		);
	}

	async runBoundHostCall<TResult>(
		ownerRunId: string,
		operation: (accountId: string) => Promise<TResult>,
	): Promise<TResult> {
		const run = this.requireHostRun(ownerRunId);
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		run.hostCalls.add(settled);
		try {
			this.assertRunSession(run);
			const result = await operation(run.accountId);
			this.assertRunSession(run);
			return result;
		} finally {
			run.hostCalls.delete(settled);
			settle();
		}
	}

	async load(
		accountId: string,
		ownerRunId: string,
		conversationId: string,
	): Promise<{
		messages: readonly { role: "user" | "assistant"; content: string }[];
		version: number;
	}> {
		this.assertCurrentAccount(accountId);
		const owner = this.requireHostRun(ownerRunId);
		if (
			owner.accountId !== accountId ||
			owner.snapshot.kind !== "conversation-turn" ||
			owner.snapshot.conversationId !== conversationId
		) {
			throw new Error(
				"Conversation memory does not belong to its owning Agent run.",
			);
		}
		const activeClientMessageIds = new Set(
			[...this.active.values()]
				.filter(
					(run) =>
						run.accountId === accountId &&
						run.snapshot.kind === "conversation-turn" &&
						run.snapshot.conversationId === conversationId,
				)
				.map((run) =>
					run.snapshot.kind === "conversation-turn"
						? run.snapshot.clientMessageId
						: "",
				),
		);
		const completed = (
			await this.inRunSession(owner, () =>
				this.repository.listMessages(accountId, conversationId, 1_000),
			)
		).filter(
			(message) =>
				(message.role === "user" || message.role === "assistant") &&
				message.status === "complete" &&
				!(
					message.clientMessageId &&
					activeClientMessageIds.has(message.clientMessageId)
				),
		);
		const recent = completed.slice(-24).map((message) => ({
			role: message.role as "user" | "assistant",
			content: message.content,
		}));
		return { messages: recent, version: completed.length };
	}

	async append(input: {
		accountId: string;
		ownerRunId: string;
		conversationId: string;
		expectedVersion: number;
		messages: readonly { role: "user" | "assistant"; content: string }[];
	}): Promise<{ version: number }> {
		this.assertCurrentAccount(input.accountId);
		const run = this.requireHostRun(input.ownerRunId);
		if (
			run.accountId !== input.accountId ||
			run.snapshot.kind !== "conversation-turn" ||
			run.snapshot.conversationId !== input.conversationId
		) {
			throw new Error(
				"Conversation memory does not belong to its owning Agent run.",
			);
		}
		const snapshot = run.snapshot;
		const before = await this.load(
			input.accountId,
			input.ownerRunId,
			input.conversationId,
		);
		if (before.version !== input.expectedVersion)
			throw new Error("Conversation memory version conflict.");
		const assistant = input.messages.findLast(
			(message) => message.role === "assistant",
		);
		if (!assistant || assistant.content !== run.assistantContent) {
			throw new Error(
				"Sidecar assistant memory does not match the streamed response.",
			);
		}
		await this.inRunSession(run, () =>
			this.repository.putMessage({
				accountId: input.accountId,
				id: snapshot.assistantMessageId!,
				conversationId: input.conversationId,
				clientMessageId: null,
				runId: run.snapshot.runId,
				role: "assistant",
				status: "complete",
				content: assistant.content,
				createdAtMs: run.snapshot.startedAtMs + 1,
			}),
		);
		const complete = (
			await this.inRunSession(run, () =>
				this.repository.listMessages(
					input.accountId,
					input.conversationId,
					1_000,
				),
			)
		).filter(
			(message) =>
				message.status === "complete" &&
				(message.role === "user" || message.role === "assistant"),
		);
		return { version: complete.length };
	}

	async propose(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		this.assertCurrentAccount(accountId);
		const run = this.requireActiveToolRun(params, accountId);
		const name = requiredToolName(params.name);
		if (!isWriteToolName(name))
			throw new Error("Only write tools require approval proposals.");
		run.snapshot.revision += 1;
		const argumentsValue = requiredRecord(params.arguments, "arguments");
		const approval = await this.toolPolicy.proposeWrite({
			accountId,
			runId: run.snapshot.runId,
			toolCallId: requiredId(params.toolCallId, "toolCallId"),
			toolName: name,
			arguments: argumentsValue,
			runRevision: run.snapshot.revision,
		});
		this.assertRunSession(run);
		const toolCall = toolSummary(
			name,
			approval.toolCallId,
			"awaiting-approval",
			this.now(),
		);
		run.snapshot.toolCalls = [...run.snapshot.toolCalls, toolCall];
		run.snapshot.pendingApproval = {
			approvalId: approval.approvalId,
			toolCallId: approval.toolCallId,
			title: approval.title,
			description: approval.description,
			risk: approval.risk,
			inputDigest: approval.inputDigest,
			requestedAtMs: approval.requestedAtMs,
		};
		await this.emit(run, { type: "tool.call.proposed", toolCall });
		await this.emit(run, {
			type: "tool.approval.requested",
			approval: run.snapshot.pendingApproval,
		});
		return { ...approval, runVersion: run.snapshot.revision };
	}

	async call(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		this.assertCurrentAccount(accountId);
		const run = this.requireActiveToolRun(params, accountId);
		const name = requiredToolName(params.name);
		const toolCallId = requiredId(params.toolCallId, "toolCallId");
		const argumentsValue = requiredRecord(params.arguments, "arguments");
		let approvalForExecution: PendingToolApproval | null = null;
		if (isReadToolName(name)) {
			await this.toolPolicy.assertReadAllowed(accountId, name);
		} else {
			const key = toolKey(run.snapshot.runId, toolCallId);
			const approved = this.approvedToolCalls.get(key);
			this.approvedToolCalls.delete(key);
			if (
				!approved ||
				approved.approvalId !== params.approvalId ||
				approved.toolName !== name ||
				approved.argumentsDigest !== params.inputDigest ||
				approved.argumentsDigest !== digestArguments(argumentsValue) ||
				params.runVersion !== approved.runRevision
			)
				throw new Error(
					"Tool execution does not match its one-time approval binding.",
				);
			approvalForExecution = approved;
		}
		const started = toolSummary(name, toolCallId, "running", this.now());
		this.replaceToolCall(run, started);
		await this.emit(run, { type: "tool.call.started", toolCall: started });
		const criticalOperation = this.beginCriticalOperation(
			run,
			"tool-execution",
		);
		try {
			if (approvalForExecution) {
				await this.toolPolicy.assertApprovedForExecution(approvalForExecution);
			}
			this.assertRunSession(run);
			const result = await this.toolExecutor.execute({
				accountId,
				runId: run.snapshot.runId,
				toolCallId,
				name,
				arguments: argumentsValue,
			});
			this.assertRunSession(run);
			const completed = {
				...started,
				status: "succeeded" as const,
				completedAtMs: this.now(),
				summary: "本地操作已完成。",
			};
			this.replaceToolCall(run, completed);
			await this.emit(run, {
				type: "tool.call.completed",
				toolCall: completed,
			});
			return result;
		} catch (error) {
			if (error instanceof AgentSessionChangedError) throw error;
			const failed = {
				...started,
				status: "failed" as const,
				completedAtMs: this.now(),
				summary: "本地操作未完成。",
			};
			this.replaceToolCall(run, failed);
			await this.emit(run, {
				type: "tool.call.failed",
				toolCall: failed,
				message:
					error instanceof Error ? error.message : "本地 Tool 执行失败。",
			});
			throw error;
		} finally {
			this.endCriticalOperation(run, criticalOperation);
		}
	}

	async cancel(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		this.assertCurrentAccount(accountId);
		const run = this.requireHostRun(requiredId(params.runId, "runId"));
		if (run.accountId !== accountId)
			throw new Error("Tool cancellation account mismatch.");
		const toolCallId = requiredId(params.toolCallId, "toolCallId");
		const cancelled =
			(await this.toolExecutor.cancel?.(accountId, toolCallId)) ?? false;
		this.assertRunSession(run);
		return { cancelled };
	}

	private async applySidecarEvent(
		run: ActiveRun,
		frame: SidecarRunEventFrame,
	): Promise<void> {
		if (terminal(run.snapshot.status)) return;
		const event = frame.event;
		switch (event.kind) {
			case "run.started":
			case "run.resumed":
				run.snapshot.status = "running";
				await this.emit(
					run,
					event.kind === "run.started"
						? { type: "run.started", startedAtMs: run.snapshot.startedAtMs }
						: {
								type: "run.progress",
								phase: "thinking",
								message: "本地 Agent 已继续运行。",
							},
				);
				return;
			case "conversation.text.delta":
				if (
					run.snapshot.kind !== "conversation-turn" ||
					run.snapshot.status === "cancelling"
				)
					return;
				run.assistantContent = event.text;
				run.pendingDelta += event.delta;
				this.scheduleDeltaFlush(run);
				await this.persistPartialIfDue(run);
				return;
			case "planning.object.delta":
				if (run.snapshot.kind === "task-planning") {
					run.snapshot.session = parsePlanningSession(
						event.object,
						run.snapshot.session?.id,
					);
				}
				return;
			case "run.suspended":
				await this.handleSuspended(run, event.suspendPayload);
				return;
			case "run.completed":
				await this.handleCompleted(run, event.result);
				return;
			case "run.cancelled":
				await this.finishCancelled(run, event.reason ?? "运行已取消。");
				return;
			case "run.failed":
				await this.failRun(run.snapshot.runId, {
					code:
						event.error.code === "MODEL_RELAY_UNAVAILABLE"
							? "unavailable"
							: event.error.code === "MODEL_RELAY_ERROR"
								? "model-failed"
								: "internal",
					message: event.error.message,
					retryable:
						event.error.code === "MODEL_RELAY_UNAVAILABLE"
							? false
							: event.error.retryable,
				});
		}
	}

	private async handleSuspended(
		run: ActiveRun,
		payload: unknown,
	): Promise<void> {
		if (run.snapshot.kind === "activity-analysis") {
			throw new Error(
				"Activity analysis Agent must not suspend for tools or input.",
			);
		}
		run.snapshot.status = "suspended";
		const reason: "approval-required" | "clarification-required" = run.snapshot
			.pendingApproval
			? "approval-required"
			: "clarification-required";
		if (run.snapshot.kind === "task-planning") {
			const session =
				parsePlanningSession(payload, run.snapshot.session?.id) ??
				run.snapshot.session;
			if (session) {
				run.snapshot.session = session;
				if (session.status === "clarifying") {
					run.snapshot.revision += 1;
					await this.emit(run, {
						type: "planning.clarification.requested",
						sessionId: session.id,
						questions: session.questions,
					});
				}
			}
		}
		await this.emit(run, { type: "run.suspended", reason });
	}

	private async handleCompleted(
		run: ActiveRun,
		result: unknown,
	): Promise<void> {
		if (run.snapshot.kind === "conversation-turn") {
			const snapshot = run.snapshot;
			await this.flushDelta(run);
			const content = conversationResultText(result) ?? run.assistantContent;
			run.assistantContent = content;
			if (snapshot.assistantMessageId) {
				await this.inRunSession(run, () =>
					this.repository.putMessage({
						accountId: run.accountId,
						id: snapshot.assistantMessageId!,
						conversationId: snapshot.conversationId,
						clientMessageId: null,
						runId: snapshot.runId,
						role: "assistant",
						status: "complete",
						content,
						createdAtMs: snapshot.startedAtMs + 1,
					}),
				);
			}
			const conversation = await this.inRunSession(run, () =>
				this.repository.getConversation(run.accountId, snapshot.conversationId),
			);
			if (!conversation)
				throw new Error("Conversation disappeared during Agent completion.");
			snapshot.conversation = await this.inRunSession(run, () =>
				this.buildConversation(run.accountId, conversation),
			);
			await this.emit(run, {
				type: "conversation.message.completed",
				conversationId: snapshot.conversationId,
				messageId: snapshot.assistantMessageId!,
				content,
				createdAtMs: snapshot.startedAtMs + 1,
			});
		} else if (run.snapshot.kind === "task-planning") {
			const session = parsePlanningSession(result, run.snapshot.session?.id);
			if (!session)
				throw new Error("Planning sidecar completed without a valid session.");
			run.snapshot.session = session;
			if (isRecord(result) && Number.isSafeInteger(result.version)) {
				run.sidecarPlanningVersion = result.version as number;
			}
			if (session.status === "clarifying") {
				await this.handleSuspended(run, session);
				return;
			}
			await this.emit(run, { type: "planning.draft.ready", session });
			await this.emit(run, { type: "planning.completed", session });
		} else {
			const summary = activityResultText(result);
			if (summary === null) {
				throw new Error(
					"Activity analysis sidecar completed without a valid summary.",
				);
			}
			run.snapshot.result = summary;
		}
		run.snapshot.status = "completed";
		await this.emit(run, { type: "run.completed", completedAtMs: this.now() });
		await this.finishRun(run, null);
	}

	private scheduleDeltaFlush(run: ActiveRun): void {
		if (run.deltaTimer) return;
		run.deltaTimer = setTimeout(() => {
			run.deltaTimer = null;
			void this.flushDelta(run);
		}, DELTA_FLUSH_MS);
	}

	private async flushDelta(run: ActiveRun): Promise<void> {
		if (!run.pendingDelta || run.snapshot.kind !== "conversation-turn") return;
		const delta = run.pendingDelta;
		run.pendingDelta = "";
		await this.emit(
			run,
			{
				type: "conversation.message.delta",
				conversationId: run.snapshot.conversationId,
				messageId: run.snapshot.assistantMessageId!,
				delta,
			},
			false,
		);
	}

	private async persistPartialIfDue(run: ActiveRun): Promise<void> {
		if (
			run.snapshot.kind !== "conversation-turn" ||
			!run.snapshot.assistantMessageId
		)
			return;
		const snapshot = run.snapshot;
		const now = this.now();
		if (
			now - run.lastPartialPersistAtMs < PARTIAL_PERSIST_MS &&
			run.assistantContent.length - run.lastPartialPersistLength <
				PARTIAL_PERSIST_CHARACTERS
		)
			return;
		await this.inRunSession(run, () =>
			this.repository.putMessage({
				accountId: run.accountId,
				id: snapshot.assistantMessageId!,
				conversationId: snapshot.conversationId,
				clientMessageId: null,
				runId: snapshot.runId,
				role: "assistant",
				status: "partial",
				content: run.assistantContent,
				createdAtMs: snapshot.startedAtMs + 1,
			}),
		);
		run.lastPartialPersistAtMs = now;
		run.lastPartialPersistLength = run.assistantContent.length;
		await this.persistRun(run);
	}

	private async failRun(
		runId: string,
		failure: AgentRunFailure,
	): Promise<void> {
		const run = this.active.get(runId);
		if (!run || terminal(run.snapshot.status) || !this.isRunSessionCurrent(run))
			return;
		await this.flushDelta(run);
		run.snapshot.status = "failed";
		run.snapshot.failure = failure;
		if (
			run.snapshot.kind === "conversation-turn" &&
			run.snapshot.assistantMessageId
		) {
			const snapshot = run.snapshot;
			await this.inRunSession(run, () =>
				this.repository.putMessage({
					accountId: run.accountId,
					id: snapshot.assistantMessageId!,
					conversationId: snapshot.conversationId,
					clientMessageId: null,
					runId,
					role: "assistant",
					status: "failed",
					content: run.assistantContent,
					createdAtMs: snapshot.startedAtMs + 1,
				}),
			);
		}
		await this.emit(run, {
			type: "run.failed",
			failedAtMs: this.now(),
			failure,
		});
		await this.finishRun(run, failure);
	}

	private async finishCancelled(
		run: ActiveRun,
		message: string,
	): Promise<void> {
		if (terminal(run.snapshot.status)) return;
		await this.flushDelta(run);
		run.snapshot.status = "cancelled";
		if (
			run.snapshot.kind === "conversation-turn" &&
			run.snapshot.assistantMessageId
		) {
			const snapshot = run.snapshot;
			await this.inRunSession(run, () =>
				this.repository.putMessage({
					accountId: run.accountId,
					id: snapshot.assistantMessageId!,
					conversationId: snapshot.conversationId,
					clientMessageId: null,
					runId: snapshot.runId,
					role: "assistant",
					status: "cancelled",
					content: run.assistantContent,
					createdAtMs: snapshot.startedAtMs + 1,
				}),
			);
		}
		await this.emit(run, {
			type: "run.cancelled",
			cancelledAtMs: this.now(),
			message,
		});
		await this.finishRun(run, null);
	}

	private async finishCancelledForLogout(run: ActiveRun): Promise<void> {
		if (terminal(run.snapshot.status)) return;
		if (run.deltaTimer) clearTimeout(run.deltaTimer);
		run.deltaTimer = null;
		run.pendingDelta = "";
		run.snapshot.status = "cancelled";
		run.snapshot.updatedAtMs = this.now();
		let failure: unknown = null;
		try {
			if (
				run.snapshot.kind === "conversation-turn" &&
				run.snapshot.assistantMessageId
			) {
				await this.repository.putMessage({
					accountId: run.accountId,
					id: run.snapshot.assistantMessageId,
					conversationId: run.snapshot.conversationId,
					clientMessageId: null,
					runId: run.snapshot.runId,
					role: "assistant",
					status: "cancelled",
					content: run.assistantContent,
					createdAtMs: run.snapshot.startedAtMs + 1,
				});
			}
		} catch (error) {
			failure = error;
		}
		try {
			await this.finishRun(run, null, true);
		} catch (error) {
			failure ??= error;
		}
		if (failure) throw failure;
	}

	private async interruptRun(
		run: ActiveRun,
		message: string,
		restorable: boolean,
	): Promise<void> {
		if (terminal(run.snapshot.status)) return;
		this.abortRelayForRun(run.snapshot.runId);
		await this.flushDelta(run);
		run.snapshot.status = "interrupted";
		run.snapshot.revision += 1;
		if (
			run.snapshot.kind === "conversation-turn" &&
			run.snapshot.assistantMessageId
		) {
			const snapshot = run.snapshot;
			await this.inRunSession(run, () =>
				this.repository.putMessage({
					accountId: run.accountId,
					id: snapshot.assistantMessageId!,
					conversationId: snapshot.conversationId,
					clientMessageId: null,
					runId: snapshot.runId,
					role: "assistant",
					status: "interrupted",
					content: run.assistantContent,
					createdAtMs: snapshot.startedAtMs + 1,
				}),
			);
		}
		await this.emit(run, {
			type: "run.interrupted",
			interruptedAtMs: this.now(),
			message,
			restorable,
		});
		await this.finishRun(run, null);
	}

	private async finishRun(
		run: ActiveRun,
		failure: AgentRunFailure | null,
		allowInvalidatedSession = false,
	): Promise<void> {
		if (run.deltaTimer) clearTimeout(run.deltaTimer);
		run.deltaTimer = null;
		let persisted = false;
		try {
			await this.persistRun(run, failure, allowInvalidatedSession);
			persisted = true;
		} finally {
			this.sidecar.untrackRun(run.snapshot.runId);
			this.active.delete(run.snapshot.runId);
			for (const key of [...this.approvedToolCalls.keys()]) {
				if (key.startsWith(`${run.snapshot.runId}:`))
					this.approvedToolCalls.delete(key);
			}
		}
		if (persisted && run.snapshot.kind === "activity-analysis") {
			try {
				await this.onActivityRunTerminal({
					jobId: run.snapshot.activityJobId,
					runId: run.snapshot.runId,
					accountId: run.accountId,
					status: run.snapshot.status as
						| "completed"
						| "failed"
						| "cancelled"
						| "interrupted",
					failure: failure ?? run.snapshot.failure ?? null,
				});
			} catch {
				// The durable activity ledger will recover a running job next launch.
			}
		}
	}

	private async resolveRecoveredApproval(
		run: ActiveRun,
		approval: PendingToolApproval,
		decision: "approve-once" | "deny",
	): Promise<void> {
		if (decision === "deny") {
			run.assistantContent = appendRecoveryNotice(
				run.assistantContent,
				"你已拒绝这项本地操作。本轮 Agent 进程曾中断，因此不会继续执行该 Tool。",
			);
			await this.handleCompleted(run, { text: run.assistantContent });
			return;
		}
		const started = toolSummary(
			approval.toolName,
			approval.toolCallId,
			"running",
			this.now(),
		);
		this.replaceToolCall(run, started);
		await this.emit(run, { type: "tool.call.started", toolCall: started });
		try {
			await this.toolPolicy.assertApprovedForExecution(approval);
			this.assertRunSession(run);
			await this.toolExecutor.execute({
				accountId: run.accountId,
				runId: run.snapshot.runId,
				toolCallId: approval.toolCallId,
				name: approval.toolName,
				arguments: structuredClone(approval.arguments),
			});
			this.assertRunSession(run);
			const completed = {
				...started,
				status: "succeeded" as const,
				completedAtMs: this.now(),
				summary: "本地操作已完成。",
			};
			this.replaceToolCall(run, completed);
			await this.emit(run, {
				type: "tool.call.completed",
				toolCall: completed,
			});
			run.assistantContent = appendRecoveryNotice(
				run.assistantContent,
				"已按你的本次确认完成本地操作。Agent 进程曾中断，本轮不再自动继续生成，以免重复执行。",
			);
			await this.handleCompleted(run, { text: run.assistantContent });
		} catch (error) {
			if (error instanceof AgentSessionChangedError) throw error;
			const failed = {
				...started,
				status: "failed" as const,
				completedAtMs: this.now(),
				summary: "本地操作未完成。",
			};
			this.replaceToolCall(run, failed);
			await this.emit(run, {
				type: "tool.call.failed",
				toolCall: failed,
				message:
					error instanceof Error ? error.message : "本地 Tool 执行失败。",
			});
			throw error;
		}
	}

	private activate(
		sessionIdentity: AuthSessionIdentity,
		snapshot: AgentRunSnapshot,
		recordInput: Record<string, unknown>,
	): ActiveRun {
		const run: ActiveRun = {
			accountId: sessionIdentity.accountId,
			sessionIdentity: { ...sessionIdentity },
			recordInput,
			snapshot,
			assistantContent: "",
			pendingDelta: "",
			deltaTimer: null,
			lastPartialPersistAtMs: this.now(),
			lastPartialPersistLength: 0,
			lastSidecarSequence: 0,
			chain: Promise.resolve(),
			recoveredFromPersistence: false,
			criticalOperation: null,
			hostCalls: new Set(),
		};
		this.active.set(snapshot.runId, run);
		return run;
	}

	private beginCriticalOperation(
		run: ActiveRun,
		kind: ActiveRunCriticalOperation["kind"],
	): ActiveRunCriticalOperation {
		if (run.criticalOperation)
			throw new Error("Agent run already has a critical operation.");
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const operation: ActiveRunCriticalOperation = { kind, settled, settle };
		run.criticalOperation = operation;
		return operation;
	}

	private abortRelayForRun(runId: string): void {
		try {
			this.abortModelRelay(runId);
		} catch {
			// Sidecar cancellation still proceeds; relay cancellation is synchronous
			// and best-effort only when a malformed injected implementation throws.
		}
	}

	private endCriticalOperation(
		run: ActiveRun,
		operation: ActiveRunCriticalOperation,
	): void {
		if (run.criticalOperation !== operation) return;
		run.criticalOperation = null;
		operation.settle();
	}

	private async emit(
		run: ActiveRun,
		event: AgentRunEvent,
		persist = true,
	): Promise<void> {
		this.assertRunSession(run);
		run.snapshot.lastSequence += 1;
		run.snapshot.updatedAtMs = this.now();
		const envelope: InternalAgentRunEventEnvelope = {
			schemaVersion: AGENT_RUN_EVENT_SCHEMA_VERSION,
			runId: run.snapshot.runId,
			requestId: run.snapshot.requestId,
			kind: run.snapshot.kind,
			sequence: run.snapshot.lastSequence,
			revision: run.snapshot.revision,
			emittedAtMs: run.snapshot.updatedAtMs,
			event,
		};
		this.onEvent(envelope);
		if (persist) await this.persistRun(run);
	}

	private async persistRun(
		run: ActiveRun,
		failure: AgentRunFailure | null = null,
		allowInvalidatedSession = false,
	): Promise<void> {
		if (!allowInvalidatedSession) this.assertRunSession(run);
		await this.repository.putRun({
			accountId: run.accountId,
			id: run.snapshot.runId,
			conversationId:
				run.snapshot.kind === "conversation-turn"
					? run.snapshot.conversationId
					: null,
			workflowId:
				run.snapshot.kind === "task-planning"
					? (run.snapshot.session?.id ?? null)
					: run.snapshot.kind === "activity-analysis"
						? run.snapshot.activityJobId
						: null,
			status: run.snapshot.status,
			input: run.recordInput,
			output: structuredClone(run.snapshot),
			error: failure,
			createdAtMs: run.snapshot.startedAtMs,
			updatedAtMs: run.snapshot.updatedAtMs,
			completedAtMs: terminal(run.snapshot.status)
				? run.snapshot.updatedAtMs
				: null,
		});
		if (!allowInvalidatedSession) this.assertRunSession(run);
	}

	private async resolveConversation(
		accountId: string,
		input: StartConversationTurnRequest,
		now: number,
		existingMessage: AgentMessageRecord | null,
	): Promise<AgentConversationRecord> {
		const requestedId = input.conversationId ?? existingMessage?.conversationId;
		if (requestedId) {
			const existing = await this.repository.getConversation(
				accountId,
				requestedId,
			);
			if (!existing) throw new Error("找不到当前账号的本地对话。");
			return existing;
		}
		const conversation: AgentConversationRecord = {
			accountId,
			id: `conversation-${randomUUID()}`,
			title: input.text.trim().slice(0, 36) || "新对话",
			createdAtMs: now,
			updatedAtMs: now,
		};
		await this.repository.putConversation(conversation);
		return conversation;
	}

	private async buildConversation(
		accountId: string,
		conversation: AgentConversationRecord,
	): Promise<ConversationRpcThread> {
		const messages = await this.repository.listMessages(
			accountId,
			conversation.id,
			1_000,
		);
		return {
			id: conversation.id,
			title: conversation.title,
			updatedAtMs: conversation.updatedAtMs,
			messages: messages
				.filter(
					(message) => message.role === "user" || message.role === "assistant",
				)
				.map(messageProjection),
		};
	}

	private async hydrateSnapshot(
		identity: AuthSessionIdentity,
		snapshot: AgentRunSnapshot,
	): Promise<AgentRunSnapshot> {
		if (snapshot.kind !== "conversation-turn") return structuredClone(snapshot);
		const conversation = await this.inSession(identity, () =>
			this.repository.getConversation(
				identity.accountId,
				snapshot.conversationId,
			),
		);
		return {
			...structuredClone(snapshot),
			conversation: conversation
				? await this.inSession(identity, () =>
						this.buildConversation(conversation.accountId, conversation),
					)
				: snapshot.conversation,
		};
	}

	private async requireMutableRun(
		runId: string,
		expectedRevision: number,
		kind?: AgentRunSnapshot["kind"],
	): Promise<ActiveRun | AgentRunRpcResult<never>> {
		try {
			const identity = this.requireSession();
			const accountId = identity.accountId;
			let run = this.active.get(runId);
			if (run && !sameSessionIdentity(run.sessionIdentity, identity)) {
				run = undefined;
			}
			if (!run || run.accountId !== accountId) {
				const record = await this.inSession(identity, () =>
					this.repository.getRun(accountId, runId),
				);
				const snapshot = record ? parsePersistedSnapshot(record.output) : null;
				if (!record || !snapshot || snapshot.status !== "suspended") {
					return {
						kind: "not-found",
						message: "找不到当前账号可恢复的 Agent 运行。",
					};
				}
				run = await this.reactivateSuspendedRun(identity, record, snapshot);
			}
			if (kind && run.snapshot.kind !== kind) {
				return {
					kind: "error",
					message: "Agent 运行类型不匹配。",
					retryable: false,
				};
			}
			if (run.snapshot.revision !== expectedRevision) {
				return conflict(
					"Agent 运行版本已变化，请先恢复最新快照。",
					run.snapshot.revision,
				);
			}
			return run;
		} catch (error) {
			return agentError(error);
		}
	}

	private async reactivateSuspendedRun(
		identity: AuthSessionIdentity,
		record: AgentRunRecord,
		snapshot: AgentRunSnapshot,
	): Promise<ActiveRun> {
		const accountId = identity.accountId;
		const recordInput = isRecord(record.input)
			? structuredClone(record.input)
			: {};
		const run = this.activate(identity, snapshot, recordInput);
		run.recoveredFromPersistence = true;
		if (snapshot.kind === "conversation-turn" && snapshot.assistantMessageId) {
			const message = await this.inSession(identity, () =>
				this.repository.getMessage(accountId, snapshot.assistantMessageId!),
			);
			run.assistantContent = message?.content ?? "";
			run.lastPartialPersistLength = run.assistantContent.length;
		}
		if (snapshot.kind === "task-planning" && snapshot.session) {
			const workflow = await this.inSession(identity, () =>
				this.repository.getWorkflow(accountId, snapshot.session!.id),
			);
			if (
				workflow &&
				isRecord(workflow.definition) &&
				Number.isSafeInteger(workflow.definition.version)
			) {
				run.sidecarPlanningVersion = workflow.definition.version as number;
			}
		}
		this.assertRunSession(run);
		this.sidecar.trackRun(snapshot.runId);
		return run;
	}

	private requireActiveToolRun(
		params: Record<string, unknown>,
		accountId: string,
	): ActiveRun {
		const runId = requiredId(params.runId, "runId");
		const run = this.active.get(runId);
		if (
			!run ||
			run.accountId !== accountId ||
			run.snapshot.kind !== "conversation-turn" ||
			terminal(run.snapshot.status)
		) {
			throw new Error(
				"Tool call does not belong to an active conversation run.",
			);
		}
		this.assertRunSession(run);
		return run;
	}

	private replaceToolCall(
		run: ActiveRun,
		toolCall: AgentToolCallSummary,
	): void {
		const existing = run.snapshot.toolCalls.some(
			(item) => item.id === toolCall.id,
		);
		run.snapshot.toolCalls = existing
			? run.snapshot.toolCalls.map((item) =>
					item.id === toolCall.id ? toolCall : item,
				)
			: [...run.snapshot.toolCalls, toolCall];
	}

	private async markOrphanedRunsInterrupted(
		identity: AuthSessionIdentity,
	): Promise<void> {
		const accountId = identity.accountId;
		const records = await this.inSession(identity, () =>
			this.repository.listRuns(accountId, 1_000),
		);
		for (const record of records) {
			const active = this.active.get(record.id);
			if (
				(active && sameSessionIdentity(active.sessionIdentity, identity)) ||
				!["starting", "running", "cancelling"].includes(record.status)
			)
				continue;
			const snapshot = parsePersistedSnapshot(record.output);
			if (!snapshot) continue;
			snapshot.status = "interrupted";
			snapshot.revision += 1;
			snapshot.updatedAtMs = this.now();
			if (
				snapshot.kind === "conversation-turn" &&
				snapshot.assistantMessageId
			) {
				const message = await this.inSession(identity, () =>
					this.repository.getMessage(accountId, snapshot.assistantMessageId!),
				);
				if (message && message.status === "partial") {
					await this.inSession(identity, () =>
						this.repository.putMessage({ ...message, status: "interrupted" }),
					);
				}
			}
			await this.inSession(identity, () =>
				this.repository.putRun({
					...record,
					status: "interrupted",
					output: snapshot,
					updatedAtMs: snapshot.updatedAtMs,
					completedAtMs: snapshot.updatedAtMs,
				}),
			);
		}
	}

	private assertCurrentAccount(accountId: string): void {
		if (this.requireSession().accountId !== accountId) {
			throw new Error("Agent host account changed during the run.");
		}
	}

	private requireSession(): AuthSessionIdentity {
		const identity = this.sessionIdentityProvider();
		if (!identity) throw new Error("请先登录后再使用本地 Agent。");
		return { ...identity };
	}

	private assertSession(identity: AuthSessionIdentity): void {
		const current = this.sessionIdentityProvider();
		if (!current || !sameSessionIdentity(current, identity)) {
			throw new AgentSessionChangedError();
		}
	}

	private assertRunSession(run: ActiveRun): void {
		if (this.active.get(run.snapshot.runId) !== run) {
			throw new AgentSessionChangedError(
				"登录会话对应的本地 Agent 运行已结束。",
			);
		}
		this.assertSession(run.sessionIdentity);
	}

	private isRunSessionCurrent(run: ActiveRun): boolean {
		const current = this.sessionIdentityProvider();
		return (
			this.active.get(run.snapshot.runId) === run &&
			current !== null &&
			sameSessionIdentity(current, run.sessionIdentity)
		);
	}

	private requireHostRun(runId: string): ActiveRun {
		const run = this.active.get(requiredId(runId, "ownerRunId"));
		if (!run || terminal(run.snapshot.status)) {
			throw new AgentSessionChangedError(
				"登录会话对应的本地 Agent 运行不存在。",
			);
		}
		this.assertRunSession(run);
		return run;
	}

	private async inSession<TResult>(
		identity: AuthSessionIdentity,
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		this.assertSession(identity);
		const result = await operation();
		this.assertSession(identity);
		return result;
	}

	private async inRunSession<TResult>(
		run: ActiveRun,
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		this.assertRunSession(run);
		const result = await operation();
		this.assertRunSession(run);
		return result;
	}

	private beginPendingStart(identity: AuthSessionIdentity): PendingStart {
		let settlePromise!: () => void;
		const settled = new Promise<void>((resolve) => {
			settlePromise = resolve;
		});
		const pending: PendingStart = {
			identity: { ...identity },
			settled,
			settle: () => {
				if (!this.pendingStarts.delete(pending)) return;
				settlePromise();
			},
		};
		this.pendingStarts.add(pending);
		return pending;
	}
}

function sameSessionIdentity(
	left: AuthSessionIdentity,
	right: AuthSessionIdentity,
): boolean {
	return (
		left.accountId === right.accountId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation
	);
}
