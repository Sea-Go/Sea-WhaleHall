import { describe, expect, test } from "bun:test";
import {
	activityReflectionScoreCalibrationCases,
	activityReflectionScoreRuleSet,
	type ActivityReflectionScoreCalibrationCase,
} from "../src/agent/activity-reflection-score-skill";

function calibratedScore(caseDefinition: ActivityReflectionScoreCalibrationCase): number {
	const total = caseDefinition.contributions.reduce((sum, contribution) => {
		if (contribution.zero_condition !== undefined) return sum;
		const relevance = activityReflectionScoreRuleSet.relevance[contribution.relevance];
		const evidence = activityReflectionScoreRuleSet.evidence[contribution.evidence];
		const duration = activityReflectionScoreRuleSet.duration[contribution.duration];
		const confidence =
			contribution.certainty === "confirmed"
				? contribution.confidence
				: contribution.certainty === "inferred"
					? Math.min(
							contribution.confidence,
							activityReflectionScoreRuleSet.confidence.inferred_cap,
						)
					: activityReflectionScoreRuleSet.confidence.uncertain;
		return sum + relevance * evidence * duration * confidence;
	}, 0);
	const rounded = Number(
		total.toFixed(activityReflectionScoreRuleSet.decimalPlaces),
	);
	return Math.min(activityReflectionScoreRuleSet.windowMaximum, rounded);
}

describe("activity reflection scoring Skill", () => {
	test("keeps every published scoring calibration case internally consistent", () => {
		for (const caseDefinition of activityReflectionScoreCalibrationCases) {
			expect(calibratedScore(caseDefinition), caseDefinition.name).toBe(
				caseDefinition.expectedScore,
			);
		}
	});

	test("covers relevance, evidence, duration, certainty, zero conditions, and capped mixed windows", () => {
		const names = activityReflectionScoreCalibrationCases.map(
			(caseDefinition) => caseDefinition.name,
		);
		expect(names).toEqual(
			expect.arrayContaining([
				"直接相关、强交叉证据、三分钟、推测",
				"支持目标、强交叉证据、九十秒、推测",
				"直接相关、受支持证据、二十秒、推测",
				"确定事件使用原始置信度",
				"无关活动固定为零",
				"相关性不确定固定为零",
				"不确定表述固定为零",
				"弱证据固定为零",
				"无目标固定为零",
				"状态、敏感交易与低交互固定为零",
				"混合窗口相加后封顶",
			]),
		);
	});
});
