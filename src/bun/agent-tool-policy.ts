import { createHash, randomUUID } from "node:crypto";

export const AUTO_READ_AGENT_TOOLS = [
	"calendar.list_events",
	"planning.get_active_plan",
	"planning.get_active_goal",
] as const;

export const APPROVAL_REQUIRED_AGENT_TOOLS = [
	"planning.save_draft",
	"calendar.create_event",
	"calendar.update_event",
	"calendar.delete_event",
	"calendar.commit_plan_schedule",
] as const;

export type AgentReadToolName = (typeof AUTO_READ_AGENT_TOOLS)[number];
export type AgentWriteToolName = (typeof APPROVAL_REQUIRED_AGENT_TOOLS)[number];
export type AgentToolName = AgentReadToolName | AgentWriteToolName;
export type AgentPermission = "agent.calendar.read" | "agent.planning.read";

export interface PendingToolApproval {
	approvalId: string;
	accountId: string;
	runId: string;
	toolCallId: string;
	toolName: AgentWriteToolName;
	argumentsDigest: string;
	runRevision: number;
	arguments: Record<string, unknown>;
	createdAtMs: number;
	expiresAtMs: number;
	status: "pending" | "approved" | "denied" | "expired";
}

export interface ToolApprovalRepository {
	hasGrant(accountId: string, permission: AgentPermission): Promise<boolean>;
	putApproval(approval: PendingToolApproval): Promise<void>;
	getApproval(accountId: string, approvalId: string): Promise<PendingToolApproval | null>;
	compareAndSetApprovalStatus(
		accountId: string,
		approvalId: string,
		expected: PendingToolApproval["status"],
		next: PendingToolApproval["status"],
	): Promise<boolean>;
}

export interface RendererToolApprovalSummary {
	approvalId: string;
	toolCallId: string;
	title: string;
	description: string;
	risk: "write" | "control";
	inputDigest: string;
	requestedAtMs: number;
	expiresAtMs: number;
}

export class AgentToolPolicyError extends Error {
	constructor(
		readonly code:
			| "tool-not-allowed"
			| "permission-required"
			| "approval-not-found"
			| "approval-expired"
			| "approval-mismatch"
			| "approval-consumed",
		message: string,
	) {
		super(message);
		this.name = "AgentToolPolicyError";
	}
}

export class AgentToolPolicy {
	constructor(
		private readonly repository: ToolApprovalRepository,
		private readonly now: () => number = () => Date.now(),
	) {}

	async assertReadAllowed(accountId: string, toolName: string): Promise<AgentReadToolName> {
		if (!isReadTool(toolName)) throw new AgentToolPolicyError("tool-not-allowed", "该 Tool 未向本地 Agent 开放。");
		const permission: AgentPermission = toolName.startsWith("calendar.")
			? "agent.calendar.read"
			: "agent.planning.read";
		if (!(await this.repository.hasGrant(accountId, permission))) {
			throw new AgentToolPolicyError("permission-required", "请先在设置中授权 Agent 读取相关本地数据。");
		}
		return toolName;
	}

	async proposeWrite(input: {
		accountId: string;
		runId: string;
		toolCallId: string;
		toolName: string;
		arguments: Record<string, unknown>;
		runRevision: number;
	}): Promise<RendererToolApprovalSummary> {
		if (!isWriteTool(input.toolName)) {
			throw new AgentToolPolicyError("tool-not-allowed", "该写入 Tool 未向本地 Agent 开放。");
		}
		assertApprovalArguments(input.toolName, input.arguments);
		const createdAtMs = this.now();
		const approval: PendingToolApproval = {
			approvalId: `approval-${randomUUID()}`,
			accountId: input.accountId,
			runId: boundedId(input.runId),
			toolCallId: boundedId(input.toolCallId),
			toolName: input.toolName,
			argumentsDigest: digestArguments(input.arguments),
			runRevision: input.runRevision,
			arguments: structuredClone(input.arguments),
			createdAtMs,
			expiresAtMs: createdAtMs + 10 * 60_000,
			status: "pending",
		};
		await this.repository.putApproval(approval);
		return presentApproval(approval);
	}

	async decide(input: {
		accountId: string;
		approvalId: string;
		runId: string;
		toolCallId: string;
		inputDigest: string;
		runRevision: number;
		decision: "approve-once" | "deny";
	}): Promise<PendingToolApproval> {
		const approval = await this.repository.getApproval(input.accountId, input.approvalId);
		if (!approval) throw new AgentToolPolicyError("approval-not-found", "审批不存在或不属于当前账号。");
		if (approval.status !== "pending") throw new AgentToolPolicyError("approval-consumed", "审批已处理，不能重复使用。");
		if (approval.expiresAtMs <= this.now()) {
			await this.repository.compareAndSetApprovalStatus(input.accountId, input.approvalId, "pending", "expired");
			throw new AgentToolPolicyError("approval-expired", "审批已超过十分钟有效期。");
		}
		if (!isWriteTool(approval.toolName)) {
			throw new AgentToolPolicyError("approval-mismatch", "审批保存的 Tool 不在本地写入白名单中。");
		}
		assertApprovalArguments(approval.toolName, approval.arguments);
		if (digestArguments(approval.arguments) !== approval.argumentsDigest) {
			throw new AgentToolPolicyError("approval-mismatch", "审批保存的参数与摘要不一致。");
		}
		if (
			approval.accountId !== input.accountId ||
			approval.runId !== input.runId ||
			approval.toolCallId !== input.toolCallId ||
			approval.argumentsDigest !== input.inputDigest ||
			approval.runRevision !== input.runRevision
		) {
			throw new AgentToolPolicyError("approval-mismatch", "审批绑定的运行、参数摘要或版本已变化。");
		}
		const next = input.decision === "approve-once" ? "approved" : "denied";
		const changed = await this.repository.compareAndSetApprovalStatus(
			input.accountId,
			input.approvalId,
			"pending",
			next,
		);
		if (!changed) throw new AgentToolPolicyError("approval-consumed", "审批已被其他操作处理。");
		return { ...approval, status: next };
	}

	/** Revalidates a one-time approval immediately before the local write begins. */
	async assertApprovedForExecution(
		approval: PendingToolApproval,
	): Promise<PendingToolApproval> {
		const persisted = await this.repository.getApproval(
			approval.accountId,
			approval.approvalId,
		);
		if (!persisted || persisted.status !== "approved") {
			throw new AgentToolPolicyError(
				"approval-consumed",
				"审批已失效，不能执行本地操作。",
			);
		}
		if (!sameApprovalBinding(persisted, approval)) {
			throw new AgentToolPolicyError(
				"approval-mismatch",
				"审批记录在执行前发生变化。",
			);
		}
		if (persisted.expiresAtMs <= this.now()) {
			const changed = await this.repository.compareAndSetApprovalStatus(
				persisted.accountId,
				persisted.approvalId,
				"approved",
				"expired",
			);
			if (!changed) {
				throw new AgentToolPolicyError(
					"approval-consumed",
					"审批已被其他操作处理。",
				);
			}
			throw new AgentToolPolicyError(
				"approval-expired",
				"审批已超过十分钟有效期，未执行本地操作。",
			);
		}
		return persisted;
	}
}

export function digestArguments(argumentsValue: Record<string, unknown>): string {
	return createHash("sha256").update(canonicalJson(argumentsValue), "utf8").digest("hex");
}

function presentApproval(approval: PendingToolApproval): RendererToolApprovalSummary {
	const presenter = presenters[approval.toolName];
	return {
		approvalId: approval.approvalId,
		toolCallId: approval.toolCallId,
		...presenter(approval.arguments),
		inputDigest: approval.argumentsDigest,
		requestedAtMs: approval.createdAtMs,
		expiresAtMs: approval.expiresAtMs,
	};
}

const presenters: Record<
	AgentWriteToolName,
	(args: Record<string, unknown>) => Pick<RendererToolApprovalSummary, "title" | "description" | "risk">
> = {
	"planning.save_draft": (args) => {
		const label = nestedLabel(args, "draft", "title", "id", "未命名计划");
		if (args.expectedVersion === undefined) {
			return {
				title: "新建计划草案",
				description: `新建本地草案“${label}”；草案标识由 WhaleHall 生成。`,
				risk: "write",
			};
		}
		return {
			title: "更新计划草案",
			description: `更新本地草案“${label}”（预期版本 ${String(args.expectedVersion)}）。`,
			risk: "write",
		};
	},
	"calendar.create_event": (args) => ({
		title: "新建日程",
		description: `在日历中新建“${nestedLabel(args, "event", "title", "id", "未命名日程")}”${describeEventSchedule(args.event)}。`,
		risk: "write",
	}),
	"calendar.update_event": (args) => ({
		title: "修改日程",
		description: `修改日程“${nestedLabel(args, "event", "title", "id", "指定日程")}”${describeEventSchedule(args.event)}。`,
		risk: "write",
	}),
	"calendar.delete_event": (args) => ({
		title: "删除日程",
		description: `删除日程“${safeLabel(args.eventId, "指定日程")}”。`,
		risk: "control",
	}),
	"calendar.commit_plan_schedule": (args) => ({
		title: "提交计划日程",
		description: `把计划“${safeLabel(args.planId, "当前计划")}”的 ${Array.isArray(args.schedule) ? args.schedule.length : 0} 项排程写入正式日历${describeFirstScheduleItem(args.schedule)}。`,
		risk: "control",
	}),
};

function describeEventSchedule(value: unknown): string {
	if (!isRecord(value) || !isRecord(value.schedule)) return "";
	const schedule = value.schedule;
	if (schedule.allDay === true) {
		const start = compactDateTime(schedule.startDate);
		const end = compactDateTime(schedule.endDateExclusive);
		return start && end ? `，全天 ${start} 至 ${end}` : "，全天";
	}
	const start = compactDateTime(schedule.start);
	const end = compactDateTime(schedule.end);
	if (!start || !end) return "";
	const timeZone = safeOptionalLabel(schedule.timeZone);
	return `，时间 ${start} 至 ${end}${timeZone ? `（${timeZone}）` : ""}`;
}

function describeFirstScheduleItem(value: unknown): string {
	if (!Array.isArray(value) || !isRecord(value[0])) return "";
	const first = value[0];
	const start = compactDateTime(first.start);
	const end = compactDateTime(first.end);
	if (!start || !end) return "";
	const timeZone = safeOptionalLabel(first.timeZone);
	return `；首项时间 ${start} 至 ${end}${timeZone ? `（${timeZone}）` : ""}`;
}

function compactDateTime(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace("T", " ");
	if (!normalized) return null;
	const match = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/.exec(normalized);
	return match ? `${match[1]}${match[2] ? ` ${match[2]}` : ""}` : null;
}

function safeOptionalLabel(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	return value.trim().replace(/\s+/g, " ").slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertApprovalArguments(
	toolName: AgentWriteToolName,
	args: Record<string, unknown>,
): void {
	const fail = (message: string): never => {
		throw new AgentToolPolicyError("approval-mismatch", message);
	};
	const id = (value: unknown, field: string): string =>
		typeof value === "string" && value.length > 0 && value.length <= 256
			? value
			: fail(`${field} 无效。`);
	const record = (value: unknown, field: string): Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value)
			? value as Record<string, unknown>
			: fail(`${field} 无效。`);
	const version = (value: unknown, field: string): void => {
		if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${field} 无效。`);
	};

	switch (toolName) {
		case "planning.save_draft": {
			const draft = record(args.draft, "draft");
			if (args.expectedVersion !== undefined) {
				id(draft.id, "draft.id");
				version(args.expectedVersion, "expectedVersion");
			}
			return;
		}
		case "calendar.create_event": {
			const event = record(args.event, "event");
			id(event.id, "event.id");
			return;
		}
		case "calendar.update_event": {
			const event = record(args.event, "event");
			const eventId = id(args.eventId, "eventId");
			if (id(event.id, "event.id") !== eventId) fail("eventId 与实际写入事件不一致。");
			version(args.expectedVersion, "expectedVersion");
			return;
		}
		case "calendar.delete_event":
			id(args.eventId, "eventId");
			version(args.expectedVersion, "expectedVersion");
			return;
		case "calendar.commit_plan_schedule":
			id(args.planId, "planId");
			version(args.calendarRevision, "calendarRevision");
			if (!Array.isArray(args.schedule) || args.schedule.length < 1 || args.schedule.length > 500) {
				fail("schedule 无效。");
			}
	}
}

function nestedLabel(
	args: Record<string, unknown>,
	recordKey: string,
	primaryKey: string,
	fallbackKey: string,
	fallback: string,
): string {
	const value = args[recordKey];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
	const record = value as Record<string, unknown>;
	return safeLabel(record[primaryKey], safeLabel(record[fallbackKey], fallback));
}

function isReadTool(value: string): value is AgentReadToolName {
	return (AUTO_READ_AGENT_TOOLS as readonly string[]).includes(value);
}

function isWriteTool(value: string): value is AgentWriteToolName {
	return (APPROVAL_REQUIRED_AGENT_TOOLS as readonly string[]).includes(value);
}

function sameApprovalBinding(
	left: PendingToolApproval,
	right: PendingToolApproval,
): boolean {
	if (!isWriteTool(left.toolName) || !isWriteTool(right.toolName)) return false;
	try {
		assertApprovalArguments(left.toolName, left.arguments);
		assertApprovalArguments(right.toolName, right.arguments);
		return (
			right.status === "approved" &&
			left.approvalId === right.approvalId &&
			left.accountId === right.accountId &&
			left.runId === right.runId &&
			left.toolCallId === right.toolCallId &&
			left.toolName === right.toolName &&
			left.argumentsDigest === right.argumentsDigest &&
			left.argumentsDigest === digestArguments(left.arguments) &&
			right.argumentsDigest === digestArguments(right.arguments) &&
			left.runRevision === right.runRevision &&
			left.createdAtMs === right.createdAtMs &&
			left.expiresAtMs === right.expiresAtMs
		);
	} catch {
		return false;
	}
}

function boundedId(value: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256) {
		throw new AgentToolPolicyError("approval-mismatch", "运行或 Tool ID 无效。");
	}
	return value;
}

function safeLabel(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim()
		? value.trim().replace(/\s+/g, " ").slice(0, 120)
		: fallback;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new AgentToolPolicyError("approval-mismatch", "Tool 参数包含非有限数值。");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	throw new AgentToolPolicyError("approval-mismatch", "Tool 参数包含不可序列化值。");
}
