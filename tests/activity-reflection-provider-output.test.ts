import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { activityReflectionAnalysisWorkedExample } from "../src/agent/activity-reflection-analysis-skill";
import {
	activityReflectionModelOutputSchema,
	createActivityReflectionProviderOutputSchema,
	createActivityReflectionRuntimeOutputSchema,
	normalizeActivityReflectionProviderOutput,
} from "../src/agent/activity-reflection-prompt";

const SEGMENTS = ["segment-1", "segment-2"];
const ACTIVITIES = ["development", "research"] as const;

function wireOutput(overrides?: {
	evidence?: unknown;
	reasonCodes?: unknown;
}): Record<string, unknown> {
	return {
		events: [
			{
				action: "推测：正在编写代码并查阅技术资料",
				activity: "development",
				goal_relevance: "supporting",
				confidence: 0.75,
				reason_codes: overrides?.reasonCodes ?? ["文档变更", "持续输入"],
				evidence: overrides?.evidence ?? ["编辑器文档修改伴随持续输入"],
				signal_segment_ids: ["segment-1"],
				started_at_ms: null,
				ended_at_ms: null,
			},
		],
		score: 0.5,
		score_reason: "目标相关的开发活动证据充分",
	};
}

describe("activity reflection provider wire shape", () => {
	test("provider schema accepts string evidence/reason_codes from weak models", () => {
		const provider = createActivityReflectionProviderOutputSchema(
			SEGMENTS,
			ACTIVITIES,
		);
		const parsed = provider.safeParse(
			wireOutput({
				evidence: "编辑器文档修改伴随持续输入",
				reasonCodes: "文档变更",
			}),
		);
		expect(parsed.success).toBeTrue();
		if (!parsed.success) return;
		const event = parsed.data.events[0];
		expect(event?.evidence).toEqual(["编辑器文档修改伴随持续输入"]);
		expect(event?.reason_codes).toEqual(["文档变更"]);
	});

	test("provider JSON schema still teaches strict arrays to the model", () => {
		const provider = createActivityReflectionProviderOutputSchema(
			SEGMENTS,
			ACTIVITIES,
		);
		const json = z.toJSONSchema(provider) as {
			properties?: {
				events?: { items?: { properties?: { evidence?: { type?: string } } } };
			};
		};
		expect(json.properties?.events?.items?.properties?.evidence?.type).toBe(
			"array",
		);
	});





});
