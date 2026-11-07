/**
 * Host-tool 名称契约与审批门。
 *
 * 休眠状态说明（2026-11 摘除死代码）：8 个 `createWhaleHallAgentTools` Mastra
 * 包装器已删除——它们从未挂载到任何 Agent（计划模型刻意走快照注入，对话
 * Agent 刻意 text-only，网关检索工具在服务端闭环），属于不可达死代码。本文件
 * 的名称映射与审批门保留，服务 runtime.ts 的 executeTool 审批路径；该路径
 * 当前同样休眠（toolProposals 无写入点），等对话 Agent 通过 provider
 * conformance gate 后重新评估挂载或整体摘除
 * （见 docs/PLANNING_ORCHESTRATION_CORRECTION_PLAN.md 的 W4）。
 */

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

export function isApprovalRequiredToolName(
	value: CanonicalAgentToolName,
): boolean {
	return approvalRequiredToolNames.has(value);
}
