import { describe, expect, test } from "bun:test";
import {
	assertPlanningModelOutputForRequest,
	assertPlanningPlan,
	buildDeterministicSevenDaySchedule,
	type CalendarChangeSet,
	canAutomaticallyMutateCalendarEvent,
	effectivePlanStartDate,
	InMemoryPlanningCalendar,
	isPlanningModelOutput,
	isPlanningPlan,
	localDateTimeToInstant,
	PLANNING_MODEL_OUTPUT_SCHEMA,
	type PlanningCalendarEvent,
	type PlanningModelAnalysisRequest,
	type PlanningModelProposal,
	type PlanningPlan,
	PlanningPlanValidationError,
	planningModelInputProjection,
	rollingSevenDayWindow,
} from "../src/agent/planning";

function validProposal(): PlanningModelProposal {
	return {
		outcome: "proposal",
		recommendedType: "fuzzy",
		rationaleSummary: "路径需要先验证。",
		assumptions: ["每周容量已经由用户确认。"],
		clarificationQuestions: [],
		assistantMessage: "先执行七天验证任务，再动态修正预计日期。",
		goal: "验证一个长期收入方向",
		estimatedCompletionDate: "2036-08-13",
		confidence: 0.4,
		estimateBasis: "当前只有方向性证据，因此使用低置信度日期。",
		schedulingPreferenceSource: "user-provided",
		schedulingPreferences: {
			weeklyCapacityMinutes: 120,
			sessionMinutes: 60,
			availableWindows: [
				{ dayOfWeek: 6, startTime: "09:00", endTime: "11:00" },
			],
		},
		tasks: [
			{
				taskKey: "validate-market",
				purpose: "validation",
				title: "验证需求",
				description: "完成一次小规模访谈。",
				estimatedMinutes: 60,
				dependencyKeys: [],
				relevance: "strong",
				relevanceReason: "关键路径任务",
			},
			{
				taskKey: "review-market",
				purpose: "review",
				title: "复盘验证结果",
				description: "决定是否继续当前方向。",
				estimatedMinutes: 60,
				dependencyKeys: ["validate-market"],
				relevance: "strong",
				relevanceReason: "关键路径任务",
			},
		],
		evaluations: [
			{ angle: "goal-alignment", verdict: "pass", summary: "任务与目标对齐。", affectedTaskKeys: [] },
			{ angle: "time-feasibility", verdict: "pass", summary: "容量足够。", affectedTaskKeys: [] },
			{ angle: "dependency-risk", verdict: "pass", summary: "依赖链清晰。", affectedTaskKeys: [] },
			{ angle: "load-recovery", verdict: "pass", summary: "负荷分布均衡。", affectedTaskKeys: [] },
			{ angle: "evidence-sufficiency", verdict: "pass", summary: "关键约束已确认。", affectedTaskKeys: [] },
		],
	};
}

function modelRequest(): PlanningModelAnalysisRequest {
	return {
		planId: "plan-1",
		analysisMode: "manual-proposal",
		currentGoal: "验证一个长期收入方向",
		currentType: null,
		trigger: "initial-analysis",
		effectiveWindow: {
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-21",
			timeZone: "Asia/Shanghai",
		},
		messages: [],
		currentTasks: [],
		currentEstimate: null,
		currentSchedulingPreferences: null,
		observationEvidence: [],
		calendarEvents: [],
		memoryHints: null,
	};
}

function draftPlan(): PlanningPlan {
	return {
		id: "plan-1",
		goal: "验证一个长期收入方向",
		requestedStartToday: false,
		timeZone: "Asia/Shanghai",
		effectiveStartDate: null,
		type: null,
		status: "draft",
		analysisState: "awaiting-analysis",
		analysisDiagnostic: null,
		pendingAnalysis: null,
		autoAdjustAuthorized: false,
		version: 1,
		createdAt: "2026-08-13T02:00:00Z",
		updatedAt: "2026-08-13T02:00:00Z",
		activeRevisionId: null,
		proposedRevisionId: null,
		revisions: [],
		estimates: [],
		tasks: [],
		messages: [],
		observationEvidence: [],
		pendingObservationAttributions: [],
		adjustments: [],
		dailySummaryDates: [],
	};
}

describe("planning structured model boundary", () => {
	test("requires low-confidence fuzzy output and explicit scheduling preferences", () => {
		const proposal = validProposal();
		expect(isPlanningModelOutput(proposal)).toBeTrue();
		expect(isPlanningModelOutput({ ...proposal, confidence: 0.8 })).toBeFalse();
		const { schedulingPreferences: _missing, ...withoutPreferences } = proposal;
		expect(isPlanningModelOutput(withoutPreferences)).toBeFalse();
		expect(
			isPlanningModelOutput({
				...proposal,
				tasks: proposal.tasks.filter((task) => task.purpose !== "review"),
			}),
		).toBeFalse();
		expect(
			isPlanningModelOutput({
				outcome: "needs-clarification",
				recommendedType: "fuzzy",
				rationaleSummary: "还缺少容量。",
				assumptions: [],
				clarificationQuestions: ["每周可投入多少分钟？"],
				assistantMessage: "请补充容量。",
			}),
		).toBeTrue();
		expect(
			isPlanningModelOutput({
				outcome: "needs-clarification",
				recommendedType: "fuzzy",
				rationaleSummary: "还缺少容量。",
				assumptions: [],
				clarificationQuestions: ["   "],
				assistantMessage: "请补充容量。",
			}),
		).toBeFalse();
	});

	test("requires automatic analysis to reuse the exact confirmed scheduling preferences", () => {
		const preferences = validProposal().schedulingPreferences;
		const request: PlanningModelAnalysisRequest = {
			...modelRequest(),
			analysisMode: "automatic-adjustment",
			trigger: "daily-summary",
			currentSchedulingPreferences: preferences,
		};
		const reused = {
			...validProposal(),
			schedulingPreferenceSource: "confirmed-reuse" as const,
			schedulingPreferences: preferences,
		};
		expect(() =>
			assertPlanningModelOutputForRequest(reused, request),
		).not.toThrow();
		expect(() =>
			assertPlanningModelOutputForRequest(
				{
					...reused,
					schedulingPreferences: {
						...preferences,
						weeklyCapacityMinutes: 180,
					},
				},
				request,
			),
		).toThrow();
		expect(() =>
			assertPlanningModelOutputForRequest(
				{ ...reused, schedulingPreferenceSource: "user-provided" },
				request,
			),
		).toThrow();
	});

	test("uses a provider-compatible steering schema while strict validation rejects bad formats", () => {
		expect(JSON.stringify(PLANNING_MODEL_OUTPUT_SCHEMA)).not.toContain(
			'"pattern"',
		);
		const proposal = validProposal();
		expect(
			isPlanningModelOutput({
				...proposal,
				estimatedCompletionDate: "2036/08/13",
			}),
		).toBeFalse();
		expect(
			isPlanningModelOutput({
				...proposal,
				tasks: [
					{ ...proposal.tasks[0], taskKey: "bad key" },
					proposal.tasks[1],
				],
			}),
		).toBeFalse();
		expect(
			isPlanningModelOutput({
				...proposal,
				schedulingPreferences: {
					...proposal.schedulingPreferences,
					availableWindows: [
						{ dayOfWeek: 6, startTime: "9am", endTime: "11:00" },
					],
				},
			}),
		).toBeFalse();
	});

});

describe("planning deterministic time and mutation rules", () => {




});

describe("planning persistence payload validation", () => {
});
