import { describe, expect, test } from "bun:test";
import { DEFAULT_PLANNING_ANALYSIS_POLICY } from "../src/agent/mastra-host/planning-analysis-policy";

/**
 * 降级梯数值契约测试：这些值就是线上行为（首轮带工具 16k/450s → 降级裸跑
 * 8k/150s → 可重试诊断）。改动任何一项都会改变总占用预算（≤10 分钟）与
 * 失控收敛路径，必须是有意识的产品/运维决策，不能随手调参。
 */
describe("DEFAULT_PLANNING_ANALYSIS_POLICY", () => {
	test("primary attempt keeps gateway research tools with a 16k output cap", () => {
		expect(DEFAULT_PLANNING_ANALYSIS_POLICY.primary).toEqual({
			withTools: true,
			maxOutputTokens: 16_000,
			timeoutCapMs: 450_000,
		});
	});

	test("degraded attempt runs tool-free with an 8k output cap", () => {
		expect(DEFAULT_PLANNING_ANALYSIS_POLICY.degraded).toEqual({
			withTools: false,
			maxOutputTokens: 8_000,
			timeoutCapMs: 150_000,
		});
	});

	test("convergence budget stays within the documented 10-minute ceiling", () => {
		const { primary, degraded } = DEFAULT_PLANNING_ANALYSIS_POLICY;
		expect(primary.timeoutCapMs + degraded.timeoutCapMs).toBeLessThanOrEqual(
			10 * 60_000,
		);
	});

	test("structured output tolerates provider shape drift for app-side classification", () => {
		expect(DEFAULT_PLANNING_ANALYSIS_POLICY.structuredErrorStrategy).toBe(
			"warn",
		);
		expect(DEFAULT_PLANNING_ANALYSIS_POLICY.maxSteps).toBe(4);
	});
});
