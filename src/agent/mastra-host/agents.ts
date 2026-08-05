import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { Memory } from "@mastra/memory";
import { ACTIVITY_REFLECTION_SYSTEM_PROMPT } from "../activity-reflection-prompt";
import { activityReflectionNativeSkillPaths } from "./activity-reflection-skills";
import {
	type ActivityReflectionWorkflow,
	type ActivityReflectionWorkflowDriver,
	createActivityReflectionWorkflow,
} from "./activity-reflection-workflow";
import type { HostMastraStorage } from "./mastra-storage";
import type { ModelRelay } from "./model-relay";
import {
	createTaskPlanningWorkflow,
	type PlanningWorkflowDriver,
	type TaskPlanningWorkflow,
} from "./planning-workflow";
import { type AgentToolExecutor, createWhaleHallAgentTools } from "./tools";

export interface MastraAgentSet {
	mastra: Mastra;
	conversation: Agent<"whalehall-conversation">;
	planning: Agent<"whalehall-planning">;
	activity: Agent<"whalehall-activity-analysis">;
	activityReflectionSkillCatalog: Agent<"whalehall-activity-reflection-skills">;
	activityReflection: Agent<"whalehall-activity-reflection">;
	planningWorkflow: TaskPlanningWorkflow;
	activityReflectionWorkflow: ActivityReflectionWorkflow;
}

export interface MastraAgentSetOptions {
	provider: string;
	modelId: string;
	baseUrl: string;
	supportsStructuredOutputs: boolean;
	reflectionProvider: string;
	reflectionModelId: string;
	reflectionBaseUrl: string;
	reflectionSupportsStructuredOutputs: boolean;
	storage: HostMastraStorage;
	relay: ModelRelay;
	reflectionRelay: ModelRelay;
	executeTool: AgentToolExecutor;
	executePlanningWorkflow: PlanningWorkflowDriver;
	executeActivityReflectionWorkflow: ActivityReflectionWorkflowDriver;
}

export function createMastraAgentSet(
	options: MastraAgentSetOptions,
): MastraAgentSet {
	const provider = createOpenAICompatible({
		name: options.provider,
		baseURL: normalizeBaseUrl(options.baseUrl),
		fetch: options.relay.fetch,
		supportsStructuredOutputs: options.supportsStructuredOutputs,
	});
	const model = provider.chatModel(options.modelId);
	const reflectionProvider = createOpenAICompatible({
		name: options.reflectionProvider,
		baseURL: normalizeBaseUrl(options.reflectionBaseUrl),
		fetch: options.reflectionRelay.fetch,
		supportsStructuredOutputs: options.reflectionSupportsStructuredOutputs,
	});
	const reflectionModel = reflectionProvider.chatModel(
		options.reflectionModelId,
	);
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
	const activity = new Agent({
		id: "whalehall-activity-analysis",
		name: "WhaleHall 活动分析助手",
		description: "仅整理活动 Worker 返回的事件与分数，不读取或调用本地工具。",
		instructions: [
			"你是 WhaleHall 的后台活动分析助手。只分析输入中已有的 Worker 事件列表和分数。",
			"绝不请求、推断或复述原始活动窗口、桌面事件、配置、账号资料或密钥。",
			"不调用工具；没有工具可用。不要把结果当作用户对话回复。",
			"用简洁中文给出可供本地加密保存的反思摘要，说明事件主题、分数含义和一个谨慎的下一步建议。",
		].join("\n"),
		model,
		tools: {},
		maxRetries: 0,
	});
	const activityReflectionSkillCatalog = new Agent({
		id: "whalehall-activity-reflection-skills",
		name: "WhaleHall 活动反思 Skill 目录",
		description: "仅在本地加载活动反思规则；从不向模型或界面运行。",
		instructions: "仅供本地 Mastra Skill 读取；不得运行模型或调用工具。",
		model: reflectionModel,
		skills: activityReflectionNativeSkillPaths,
		skillsFormat: "markdown",
		tools: {},
		maxRetries: 0,
	});
	const activityReflection = new Agent({
		id: "whalehall-activity-reflection",
		name: "WhaleHall 活动反思模型",
		description: "对一个本地封闭活动窗口生成可核对的结构化中文事件。",
		instructions: ACTIVITY_REFLECTION_SYSTEM_PROMPT,
		model: reflectionModel,
		// Raw-window calls use no Tools. The local Skill catalog above loads the
		// framework-native rules deterministically before this single model call.
		tools: {},
		maxRetries: 0,
	});
	const planningWorkflow = createTaskPlanningWorkflow(
		options.executePlanningWorkflow,
	);
	const activityReflectionWorkflow = createActivityReflectionWorkflow(
		options.executeActivityReflectionWorkflow,
	);
	const mastra = new Mastra({
		storage: options.storage.composite,
		// The reflection Agent deliberately remains unregistered. Mastra 1.55
		// makes registered Agents durable and persists their internal agent-loop
		// snapshots even when the enclosing Workflow opts out. A standalone Agent
		// uses Mastra's ephemeral in-memory host, which keeps this raw-window
		// prompt/output out of the desktop database and reverse storage protocol.
		agents: { conversation, planning, activity },
		workflows: {
			planning: planningWorkflow,
			activityReflection: activityReflectionWorkflow,
		},
		logger: false,
	});
	return {
		mastra,
		conversation,
		planning,
		activity,
		activityReflectionSkillCatalog,
		activityReflection,
		planningWorkflow,
		activityReflectionWorkflow,
	};
}

function normalizeBaseUrl(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}
