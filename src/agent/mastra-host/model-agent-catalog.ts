export const MODEL_PURPOSES = [
	"agent",
	"activity",
	"planning",
	"reflection",
] as const;

export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export const REASONING_TIERS = ["high", "medium", "low"] as const;

export type ReasoningTier = (typeof REASONING_TIERS)[number];

export const MODEL_AGENT_CATALOG = [
	{
		id: "whalehall-conversation",
		displayName: "对话",
		purpose: "agent",
		recommendedTier: "medium",
	},
	{
		id: "whalehall-planning",
		displayName: "规划",
		purpose: "planning",
		recommendedTier: "high",
	},
	{
		id: "whalehall-planning-analysis",
		displayName: "规划分析",
		purpose: "planning",
		recommendedTier: "high",
	},
	{
		id: "whalehall-activity-reflection",
		displayName: "活动反思",
		purpose: "reflection",
		recommendedTier: "high",
	},
	{
		id: "whalehall-activity-support-supervisor",
		displayName: "主动关怀调度",
		purpose: "activity",
		recommendedTier: "medium",
	},
	{
		id: "whalehall-activity-momentum-coach",
		displayName: "行动推进教练",
		purpose: "activity",
		recommendedTier: "low",
	},
	{
		id: "whalehall-activity-blocker-coach",
		displayName: "卡点拆解教练",
		purpose: "activity",
		recommendedTier: "low",
	},
	{
		id: "whalehall-activity-focus-coach",
		displayName: "专注教练",
		purpose: "activity",
		recommendedTier: "low",
	},
	{
		id: "whalehall-activity-recovery-companion",
		displayName: "恢复陪伴",
		purpose: "activity",
		recommendedTier: "low",
	},
	{
		id: "whalehall-activity-check-in-companion",
		displayName: "轻量问候",
		purpose: "activity",
		recommendedTier: "low",
	},
	{
		id: "whalehall-activity-support-voice",
		displayName: "关怀表达",
		purpose: "activity",
		recommendedTier: "low",
	},
] as const satisfies readonly {
	id: string;
	displayName: string;
	purpose: ModelPurpose;
	recommendedTier: ReasoningTier;
}[];

export type ModelAgentId = (typeof MODEL_AGENT_CATALOG)[number]["id"];

export const MODEL_AGENT_IDS = {
	conversation: "whalehall-conversation",
	planning: "whalehall-planning",
	planningAnalysis: "whalehall-planning-analysis",
	activityReflection: "whalehall-activity-reflection",
	activitySupportSupervisor: "whalehall-activity-support-supervisor",
	activitySupportVoice: "whalehall-activity-support-voice",
} as const satisfies Record<string, ModelAgentId>;

const modelAgentById = new Map<
	ModelAgentId,
	(typeof MODEL_AGENT_CATALOG)[number]
>(MODEL_AGENT_CATALOG.map((agent) => [agent.id, agent]));

export function isModelAgentId(value: unknown): value is ModelAgentId {
	return typeof value === "string" && modelAgentById.has(value as ModelAgentId);
}

export function isModelPurpose(value: unknown): value is ModelPurpose {
	return (
		typeof value === "string" &&
		(MODEL_PURPOSES as readonly string[]).includes(value)
	);
}

export function modelAgentPurpose(agentId: ModelAgentId): ModelPurpose {
	const agent = modelAgentById.get(agentId);
	if (!agent) throw new Error("Unknown WhaleHall model Agent.");
	return agent.purpose;
}

export const ACTIVITY_SUPPORT_SPECIALIST_AGENT_IDS = {
	momentumCoach: "whalehall-activity-momentum-coach",
	blockerCoach: "whalehall-activity-blocker-coach",
	focusCoach: "whalehall-activity-focus-coach",
	recoveryCompanion: "whalehall-activity-recovery-companion",
	checkInCompanion: "whalehall-activity-check-in-companion",
} as const satisfies Record<string, ModelAgentId>;
