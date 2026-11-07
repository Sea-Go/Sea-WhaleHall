import { describe, expect, test } from "bun:test";
import {
	type ActivitySupportRoute,
	fallbackActivitySupportBrief,
	fallbackActivitySupportMessage,
	guardActivitySupportAssessment,
	isSafeActivitySupportBrief,
	isSafeActivitySupportMessage,
	specialistKeyForRoute,
} from "../src/agent/mastra-host/activity-support-team";
import type { ActivityAnalysisWorkerResult } from "../src/shared/activity-analysis-contract";
import {
	ACTIVITY_SUPPORT_CONTEXT_SCHEMA_VERSION,
	containsScoringLanguage,
	createActivitySupportContext,
	isActivitySupportContext,
	MAXIMUM_ACTIVITY_SUPPORT_RECENT_APPROACHES,
} from "../src/shared/activity-support";
import type { ProactiveFeedbackItem } from "../src/shared/proactive-feedback";

function workerResult(
	overrides: Partial<ActivityAnalysisWorkerResult> = {},
): ActivityAnalysisWorkerResult {
	return {
		request_id: "worker-request-default",
		score: 0.72,
		score_reason: "内部触发理由",
		events: [
			{
				source_event_ids: ["source-window-default"],
				time: "09:00–09:05",
				action: "确定：正在编写测试",
				activity: "development",
				goal_relevance: "direct",
				confidence: 0.91,
				reason_codes: ["internal-reason"],
				evidence: ["internal-evidence"],
				started_at_ms: 1_700_000_000_000,
				ended_at_ms: 1_700_000_300_000,
			},
		],
		...overrides,
	};
}

function feedback(id: string, message: string): ProactiveFeedbackItem {
	return { id, generatedAtMs: 1_700_000_000_000, message };
}

function validContext() {
	return createActivitySupportContext({
		activeGoal: {
			schemaVersion: "active-goal.v1",
			goalId: "goal-current",
			planId: "plan-current",
			version: 1,
			text: "完成活动关怀团队",
			activatedAtMs: 1_700_000_000_000,
		},
		recentFeedback: [],
		analyses: [workerResult()],
	});
}

describe("activity support context privacy boundary", () => {
	test("projects only support-safe observation fields and omits scores, IDs, evidence, and time", () => {
		const context = createActivitySupportContext({
			activeGoal: {
				schemaVersion: "active-goal.v1",
				goalId: "goal-id-must-not-cross",
				planId: "plan-id-must-not-cross",
				version: 1,
				text: "完成活动关怀团队",
				activatedAtMs: 1_700_000_000_000,
			},
			recentFeedback: [],
			analyses: [
				workerResult({
					request_id: "worker-request-id-must-not-cross",
					score: 0.91,
					score_reason: "score-reason-must-not-cross",
					events: [
						{
							source_event_ids: ["source-event-id-must-not-cross"],
							time: "2026-08-19 09:00–09:05-must-not-cross",
							action: "确定：得分 0.9 并编写测试",
							activity: "development",
							goal_relevance: "direct",
							confidence: 0.91,
							reason_codes: ["reason-code-must-not-cross"],
							evidence: ["evidence-must-not-cross"],
							started_at_ms: 1_700_000_000_000,
							ended_at_ms: 1_700_000_300_000,
						},
					],
				}),
			],
		});

		expect(context.observations).toEqual([
			{
				activity: "development",
				goalRelation: "direct",
				evidenceStrength: "strong",
				signals: ["goal_progress"],
			},
		]);

		const serialized = JSON.stringify(context);
		for (const forbidden of [
			"worker-request-id-must-not-cross",
			"source-event-id-must-not-cross",
			"score-reason-must-not-cross",
			"reason-code-must-not-cross",
			"evidence-must-not-cross",
			"2026-08-19 09:00–09:05-must-not-cross",
			"1700000000000",
			"1700000300000",
			"0.91",
			'"score"',
			'"score_reason"',
			'"confidence"',
			'"source_event_ids"',
			'"reason_codes"',
			'"evidence"',
			'"started_at_ms"',
			'"ended_at_ms"',
			'"time"',
			"编写测试",
			"得分",
		]) {
			expect(serialized, forbidden).not.toContain(forbidden);
		}
	});

	test("projects recent feedback into bounded approach enums without forwarding its text", () => {
		const context = createActivitySupportContext({
			activeGoal: null,
			recentFeedback: [
				feedback("feedback-breakdown", "可以先验证最不确定的一点。"),
				feedback("feedback-scored", "这次得分很高，不应作为上下文。"),
				feedback(
					"feedback-private",
					"客户张三，订单 ID 8472，文件 /secret/path。",
				),
				feedback("feedback-rest", "可以先歇一下，再慢慢恢复。"),
				feedback("feedback-over-cap", "准备好后再回到原来的任务。"),
			],
			analyses: [workerResult()],
		});

		expect(context.recentApproaches).toEqual([
			"problem_breakdown",
			"rest_and_resume",
		]);
		expect(context.recentApproaches).toHaveLength(
			MAXIMUM_ACTIVITY_SUPPORT_RECENT_APPROACHES,
		);
		const serialized = JSON.stringify(context);
		expect(serialized).not.toMatch(/(?:张三|8472|secret|path|得分)/u);
	});

	test("maps free-form Worker text to allowlisted signals without forwarding it", () => {
		const baseEvent = workerResult().events[0];
		if (!baseEvent) {
			throw new Error("Expected one Worker event fixture.");
		}
		const context = createActivitySupportContext({
			activeGoal: null,
			recentFeedback: [],
			analyses: [
				workerResult({
					events: [
						{
							...baseEvent,
							action: "推测：正在联系张三，账号 ABC123，并反复排查报错",
							activity: "客户张三的项目",
							goal_relevance: "direct",
						},
					],
				}),
			],
		});

		expect(context.observations).toEqual([
			{
				activity: "other_unknown",
				goalRelation: "direct",
				evidenceStrength: "strong",
				signals: ["goal_progress", "possible_blocker"],
			},
		]);
		expect(JSON.stringify(context)).not.toMatch(/(?:张三|ABC123|联系|报错)/u);
	});


	for (const message of [
		"包含分数的历史消息",
		"包含评分的历史消息",
		"包含得分的历史消息",
		"包含贡献度的历史消息",
		"包含置信度的历史消息",
		"包含证据强度的历史消息",
		"这次是 90 分",
		"这次是九十分，继续",
		"这次表现满分",
		"contains SCORE metadata",
		"contains consumedScore metadata",
	]) {
	}
});

describe("activity support context exact validation", () => {


});

describe("activity support output firewall", () => {

	for (const [label, message] of [
		["scoring terminology", "这次得分很好，继续加油。"],
		["internal Agent label", "Agent 建议你继续。"],
		["machine certainty label", "确定：你已经完成任务。"],
		["raw internal field", "goal_relevance 显示你在推进。"],
		["URL", "请查看 https://example.test/next。"],
		["HTML", "<strong>继续加油</strong>"],
		["code fence", "```\n继续加油\n```"],
		["list markdown", "- 继续当前任务"],
		["bold markdown", "**继续加油**"],
		["bare percentage", "你已经有 90% 的把握了。"],
		["numeric score", "这次是 90 分，继续。"],
		["Chinese-numeral score", "这次是九十分，继续。"],
		["full-score language", "这次表现满分，继续。"],
		["shaming label", "你就是在摸鱼，赶紧回来。"],
		["unsupported blocker claim", "用户明显卡住了，应该立刻换方案。"],
		["unsupported fatigue claim", "你已经疲劳，需要马上停下。"],
		["soft blocker diagnosis", "看起来你有点卡住了。"],
		["tentative fatigue diagnosis", "你可能疲劳了。"],
		["implicit fatigue diagnosis", "你似乎很累。"],
		["soft fatigue diagnosis", "看起来你有点累。"],
		["fatigue synonym diagnosis", "你似乎精疲力竭。"],
		["implicit blocker diagnosis", "看起来有点卡住了。"],
		[
			"mixed conditional and direct blocker claim",
			"如果这里卡住可以拆小，但你已经卡住了。",
		],
		["mixed subjectless blocker claim", "如果卡住可以拆小，但当前卡住了。"],
		[
			"mixed subjectless blocker clauses",
			"若卡点可以记录下来。不过看来卡点已经出现。",
		],
		["prescriptive rest claim", "你应该马上休息。"],
		["emoji", "继续加油🙂"],
	] as const) {
	}

});

describe("activity support deterministic routing", () => {






});
