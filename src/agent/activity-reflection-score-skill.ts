/**
 * Calibration data for the native filesystem Skill at
 * skills/activity-reflection-scoring/SKILL.md. Production reflection calls
 * load that Skill through Mastra and keep the returned model score authoritative;
 * this module is not a prompt-building fallback and does not recalculate scores.
 */
export const activityReflectionScoreRuleSet = {
	relevance: {
		direct: 1,
		supporting: 0.6,
		unrelated: 0,
		uncertain: 0,
	},
	evidence: {
		strong_cross: 1,
		supported: 0.7,
		weak: 0,
	},
	duration: {
		at_least_120_seconds: 1,
		from_30_to_119_seconds: 0.75,
		under_30_seconds: 0.5,
		unknown_duration: 0.5,
	},
	confidence: {
		confirmed: "confidence",
		inferred_cap: 0.85,
		uncertain: 0,
	},
	windowMaximum: 1,
	decimalPlaces: 2,
} as const;

export type ActivityReflectionScoreCalibrationCase = {
	name: string;
	contributions: ReadonlyArray<{
		relevance: keyof typeof activityReflectionScoreRuleSet.relevance;
		evidence: keyof typeof activityReflectionScoreRuleSet.evidence;
		duration: keyof typeof activityReflectionScoreRuleSet.duration;
		certainty: "confirmed" | "inferred" | "uncertain";
		confidence: number;
		zero_condition?:
			| "无目标"
			| "状态事件"
			| "敏感交易"
			| "低交互或信息缺失";
	}>;
	expectedScore: number;
};

/**
 * Test calibration only. Production code deliberately does not import this
 * table to recalculate, cap, or otherwise overwrite a model-returned score.
 */
export const activityReflectionScoreCalibrationCases: readonly ActivityReflectionScoreCalibrationCase[] = [
	{
		name: "直接相关、强交叉证据、三分钟、推测",
		contributions: [
			{
				relevance: "direct",
				evidence: "strong_cross",
				duration: "at_least_120_seconds",
				certainty: "inferred",
				confidence: 0.85,
			},
		],
		expectedScore: 0.85,
	},
	{
		name: "支持目标、强交叉证据、九十秒、推测",
		contributions: [
			{
				relevance: "supporting",
				evidence: "strong_cross",
				duration: "from_30_to_119_seconds",
				certainty: "inferred",
				confidence: 0.75,
			},
		],
		expectedScore: 0.34,
	},
	{
		name: "直接相关、受支持证据、二十秒、推测",
		contributions: [
			{
				relevance: "direct",
				evidence: "supported",
				duration: "under_30_seconds",
				certainty: "inferred",
				confidence: 0.6,
			},
		],
		expectedScore: 0.21,
	},
	{
		name: "确定事件使用原始置信度",
		contributions: [
			{
				relevance: "direct",
				evidence: "strong_cross",
				duration: "unknown_duration",
				certainty: "confirmed",
				confidence: 0.9,
			},
		],
		expectedScore: 0.45,
	},
	{
		name: "无关活动固定为零",
		contributions: [
			{
				relevance: "unrelated",
				evidence: "strong_cross",
				duration: "at_least_120_seconds",
				certainty: "confirmed",
				confidence: 1,
			},
		],
		expectedScore: 0,
	},
	{
		name: "相关性不确定固定为零",
		contributions: [
			{
				relevance: "uncertain",
				evidence: "strong_cross",
				duration: "at_least_120_seconds",
				certainty: "inferred",
				confidence: 1,
			},
		],
		expectedScore: 0,
	},
	{
		name: "不确定表述固定为零",
		contributions: [
			{
				relevance: "direct",
				evidence: "strong_cross",
				duration: "at_least_120_seconds",
				certainty: "uncertain",
				confidence: 1,
			},
		],
		expectedScore: 0,
	},
	{
		name: "弱证据固定为零",
		contributions: [
			{
				relevance: "direct",
				evidence: "weak",
				duration: "from_30_to_119_seconds",
				certainty: "inferred",
				confidence: 0.8,
			},
		],
		expectedScore: 0,
	},
	{
		name: "无目标固定为零",
		contributions: [
			{
				relevance: "direct",
				evidence: "strong_cross",
				duration: "at_least_120_seconds",
				certainty: "confirmed",
				confidence: 1,
				zero_condition: "无目标",
			},
		],
		expectedScore: 0,
	},
	{
		name: "状态、敏感交易与低交互固定为零",
		contributions: [
			{
				relevance: "direct",
				evidence: "strong_cross",
				duration: "at_least_120_seconds",
				certainty: "confirmed",
				confidence: 1,
				zero_condition: "状态事件",
			},
			{
				relevance: "direct",
				evidence: "supported",
				duration: "under_30_seconds",
				certainty: "inferred",
				confidence: 0.8,
				zero_condition: "敏感交易",
			},
			{
				relevance: "supporting",
				evidence: "weak",
				duration: "unknown_duration",
				certainty: "inferred",
				confidence: 0.8,
				zero_condition: "低交互或信息缺失",
			},
		],
		expectedScore: 0,
	},
	{
		name: "混合窗口相加后封顶",
		contributions: [
			{
				relevance: "direct",
				evidence: "strong_cross",
				duration: "at_least_120_seconds",
				certainty: "confirmed",
				confidence: 0.9,
			},
			{
				relevance: "supporting",
				evidence: "strong_cross",
				duration: "at_least_120_seconds",
				certainty: "confirmed",
				confidence: 0.6,
			},
			{
				relevance: "direct",
				evidence: "strong_cross",
				duration: "at_least_120_seconds",
				certainty: "confirmed",
				confidence: 0.9,
			},
		],
		expectedScore: 1,
	},
] as const;

export const activityReflectionScoreFormula = [
	"评分对象是一个封闭窗口内的语义活动事件。先分别计算每个可计分事件，再把贡献相加；不要按原始观察条数、应用数量或输入次数直接给分。",
	"事件贡献 = 相关性系数 × 证据系数 × 时长系数 × 置信度系数。窗口 score = min(1, 所有事件贡献之和)，并四舍五入到两位小数。",
	"相关性系数：direct 为 1.00；supporting 为 0.60；unrelated 与 uncertain 为 0。没有当前目标时所有事件都为 0。",
	"证据系数：强交叉证据为 1.00；受支持证据为 0.70；只有单一弱观察为 0。强交叉证据必须有至少两类独立、相互支持的信号，且至少一类能说明具体活动。",
	"时长系数：持续至少 120 秒为 1.00；30 到 119 秒为 0.75；少于 30 秒或无法确认时间为 0.50。",
	"置信度系数：确定事件取 confidence；推测事件取 min(confidence, 0.85)；不确定事件固定为 0。",
	"状态事件、idle_transition、other_unknown、低交互、信息缺失、证据矛盾、敏感支付、账户、结算和金融交易固定为 0；普通商品比较只有目标直接相关且证据充分时才可计分。",
	"score 是本地累加贡献，不是是否立即调用下一步 Agent 的命令。客户端只会累计你返回的 [0,1] 分数。",
] as const;

export const activityReflectionScoreEvidenceRules = [
	"强交叉证据示例：文档修改加持续输入；游戏上下文加持续操作；同一工作流中的编辑、输入和资料查阅。",
	"受支持证据示例：存在活动特定的文档、控件或页面变化，并有连续性或有限交互支持，但缺少第二类直接证据。",
	"弱证据示例：只有前台切换、标签导航、输入统计、低交互、未知应用或相互矛盾的信息。弱证据不得累计分数。",
	"多段事件必须先按活动 Skill 合并；同一连续活动不能拆成多段来人为提高总分。",
] as const;

export const activityReflectionScoreExamples = [
	"示例一：目标直接相关、持续 3 分钟、强交叉证据、推测、confidence=0.85 → 1.00 × 1.00 × 1.00 × 0.85 = 0.85。",
	"示例二：支持目标、持续 90 秒、强交叉证据、推测、confidence=0.75 → 0.60 × 1.00 × 0.75 × 0.75 = 0.34。",
	"示例三：目标直接相关、持续 20 秒、受支持证据、推测、confidence=0.60 → 1.00 × 0.70 × 0.50 × 0.60 = 0.21。",
	"示例四：锁屏、暂离、睡眠、未知活动、敏感结算或没有目标 → 0。",
	"示例五：两段有效活动的贡献相加后超过 1 时，窗口 score 只能返回 1.00。",
] as const;

export const activityReflectionScoreSelfChecks = [
	"提交 JSON 前自检一：score 必须是 0 到 1 的两位小数；events 为空时 score 必须为 0。",
	"提交 JSON 前自检二：先判断目标是否存在，再判断 goal_relevance、证据强度、时长和置信度；其中任一零分条件成立时，该事件贡献为 0。",
	"提交 JSON 前自检三：score_reason 必须是简短中文，说明目标相关性、证据强度、持续时长和最终分数；不得包含应用名、文档内容、URL、联系人、账号或原始字段。",
	"提交 JSON 前自检四：不得给状态事件、未知活动、低交互、敏感交易或不确定事件分数，也不得为了达到阈值而抬高 confidence 或拆分连续活动。",
] as const;
