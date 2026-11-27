import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { activityReflectionAnalysisDimensions } from "../src/agent/activity-reflection-analysis-skill";
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
				"有目标但相关性不确定按支持目标计",
				"相关性不确定不放宽未知与不确定表述",
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

	test("counts work whose relation to the goal is uncertain as support", () => {
		// A goal of pending tasks must not silence every other kind of work.
		expect(activityReflectionScoreRuleSet.relevance.uncertain).toBe(0.6);
		expect(activityReflectionScoreRuleSet.relevance.unrelated).toBe(0);
		const formula = activityReflectionScoreFormula.join("\n");
		expect(formula).toContain("supporting 与 uncertain 为 0.60");
		expect(formula).not.toContain("unrelated 与 uncertain 为 0");
		expect(activityReflectionScoreExamples.join("\n")).toContain(
			"0.60 × 1.00 × 1.00 × 0.70 = 0.42",
		);
		// Only the relevance factor gives way: an activity the reflection
		// cannot name, weak evidence and state events still score zero.
		expect(activityReflectionScoreSelfChecks.join("\n")).toContain(
			"以“不确定：”开头的事件分数",
		);

		const skillRoot = resolve(import.meta.dir, "../src/agent/skills");
		for (const relative of [
			"activity-reflection-scoring/SKILL.md",
			"activity-reflection-scoring/references/scoring-rules.md",
			"activity-reflection-scoring/references/evaluation-matrix.md",
		]) {
			const text = readFileSync(resolve(skillRoot, relative), "utf8");
			expect(text, relative).toContain("uncertain=0.60");
			expect(text, relative).not.toContain("unrelated/uncertain=0");
			expect(text, relative).not.toContain("`unrelated=0`；`uncertain=0`");
			expect(text, relative).not.toContain("unrelated/uncertain`");
		}
		const scoring = readFileSync(
			resolve(skillRoot, "activity-reflection-scoring/SKILL.md"),
			"utf8",
		);
		expect(scoring).toContain("活动本身无法确定");
	});

	test("keeps the two Skill bodies self-contained for a model without tools", () => {
		const skillRoot = resolve(import.meta.dir, "../src/agent/skills");
		const scoring = readFileSync(
			resolve(skillRoot, "activity-reflection-scoring/SKILL.md"),
			"utf8",
		);
		const analysis = readFileSync(
			resolve(skillRoot, "activity-reflection-analysis/SKILL.md"),
			"utf8",
		);

		// The reflection agent has no tools: a pointer to a file it cannot
		// open only misleads it.
		expect(scoring).not.toContain("references/");
		expect(analysis).not.toContain("references/");

		// The evidence tier is the one factor a no-goal score still leaves open.
		expect(scoring).toContain("强交叉 `1.00`");
		expect(scoring).toContain("受支持 `0.70`");
		expect(scoring).toContain("单一弱观察 `0`");
		expect(scoring).toContain("至少两类独立且相互支持的信号");

		const dimensions = activityReflectionAnalysisDimensions.join("\n");
		expect(analysis).toContain("没有当前目标时不判断相关性");
		expect(dimensions).toContain("没有当前目标时不判断目标相关性");
		expect(dimensions).not.toContain("只由当前目标相关");

		// The label stays honest; only the scoring decides what it is worth.
		expect(analysis).toContain("`uncertain` 是活动明确");
		expect(analysis).toContain("拿不准时如实填 `uncertain`");
		expect(dimensions).toContain("与目标的关系无法确认也照常计分");
	});
});
