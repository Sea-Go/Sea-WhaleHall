import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	decodeDynamicPlanningProviderOutput,
	dynamicPlanningProviderOutputSchema,
} from "../src/agent/mastra-host/planning-analysis";
import type { AgentHostMethod } from "../src/agent/mastra-host/protocol";
import type {
	PlanningModelAnalysisRequest,
	PlanningModelProposal,
} from "../src/agent/planning";
import { assertPlanningModelOutputForRequest } from "../src/agent/planning";
import {
	MAX_PLANNING_MODEL_CONTEXT_MESSAGES,
	MAX_PLANNING_MODEL_OBSERVATION_EVIDENCE,
} from "../src/agent/planning/model";
import {
	MastraPlanningModel,
	type PlanningAnalysisSidecar,
} from "../src/bun/mastra-planning-model";
import { MastraSidecarError } from "../src/bun/mastra-sidecar-client";

function requestFixture(): PlanningModelAnalysisRequest {
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

function proposalFixture(): PlanningModelProposal {
	return {
		outcome: "proposal",
		recommendedType: "fuzzy",
		rationaleSummary: "路径需要先验证。",
		assumptions: [],
		clarificationQuestions: [],
		assistantMessage: "先执行七天验证任务，再动态修正预计日期。",
		goal: "验证一个长期收入方向",
		estimatedCompletionDate: "2036-08-13",
		confidence: 0.4,
		estimateBasis: "当前只有方向性证据。",
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

describe("MastraPlanningModel", () => {
	test("keeps the recursive provider JSON Schema free of pattern", () => {
		const providerSchema = z.toJSONSchema(dynamicPlanningProviderOutputSchema);
		expect(JSON.stringify(providerSchema)).not.toContain('"pattern"');
	});

	test("normalizes the stable provider envelope into the strict proposal union", () => {
		const proposal = proposalFixture();
		expect(
			decodeDynamicPlanningProviderOutput(
				{
					outcome: proposal.outcome,
					recommendedType: proposal.recommendedType,
					rationaleSummary: proposal.rationaleSummary,
					assumptions: proposal.assumptions,
					clarificationQuestions: proposal.clarificationQuestions,
					assistantMessage: proposal.assistantMessage,
					proposal: {
						goal: proposal.goal,
						estimatedCompletionDate: proposal.estimatedCompletionDate,
						confidence: proposal.confidence,
						estimateBasis: proposal.estimateBasis,
						schedulingPreferenceSource: proposal.schedulingPreferenceSource,
						schedulingPreferences: proposal.schedulingPreferences,
						tasks: proposal.tasks,
					},
				},
				requestFixture(),
			),
		).toEqual(proposal);
	});

	test("defaults an omitted proposal question list but rejects it for clarification", () => {
		const proposal = proposalFixture();
		const providerProposal = {
			outcome: proposal.outcome,
			recommendedType: proposal.recommendedType,
			rationaleSummary: proposal.rationaleSummary,
			assumptions: proposal.assumptions,
			assistantMessage: proposal.assistantMessage,
			proposal: {
				goal: proposal.goal,
				estimatedCompletionDate: proposal.estimatedCompletionDate,
				confidence: proposal.confidence,
				estimateBasis: proposal.estimateBasis,
				schedulingPreferenceSource: proposal.schedulingPreferenceSource,
				schedulingPreferences: proposal.schedulingPreferences,
				tasks: proposal.tasks,
			},
		};
		expect(
			decodeDynamicPlanningProviderOutput(providerProposal, requestFixture()),
		).toEqual(proposal);
		expect(
			decodeDynamicPlanningProviderOutput(
				{
					...providerProposal,
					outcome: "needs-clarification",
					proposal: null,
				},
				requestFixture(),
			),
		).toBeNull();
	});

	test("drops known proposal fields from a clarification but rejects arbitrary extras", () => {
		const mixed = {
			outcome: "needs-clarification",
			recommendedType: "short-term",
			rationaleSummary: "还缺少交付格式。",
			assumptions: [],
			clarificationQuestions: ["演示文稿面向什么受众？"],
			assistantMessage: "请先确认受众。",
			goal: "制作演示文稿",
			estimatedCompletionDate: "2026-09-01",
			confidence: 0.7,
			estimateBasis: "基于当前说明。",
			schedulingPreferenceSource: "user-provided",
			schedulingPreferences: {
				weeklyCapacityMinutes: 240,
				sessionMinutes: 60,
				availableWindows: [
					{ dayOfWeek: 2, startTime: "19:00", endTime: "21:00" },
				],
			},
			tasks: [proposalFixture().tasks[0]],
		};
		expect(
			decodeDynamicPlanningProviderOutput(mixed, requestFixture()),
		).toEqual({
			outcome: "needs-clarification",
			recommendedType: "short-term",
			rationaleSummary: "还缺少交付格式。",
			assumptions: [],
			clarificationQuestions: ["演示文稿面向什么受众？"],
			assistantMessage: "请先确认受众。",
		});
		expect(
			decodeDynamicPlanningProviderOutput(
				{ ...mixed, unexpected: true },
				requestFixture(),
			),
		).toBeNull();
		expect(
			decodeDynamicPlanningProviderOutput(
				{ ...mixed, clarificationQuestions: ["   "] },
				requestFixture(),
			),
		).toBeNull();
	});

	test("keeps a complete mixed proposal confirmable and drops stray questions", () => {
		const proposal = proposalFixture();
		expect(
			decodeDynamicPlanningProviderOutput(
				{
					outcome: "proposal",
					recommendedType: "fuzzy",
					rationaleSummary: proposal.rationaleSummary,
					assumptions: proposal.assumptions,
					clarificationQuestions: ["请确认演示文稿受众。"],
					assistantMessage: "还需要确认受众。",
					proposal: {
						goal: proposal.goal,
						estimatedCompletionDate: proposal.estimatedCompletionDate,
						confidence: 0.9,
						estimateBasis: proposal.estimateBasis,
						schedulingPreferenceSource: proposal.schedulingPreferenceSource,
						schedulingPreferences: proposal.schedulingPreferences,
						tasks: proposal.tasks,
					},
				},
				requestFixture(),
			),
		).toEqual({
			...proposal,
			outcome: "proposal",
			recommendedType: "fuzzy",
			clarificationQuestions: [],
			assistantMessage: "还需要确认受众。",
			confidence: 0.5,
		});
		expect(
			decodeDynamicPlanningProviderOutput(
				{
					outcome: "proposal",
					recommendedType: "fuzzy",
					rationaleSummary: proposal.rationaleSummary,
					assumptions: proposal.assumptions,
					clarificationQuestions: ["请确认演示文稿受众。"],
					assistantMessage: "还需要确认受众。",
					proposal: {
						goal: proposal.goal,
						estimatedCompletionDate: proposal.estimatedCompletionDate,
						confidence: 0.9,
						estimateBasis: proposal.estimateBasis,
						schedulingPreferenceSource: proposal.schedulingPreferenceSource,
						schedulingPreferences: proposal.schedulingPreferences,
						tasks: proposal.tasks,
					},
				},
				{ ...requestFixture(), analysisMode: "automatic-adjustment" },
			),
		).toBeNull();
	});

	test("caps fuzzy proposal confidence before strict domain validation", () => {
		const proposal = proposalFixture();
		const decoded = decodeDynamicPlanningProviderOutput(
			{
				outcome: proposal.outcome,
				recommendedType: proposal.recommendedType,
				rationaleSummary: proposal.rationaleSummary,
				assumptions: proposal.assumptions,
				clarificationQuestions: [],
				assistantMessage: proposal.assistantMessage,
				proposal: {
					goal: proposal.goal,
					estimatedCompletionDate: proposal.estimatedCompletionDate,
					confidence: 0.9,
					estimateBasis: proposal.estimateBasis,
					schedulingPreferenceSource: proposal.schedulingPreferenceSource,
					schedulingPreferences: proposal.schedulingPreferences,
					tasks: proposal.tasks,
				},
			},
			requestFixture(),
		);
		expect(decoded).toMatchObject({ outcome: "proposal", confidence: 0.5 });
	});

	test("reclassifies a bad manual reuse label when no preference is confirmed", () => {
		const proposal = proposalFixture();
		const providerValue = {
			outcome: proposal.outcome,
			recommendedType: proposal.recommendedType,
			rationaleSummary: proposal.rationaleSummary,
			assumptions: ["用户已确认的排程偏好", "任务必须满足依赖关系"],
			clarificationQuestions: [],
			assistantMessage: proposal.assistantMessage,
			proposal: {
				goal: proposal.goal,
				estimatedCompletionDate: proposal.estimatedCompletionDate,
				confidence: proposal.confidence,
				estimateBasis: proposal.estimateBasis,
				schedulingPreferenceSource: "confirmed-reuse" as const,
				schedulingPreferences: proposal.schedulingPreferences,
				tasks: proposal.tasks,
			},
		};
		const decoded = decodeDynamicPlanningProviderOutput(
			providerValue,
			requestFixture(),
		);
		expect(decoded).toMatchObject({
			outcome: "proposal",
			schedulingPreferenceSource: "user-provided",
			assumptions: ["任务必须满足依赖关系"],
			assistantMessage:
				"已生成一版完整提案；请核对排程偏好，确认后才会开始执行。",
		});
		const withConfirmedPreferences = decodeDynamicPlanningProviderOutput(
			providerValue,
			{
				...requestFixture(),
				currentSchedulingPreferences: proposal.schedulingPreferences,
			},
		);
		expect(withConfirmedPreferences).toMatchObject({
			outcome: "proposal",
			schedulingPreferenceSource: "confirmed-reuse",
		});
		const automaticRequest = {
			...requestFixture(),
			analysisMode: "automatic-adjustment" as const,
		};
		const automaticDecoded = decodeDynamicPlanningProviderOutput(
			providerValue,
			automaticRequest,
		);
		expect(automaticDecoded).toMatchObject({
			schedulingPreferenceSource: "confirmed-reuse",
		});
		expect(() =>
			assertPlanningModelOutputForRequest(automaticDecoded, automaticRequest),
		).toThrow();
	});

	test("uses the narrow live method and stable durable request identity", async () => {
		let captured:
			| {
					method: AgentHostMethod;
					params: Record<string, unknown>;
					options?: {
						requestId?: string;
						timeoutMs?: number;
						signal?: AbortSignal;
					};
			  }
			| undefined;
		const sidecar: PlanningAnalysisSidecar = {
			async request<TResult>(
				method: AgentHostMethod,
				params: Record<string, unknown>,
				options?: {
					requestId?: string;
					timeoutMs?: number;
					signal?: AbortSignal;
				},
			) {
				captured = { method, params, options };
				return proposalFixture() as TResult;
			},
		};
		const model = new MastraPlanningModel({
			sidecar,
			modelVersion: "relay/test-model",
		});

		await expect(
			model.analyze(requestFixture(), {
				requestId: "planning-analysis:operation-1",
			}),
		).resolves.toEqual(proposalFixture());
		expect(captured?.method).toBe("planning.analyze");
		expect(captured?.params).toMatchObject({
			requestId: "planning-analysis:operation-1",
			analysis: requestFixture(),
		});
		expect(captured?.options?.requestId).toBe(
			"dynamic:planning-analysis:operation-1",
		);
		expect(model.modelVersion).toBe("relay/test-model");
	});

	test("bounds only the transported conversation while preserving durable history", async () => {
		let capturedAnalysis: PlanningModelAnalysisRequest | undefined;
		const sidecar: PlanningAnalysisSidecar = {
			async request<TResult>(
				_method: AgentHostMethod,
				params: Record<string, unknown>,
			) {
				capturedAnalysis = params.analysis as PlanningModelAnalysisRequest;
				return proposalFixture() as TResult;
			},
		};
		const model = new MastraPlanningModel({
			sidecar,
			modelVersion: "relay/test-model",
		});
		const base = requestFixture();
		const messages = Array.from(
			{ length: MAX_PLANNING_MODEL_CONTEXT_MESSAGES + 3 },
			(_, index) => ({
				id: `message-${index}`,
				planId: base.planId,
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: `message ${index}`,
				createdAt: "2026-08-14T00:00:00.000Z",
				causedByOperationId: `operation-${index}`,
			}),
		);
		const observationEvidence = Array.from(
			{ length: MAX_PLANNING_MODEL_OBSERVATION_EVIDENCE + 3 },
			(_, index) => ({
				id: `evidence-${index}`,
				observationId: `observation-${index}`,
				planId: base.planId,
				taskId: "task-1",
				startedAt: "2026-08-14T00:00:00.000Z",
				endedAt: "2026-08-14T00:15:00.000Z",
				relevantMinutes: 15,
				confidence: 0.9,
				attribution: "unique-observed" as const,
				recordedAt: "2026-08-14T00:15:00.000Z",
			}),
		);
		const request = { ...base, messages, observationEvidence };

		await model.analyze(request, {
			requestId: "planning-analysis:operation-long-history",
		});

		expect(request.messages).toHaveLength(
			MAX_PLANNING_MODEL_CONTEXT_MESSAGES + 3,
		);
		expect(capturedAnalysis?.messages).toHaveLength(
			MAX_PLANNING_MODEL_CONTEXT_MESSAGES,
		);
		expect(capturedAnalysis?.messages[0]?.id).toBe("message-3");
		expect(capturedAnalysis?.messages.at(-1)?.id).toBe(
			`message-${MAX_PLANNING_MODEL_CONTEXT_MESSAGES + 2}`,
		);
		expect(request.observationEvidence).toHaveLength(
			MAX_PLANNING_MODEL_OBSERVATION_EVIDENCE + 3,
		);
		expect(capturedAnalysis?.observationEvidence).toHaveLength(
			MAX_PLANNING_MODEL_OBSERVATION_EVIDENCE,
		);
		expect(capturedAnalysis?.observationEvidence[0]?.id).toBe("evidence-3");
	});

	test("maps strict Sidecar output rejection to a retryable Planning failure", async () => {
		const model = new MastraPlanningModel({
			sidecar: {
				async request() {
					throw new MastraSidecarError(
						"PLANNING_OUTPUT_INVALID",
						"invalid",
						true,
					);
				},
			},
			modelVersion: "relay/test-model",
		});

		await expect(
			model.analyze(requestFixture(), {
				requestId: "planning-analysis:operation-invalid",
			}),
		).rejects.toMatchObject({ code: "invalid-output", retryable: true });
	});

	test("authorizes only pending invocation IDs and aborts the matching relay", async () => {
		let invocationId = "";
		let observedPending = false;
		const aborted: string[] = [];
		const sidecar: PlanningAnalysisSidecar = {
			request(_method, params, options) {
				invocationId = String(params.invocationId);
				observedPending = model.hasPendingInvocation(invocationId);
				return new Promise((_resolve, reject) => {
					const abort = () =>
						reject(new MastraSidecarError("CANCELLED", "cancelled", true));
					if (options?.signal?.aborted) abort();
					else
						options?.signal?.addEventListener("abort", abort, { once: true });
				});
			},
		};
		const model = new MastraPlanningModel({
			sidecar,
			modelVersion: "relay/test-model",
			onInvocationAbort: (id) => aborted.push(id),
		});
		const controller = new AbortController();
		const pending = model.analyze(requestFixture(), {
			requestId: "planning-analysis:operation-cancel",
			signal: controller.signal,
		});
		controller.abort();

		await expect(pending).rejects.toMatchObject({ code: "cancelled" });
		expect(observedPending).toBeTrue();
		expect(aborted).toEqual([invocationId]);
		expect(model.hasPendingInvocation(invocationId)).toBeFalse();
	});

	test("revokes delayed account capabilities and remains reusable", async () => {
		let pendingInvocationId = "";
		let releaseFirst!: (value: PlanningModelProposal) => void;
		let requestCount = 0;
		const aborted: string[] = [];
		const sidecar: PlanningAnalysisSidecar = {
			request<TResult>(
				_method: AgentHostMethod,
				params: Record<string, unknown>,
			) {
				requestCount += 1;
				if (requestCount === 1) {
					pendingInvocationId = String(params.invocationId);
					return new Promise<PlanningModelProposal>((resolve) => {
						releaseFirst = resolve;
					}) as Promise<TResult>;
				}
				return Promise.resolve(proposalFixture() as TResult);
			},
		};
		const model = new MastraPlanningModel({
			sidecar,
			modelVersion: "relay/test-model",
			onInvocationAbort: (id) => aborted.push(id),
		});
		const first = model.analyze(requestFixture(), {
			requestId: "planning-analysis:account-a",
		});
		await Promise.resolve();
		expect(model.hasPendingInvocation(pendingInvocationId)).toBeTrue();

		model.cancelPending();
		expect(model.hasPendingInvocation(pendingInvocationId)).toBeFalse();
		releaseFirst(proposalFixture());
		await expect(first).rejects.toMatchObject({ code: "cancelled" });
		expect(aborted).toEqual([pendingInvocationId]);
		await expect(
			model.analyze(requestFixture(), {
				requestId: "planning-analysis:account-b",
			}),
		).resolves.toEqual(proposalFixture());
	});
});
