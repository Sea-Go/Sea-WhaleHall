import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const exposedToCanonicalToolName = {
	calendar_list_events: "calendar.list_events",
	planning_get_active_plan: "planning.get_active_plan",
	planning_get_active_goal: "planning.get_active_goal",
	planning_save_draft: "planning.save_draft",
	calendar_create_event: "calendar.create_event",
	calendar_update_event: "calendar.update_event",
	calendar_delete_event: "calendar.delete_event",
	calendar_commit_plan_schedule: "calendar.commit_plan_schedule",
} as const;

export type ExposedAgentToolName = keyof typeof exposedToCanonicalToolName;
export type CanonicalAgentToolName =
	(typeof exposedToCanonicalToolName)[ExposedAgentToolName];

const approvalRequiredToolNames = new Set<CanonicalAgentToolName>([
	"planning.save_draft",
	"calendar.create_event",
	"calendar.update_event",
	"calendar.delete_event",
	"calendar.commit_plan_schedule",
]);

export interface AgentToolRequestContext {
	runId: string;
	requestId: string;
}

export interface AgentToolExecutionInput extends AgentToolRequestContext {
	toolCallId: string;
	name: CanonicalAgentToolName;
	arguments: Record<string, unknown>;
	signal?: AbortSignal;
}

export type AgentToolExecutor = (
	input: AgentToolExecutionInput,
) => Promise<unknown>;

const recordSchema = z.record(z.string(), z.unknown());
const emptySchema = z.object({}).strict();
const planScheduleItemSchema = z.object({
	id: z.string().min(1),
	taskId: z.string().min(1),
	title: z.string().min(1),
	start: z.string().min(1),
	end: z.string().min(1),
	timeZone: z.string().min(1),
}).strict();

export function createWhaleHallAgentTools(execute: AgentToolExecutor) {
	return {
		calendar_list_events: createHostTool(
			"calendar_list_events",
			"读取指定日期范围内的本地日历事件。",
			z.object({
				fromDate: z.string().min(1),
				toDateExclusive: z.string().min(1),
				timeZone: z.string().min(1),
			}),
			false,
			execute,
		),
		planning_get_active_plan: createHostTool(
			"planning_get_active_plan",
			"读取当前生效的本地计划。",
			emptySchema,
			false,
			execute,
		),
		planning_get_active_goal: createHostTool(
			"planning_get_active_goal",
			"读取当前生效的本地目标。",
			emptySchema,
			false,
			execute,
		),
		planning_save_draft: createHostTool(
			"planning_save_draft",
			"保存一个本地计划草案；执行前必须由用户批准。",
			z.object({
				title: z.string().min(1),
				draft: recordSchema,
				expectedVersion: z.number().int().nonnegative().optional(),
			}),
			true,
			execute,
		),
		calendar_create_event: createHostTool(
			"calendar_create_event",
			"创建一个本地日历事件；执行前必须由用户批准。",
			z.object({
				title: z.string().min(1).optional(),
				event: recordSchema,
			}),
			true,
			execute,
		),
		calendar_update_event: createHostTool(
			"calendar_update_event",
			"修改一个本地日历事件；执行前必须由用户批准。",
			z.object({
				eventId: z.string().min(1),
				title: z.string().min(1).optional(),
				expectedVersion: z.number().int().nonnegative(),
				recurrenceScope: z.enum(["occurrence", "following", "series"]).optional(),
				event: recordSchema,
			}),
			true,
			execute,
		),
		calendar_delete_event: createHostTool(
			"calendar_delete_event",
			"删除一个本地日历事件；执行前必须由用户批准。",
			z.object({
				eventId: z.string().min(1),
				title: z.string().min(1).optional(),
				expectedVersion: z.number().int().nonnegative(),
				recurrenceScope: z.enum(["occurrence", "following", "series"]).optional(),
			}),
			true,
			execute,
		),
		calendar_commit_plan_schedule: createHostTool(
			"calendar_commit_plan_schedule",
			"把计划排程写入正式日历；执行前必须由用户批准。",
			z.object({
				planId: z.string().min(1),
				title: z.string().min(1).optional(),
				calendarRevision: z.number().int().nonnegative(),
				schedule: z.array(planScheduleItemSchema).min(1).max(500),
			}).strict(),
			true,
			execute,
		),
	};
}

export function canonicalToolName(value: string): CanonicalAgentToolName | null {
	return Object.prototype.hasOwnProperty.call(exposedToCanonicalToolName, value)
		? exposedToCanonicalToolName[value as ExposedAgentToolName]
		: null;
}

export function isApprovalRequiredToolName(
	value: CanonicalAgentToolName,
): boolean {
	return approvalRequiredToolNames.has(value);
}

function createHostTool<
	const TId extends ExposedAgentToolName,
	const TSchema extends z.ZodType<Record<string, unknown>>,
>(
	id: TId,
	description: string,
	inputSchema: TSchema,
	requireApproval: boolean,
	execute: AgentToolExecutor,
) {
	return createTool({
		id,
		description,
		inputSchema,
		requireApproval,
		strict: true,
		execute: async (argumentsValue, context) => {
			const requestContext = context.requestContext;
			const runId = requestContext.get("runId");
			const requestId = requestContext.get("requestId");
			const toolCallId = context.agent?.toolCallId;
			if (
				typeof runId !== "string" ||
				typeof requestId !== "string" ||
				typeof toolCallId !== "string"
			) {
				throw new Error("Agent Tool execution context is incomplete.");
			}
			return execute({
				runId,
				requestId,
				toolCallId,
				name: exposedToCanonicalToolName[id],
				arguments: argumentsValue,
				signal: context.abortSignal,
			});
		},
	});
}
