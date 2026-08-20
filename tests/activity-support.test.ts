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

	test("keeps the most recent bounded observations when a Worker job spans many windows", () => {
		const baseEvent = workerResult().events[0];
		if (!baseEvent) {
			throw new Error("Expected one Worker event fixture.");
		}
		const analyses = Array.from({ length: 41 }, (_, index) =>
			workerResult({
				request_id: `worker-request-${index}`,
				events: [
					{
						...baseEvent,
						action: "确定：正在进行当前活动",
						activity: index === 40 ? "gaming" : "development",
						goal_relevance: index === 40 ? "unrelated" : "direct",
					},
				],
			}),
		);

		const context = createActivitySupportContext({
			activeGoal: null,
			recentFeedback: [],
			analyses,
		});

		expect(context.observations).toHaveLength(40);
		expect(context.observations.at(-1)).toEqual({
			activity: "gaming",
			goalRelation: "unrelated",
			evidenceStrength: "strong",
			signals: ["goal_unrelated"],
		});
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
		test(`recognizes scoring language: ${message}`, () => {
			expect(containsScoringLanguage(message)).toBe(true);
		});
	}
});

describe("activity support context exact validation", () => {
	test("accepts its own bounded projection", () => {
		const context = validContext();
		expect(context.schemaVersion).toBe(ACTIVITY_SUPPORT_CONTEXT_SCHEMA_VERSION);
		expect(isActivitySupportContext(context)).toBe(true);
	});

	test("rejects missing or unknown top-level fields", () => {
		const context = validContext();
		const { observations: _observations, ...missingObservations } = context;
		expect(isActivitySupportContext(missingObservations)).toBe(false);
		expect(
			isActivitySupportContext({ ...context, unexpected: "must-reject" }),
		).toBe(false);
		expect(
			isActivitySupportContext({
				...context,
				schemaVersion: "activity-support-context.v0",
			}),
		).toBe(false);
	});

	test("rejects malformed observations and untrusted recent approaches", () => {
		const context = validContext();
		const observation = context.observations[0];
		if (!observation) {
			throw new Error("Expected one valid support observation.");
		}

		expect(
			isActivitySupportContext({
				...context,
				observations: [{ ...observation, freeText: "must-reject" }],
			}),
		).toBe(false);
		expect(
			isActivitySupportContext({
				...context,
				observations: [{ ...observation, evidenceStrength: "certain" }],
			}),
		).toBe(false);
		expect(isActivitySupportContext({ ...context, observations: [] })).toBe(
			false,
		);
		expect(
			isActivitySupportContext({
				...context,
				recentApproaches: ["unknown_approach"],
			}),
		).toBe(false);
		expect(
			isActivitySupportContext({
				...context,
				observations: [{ ...observation, activity: "客户张三的项目" }],
			}),
		).toBe(false);
		expect(
			isActivitySupportContext({
				...context,
				observations: [
					{
						...observation,
						goalRelation: "score_reason",
					},
				],
			}),
		).toBe(false);
		expect(
			isActivitySupportContext({
				...context,
				activeGoal: "包含控制字符\u0007",
			}),
		).toBe(false);
	});
});

describe("activity support output firewall", () => {
	test("accepts bounded, plain Chinese support text", () => {
		expect(
			isSafeActivitySupportMessage(
				"看起来你正在稳步推进。要不要先记下一个最小的下一步？",
			),
		).toBe(true);
	});

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
		test(`rejects ${label}`, () => {
			expect(isSafeActivitySupportMessage(message)).toBe(false);
		});
	}

	test("allows duration language and a genuinely conditional blocker phrase", () => {
		expect(
			isSafeActivitySupportMessage("可以先休息 5 分钟，再决定下一步。"),
		).toBe(true);
		expect(
			isSafeActivitySupportMessage(
				"如果这里确实有点卡住，可以先写下一个最小未知点。",
			),
		).toBe(true);
	});
});

describe("activity support deterministic routing", () => {
	test("maps every declared route to one fixed specialist", () => {
		const expected = [
			["momentum", "momentumCoach"],
			["possible_blocker", "blockerCoach"],
			["attention_drift", "focusCoach"],
			["recovery", "recoveryCompanion"],
			["gentle_check_in", "checkInCompanion"],
		] as const satisfies readonly (readonly [ActivitySupportRoute, string])[];
		for (const [route, specialist] of expected) {
			expect(specialistKeyForRoute(route)).toBe(specialist);
		}
	});

	test("downgrades unsupported blocker, recovery, and drift claims to a gentle check-in", () => {
		const context = validContext();
		for (const route of [
			"possible_blocker",
			"recovery",
			"attention_drift",
		] as const) {
			expect(
				guardActivitySupportAssessment(context, {
					route,
					certainty: "high",
					situation: "模型作出的过度判断",
					userNeed: "模型声称需要对应帮助",
				}),
			).toEqual({
				route: "gentle_check_in",
				certainty: "low",
				situation: "现有线索不足以判断用户此刻的具体状态",
				userNeed: "用不打扰的方式让用户自己选择需要的帮助",
			});
		}
	});

	test("permits only evidence-backed blocker, recovery, and unrelated routes", () => {
		const cases = [
			{
				route: "possible_blocker" as const,
				goalRelation: "direct",
				signals: ["goal_progress", "possible_blocker"] as const,
			},
			{
				route: "recovery" as const,
				goalRelation: "uncertain",
				signals: ["recovery"] as const,
			},
			{
				route: "attention_drift" as const,
				goalRelation: "unrelated",
				signals: ["goal_unrelated"] as const,
			},
		] as const;
		for (const item of cases) {
			const assessment = {
				route: item.route,
				certainty: "high" as const,
				situation: "存在与路由匹配的明确线索",
				userNeed: "提供对应且保留选择权的帮助",
			};
			const guarded = guardActivitySupportAssessment(
				{
					...validContext(),
					observations: [
						{
							activity: "other_unknown",
							goalRelation: item.goalRelation,
							evidenceStrength: "strong",
							signals: item.signals,
						},
					],
				},
				assessment,
			);
			expect(guarded.route).toBe(item.route);
		}
	});

	test("never treats an inconclusive inability-to-judge observation as a blocker", () => {
		const guarded = guardActivitySupportAssessment(
			{
				...validContext(),
				observations: [
					{
						activity: "other_unknown",
						goalRelation: "direct",
						evidenceStrength: "strong",
						signals: ["uncertain"],
					},
				],
			},
			{
				route: "possible_blocker",
				certainty: "high",
				situation: "用户明显卡住",
				userNeed: "立刻干预",
			},
		);
		expect(guarded).toEqual({
			route: "gentle_check_in",
			certainty: "low",
			situation: "现有线索不足以判断用户此刻的具体状态",
			userNeed: "用不打扰的方式让用户自己选择需要的帮助",
		});
	});

	test("replaces model-authored labels with a canonical evidence-bounded assessment", () => {
		const guarded = guardActivitySupportAssessment(validContext(), {
			route: "momentum",
			certainty: "high",
			situation: "用户就是在摸鱼后突然努力",
			userNeed: "批评用户并制造压力",
		});
		expect(guarded).toEqual({
			route: "momentum",
			certainty: "high",
			situation: "现有线索显示用户正在推进目标相关的事情",
			userNeed: "保护当前势头并提供一个可选择的最小下一步",
		});
	});

	test("caps model certainty at the local evidence band", () => {
		const guarded = guardActivitySupportAssessment(
			{
				...validContext(),
				observations: [
					{
						activity: "development",
						goalRelation: "direct",
						evidenceStrength: "moderate",
						signals: ["goal_progress"],
					},
				],
			},
			{
				route: "momentum",
				certainty: "high",
				situation: "有目标相关推进",
				userNeed: "保护当前节奏",
			},
		);
		expect(guarded.certainty).toBe("medium");
	});

	test("keeps every deterministic fallback brief and message inside the output firewall", () => {
		for (const route of [
			"momentum",
			"possible_blocker",
			"attention_drift",
			"recovery",
			"gentle_check_in",
		] as const) {
			expect(
				isSafeActivitySupportBrief(fallbackActivitySupportBrief(route)),
			).toBe(true);
			expect(
				isSafeActivitySupportMessage(fallbackActivitySupportMessage(route)),
			).toBe(true);
		}
		expect(
			isSafeActivitySupportBrief({
				acknowledgement: "你的得分很高",
				suggestion: "继续做下去",
				question: null,
			}),
		).toBe(false);
	});
});
