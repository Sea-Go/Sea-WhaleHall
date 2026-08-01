import { randomUUID } from "node:crypto";
import type {
	AgentWorkflowRecord,
	AgentWorkflowSnapshotListOptions,
	AgentWorkflowSnapshotRecord,
	EncryptedAgentRepository,
} from "./encrypted-agent-repository";
import type { CalendarRepository } from "./calendar-repository";
import type { AgentToolPolicy } from "./agent-tool-policy";
import { validatePlanningDraft } from "./planning-validator";
import type { TaskPlanningDraft, TaskPlanningInput } from "../shared/task-planning";

export interface ConversationMemoryService {
	load(accountId: string, ownerRunId: string, conversationId: string): Promise<{
		messages: readonly { role: "user" | "assistant"; content: string }[];
		version: number;
	}>;
	append(input: {
		accountId: string;
		ownerRunId: string;
		conversationId: string;
		expectedVersion: number;
		messages: readonly { role: "user" | "assistant"; content: string }[];
	}): Promise<{ version: number }>;
}

export interface AgentToolHost {
	propose(accountId: string, params: Record<string, unknown>): Promise<unknown>;
	call(accountId: string, params: Record<string, unknown>): Promise<unknown>;
	cancel(accountId: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface LocalAgentHostServicesOptions {
	runBound<TResult>(
		ownerRunId: string,
		operation: (accountId: string) => Promise<TResult>,
	): Promise<TResult>;
	repository: Pick<
		EncryptedAgentRepository,
		| "getWorkflow"
		| "putWorkflow"
		| "putWorkflowSnapshot"
		| "getWorkflowSnapshot"
		| "listWorkflowSnapshots"
		| "deleteWorkflowSnapshot"
	>;
	calendar: CalendarRepository;
	toolPolicy: Pick<AgentToolPolicy, "assertReadAllowed">;
	memory: ConversationMemoryService;
	tools: AgentToolHost;
	now?: () => number;
}

interface StoredPlanningWorkflow {
	sessionId: string;
	runId: string;
	workflowRunId: string;
	input: TaskPlanningInput;
	answers: readonly { questionKey: string; answerText: string }[];
	clarificationRounds: number;
	version: number;
	result: unknown | null;
}

/** Implements reverse Sidecar→Bun calls. All account identity is supplied by
 * the current Bun session, never trusted from the Sidecar payload. */
export class LocalAgentHostServices {
	private readonly now: () => number;
	private readonly workflowSnapshotLocks = new Map<string, Promise<void>>();

	constructor(private readonly options: LocalAgentHostServicesOptions) {
		this.now = options.now ?? Date.now;
	}

	async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
		const ownerRunId = requiredId(params.ownerRunId, "ownerRunId");
		const boundParams = { ...params };
		delete boundParams.ownerRunId;
		return this.options.runBound(ownerRunId, (accountId) =>
			this.handleBound(method, accountId, ownerRunId, boundParams));
	}

	private async handleBound(
		method: string,
		accountId: string,
		ownerRunId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		switch (method) {
			case "memory/load":
				return this.loadMemory(accountId, ownerRunId, params);
			case "memory/append":
				return this.appendMemory(accountId, ownerRunId, params);
			case "workflow/start":
				assertOwnerRun(ownerRunId, params);
				return this.startWorkflow(accountId, params);
			case "workflow/resume":
				assertOwnerRun(ownerRunId, params);
				return this.resumeWorkflow(accountId, params);
			case "workflow/snapshot.persist":
				return this.persistWorkflowSnapshot(accountId, params);
			case "workflow/snapshot.load":
				return this.loadWorkflowSnapshot(accountId, params);
			case "workflow/snapshot.list":
				return this.listWorkflowSnapshots(accountId, params);
			case "workflow/snapshot.get":
				return this.getWorkflowSnapshot(accountId, params);
			case "workflow/snapshot.delete":
				return this.deleteWorkflowSnapshot(accountId, params);
			case "workflow/snapshot.update-results":
				return this.updateWorkflowResults(accountId, params);
			case "workflow/snapshot.update-state":
				return this.updateWorkflowState(accountId, params);
			case "planning/load":
				return this.loadPlanning(accountId, params);
			case "planning/save":
				assertOwnerRun(ownerRunId, params);
				return this.savePlanning(accountId, params);
			case "planning/validate":
				return this.validatePlanning(accountId, params);
			case "calendar/query":
				return this.queryCalendar(accountId, params);
			case "tool/call":
				assertOwnerRun(ownerRunId, params);
				return this.options.tools.call(accountId, params);
			case "tool/propose":
				assertOwnerRun(ownerRunId, params);
				return this.options.tools.propose(accountId, params);
			case "tool/cancel":
				assertOwnerRun(ownerRunId, params);
				return this.options.tools.cancel(accountId, params);
			case "tool/list":
				return { tools: [] };
			default:
				throw new Error(`Unsupported local Agent host call: ${method}`);
		}
	}

	private async loadMemory(
		accountId: string,
		ownerRunId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		assertResource(accountId, params);
		return this.options.memory.load(
			accountId,
			ownerRunId,
			requiredId(params.threadId, "threadId"),
		);
	}

	private async appendMemory(
		accountId: string,
		ownerRunId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		assertResource(accountId, params);
		if (!Array.isArray(params.messages) || params.messages.length < 1 || params.messages.length > 8) {
			throw new Error("memory/append messages must contain one to eight items.");
		}
		return this.options.memory.append({
			accountId,
			ownerRunId,
			conversationId: requiredId(params.threadId, "threadId"),
			expectedVersion: requiredVersion(params.expectedVersion, "expectedVersion"),
			messages: params.messages.map(parseMemoryMessage),
		});
	}

	private async startWorkflow(accountId: string, params: Record<string, unknown>): Promise<unknown> {
		if (params.workflow !== "task-planning") throw new Error("Only task-planning workflow is available.");
		const sessionId = requiredId(params.sessionId, "sessionId");
		const existing = await this.options.repository.getWorkflow(accountId, sessionId);
		if (existing) {
			const state = parseWorkflow(existing);
			return { workflowRunId: state.workflowRunId };
		}
		const now = this.now();
		const state: StoredPlanningWorkflow = {
			sessionId,
			runId: requiredId(params.runId, "runId"),
			workflowRunId: `workflow-${randomUUID()}`,
			input: parsePlanningInput(params.input),
			answers: [],
			clarificationRounds: 0,
			version: 0,
			result: null,
		};
		await this.options.repository.putWorkflow({
			accountId,
			id: sessionId,
			name: "task-planning",
			definition: state,
			enabled: true,
			createdAtMs: now,
			updatedAtMs: now,
		});
		return { workflowRunId: state.workflowRunId };
	}

	private async resumeWorkflow(accountId: string, params: Record<string, unknown>): Promise<unknown> {
		const sessionId = requiredId(params.sessionId, "sessionId");
		const record = await this.requireWorkflow(accountId, sessionId);
		const state = parseWorkflow(record);
		if (params.workflowRunId !== state.workflowRunId) throw new Error("Workflow run ID changed.");
		const answers = Array.isArray(params.answers) ? params.answers.map(parsePlanningAnswer) : [];
		state.answers = [...state.answers, ...answers];
		await this.saveWorkflowRecord(record, state);
		return { resumed: true, version: state.version };
	}

	private async persistWorkflowSnapshot(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		assertExactKeys(params, [
			"createdAtMs",
			"resourceId",
			"runId",
			"snapshot",
			"updatedAtMs",
			"workflowName",
		], ["resourceId", "createdAtMs", "updatedAtMs"]);
		assertWorkflowResource(accountId, params.resourceId);
		const workflowName = requiredId(params.workflowName, "workflowName");
		const runId = requiredId(params.runId, "runId");
		const snapshot = requiredRecord(params.snapshot, "snapshot");
		return this.withWorkflowSnapshotLock(accountId, workflowName, runId, async () => {
			const existing = await this.options.repository.getWorkflowSnapshot(
				accountId,
				runId,
				workflowName,
			);
			const currentTime = this.now();
			const createdAtMs = optionalTimestamp(params.createdAtMs, "createdAtMs") ??
				existing?.createdAtMs ?? currentTime;
			const updatedAtMs = optionalTimestamp(params.updatedAtMs, "updatedAtMs") ?? currentTime;
			if (updatedAtMs < createdAtMs) throw new Error("Workflow snapshot timestamps are invalid.");
			await this.options.repository.putWorkflowSnapshot({
				accountId,
				workflowName,
				runId,
				resourceId: accountId,
				snapshot: structuredClone(snapshot),
				createdAtMs,
				updatedAtMs,
			});
			return { persisted: true };
		});
	}

	private async loadWorkflowSnapshot(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		assertExactKeys(params, ["runId", "workflowName"]);
		const record = await this.options.repository.getWorkflowSnapshot(
			accountId,
			requiredId(params.runId, "runId"),
			requiredId(params.workflowName, "workflowName"),
		);
		return record?.snapshot ?? null;
	}

	private async listWorkflowSnapshots(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		assertExactKeys(params, [
			"fromDateMs",
			"page",
			"perPage",
			"resourceId",
			"status",
			"toDateMs",
			"workflowName",
		], ["workflowName", "fromDateMs", "toDateMs", "perPage", "page", "resourceId", "status"]);
		assertWorkflowResource(accountId, params.resourceId);
		const options: AgentWorkflowSnapshotListOptions = {
			workflowName: optionalId(params.workflowName, "workflowName"),
			fromDateMs: optionalTimestamp(params.fromDateMs, "fromDateMs"),
			toDateMs: optionalTimestamp(params.toDateMs, "toDateMs"),
			perPage: optionalPerPage(params.perPage),
			page: optionalVersion(params.page, "page"),
			resourceId: params.resourceId === undefined ? undefined : accountId,
			status: optionalId(params.status, "status"),
		};
		const result = await this.options.repository.listWorkflowSnapshots(accountId, options);
		return {
			runs: result.runs.map(workflowSnapshotHostRecord),
			total: result.total,
		};
	}

	private async getWorkflowSnapshot(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		assertExactKeys(params, ["runId", "workflowName"], ["workflowName"]);
		const record = await this.options.repository.getWorkflowSnapshot(
			accountId,
			requiredId(params.runId, "runId"),
			optionalId(params.workflowName, "workflowName"),
		);
		return record ? workflowSnapshotHostRecord(record) : null;
	}

	private async deleteWorkflowSnapshot(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		assertExactKeys(params, ["runId", "workflowName"]);
		const workflowName = requiredId(params.workflowName, "workflowName");
		const runId = requiredId(params.runId, "runId");
		return this.withWorkflowSnapshotLock(accountId, workflowName, runId, async () => ({
			deleted: await this.options.repository.deleteWorkflowSnapshot(
				accountId,
				runId,
				workflowName,
			),
		}));
	}

	private async updateWorkflowResults(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		assertExactKeys(params, [
			"requestContext",
			"result",
			"runId",
			"stepId",
			"workflowName",
		]);
		const workflowName = requiredId(params.workflowName, "workflowName");
		const runId = requiredId(params.runId, "runId");
		const stepId = requiredId(params.stepId, "stepId");
		const result = requiredRecord(params.result, "result");
		const requestContext = requiredRecord(params.requestContext, "requestContext");
		return this.withWorkflowSnapshotLock(accountId, workflowName, runId, async () => {
			const record = await this.options.repository.getWorkflowSnapshot(
				accountId,
				runId,
				workflowName,
			);
			if (!record) return {};
			const snapshot = requiredRecord(structuredClone(record.snapshot), "stored snapshot");
			const context = mergeWorkflowStepResult(snapshot, stepId, result, requestContext);
			await this.saveUpdatedWorkflowSnapshot(record, snapshot);
			return context;
		});
	}

	private async updateWorkflowState(
		accountId: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		assertExactKeys(params, ["opts", "runId", "workflowName"]);
		const workflowName = requiredId(params.workflowName, "workflowName");
		const runId = requiredId(params.runId, "runId");
		const opts = requiredRecord(params.opts, "opts");
		return this.withWorkflowSnapshotLock(accountId, workflowName, runId, async () => {
			const record = await this.options.repository.getWorkflowSnapshot(
				accountId,
				runId,
				workflowName,
			);
			if (!record) return null;
			const snapshot = requiredRecord(structuredClone(record.snapshot), "stored snapshot");
			if (!isRecord(snapshot.context)) throw new Error("Stored workflow snapshot context is invalid.");
			const next = { ...snapshot, ...structuredClone(opts) };
			await this.saveUpdatedWorkflowSnapshot(record, next);
			return next;
		});
	}

	private async saveUpdatedWorkflowSnapshot(
		record: AgentWorkflowSnapshotRecord,
		snapshot: Record<string, unknown>,
	): Promise<void> {
		await this.options.repository.putWorkflowSnapshot({
			...record,
			snapshot,
			updatedAtMs: Math.max(record.createdAtMs, this.now()),
		});
	}

	private async withWorkflowSnapshotLock<T>(
		accountId: string,
		workflowName: string,
		runId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const key = `${accountId}\u0000${workflowName}\u0000${runId}`;
		const previous = this.workflowSnapshotLocks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => current);
		this.workflowSnapshotLocks.set(key, queued);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.workflowSnapshotLocks.get(key) === queued) {
				this.workflowSnapshotLocks.delete(key);
			}
		}
	}

	private async loadPlanning(accountId: string, params: Record<string, unknown>): Promise<unknown> {
		await this.options.toolPolicy.assertReadAllowed(accountId, "planning.get_active_plan");
		const record = await this.requireWorkflow(accountId, requiredId(params.sessionId, "sessionId"));
		return parseWorkflow(record);
	}

	private async savePlanning(accountId: string, params: Record<string, unknown>): Promise<unknown> {
		const sessionId = requiredId(params.sessionId, "sessionId");
		const record = await this.requireWorkflow(accountId, sessionId);
		const current = parseWorkflow(record);
		const expectedVersion = requiredVersion(params.expectedVersion, "expectedVersion");
		if (current.version !== expectedVersion) throw new Error("Planning workflow version conflict.");
		const next: StoredPlanningWorkflow = {
			...current,
			input: parsePlanningInput(params.input),
			answers: Array.isArray(params.answers) ? params.answers.map(parsePlanningAnswer) : current.answers,
			clarificationRounds: requiredVersion(params.clarificationRounds, "clarificationRounds"),
			workflowRunId: requiredId(params.workflowRunId, "workflowRunId"),
			version: current.version + 1,
			result: structuredClone(params.result),
		};
		await this.saveWorkflowRecord(record, next);
		return { version: next.version };
	}

	private async validatePlanning(accountId: string, params: Record<string, unknown>): Promise<unknown> {
		await this.options.toolPolicy.assertReadAllowed(accountId, "calendar.list_events");
		const sessionId = requiredId(params.sessionId, "sessionId");
		const record = await this.requireWorkflow(accountId, sessionId);
		const state = parseWorkflow(record);
		const draft = params.draft as TaskPlanningDraft;
		const snapshot = await this.options.calendar.snapshot(
			accountId,
			localDate(this.now(), state.input.timeZone),
			nextDate(state.input.deadline),
		);
		const validation = validatePlanningDraft(draft, state.input, snapshot);
		return {
			...validation,
			calendar: {
				revision: snapshot.revision,
				fromDate: snapshot.fromDate,
				toDateExclusive: snapshot.toDateExclusive,
				timeZone: snapshot.timeZone,
				events: snapshot.events,
			},
		};
	}

	private async queryCalendar(accountId: string, params: Record<string, unknown>): Promise<unknown> {
		await this.options.toolPolicy.assertReadAllowed(accountId, "calendar.list_events");
		const fromDate = requiredDate(params.fromDate, "fromDate");
		const toDateExclusive = requiredDate(params.toDateExclusive, "toDateExclusive");
		const requestedZone = requiredId(params.timeZone, "timeZone");
		const snapshot = await this.options.calendar.snapshot(accountId, fromDate, toDateExclusive);
		if (snapshot.timeZone !== requestedZone) {
			throw new Error("Calendar time zone does not match the authenticated account settings.");
		}
		return {
			fromDate,
			toDateExclusive,
			timeZone: snapshot.timeZone,
			revision: snapshot.revision,
			events: snapshot.events,
		};
	}

	private async requireWorkflow(accountId: string, sessionId: string): Promise<AgentWorkflowRecord> {
		const record = await this.options.repository.getWorkflow(accountId, sessionId);
		if (!record) throw new Error("Planning workflow was not found.");
		return record;
	}

	private async saveWorkflowRecord(
		record: AgentWorkflowRecord,
		state: StoredPlanningWorkflow,
	): Promise<void> {
		await this.options.repository.putWorkflow({
			...record,
			definition: state,
			updatedAtMs: this.now(),
		});
	}
}

function assertResource(accountId: string, params: Record<string, unknown>): void {
	if (params.namespace !== "conversation" || params.resourceId !== accountId) {
		throw new Error("Memory resource does not match the authenticated account.");
	}
}

function parseWorkflow(record: AgentWorkflowRecord): StoredPlanningWorkflow {
	if (!isRecord(record.definition)) throw new Error("Stored planning workflow is invalid.");
	const value = record.definition;
	return {
		sessionId: requiredId(value.sessionId, "sessionId"),
		runId: requiredId(value.runId, "runId"),
		workflowRunId: requiredId(value.workflowRunId, "workflowRunId"),
		input: parsePlanningInput(value.input),
		answers: Array.isArray(value.answers) ? value.answers.map(parsePlanningAnswer) : [],
		clarificationRounds: requiredVersion(value.clarificationRounds, "clarificationRounds"),
		version: requiredVersion(value.version, "version"),
		result: structuredClone(value.result),
	};
}

function parsePlanningInput(value: unknown): TaskPlanningInput {
	if (!isRecord(value)) throw new Error("Planning input is invalid.");
	return structuredClone(value) as unknown as TaskPlanningInput;
}

function parseMemoryMessage(value: unknown): { role: "user" | "assistant"; content: string } {
	if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string" || value.content.length > 64 * 1024) {
		throw new Error("Conversation memory message is invalid.");
	}
	return { role: value.role, content: value.content };
}

function parsePlanningAnswer(value: unknown): { questionKey: string; answerText: string } {
	if (!isRecord(value) || typeof value.questionKey !== "string" || typeof value.answerText !== "string") {
		throw new Error("Planning answer is invalid.");
	}
	return { questionKey: value.questionKey, answerText: value.answerText };
}

function requiredId(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(`${field} is invalid.`);
	return value;
}

function assertOwnerRun(ownerRunId: string, params: Record<string, unknown>): void {
	if (requiredId(params.runId, "runId") !== ownerRunId) {
		throw new Error("Sidecar host call does not match its owning Agent run.");
	}
}

function requiredVersion(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} is invalid.`);
	return value as number;
}

function optionalVersion(value: unknown, field: string): number | undefined {
	return value === undefined ? undefined : requiredVersion(value, field);
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${field} is invalid.`);
	}
	return value as number;
}

function optionalId(value: unknown, field: string): string | undefined {
	return value === undefined ? undefined : requiredId(value, field);
}

function optionalPerPage(value: unknown): number | false | undefined {
	if (value === undefined || value === false) return value;
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000) {
		throw new Error("perPage is invalid.");
	}
	return value as number;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${field} is invalid.`);
	return value;
}

function assertWorkflowResource(accountId: string, value: unknown): void {
	if (value !== undefined && value !== accountId) {
		throw new Error("Workflow resource does not match the authenticated account.");
	}
}

function assertExactKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): void {
	const allowed = new Set(allowedKeys);
	const optional = new Set(optionalKeys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`Unexpected field: ${key}.`);
	}
	for (const key of allowed) {
		if (!optional.has(key) && !Object.prototype.hasOwnProperty.call(value, key)) {
			throw new Error(`Missing field: ${key}.`);
		}
	}
}

function workflowSnapshotHostRecord(record: AgentWorkflowSnapshotRecord): Record<string, unknown> {
	return {
		workflowName: record.workflowName,
		runId: record.runId,
		resourceId: record.resourceId,
		snapshot: structuredClone(record.snapshot),
		createdAtMs: record.createdAtMs,
		updatedAtMs: record.updatedAtMs,
	};
}

function mergeWorkflowStepResult(
	snapshot: Record<string, unknown>,
	stepId: string,
	result: Record<string, unknown>,
	requestContext: Record<string, unknown>,
): Record<string, unknown> {
	if (!isRecord(snapshot.context)) {
		throw new Error("Stored workflow snapshot context is invalid.");
	}
	const context = snapshot.context;
	const existing = context[stepId];
	if (
		isRecord(existing) &&
		Array.isArray(existing.output) &&
		Array.isArray(result.output)
	) {
		const existingOutput = existing.output;
		const incomingOutput = result.output;
		const mergedOutput = [...existingOutput];
		const hasPending = incomingOutput.some(isPendingWorkflowMarker);
		const size = Math.max(existingOutput.length, incomingOutput.length);
		for (let index = 0; index < size; index += 1) {
			if (index >= incomingOutput.length) continue;
			const incoming = incomingOutput[index];
			if (isPendingWorkflowMarker(incoming)) {
				if (
					index >= existingOutput.length ||
					canResetWorkflowOutput(existingOutput[index])
				) {
					mergedOutput[index] = null;
				}
			} else if (incoming !== null && incoming !== undefined && !hasPending) {
				mergedOutput[index] = structuredClone(incoming);
			} else if (index >= existingOutput.length) {
				mergedOutput[index] = null;
			}
		}
		context[stepId] = {
			...structuredClone(existing),
			...(hasPending ? {} : structuredClone(result)),
			output: mergedOutput,
		};
	} else {
		context[stepId] = structuredClone(result);
	}
	snapshot.requestContext = {
		...(isRecord(snapshot.requestContext) ? snapshot.requestContext : {}),
		...structuredClone(requestContext),
	};
	return structuredClone(context);
}

function isPendingWorkflowMarker(value: unknown): boolean {
	return isRecord(value) &&
		value.__mastra_pending__ === true &&
		Object.keys(value).length === 1;
}

function canResetWorkflowOutput(value: unknown): boolean {
	if (value === null || value === undefined || isPendingWorkflowMarker(value)) return true;
	return isRecord(value) &&
		value.status === "suspended" &&
		("suspendPayload" in value || "suspendedAt" in value);
}

function requiredDate(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} is invalid.`);
	return value;
}

function localDate(nowMs: number, timeZone: string): string {
	const values = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
			.formatToParts(nowMs)
			.map((part) => [part.type, part.value]),
	);
	return `${values.year}-${values.month}-${values.day}`;
}

function nextDate(value: string): string {
	const date = new Date(`${value}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + 1);
	return date.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
