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


























});
