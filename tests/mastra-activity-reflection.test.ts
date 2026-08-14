import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type ActivityEventWorkerRequest,
	validateActivityEventWorkerResponse,
} from "../src/agent/activity-event-worker";
import {
	ACTIVITY_REFLECTION_SYSTEM_PROMPT,
	type ActivityReflectionModelOutput,
	activityReflectionModelOutputSchema,
	activityReflectionOutputToWorkerResponse,
	createActivityReflectionPrompt,
	createActivityReflectionRuntimeOutputSchema,
} from "../src/agent/activity-reflection-prompt";
import { ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES } from "../src/agent/activity-reflection-skill-names";
import {
	deriveActivityReflectionStateHints,
	deriveActivityReflectionStateMarkers,
} from "../src/agent/activity-reflection-state-hints";
import { loadActivityReflectionNativeSkillContext } from "../src/agent/mastra-host/activity-reflection-skills";
import type { AgentHostMethod } from "../src/agent/mastra-host/protocol";
import { runActivityReflectionWithDeadline } from "../src/agent/mastra-host/runtime";
import {
	type ActivityReflectionSidecar,
	MastraActivityReflectionAnalyzer,
} from "../src/bun/mastra-activity-reflection";
import { MastraSidecarError } from "../src/bun/mastra-sidecar-client";
import { isActivityAnalysisWorkerResult } from "../src/shared/activity-analysis-contract";

function requestFixture(
	requestId = "activity-window-request-1",
): ActivityEventWorkerRequest {
	return {
		schema_version: "activity-event-analysis-request.v1",
		request_id: requestId,
		raw_event: {
			windowId: "sealed-window-1",
			events: [
				{ kind: "application.foregroundChanged", occurredAtMs: 1_000 },
				{
					id: "raw-event-1",
					kind: "editor.documentChanged",
					occurredAtMs: 1_050,
					payload: { language: "TypeScript", text: "private source text" },
				},
				{ kind: "input.activityAggregated", occurredAtMs: 2_000 },
			],
		},
		context: {
			goal: { goalId: "goal-1", text: "private goal text" },
			response_contract: {
				source_window_id: "sealed-window-1",
				source_event_ids: ["raw-event-1"],
				window_started_at_ms: 1_000,
				window_ended_at_ms: 2_000,
				time_zone: "UTC",
			},
		},
	};
}

function modelOutputFixture(): ActivityReflectionModelOutput {
	return {
		events: [
			{
				action: "推测：正在进行编程",
				activity: "development",
				goal_relevance: "direct",
				confidence: 0.72,
				reason_codes: ["editor_activity"],
				evidence: ["编辑器持续前台且存在交互"],
				signal_segment_ids: ["segment-1"],
				started_at_ms: 1_050,
				ended_at_ms: 1_950,
			},
		],
		score: 0.75,
		score_reason: "与当前目标直接相关",
	};
}

describe("MastraActivityReflectionAnalyzer", () => {
	test("delegates analysis and scoring instructions to Mastra-native filesystem Skills", () => {
		const skillRoot = resolve(import.meta.dir, "../skills");
		for (const skillName of ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES) {
			const skillPath = resolve(skillRoot, skillName, "SKILL.md");
			expect(existsSync(skillPath)).toBeTrue();
			expect(readFileSync(skillPath, "utf8")).toContain(`name: ${skillName}`);
			expect(ACTIVITY_REFLECTION_SYSTEM_PROMPT).toContain(skillName);
		}
		expect(ACTIVITY_REFLECTION_SYSTEM_PROMPT).toContain(
			"Mastra 原生 Skill API",
		);
		expect(ACTIVITY_REFLECTION_SYSTEM_PROMPT).not.toContain(
			"方法一（先聚合、后写 JSON）",
		);
		expect(ACTIVITY_REFLECTION_SYSTEM_PROMPT).not.toContain(
			"事件贡献 = 相关性系数",
		);
	});

	test("loads both runtime rules through Mastra's native Skill catalog before a model call", async () => {
		const requested: string[] = [];
		const context = await loadActivityReflectionNativeSkillContext({
			async getSkill(name) {
				requested.push(name);
				return { instructions: `规则：${name}` };
			},
		});
		expect(requested).toEqual([...ACTIVITY_REFLECTION_NATIVE_SKILL_NAMES]);
		expect(context).toMatchObject({ role: "system" });
		expect(context.content).toContain("规则：activity-reflection-analysis");
		expect(context.content).toContain("规则：activity-reflection-scoring");
		expect(context.content).toContain(
			"不能把 development、communication 等英文枚举写入 action",
		);
	});

	test("requires a concrete Chinese action after its certainty prefix", () => {
		const output = modelOutputFixture();
		output.events[0]!.action = "确定：";
		expect(
			activityReflectionModelOutputSchema.safeParse(output).success,
		).toBeFalse();
	});

	test("rejects an uncertainty prefix without a concrete Chinese action", () => {
		const receipt = {
			request_id: "empty-uncertain-action",
			events: [
				{
					time: "00:00:01-00:00:02",
					action: "不确定：",
					source_event_ids: ["source-1"],
					activity: "other_unknown",
					goal_relevance: "uncertain",
					confidence: 0,
					reason_codes: ["evidence_limited"],
					evidence: ["证据有限"],
					started_at_ms: 1_000,
					ended_at_ms: 2_000,
				},
			],
			score: 0,
			score_reason: "证据不足，计 0 分",
		};
		expect(isActivityAnalysisWorkerResult(receipt)).toBeFalse();
	});

	test("rejects deterministic control characters in Worker output", () => {
		const receipt = {
			request_id: "control-character-output",
			events: [
				{
					time: "00:00:01-00:00:02",
					action: "推测：正在进行编程",
					source_event_ids: ["source-1"],
					activity: "development",
					goal_relevance: "direct",
					confidence: 0.72,
					reason_codes: ["editor_activity"],
					evidence: ["编辑器持续前台且存在交互"],
					started_at_ms: 1_000,
					ended_at_ms: 2_000,
				},
			],
			score: 0.75,
			score_reason: "与当前目标直接相关",
		};
		expect(isActivityAnalysisWorkerResult(receipt)).toBeTrue();
		receipt.events[0]!.evidence = ["安全文本\u0085隐藏控制内容"];

		expect(isActivityAnalysisWorkerResult(receipt)).toBeFalse();
	});

	test("ignores prototype property names as presence boundaries", () => {
		const rawEvent = {
			events: [
				{ kind: "editor.documentChanged", occurredAtMs: 1_000 },
				{ kind: "constructor", occurredAtMs: 1_500 },
				{ kind: "toString", occurredAtMs: 1_600 },
			],
		};
		expect(
			deriveActivityReflectionStateHints(rawEvent).presence_boundaries,
		).toEqual([]);
		expect(
			deriveActivityReflectionStateMarkers(rawEvent, {
				startedAtMs: 1_000,
				endedAtMs: 2_000,
			}),
		).toEqual([]);
	});

	test("cancels a non-settling Mastra reflection workflow at its deadline", async () => {
		let cancellationCount = 0;
		await expect(
			runActivityReflectionWithDeadline(
				() => new Promise<never>(() => {}),
				async () => {
					cancellationCount += 1;
				},
				20,
			),
		).rejects.toThrow("Activity reflection workflow timed out.");
		expect(cancellationCount).toBe(1);
	});

	test("rejects an observation label masquerading as a human activity", () => {
		const output = modelOutputFixture();
		output.events[0]!.action = "推测：应用状态更改";
		expect(
			activityReflectionModelOutputSchema.safeParse(output).success,
		).toBeFalse();
	});

	test("normalizes Latin identifiers in a model action to a safe Chinese summary", () => {
		const output = modelOutputFixture();
		output.events[0]!.action = "推测：正在浏览 TypeScript 文档";
		output.events[0]!.activity = "research";
		expect(
			activityReflectionOutputToWorkerResponse(output, requestFixture())
				.events[0]?.action,
		).toBe("推测：正在查阅技术资料");
	});

	test("rejects model-authored state events because state boundaries belong to the client", () => {
		const output = modelOutputFixture();
		output.events[0]!.action = "确定：在进行浏览器标签导航";
		output.events[0]!.activity = "idle_transition";
		expect(
			activityReflectionModelOutputSchema.safeParse(output).success,
		).toBeFalse();
		expect(() =>
			activityReflectionOutputToWorkerResponse(output, requestFixture()),
		).toThrow("invalid_response");
	});

	test("does not preserve a specific document title or an unsupported app-operation claim", () => {
		const output = modelOutputFixture();
		output.events[0]!.action = "确定：在浏览 TypeScript API 参考文档";
		output.events[0]!.activity = "system_file_ops";
		expect(
			activityReflectionOutputToWorkerResponse(output, requestFixture())
				.events[0]?.action,
		).toBe("推测：正在查阅技术资料");

		output.events[0]!.action = "推测：正在关闭 Visual Studio Code 应用";
		expect(
			activityReflectionOutputToWorkerResponse(output, requestFixture())
				.events[0]?.action,
		).toBe("不确定：正在使用桌面应用，具体活动无法判断");
	});

	test("retains a combined coding-and-research hypothesis across adjacent local segments", () => {
		const request = requestFixture();
		request.raw_event = {
			windowId: "combined-window",
			events: [
				{ kind: "application.foregroundChanged", occurredAtMs: 1_000 },
				{
					kind: "editor.documentChanged",
					occurredAtMs: 1_050,
					payload: { language: "TypeScript" },
				},
				{ kind: "input.activityAggregated", occurredAtMs: 1_950 },
				{ kind: "application.foregroundChanged", occurredAtMs: 2_000 },
				{ kind: "browser.tabNavigated", occurredAtMs: 2_050 },
				{ kind: "input.activityAggregated", occurredAtMs: 3_000 },
			],
		};
		request.context = {
			...request.context,
			response_contract: {
				source_window_id: "sealed-window-1",
				source_event_ids: ["raw-event-1"],
				window_started_at_ms: 1_000,
				window_ended_at_ms: 3_000,
				time_zone: "UTC",
			},
		};
		const output = {
			events: [
				{
					...modelOutputFixture().events[0]!,
					action: "推测：正在编写代码并查阅技术资料",
					activity: "development" as const,
					confidence: 0.85,
					signal_segment_ids: ["segment-1", "segment-2"],
					started_at_ms: null,
					ended_at_ms: null,
				},
			],
			score: 0.85,
			score_reason: "存在连续编辑和资料查阅证据",
		};
		const response = activityReflectionOutputToWorkerResponse(output, request);
		expect(response.events).toEqual([
			expect.objectContaining({
				time: "00:00:01-00:00:03",
				action: "推测：正在编写代码并查阅技术资料",
				activity: "development",
				started_at_ms: 1_000,
				ended_at_ms: 3_000,
			}),
		]);
	});

	test("canonicalizes repeated segment tokens inside one model event", () => {
		const output = createActivityReflectionRuntimeOutputSchema(
			["segment-1"],
			["other_unknown"],
		).parse({
			events: [
				{
					action: "不确定：具体活动无法判断",
					activity: "other_unknown",
					goal_relevance: "uncertain",
					confidence: 0.2,
					reason_codes: ["evidence_limited"],
					evidence: ["现有证据不足"],
					signal_segment_ids: ["segment-1", "segment-1", "segment-1"],
					started_at_ms: null,
					ended_at_ms: null,
				},
			],
			score: 0,
			score_reason: "证据不足，暂不累计分数",
		});

		const response = activityReflectionOutputToWorkerResponse(
			output,
			requestFixture(),
		);
		expect(response).toMatchObject({
			events: [
				{
					action: "不确定：具体活动无法判断",
					started_at_ms: 1_000,
					ended_at_ms: 2_000,
				},
			],
			score: 0,
		});
		expect(() =>
			validateActivityEventWorkerResponse(response, response.request_id),
		).not.toThrow();
	});

	test("still rejects one local segment claimed by multiple model events", () => {
		const first = modelOutputFixture().events[0]!;
		const output: ActivityReflectionModelOutput = {
			...modelOutputFixture(),
			events: [
				first,
				{
					...first,
					action: "推测：正在查阅技术资料",
					activity: "research",
				},
			],
		};

		expect(() =>
			activityReflectionOutputToWorkerResponse(output, requestFixture()),
		).toThrow("invalid_response");
	});

	test("preserves a valid short model time slice and fills only missing endpoints", () => {
		const shortSlice = modelOutputFixture();
		const shortResponse = activityReflectionOutputToWorkerResponse(
			shortSlice,
			requestFixture(),
		);
		expect(shortResponse.events[0]).toMatchObject({
			started_at_ms: 1_050,
			ended_at_ms: 1_950,
		});

		const missingEnd = {
			...modelOutputFixture(),
			events: [
				{
					...modelOutputFixture().events[0]!,
					started_at_ms: 1_250,
					ended_at_ms: null,
				},
			],
		};
		expect(
			activityReflectionOutputToWorkerResponse(missingEnd, requestFixture())
				.events[0],
		).toMatchObject({ started_at_ms: 1_250, ended_at_ms: 2_000 });
	});

	test("adds deterministic zero-score state markers only for actual nonempty-window boundaries", () => {
		const request = requestFixture("state-boundary-window");
		request.raw_event = {
			windowId: "sealed-window-state",
			events: [
				{
					kind: "editor.documentChanged",
					occurredAtMs: 1_100,
					sensitivity: "content",
				},
				{
					kind: "presence.locked",
					occurredAtMs: 1_800,
					sensitivity: "metadata",
				},
			],
		};
		const output = modelOutputFixture();
		output.events[0]!.started_at_ms = null;
		output.events[0]!.ended_at_ms = null;
		output.score = 0.6;
		output.score_reason = "目标直接相关，强交叉证据，计 0.60 分";
		const response = activityReflectionOutputToWorkerResponse(output, request);
		expect(response.score).toBe(0.6);
		expect(response.events).toEqual([
			expect.objectContaining({
				activity: "development",
				started_at_ms: 1_100,
				ended_at_ms: 1_800,
			}),
			expect.objectContaining({
				action: "确定：电脑已锁屏",
				activity: "idle_transition",
				goal_relevance: "uncertain",
				confidence: 1,
				started_at_ms: 1_800,
				ended_at_ms: 1_800,
			}),
		]);

		const stateOnlyRequest = requestFixture("state-only-window");
		stateOnlyRequest.raw_event = {
			windowId: "not-a-sealed-activity-window",
			events: [{ kind: "presence.locked", occurredAtMs: 1_800 }],
		};
		expect(
			activityReflectionOutputToWorkerResponse(
				{ events: [], score: 0, score_reason: "只有状态边界，计 0 分" },
				stateOnlyRequest,
			).events,
		).toEqual([]);
	});

	test("uses a selected local segment for null model timestamps and rejects a timestamp outside it", () => {
		const fromSegment = modelOutputFixture();
		fromSegment.events[0]!.started_at_ms = null;
		fromSegment.events[0]!.ended_at_ms = null;
		expect(
			activityReflectionOutputToWorkerResponse(fromSegment, requestFixture())
				.events[0],
		).toMatchObject({ started_at_ms: 1_000, ended_at_ms: 2_000 });

		const outsideSegment = modelOutputFixture();
		outsideSegment.events[0]!.started_at_ms = 999;
		expect(() =>
			activityReflectionOutputToWorkerResponse(
				outsideSegment,
				requestFixture(),
			),
		).toThrow("invalid_response");
	});

	test("keeps a directly supported gaming example and a zero-score uncertain example reviewable", () => {
		const gaming = modelOutputFixture();
		gaming.events[0]!.action = "确定：正在进行游戏";
		gaming.events[0]!.activity = "gaming";
		gaming.events[0]!.confidence = 0.92;
		expect(
			activityReflectionOutputToWorkerResponse(gaming, requestFixture())
				.events[0]?.action,
		).toBe("确定：正在进行游戏");

		const uncertain = modelOutputFixture();
		uncertain.events[0]!.action = "不确定：正在查阅技术资料";
		uncertain.events[0]!.activity = "research";
		uncertain.events[0]!.confidence = 0.3;
		uncertain.score = 0;
		uncertain.score_reason = "证据不足，暂不累计分数";
		expect(
			activityReflectionOutputToWorkerResponse(uncertain, requestFixture()),
		).toMatchObject({
			events: [
				{
					action: "不确定：正在查阅技术资料",
					confidence: 0.3,
				},
			],
			score: 0,
		});
	});

	test("redacts model evidence and downgrades unsupported development certainty locally", () => {
		const output = modelOutputFixture();
		output.events[0]!.action = "确定：正在进行代码编写";
		output.events[0]!.reason_codes = ["VS Code 应用切换"];
		output.events[0]!.evidence = [
			"https://example.invalid/private",
			"编辑器持续前台且存在交互",
		];
		const response = activityReflectionOutputToWorkerResponse(
			output,
			requestFixture(),
		);
		expect(response.events[0]).toMatchObject({
			action: "推测：正在进行代码编写",
			reason_codes: ["客户端反思"],
			evidence: ["编辑器持续前台且存在交互"],
		});
	});

	test("keeps the model score intact while redacting a sensitive score reason", () => {
		const output = modelOutputFixture();
		output.score = 0.6;
		output.score_reason =
			"目标直接相关，详见 https://private.invalid，计 0.60 分";
		const response = activityReflectionOutputToWorkerResponse(
			output,
			requestFixture(),
		);
		expect(response.score).toBe(0.6);
		expect(response.score_reason).toBe(
			"已按目标相关性、证据和持续时间计 0.60 分",
		);
	});

	test("accepts a Chinese scoring-Skill calibration result without recomputing it", () => {
		const output = modelOutputFixture();
		output.events[0]!.confidence = 0.85;
		output.score = 0.85;
		output.score_reason = "目标直接相关，强交叉证据，持续约 3 分钟，计 0.85 分";
		expect(
			activityReflectionOutputToWorkerResponse(output, requestFixture()),
		).toMatchObject({
			score: 0.85,
			score_reason: "目标直接相关，强交叉证据，持续约 3 分钟，计 0.85 分",
		});
	});

	test("requires Chinese score reasons and makes sensitive commerce actions noncommittal", () => {
		const output = modelOutputFixture();
		output.score_reason = "direct score";
		expect(
			activityReflectionModelOutputSchema.safeParse(output).success,
		).toBeFalse();

		const commerce = modelOutputFixture();
		commerce.events[0]!.action = "确定：正在完成支付结算";
		commerce.events[0]!.activity = "commerce";
		commerce.score = 0;
		commerce.score_reason = "敏感结算不计分";
		expect(
			activityReflectionOutputToWorkerResponse(commerce, requestFixture())
				.events[0]?.action,
		).toBe("不确定：正在处理敏感页面，具体活动无法判断");
	});

	test("builds the full client-owned prompt, then writes a local reviewable receipt", async () => {
		const rawRequest = requestFixture();
		const sidecarCalls: Array<{
			method: string;
			params: Record<string, unknown>;
			requestId?: string;
		}> = [];
		const sidecar: ActivityReflectionSidecar = {
			async request<TResult = unknown>(
				method: AgentHostMethod,
				params: Record<string, unknown>,
				options?: {
					requestId?: string;
					timeoutMs?: number;
					signal?: AbortSignal;
				},
			): Promise<TResult> {
				sidecarCalls.push({
					method,
					params: structuredClone(params),
					...options,
				});
				return modelOutputFixture() as TResult;
			},
		};
		const analyzer = new MastraActivityReflectionAnalyzer({ sidecar });

		await expect(analyzer.analyze(rawRequest)).resolves.toEqual({
			schema_version: "activity-event-analysis-response.v1",
			request_id: rawRequest.request_id,
			events: [
				{
					time: "00:00:01-00:00:01",
					action: "推测：正在进行编程",
					source_event_ids: ["sealed-window-1"],
					activity: "development",
					goal_relevance: "direct",
					confidence: 0.72,
					reason_codes: ["客户端反思"],
					evidence: ["编辑器持续前台且存在交互"],
					started_at_ms: 1_050,
					ended_at_ms: 1_950,
				},
			],
			score: 0.75,
			score_reason: "与当前目标直接相关",
		});
		expect(sidecarCalls).toEqual([
			expect.objectContaining({
				method: "reflection.analyze",
				requestId: `reflection:${rawRequest.request_id}`,
				signal: expect.any(AbortSignal),
				params: expect.objectContaining({
					invocationId: expect.stringMatching(/^activity-reflection-/u),
					requestId: rawRequest.request_id,
					signalSegmentIds: ["segment-1"],
					candidateActivities: ["development"],
					userPrompt: expect.stringContaining(
						"COMPRESSED_ACTIVITY_EVENTS_JSON=",
					),
				}),
			}),
		]);
		const localPrompt = String(sidecarCalls[0]?.params.userPrompt);
		expect(localPrompt).toContain("LOCAL_STATE_HINTS_JSON=");
		expect(localPrompt).toContain("LOCAL_SIGNAL_INDEX_JSON=");
		expect(localPrompt).toContain("ACTIVITY_CONTEXT_JSON=");
		expect(localPrompt).toContain("private source text");
		expect(localPrompt).toContain("private goal text");
		expect(localPrompt).toContain("【最终输出合同】");
		expect(localPrompt).toContain("analysis_summary、context_details");
		expect(analyzer.hasPendingInvocation("not-a-real-invocation")).toBeFalse();
	});

	test("compresses every model-bound observation to time, tools, and message", () => {
		const prompt = createActivityReflectionPrompt(requestFixture()).userPrompt;
		const compressedLine = prompt
			.split("\n")
			.find((line) => line.startsWith("COMPRESSED_ACTIVITY_EVENTS_JSON="));
		const contextLine = prompt
			.split("\n")
			.find((line) => line.startsWith("ACTIVITY_CONTEXT_JSON="));
		expect(compressedLine).toBeDefined();
		expect(contextLine).toBeDefined();
		if (!compressedLine || !contextLine) {
			throw new Error("Compressed activity prompt is incomplete.");
		}
		const compressed = JSON.parse(
			compressedLine.slice("COMPRESSED_ACTIVITY_EVENTS_JSON=".length),
		) as Array<Record<string, unknown>>;
		expect(compressed).toHaveLength(3);
		for (const event of compressed) {
			expect(Object.keys(event).sort()).toEqual([
				"context_only",
				"message",
				"time",
				"tools",
			]);
			expect(event.context_only).toBeFalse();
		}
		expect(compressed).toEqual([
			{
				time: "00:00:01-00:00:01",
				tools: "WhaleHall 原生桌面观察器（application.foregroundChanged）",
				message: null,
				context_only: false,
			},
			{
				time: "00:00:01-00:00:01",
				tools: "WhaleHall 编辑器观察器（editor.documentChanged）",
				message: { language: "TypeScript", text: "private source text" },
				context_only: false,
			},
			{
				time: "00:00:02-00:00:02",
				tools: "WhaleHall 输入观察器（input.activityAggregated）",
				message: null,
				context_only: false,
			},
		]);
		expect(
			JSON.parse(contextLine.slice("ACTIVITY_CONTEXT_JSON=".length)),
		).toEqual({ active_goal: "private goal text" });
		expect(prompt).not.toContain("RAW_EVENT_JSON=");
		expect(prompt).not.toContain('"windowId":"sealed-window-1"');
		expect(prompt).not.toContain('"source_window_id"');
	});

	test("uses a collector-provided observation range in compressed time", () => {
		const request = requestFixture("compressed-range-window");
		const rawWindow = request.raw_event as {
			events: Array<Record<string, unknown>>;
		};
		rawWindow.events[2] = {
			kind: "input.activityAggregated",
			occurredAtMs: 9_999,
			payload: {
				bucketStartedAtMs: 1_200,
				bucketEndedAtMs: 2_300,
				keyCount: 13,
			},
		};
		const compressedLine = createActivityReflectionPrompt(request)
			.userPrompt.split("\n")
			.find((line) => line.startsWith("COMPRESSED_ACTIVITY_EVENTS_JSON="));
		expect(compressedLine).toBeDefined();
		if (!compressedLine) {
			throw new Error("Compressed activity prompt is incomplete.");
		}
		const compressed = JSON.parse(
			compressedLine.slice("COMPRESSED_ACTIVITY_EVENTS_JSON=".length),
		) as Array<Record<string, unknown>>;
		expect(compressed[2]).toEqual({
			time: "00:00:01-00:00:02",
			tools: "WhaleHall 输入观察器（input.activityAggregated）",
			message: {
				bucketStartedAtMs: 1_200,
				bucketEndedAtMs: 2_300,
				keyCount: 13,
			},
			context_only: false,
		});
	});

	test("adds a local factual signal index without copying private payload values", () => {
		const request = requestFixture("signal-index-window");
		request.raw_event = {
			contextOnly: [
				{
					kind: "browser.tabNavigated",
					occurredAtMs: 900,
					payload: { title: "earlier context" },
				},
			],
			events: [
				{
					kind: "application.foregroundChanged",
					occurredAtMs: 1_000,
					payload: { appName: "private editor" },
				},
				{ kind: "input.activityAggregated", occurredAtMs: 1_500 },
				{ kind: "editor.documentChanged", occurredAtMs: 2_000 },
				{
					kind: "application.foregroundChanged",
					occurredAtMs: 9_000,
					payload: { appName: "private browser" },
				},
				{ kind: "browser.tabNavigated", occurredAtMs: 9_500 },
			],
		};
		const prompt = createActivityReflectionPrompt(request).userPrompt;
		const compressedLine = prompt
			.split("\n")
			.find((line) => line.startsWith("COMPRESSED_ACTIVITY_EVENTS_JSON="));
		expect(compressedLine).toBeDefined();
		const evidence = JSON.parse(
			compressedLine!.slice("COMPRESSED_ACTIVITY_EVENTS_JSON=".length),
		) as Array<Record<string, unknown>>;
		expect(evidence[0]).toMatchObject({
			context_only: true,
			message: { title: "earlier context" },
		});
		expect(
			evidence.slice(1).every((item) => item.context_only === false),
		).toBeTrue();
		const signalIndex = prompt
			.split("\n")
			.find((line) => line.startsWith("LOCAL_SIGNAL_INDEX_JSON="));
		expect(signalIndex).toContain("文档变更观察");
		expect(signalIndex).toContain("浏览器资料观察");
		expect(signalIndex).not.toContain("private editor");
		expect(signalIndex).not.toContain("private browser");
		expect(signalIndex).not.toContain("earlier context");
	});

	test("rejects malformed model output before it can reach the score ledger", async () => {
		const sidecar: ActivityReflectionSidecar = {
			async request<TResult = unknown>(): Promise<TResult> {
				return {
					events: [{ action: "English action only" }],
					score: 1,
					score_reason: "bad",
				} as TResult;
			},
		};
		const analyzer = new MastraActivityReflectionAnalyzer({ sidecar });

		await expect(
			analyzer.analyze(requestFixture("invalid-model-output")),
		).rejects.toThrow("invalid_response");
	});

	test("classifies Sidecar semantic rejection as deterministic model output", async () => {
		const sidecar: ActivityReflectionSidecar = {
			async request<TResult = unknown>(): Promise<TResult> {
				throw new MastraSidecarError(
					"ACTIVITY_OUTPUT_INVALID",
					"sanitized semantic rejection",
					false,
				);
			},
		};
		const analyzer = new MastraActivityReflectionAnalyzer({ sidecar });

		await expect(
			analyzer.analyze(requestFixture("sidecar-semantic-rejection")),
		).rejects.toMatchObject({
			name: "ActivityEventWorkerClientError",
			code: "invalid_response",
			retryable: true,
		});
	});

	test("cancels its matching relay invocation without dropping the durable outbox item", async () => {
		let release!: () => void;
		const pending = new Promise<never>((_resolve, reject) => {
			release = () => reject(new Error("cancelled by test"));
		});
		const sidecar: ActivityReflectionSidecar = {
			async request<TResult = unknown>(): Promise<TResult> {
				return pending as TResult;
			},
		};
		const aborted: string[] = [];
		const analyzer = new MastraActivityReflectionAnalyzer({
			sidecar,
			onInvocationAbort: (invocationId) => aborted.push(invocationId),
		});
		const controller = new AbortController();
		const run = analyzer.analyze(requestFixture("cancelled-output"), {
			signal: controller.signal,
		});
		controller.abort();
		release();

		await expect(run).rejects.toThrow();
		expect(aborted).toHaveLength(1);
		expect(aborted[0]).toMatch(/^activity-reflection-/u);
	});
});
