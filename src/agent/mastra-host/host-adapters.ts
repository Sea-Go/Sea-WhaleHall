import {
	isRecord,
	type HostToolApprovalSummary,
	type HostPlanningState,
	type TaskPlanningAnswer,
	type TaskPlanningInput,
} from "./protocol";
import {
	taskPlanningQuestionKeySchema,
	type TaskPlanningDraft,
} from "./schemas";
import { AgentHostRuntimeError, type HostRequestPeer } from "./transport";

export interface CalendarSnapshot {
	fromDate: string;
	toDateExclusive: string;
	timeZone: string;
	revision: number;
	data: unknown;
}

export interface PlanningValidationIssue {
	code: string;
	message: string;
	proposalId?: string;
	busyEventIds?: readonly string[];
}

export interface PlanningValidationResult {
	ok: boolean;
	issues: readonly PlanningValidationIssue[];
}

export interface HostToolProposal extends HostToolApprovalSummary {
	name: string;
	arguments: Record<string, unknown>;
	runVersion: number;
}

export class HostStateAdapters {
	constructor(private readonly peer: HostRequestPeer) {}

	async startPlanningWorkflow(input: {
		sessionId: string;
		runId: string;
		planningInput: TaskPlanningInput;
	}): Promise<string> {
		const value = await this.peer.requestHost("workflow/start", {
			workflow: "task-planning",
			sessionId: input.sessionId,
			runId: input.runId,
			input: input.planningInput,
		});
		if (!isRecord(value) || typeof value.workflowRunId !== "string" || !value.workflowRunId) {
			throw invalidHostState("workflow/start returned an invalid workflow run ID.");
		}
		return value.workflowRunId;
	}

	async resumePlanningWorkflow(input: {
		workflowRunId: string;
		sessionId: string;
		runId: string;
		answers: readonly TaskPlanningAnswer[];
	}): Promise<void> {
		await this.peer.requestHost("workflow/resume", {
			workflow: "task-planning",
			workflowRunId: input.workflowRunId,
			sessionId: input.sessionId,
			runId: input.runId,
			answers: input.answers,
		});
	}

	async queryCalendar(input: TaskPlanningInput): Promise<CalendarSnapshot> {
		const fromDate = localIsoDate(new Date(), input.timeZone);
		const toDateExclusive = nextIsoDate(input.deadline);
		const value = await this.peer.requestHost("calendar/query", {
			fromDate,
			toDateExclusive,
			timeZone: input.timeZone,
			include: ["timed", "all-day", "recurring", "exceptions", "proposed", "committed"],
		});
		if (
			!isRecord(value) ||
			!Array.isArray(value.events) ||
			value.timeZone !== input.timeZone ||
			value.fromDate !== fromDate ||
			value.toDateExclusive !== toDateExclusive
		) {
			throw invalidHostState("calendar/query returned an invalid snapshot.");
		}
		return {
			fromDate,
			toDateExclusive,
			timeZone: input.timeZone,
			revision: safeVersion(value.revision),
			data: value,
		};
	}

	async loadPlanning(sessionId: string): Promise<HostPlanningState> {
		const value = await this.peer.requestHost("planning/load", { sessionId });
		if (
			!isRecord(value) ||
			value.sessionId !== sessionId ||
			!isRecord(value.input) ||
			!Array.isArray(value.answers) ||
			typeof value.runId !== "string" ||
			!value.runId ||
			typeof value.workflowRunId !== "string"
		) {
			throw invalidHostState("planning/load returned an invalid session.");
		}
		return {
			sessionId,
			runId: value.runId,
			input: parsePlanningInput(value.input),
			answers: value.answers.map(parsePlanningAnswer),
			clarificationRounds: safeNonNegativeInteger(value.clarificationRounds),
			workflowRunId: value.workflowRunId,
			version: safeVersion(value.version),
		};
	}

	async savePlanning(state: HostPlanningState, result: unknown): Promise<number> {
		const value = await this.peer.requestHost("planning/save", {
			...state,
			expectedVersion: state.version,
			result,
		});
		if (!isRecord(value)) {
			throw invalidHostState("planning/save returned an invalid result.");
		}
		return safeVersion(value.version);
	}

	async validatePlanning(
		sessionId: string,
		draft: TaskPlanningDraft,
	): Promise<PlanningValidationResult> {
		const value = await this.peer.requestHost("planning/validate", { sessionId, draft });
		if (!isRecord(value) || typeof value.ok !== "boolean" || !Array.isArray(value.issues)) {
			throw invalidHostState("planning/validate returned an invalid result.");
		}
		return {
			ok: value.ok,
			issues: value.issues.map(parsePlanningValidationIssue),
		};
	}

	async proposeTool(input: {
		runId: string;
		toolCallId: string;
		name: string;
		arguments: Record<string, unknown>;
	}): Promise<HostToolProposal> {
		const value = await this.peer.requestHost("tool/propose", input);
		if (!isRecord(value)) {
			throw invalidHostState("tool/propose returned an invalid approval summary.");
		}
		const summary = parseToolApprovalSummary(value, input.toolCallId);
		return {
			...summary,
			name: input.name,
			arguments: structuredClone(input.arguments),
			runVersion: safeVersion(value.runVersion),
		};
	}

	async callTool(
		proposal: HostToolProposal | null,
		input: {
			runId: string;
			toolCallId: string;
			name: string;
			arguments: Record<string, unknown>;
			signal?: AbortSignal;
		},
	): Promise<unknown> {
		const params = {
			runId: input.runId,
			toolCallId: input.toolCallId,
			name: input.name,
			arguments: input.arguments,
			...(proposal
				? {
						approvalId: proposal.approvalId,
						inputDigest: proposal.inputDigest,
						runVersion: proposal.runVersion,
					}
				: {}),
		};
		try {
			return await this.peer.requestHost("tool/call", params, { signal: input.signal });
		} catch (error) {
			if (input.signal?.aborted) {
				void this.peer.requestHost("tool/cancel", {
					runId: input.runId,
					toolCallId: input.toolCallId,
				});
			}
			throw error;
		}
	}
}

function parsePlanningValidationIssue(value: unknown): PlanningValidationIssue {
	if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
		throw invalidHostState("planning/validate returned an invalid issue.");
	}
	if (
		value.proposalId !== undefined &&
		typeof value.proposalId !== "string"
	) {
		throw invalidHostState("planning/validate returned an invalid proposal ID.");
	}
	if (
		value.busyEventIds !== undefined &&
		(!Array.isArray(value.busyEventIds) ||
			!value.busyEventIds.every((entry) => typeof entry === "string"))
	) {
		throw invalidHostState("planning/validate returned invalid busy event IDs.");
	}
	return {
		code: value.code,
		message: value.message,
		...(typeof value.proposalId === "string" ? { proposalId: value.proposalId } : {}),
		...(Array.isArray(value.busyEventIds)
			? { busyEventIds: value.busyEventIds as string[] }
			: {}),
	};
}

function parseToolApprovalSummary(
	value: unknown,
	toolCallId: string,
): HostToolApprovalSummary {
	if (
		!isRecord(value) ||
		value.toolCallId !== toolCallId ||
		typeof value.approvalId !== "string" ||
		typeof value.title !== "string" ||
		typeof value.description !== "string" ||
		(value.risk !== "write" && value.risk !== "control") ||
		typeof value.inputDigest !== "string" ||
		typeof value.requestedAtMs !== "number" ||
		typeof value.expiresAtMs !== "number"
	) {
		throw invalidHostState("tool/propose returned an invalid approval summary.");
	}
	return value as unknown as HostToolApprovalSummary;
}

function parsePlanningAnswer(value: unknown): TaskPlanningAnswer {
	if (
		!isRecord(value) ||
		typeof value.questionKey !== "string" ||
		!taskPlanningQuestionKeySchema.safeParse(value.questionKey).success ||
		typeof value.answerText !== "string"
	) {
		throw invalidHostState("Host planning state contains an invalid answer.");
	}
	return value as unknown as TaskPlanningAnswer;
}

function parsePlanningInput(value: Record<string, unknown>): TaskPlanningInput {
	const preferredSessionMinutes = value.preferredSessionMinutes;
	if (
		typeof value.goal !== "string" ||
		(value.planType !== "short-term" && value.planType !== "long-term") ||
		typeof value.deadline !== "string" ||
		(value.priority !== "low" && value.priority !== "medium" && value.priority !== "high") ||
		typeof value.weeklyCapacityHours !== "number" ||
		!Array.isArray(value.unavailableDays) ||
		!value.unavailableDays.every((day) => typeof day === "string") ||
		!([30, 45, 60, 90] as const).includes(preferredSessionMinutes as 30) ||
		(value.preferredDayPart !== "morning" &&
			value.preferredDayPart !== "afternoon" &&
			value.preferredDayPart !== "evening" &&
			value.preferredDayPart !== "flexible") ||
		typeof value.timeZone !== "string"
	) {
		throw invalidHostState("Host planning state contains invalid input.");
	}
	return value as unknown as TaskPlanningInput;
}

function safeVersion(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw invalidHostState("Host state version must be a non-negative safe integer.");
	}
	return value as number;
}

function safeNonNegativeInteger(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw invalidHostState("Host state counter must be a non-negative safe integer.");
	}
	return value as number;
}

function localIsoDate(date: Date, timeZone: string): string {
	try {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(date);
		const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
		if (!values.year || !values.month || !values.day) throw new Error("missing date parts");
		return `${values.year}-${values.month}-${values.day}`;
	} catch (error) {
		throw new AgentHostRuntimeError({
			code: "INVALID_REQUEST",
			message: `Invalid IANA time zone: ${timeZone}`,
			retryable: false,
			details: { cause: error instanceof Error ? error.message : String(error) },
		});
	}
}

function nextIsoDate(value: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) throw invalidHostState("Planning deadline is not an ISO date.");
	const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
	if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
		throw invalidHostState("Planning deadline is invalid.");
	}
	date.setUTCDate(date.getUTCDate() + 1);
	return date.toISOString().slice(0, 10);
}

function invalidHostState(message: string): AgentHostRuntimeError {
	return new AgentHostRuntimeError({
		code: "INTERNAL_ERROR",
		message,
		retryable: true,
	});
}
