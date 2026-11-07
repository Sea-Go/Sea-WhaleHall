/**
 * Dynamic Planning 语义分析降级梯的单一事实源。
 *
 * 首轮带网关调研工具、输出硬上限 16k token、≤450s（2026-11-03/04 实测健康
 * 分析需 200-410s、思考 49-67KB 文本；450s 仍小于 DC 工具环单轮 8 分钟预算，
 * 也小于 Bun 侧 620s RPC 兜底）；超时后去工具裸跑、8k token、≤150s；再超时
 * 落可重试诊断。真失控思考不靠时限兜底，由网关 512KB 文本护栏（≈健康思考
 * 8 倍）在服务端截断。数值改动会改变线上行为与预算承诺（总占用 ≤10 分钟），
 * 必须同步更新 tests/planning-analysis-policy.test.ts。
 */
export interface PlanningAnalysisAttemptPolicy {
	/** 是否暴露网关调研工具（zhipu.*）；降级轮必须关闭以去掉循环素材。 */
	withTools: boolean;
	/** 该轮输出 token 硬上限；失控循环在配额处必然截断，而不是吐到兜底超时。 */
	maxOutputTokens: number;
	/** 该轮超时上限（与全局 dynamicPlanningAnalysisTimeoutMs 取 min）。 */
	timeoutCapMs: number;
}

export interface PlanningAnalysisPolicy {
	primary: PlanningAnalysisAttemptPolicy;
	degraded: PlanningAnalysisAttemptPolicy;
	/** 网关桥降级时本地兜底 execute 之后的收敛步数。 */
	maxSteps: number;
	structuredErrorStrategy: "warn";
}

export const DEFAULT_PLANNING_ANALYSIS_POLICY: PlanningAnalysisPolicy = {
	primary: {
		withTools: true,
		maxOutputTokens: 16_000,
		timeoutCapMs: 450_000,
	},
	degraded: {
		withTools: false,
		maxOutputTokens: 8_000,
		timeoutCapMs: 150_000,
	},
	maxSteps: 4,
	structuredErrorStrategy: "warn",
};
