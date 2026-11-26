import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type ActivityReflectionScoreCalibrationCase,
	activityReflectionScoreCalibrationCases,
	activityReflectionScoreExamples,
	activityReflectionScoreFormula,
	activityReflectionScoreRuleSet,
	activityReflectionScoreSelfChecks,
} from "../src/agent/activity-reflection-score-skill";

function calibratedScore(
	caseDefinition: ActivityReflectionScoreCalibrationCase,
): number {
	const total = caseDefinition.contributions.reduce((sum, contribution) => {
		if (contribution.zero_condition !== undefined) return sum;
		const relevance =
			activityReflectionScoreRuleSet.relevance[contribution.relevance];
		const evidence =
			activityReflectionScoreRuleSet.evidence[contribution.evidence];
		const duration =
			activityReflectionScoreRuleSet.duration[contribution.duration];
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
				"无目标有效活动按支持目标计",
				"无目标下敏感、状态与未知活动固定为零",
				"状态、敏感交易与低交互固定为零",
				"混合窗口相加后封顶",
			]),
		);
	});

	test("states the no-goal rule in the formula, the examples and the Skill text", () => {
		const noGoalRule = "没有当前目标时不按目标过滤";
		expect(activityReflectionScoreFormula.join("\n")).toContain(noGoalRule);
		expect(activityReflectionScoreFormula.join("\n")).not.toContain(
			"没有当前目标时所有事件都为 0",
		);
		expect(activityReflectionScoreExamples.join("\n")).toContain(
			"没有当前目标、持续 3 分钟、强交叉证据",
		);
		expect(activityReflectionScoreSelfChecks.join("\n")).toContain(
			"没有当前目标时判断是否属于持续、可核对的有效活动",
		);

		const skillRoot = resolve(import.meta.dir, "../src/agent/skills");
		for (const relative of [
			"activity-reflection-scoring/SKILL.md",
			"activity-reflection-scoring/references/scoring-rules.md",
			"activity-reflection-scoring/references/evaluation-matrix.md",
		]) {
			const text = readFileSync(resolve(skillRoot, relative), "utf8");
			expect(text, relative).toContain(noGoalRule);
			expect(text, relative).not.toContain("无当前目标为 `0`");
			expect(text, relative).not.toContain("无当前目标时一律为 `0`");
		}
	});
});
