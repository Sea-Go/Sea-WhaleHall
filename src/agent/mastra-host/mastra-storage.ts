import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { StorageThreadType } from "@mastra/core/memory";
import {
	MastraCompositeStore,
	MemoryStorage,
	WorkflowsStorage,
} from "@mastra/core/storage";
import type {
	StorageListMessagesInput,
	StorageListMessagesOutput,
	StorageListThreadsInput,
	StorageListThreadsOutput,
	WorkflowRun,
	WorkflowRuns,
} from "@mastra/core/storage";
import type { WorkflowRunState } from "@mastra/core/workflows";
import {
	isRecord,
	type ConversationInputMessage,
} from "./protocol";
import {
	AgentHostRuntimeError,
	type HostRequestPeer,
} from "./transport";

export interface ConversationMemoryExecutionContext {
	runId: string;
	requestId: string;
	threadId: string;
	resourceId: string;
	expectedVersion?: number;
	persistedVersion?: number;
	versionChecked: boolean;
	suspendedForApproval?: boolean;
}

/**
 * Mastra storage domains backed by authenticated reverse calls to Bun.
 *
 * This object never persists Agent state in the Sidecar. Bun derives the account
 * from its current session and encrypts every stored record. The async context is
 * used only to bind MemoryStorage methods (whose interface does not carry a
 * RequestContext) to the conversation turn currently executing them.
 */
export class HostMastraStorage {
	readonly composite: MastraCompositeStore;
	readonly memory: RemoteMemoryStorage;
	readonly workflows: RemoteWorkflowsStorage;
	private readonly conversationContext =
		new AsyncLocalStorage<ConversationMemoryExecutionContext>();

	constructor(peer: HostRequestPeer) {
		this.memory = new RemoteMemoryStorage(peer, () =>
			this.conversationContext.getStore(),
		);
		this.workflows = new RemoteWorkflowsStorage(peer);
		this.composite = new MastraCompositeStore({
			id: "whalehall-host-storage",
			domains: {
				memory: this.memory,
				workflows: this.workflows,
			},
		});
	}

	runConversation<T>(
		context: ConversationMemoryExecutionContext,
		operation: () => T,
	): T {
		return this.conversationContext.run(context, operation);
	}
}

class RemoteMemoryStorage extends MemoryStorage {
	constructor(
		private readonly peer: HostRequestPeer,
		private readonly getContext: () =>
			| ConversationMemoryExecutionContext
			| undefined,
	) {
		super();
	}

	async dangerouslyClearAll(): Promise<void> {
		throw storageError("Mastra Memory clearing is not available in the Sidecar.");
	}

	async getThreadById({
		threadId,
		resourceId,
	}: {
		threadId: string;
		resourceId?: string;
	}): Promise<StorageThreadType | null> {
		const context = this.requireContext(threadId, resourceId);
		await this.load(context);
		return threadRecord(context);
	}

	async saveThread({
		thread,
	}: {
		thread: StorageThreadType;
	}): Promise<StorageThreadType> {
		const context = this.requireContext(thread.id, thread.resourceId);
		await this.load(context);
		return { ...thread, resourceId: context.resourceId };
	}

	async updateThread({
		id,
		title,
		metadata,
	}: {
		id: string;
		title: string;
		metadata: Record<string, unknown>;
	}): Promise<StorageThreadType> {
		const context = this.requireContext(id);
		await this.load(context);
		return { ...threadRecord(context), title, metadata, updatedAt: new Date() };
	}

	async deleteThread({ threadId }: { threadId: string }): Promise<void> {
		this.requireContext(threadId);
		throw storageError("Conversation deletion must be initiated by Bun.");
	}

	async listMessages(
		args: StorageListMessagesInput,
	): Promise<StorageListMessagesOutput> {
		const threadId = singleThreadId(args.threadId);
		const context = this.requireContext(threadId, args.resourceId);
		const memory = await this.load(context);
		let messages = memory.messages.map((message, index) =>
			toMastraMessage(message, context, index, memory.version),
		);
		const direction = args.orderBy?.direction ?? "ASC";
		if (direction === "DESC") messages = messages.reverse();
		const page = args.page ?? 0;
		const perPage = args.perPage ?? 40;
		const start = perPage === false ? 0 : page * perPage;
		const selected =
			perPage === false ? messages : messages.slice(start, start + perPage);
		return {
			messages: selected,
			total: messages.length,
			page,
			perPage,
			hasMore: perPage === false ? false : start + selected.length < messages.length,
		};
	}

	async listMessagesById({
		messageIds,
	}: {
		messageIds: string[];
	}): Promise<{ messages: MastraDBMessage[] }> {
		const context = this.requireContext();
		const all = await this.listMessages({
			threadId: context.threadId,
			resourceId: context.resourceId,
			perPage: false,
		});
		const ids = new Set(messageIds);
		return { messages: all.messages.filter((message) => ids.has(message.id)) };
	}

	async saveMessages({
		messages,
	}: {
		messages: MastraDBMessage[];
	}): Promise<{ messages: MastraDBMessage[] }> {
		const context = this.requireContext();
		for (const message of messages) {
			if (message.threadId && message.threadId !== context.threadId) {
				throw storageError("Mastra Memory attempted to cross conversation boundaries.");
			}
			if (message.resourceId && message.resourceId !== context.resourceId) {
				throw storageError("Mastra Memory attempted to cross resource boundaries.");
			}
		}

		// A requireApproval turn is not complete. Bun already owns its partial
		// assistant record, so committing it as complete here would poison the next
		// turn. The resumed Agent invocation will save the resolved transcript.
		if (context.suspendedForApproval || messages.some(hasPendingToolApproval)) {
			return { messages };
		}

		const projected = projectConversationMessages(messages);
		if (!projected.some((message) => message.role === "assistant")) {
			// User input is written idempotently by Bun before the Sidecar starts.
			// A user-only Memory save is therefore already durable and must not be
			// inserted a second time under Mastra's generated message ID.
			return { messages };
		}
		const current = await this.load(context, true);
		const result = await this.peer.requestHost("memory/append", {
			namespace: "conversation",
			threadId: context.threadId,
			resourceId: context.resourceId,
			expectedVersion: current.version,
			messages: projected,
		});
		if (!isRecord(result) || !isVersion(result.version)) {
			throw storageError("memory/append returned an invalid version.");
		}
		context.persistedVersion = result.version;
		return { messages };
	}

	async updateMessages({
		messages,
	}: Parameters<MemoryStorage["updateMessages"]>[0]): Promise<MastraDBMessage[]> {
		this.requireContext();
		if (messages.length === 0) return [];
		throw storageError("Mastra Memory message mutation is not available in the Sidecar.");
	}

	async deleteMessages(messageIds: string[]): Promise<void> {
		this.requireContext();
		if (messageIds.length === 0) return;
		throw storageError("Mastra Memory message deletion must be initiated by Bun.");
	}

	async listThreads(
		args: StorageListThreadsInput,
	): Promise<StorageListThreadsOutput> {
		const context = this.requireContext();
		if (
			args.filter?.resourceId &&
			args.filter.resourceId !== context.resourceId
		) {
			return emptyThreadPage(args);
		}
		await this.load(context);
		const page = args.page ?? 0;
		const perPage = args.perPage ?? 100;
		const include = page === 0 && (perPage === false || perPage > 0);
		return {
			threads: include ? [threadRecord(context)] : [],
			total: 1,
			page,
			perPage,
			hasMore: false,
		};
	}

	private requireContext(
		threadId?: string,
		resourceId?: string,
	): ConversationMemoryExecutionContext {
		const context = this.getContext();
		if (!context) {
			throw storageError("Mastra Memory was called outside an Agent turn.");
		}
		if (threadId && threadId !== context.threadId) {
			throw storageError("Mastra Memory thread does not match the active turn.");
		}
		if (resourceId && resourceId !== context.resourceId) {
			throw storageError("Mastra Memory resource does not match the active turn.");
		}
		return context;
	}

	private async load(
		context: ConversationMemoryExecutionContext,
		ignoreExpectedVersion = false,
	): Promise<{ messages: readonly ConversationInputMessage[]; version: number }> {
		const value = await this.peer.requestHost("memory/load", {
			namespace: "conversation",
			threadId: context.threadId,
			resourceId: context.resourceId,
		});
		if (!isRecord(value) || !Array.isArray(value.messages) || !isVersion(value.version)) {
			throw storageError("memory/load returned an invalid conversation record.");
		}
		const messages = value.messages.map(parseConversationMessage);
		if (
			!ignoreExpectedVersion &&
			!context.versionChecked &&
			context.expectedVersion !== undefined &&
			context.expectedVersion !== value.version
		) {
			throw new AgentHostRuntimeError({
				code: "RUN_CONFLICT",
				message: "Conversation memory version changed before the run started.",
				retryable: true,
				details: {
					expectedVersion: context.expectedVersion,
					actualVersion: value.version,
				},
			});
		}
		context.versionChecked = true;
		return { messages, version: value.version };
	}
}

class RemoteWorkflowsStorage extends WorkflowsStorage {
	constructor(private readonly peer: HostRequestPeer) {
		super();
	}

	supportsConcurrentUpdates(): boolean {
		return true;
	}

	async dangerouslyClearAll(): Promise<void> {
		throw storageError("Mastra Workflow clearing is not available in the Sidecar.");
	}

	async updateWorkflowResults(
		args: Parameters<WorkflowsStorage["updateWorkflowResults"]>[0],
	): ReturnType<WorkflowsStorage["updateWorkflowResults"]> {
		const value = await this.peer.requestHost(
			"workflow/snapshot.update-results",
			args,
		);
		if (!isRecord(value)) {
			throw storageError("Workflow result update returned invalid context.");
		}
		return value as Awaited<ReturnType<WorkflowsStorage["updateWorkflowResults"]>>;
	}

	async updateWorkflowState(
		args: Parameters<WorkflowsStorage["updateWorkflowState"]>[0],
	): ReturnType<WorkflowsStorage["updateWorkflowState"]> {
		const value = await this.peer.requestHost(
			"workflow/snapshot.update-state",
			args,
		);
		if (value === undefined || value === null) return undefined;
		if (!isRecord(value)) {
			throw storageError("Workflow state update returned an invalid snapshot.");
		}
		return value as unknown as Awaited<
			ReturnType<WorkflowsStorage["updateWorkflowState"]>
		>;
	}

	async persistWorkflowSnapshot({
		createdAt,
		updatedAt,
		...args
	}: Parameters<WorkflowsStorage["persistWorkflowSnapshot"]>[0]): Promise<void> {
		await this.peer.requestHost("workflow/snapshot.persist", {
			...args,
			...(createdAt ? { createdAtMs: createdAt.getTime() } : {}),
			...(updatedAt ? { updatedAtMs: updatedAt.getTime() } : {}),
		});
	}

	async loadWorkflowSnapshot({
		workflowName,
		runId,
	}: Parameters<WorkflowsStorage["loadWorkflowSnapshot"]>[0]): Promise<WorkflowRunState | null> {
		const value = await this.peer.requestHost("workflow/snapshot.load", {
			workflowName,
			runId,
		});
		if (value === null) return null;
		const snapshot = isRecord(value) && "snapshot" in value ? value.snapshot : value;
		if (!isRecord(snapshot)) {
			throw storageError("Workflow snapshot load returned invalid state.");
		}
		return snapshot as unknown as WorkflowRunState;
	}

	async listWorkflowRuns(
		args: Parameters<WorkflowsStorage["listWorkflowRuns"]>[0] = {},
	): Promise<WorkflowRuns> {
		const value = await this.peer.requestHost("workflow/snapshot.list", {
			...args,
			...(args.fromDate ? { fromDateMs: args.fromDate.getTime() } : {}),
			...(args.toDate ? { toDateMs: args.toDate.getTime() } : {}),
			fromDate: undefined,
			toDate: undefined,
		});
		if (!isRecord(value) || !Array.isArray(value.runs) || !isVersion(value.total)) {
			throw storageError("Workflow snapshot list returned invalid records.");
		}
		return {
			runs: value.runs.map(parseWorkflowRun),
			total: value.total,
		};
	}

	async getWorkflowRunById(
		args: Parameters<WorkflowsStorage["getWorkflowRunById"]>[0],
	): Promise<WorkflowRun | null> {
		const value = await this.peer.requestHost("workflow/snapshot.get", args);
		return value === null ? null : parseWorkflowRun(value);
	}

	async deleteWorkflowRunById(
		args: Parameters<WorkflowsStorage["deleteWorkflowRunById"]>[0],
	): Promise<void> {
		await this.peer.requestHost("workflow/snapshot.delete", args);
	}
}

function parseConversationMessage(value: unknown): ConversationInputMessage {
	if (
		!isRecord(value) ||
		(value.role !== "user" && value.role !== "assistant") ||
		typeof value.content !== "string"
	) {
		throw storageError("Host memory contains an invalid conversation message.");
	}
	return { role: value.role, content: value.content };
}

function toMastraMessage(
	message: ConversationInputMessage,
	context: ConversationMemoryExecutionContext,
	index: number,
	version: number,
): MastraDBMessage {
	const digest = createHash("sha256")
		.update(`${message.role}\0${message.content}\0${index}\0${version}`)
		.digest("hex")
		.slice(0, 24);
	return {
		id: `host-message-${digest}`,
		role: message.role,
		type: "text",
		content: {
			format: 2,
			parts: [{ type: "text", text: message.content }],
		},
		createdAt: new Date(index + 1),
		threadId: context.threadId,
		resourceId: context.resourceId,
	};
}

function projectConversationMessages(
	messages: readonly MastraDBMessage[],
): ConversationInputMessage[] {
	const projected: ConversationInputMessage[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = message.content.parts
			.filter(
				(part): part is Extract<typeof part, { type: "text" }> =>
					part.type === "text",
			)
			.map((part) => part.text)
			.join("");
		if (!text && message.role === "user") continue;
		projected.push({ role: message.role, content: text });
	}
	return projected;
}

function hasPendingToolApproval(message: MastraDBMessage): boolean {
	return message.content.parts.some(
		(part) =>
			part.type === "tool-invocation" &&
			part.toolInvocation.state === "approval-requested",
	);
}

function threadRecord(
	context: ConversationMemoryExecutionContext,
): StorageThreadType {
	return {
		id: context.threadId,
		resourceId: context.resourceId,
		title: "",
		metadata: {},
		createdAt: new Date(0),
		updatedAt: new Date(),
	};
}

function emptyThreadPage(
	args: StorageListThreadsInput,
): StorageListThreadsOutput {
	return {
		threads: [],
		total: 0,
		page: args.page ?? 0,
		perPage: args.perPage ?? 100,
		hasMore: false,
	};
}

function singleThreadId(value: string | string[]): string {
	if (typeof value === "string") return value;
	if (value.length === 1 && value[0]) return value[0];
	throw storageError("WhaleHall Memory supports exactly one conversation per query.");
}

function parseWorkflowRun(value: unknown): WorkflowRun {
	if (
		!isRecord(value) ||
		typeof value.workflowName !== "string" ||
		typeof value.runId !== "string" ||
		!isRecord(value.snapshot) ||
		!isVersion(value.createdAtMs) ||
		!isVersion(value.updatedAtMs) ||
		(value.resourceId !== undefined && typeof value.resourceId !== "string")
	) {
		throw storageError("Host returned an invalid Workflow run record.");
	}
	return {
		workflowName: value.workflowName,
		runId: value.runId,
		resourceId: value.resourceId,
		snapshot: value.snapshot as unknown as WorkflowRunState,
		createdAt: new Date(value.createdAtMs),
		updatedAt: new Date(value.updatedAtMs),
	};
}

function isVersion(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function storageError(message: string): AgentHostRuntimeError {
	return new AgentHostRuntimeError({
		code: "INTERNAL_ERROR",
		message,
		retryable: false,
	});
}
