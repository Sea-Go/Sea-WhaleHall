import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { dynamicPlanningOutputSchema } from "../src/agent/mastra-host/planning-analysis";
import type { AgentHostMethod } from "../src/agent/mastra-host/protocol";
import type {
	PlanningModelAnalysisRequest,
	PlanningModelProposal,
} from "../src/agent/planning";
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
});
