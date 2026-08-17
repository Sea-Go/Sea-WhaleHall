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
			},
			{
				taskKey: "review-market",
				purpose: "review",
				title: "复盘验证结果",
				description: "决定是否继续当前方向。",
				estimatedMinutes: 60,
				dependencyKeys: ["validate-market"],
			},
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

	test("projects only the bounded semantic context for the remote Mastra call", () => {
		const projected = planningModelInputProjection({
			...modelRequest(),
			messages: [
				{
					id: "message-secret-id",
					planId: "plan-1",
					role: "user",
					content: "验证需求",
					createdAt: "2026-08-13T02:00:00Z",
					causedByOperationId: "operation-secret-id",
				},
			],
		});
		expect(projected).toMatchObject({
			analysisMode: "manual-proposal",
			conversation: [
				{
					role: "user",
					content: "验证需求",
					createdAt: "2026-08-13T02:00:00Z",
				},
			],
		});
		expect(JSON.stringify(projected)).not.toContain("message-secret-id");
		expect(JSON.stringify(projected)).not.toContain("operation-secret-id");
	});
});

describe("planning deterministic time and mutation rules", () => {
	test("uses named timezones across midnight and DST without plan-level end dates", () => {
		expect(
			effectivePlanStartDate(
				Date.parse("2026-08-13T16:01:00Z"),
				"Asia/Shanghai",
				false,
			),
		).toBe("2026-08-15");
		expect(
			effectivePlanStartDate(
				Date.parse("2026-03-08T06:30:00Z"),
				"America/New_York",
				true,
			),
		).toBe("2026-03-08");
		expect(rollingSevenDayWindow("2026-03-08")).toEqual({
			startDate: "2026-03-08",
			endDateExclusive: "2026-03-15",
		});
		expect(() =>
			localDateTimeToInstant("2026-03-08", "02:30", "America/New_York"),
		).toThrow();
	});

	test("freezes the entire current local date and all user-locked events", () => {
		const event: PlanningCalendarEvent = {
			id: "event-1",
			title: "执行任务",
			kind: "plan",
			state: "committed",
			start: "2026-08-14T05:00:00Z",
			end: "2026-08-14T06:00:00Z",
			timeZone: "Asia/Shanghai",
			planId: "plan-1",
			sourceTaskId: "task-1",
			scheduleOrigin: "model",
			userLocked: false,
			version: 1,
		};
		const today = canAutomaticallyMutateCalendarEvent(event, {
			planId: "plan-1",
			nowMs: Date.parse("2026-08-14T00:00:00Z"),
			planTimeZone: "Asia/Shanghai",
		});
		expect(today).toEqual({ allowed: false, reason: "today-frozen" });
		const locked = canAutomaticallyMutateCalendarEvent(
			{
				...event,
				start: "2026-08-15T05:00:00Z",
				end: "2026-08-15T06:00:00Z",
				userLocked: true,
			},
			{
				planId: "plan-1",
				nowMs: Date.parse("2026-08-14T00:00:00Z"),
				planTimeZone: "Asia/Shanghai",
			},
		);
		expect(locked).toEqual({ allowed: false, reason: "user-locked" });
	});

	test("the deterministic scheduler rejects any window other than seven dates", () => {
		expect(() =>
			buildDeterministicSevenDaySchedule({
				planId: "plan-1",
				timeZone: "Asia/Shanghai",
				window: {
					startDate: "2026-08-14",
					endDateExclusive: "2026-08-22",
				},
				mutableStartDate: "2026-08-14",
				tasks: [],
				taskStates: [],
				preferences: {
					weeklyCapacityMinutes: 60,
					sessionMinutes: 60,
					availableWindows: [
						{ dayOfWeek: 5, startTime: "09:00", endTime: "10:00" },
					],
				},
				busyEvents: [],
				nowMs: Date.parse("2026-08-13T02:00:00Z"),
				createId: () => "schedule-1",
			}),
		).toThrow("exactly seven");
	});

	test("prioritizes fuzzy validation and review over ordinary execution when capacity is scarce", () => {
		const taskStates = (
			[
				["execute", "execution"],
				["review", "review"],
				["validate", "validation"],
			] as const
		).map(([id, purpose]) => ({
			id,
			planId: "plan-1",
			sourceKey: id,
			purpose,
			title: id,
			description: "",
			estimatedMinutes: 60,
			dependencyTaskIds: [],
			status: "pending" as const,
			statusChangedAt: null,
			statusChangedBy: null,
		}));
		const scheduled = buildDeterministicSevenDaySchedule({
			planId: "plan-1",
			timeZone: "Asia/Shanghai",
			window: rollingSevenDayWindow("2026-08-14"),
			mutableStartDate: "2026-08-14",
			tasks: taskStates.map((task) => ({
				taskId: task.id,
				sourceKey: task.sourceKey,
				purpose: task.purpose,
				title: task.title,
				description: task.description,
				estimatedMinutes: task.estimatedMinutes,
				dependencyTaskIds: [],
			})),
			taskStates,
			preferences: {
				weeklyCapacityMinutes: 120,
				sessionMinutes: 60,
				availableWindows: [
					{ dayOfWeek: 5, startTime: "09:00", endTime: "12:00" },
				],
			},
			busyEvents: [],
			nowMs: Date.parse("2026-08-13T02:00:00Z"),
			createId: (() => {
				let id = 0;
				return () => `schedule-${++id}`;
			})(),
		});
		expect(scheduled.schedule.map((item) => item.taskId)).toEqual([
			"validate",
			"review",
		]);
		expect(scheduled.unscheduledTaskIds).toEqual(["execute"]);
	});

	test("calendar change sets are atomic when a proposed event conflicts", async () => {
		const occupied: PlanningCalendarEvent = {
			id: "manual-1",
			title: "手动占用",
			kind: "manual-block",
			state: "committed",
			start: "2026-08-14T01:00:00Z",
			end: "2026-08-14T02:00:00Z",
			timeZone: "Asia/Shanghai",
			planId: null,
			sourceTaskId: null,
			scheduleOrigin: "user",
			userLocked: true,
			version: 1,
		};
		const calendar = new InMemoryPlanningCalendar([occupied]);
		const candidate: PlanningCalendarEvent = {
			...occupied,
			id: "plan-event-1",
			title: "计划任务",
			kind: "plan",
			planId: "plan-1",
			sourceTaskId: "task-1",
			scheduleOrigin: "model",
			userLocked: false,
			version: 1,
		};
		const changeSet: CalendarChangeSet = {
			id: "change-1",
			planId: "plan-1",
			operationId: "calendar-operation-1",
			createdAt: "2026-08-13T02:00:00Z",
			changes: [
				{
					kind: "create",
					eventId: candidate.id,
					expectedVersion: null,
					before: null,
					after: candidate,
				},
			],
		};
		const result = await calendar.applyChangeSet(changeSet);
		expect(result.ok).toBeFalse();
		const events = await calendar.listEvents({
			startDate: "2026-08-14",
			endDateExclusive: "2026-08-15",
			timeZone: "Asia/Shanghai",
		});
		expect(events.map((event) => event.id)).toEqual(["manual-1"]);
	});
});

describe("planning persistence payload validation", () => {
	test("accepts a strict pure-JSON draft and rejects corrupt or extra fields", () => {
		const plan = draftPlan();
		expect(isPlanningPlan(plan)).toBeTrue();
		expect(() => assertPlanningPlan({ ...plan, version: 0 })).toThrow(
			PlanningPlanValidationError,
		);
		expect(isPlanningPlan({ ...plan, unexpected: true })).toBeFalse();
	});
});
