import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { Memory } from "@mastra/memory";
import type { HostMastraStorage } from "./mastra-storage";
import type { ModelRelay } from "./model-relay";
import {
	createTaskPlanningWorkflow,
	type PlanningWorkflowDriver,
	type TaskPlanningWorkflow,
} from "./planning-workflow";
import {
	createWhaleHallAgentTools,
	type AgentToolExecutor,
} from "./tools";

export interface MastraAgentSet {
	mastra: Mastra;
	conversation: Agent<"whalehall-conversation">;
	planning: Agent<"whalehall-planning">;
	planningWorkflow: TaskPlanningWorkflow;
}

export interface MastraAgentSetOptions {
	provider: string;
	modelId: string;
	baseUrl: string;
	supportsStructuredOutputs: boolean;
	storage: HostMastraStorage;
	relay: ModelRelay;
	executeTool: AgentToolExecutor;
	executePlanningWorkflow: PlanningWorkflowDriver;
}

export function createMastraAgentSet(options: MastraAgentSetOptions): MastraAgentSet {
	const provider = createOpenAICompatible({
		name: options.provider,
		baseURL: normalizeBaseUrl(options.baseUrl),
		fetch: options.relay.fetch,
		supportsStructuredOutputs: options.supportsStructuredOutputs,
	});
	const model = provider.chatModel(options.modelId);
	const tools = createWhaleHallAgentTools(options.executeTool);
	const memory = new Memory({
		storage: options.storage.composite,
		options: {
			lastMessages: 24,
			semanticRecall: false,
			generateTitle: false,
			workingMemory: { enabled: false },
		},
	});
	const conversation = new Agent({
		id: "whalehall-conversation",
		name: "WhaleHall 对话助手",
		description: "在桌面端持续对话并流式返回自然中文回答。",
		instructions: [
			"你是 WhaleHall 桌面助手。使用清楚、自然、简洁的中文回答。",
			"延续提供的会话上下文；不虚构本地数据、工具结果或已经执行的操作。",
			"需要读取日历、当前计划或目标时，使用已注册的只读 Tool；不要猜测本地状态。",
			"需要保存计划或改动日历时，使用已注册的写入 Tool，并等待用户审批；审批前不得声称操作已经完成。",
			"未注册的本地能力不可调用，也不可用相近 Tool 冒充。",
		].join("\n"),
		model,
		memory,
		tools,
		maxRetries: 0,
	});
	const planning = new Agent({
		id: "whalehall-planning",
		name: "WhaleHall 计划助手",
		description: "把目标澄清并拆分成可排期、可验收的里程碑和任务。",
		instructions: [
			"你是 WhaleHall 计划助手，必须输出符合所给结构化 schema 的 JSON。",
			"信息不足且会实质改变计划时，返回 clarifying，每轮只询问 1 到 3 个必要问题。",
			"信息足够时返回 draft；phases 必须是按 order 明确排序的阶段，每个 milestone.phaseId 必须引用已有阶段 ID。任务要具体、可执行、有完成标准，依赖必须引用任务 ID。",
			"draft 必须原样带回 calendarRevision，并根据提供的完整日历快照给出 exact schedule；每项包含 taskId、带 UTC offset 的 start/end 与原 IANA timeZone。无法排入的任务放入 unscheduledTaskIds。",
			"日期使用 YYYY-MM-DD，分钟估算使用正整数。不要在 JSON 外添加文字。",
		].join("\n"),
		model,
		maxRetries: 0,
	});
	const planningWorkflow = createTaskPlanningWorkflow(
		options.executePlanningWorkflow,
	);
	const mastra = new Mastra({
		storage: options.storage.composite,
		agents: { conversation, planning },
		workflows: { planning: planningWorkflow },
		logger: false,
	});
	return { mastra, conversation, planning, planningWorkflow };
}

function normalizeBaseUrl(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}
