import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { dynamicPlanningOutputSchema } from "../src/agent/mastra-host/planning-analysis";
import type { AgentHostMethod } from "../src/agent/mastra-host/protocol";
import type {
	PlanningModelAnalysisRequest,
	PlanningModelProposal,
} from "../src/agent/planning";
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
		const providerSchema = z.toJSONSchema(dynamicPlanningOutputSchema);
		expect(JSON.stringify(providerSchema)).not.toContain('"pattern"');
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
