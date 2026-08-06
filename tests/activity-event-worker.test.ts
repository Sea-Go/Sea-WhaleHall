import { describe, expect, test } from "bun:test";
import {
	ActivityEventWorkerClientError,
	validateActivityEventWorkerResponse,
	type ActivityEventWorkerResponse,
} from "../src/agent/activity-event-worker";

function responseFixture(requestId = "request-1"): ActivityEventWorkerResponse {
	return {
		schema_version: "activity-event-analysis-response.v1",
		request_id: requestId,
		events: [
			{
				time: "10:00:00-12:00:00",
				action: "推测：正在进行编程",
				source_event_ids: ["sealed-window-1"],
				activity: "development",
				goal_relevance: "direct",
				confidence: 0.9,
				reason_codes: ["editor_activity"],
				evidence: ["编辑器保持前台"],
				started_at_ms: 1_000,
				ended_at_ms: 2_000,
			},
		],
		score: 0.5,
		score_reason: "目标相关活动",
	};
}

describe("local activity analysis receipt contract", () => {
	test("accepts a reviewable Chinese event and score after local normalization", () => {
		expect(validateActivityEventWorkerResponse(responseFixture(), "request-1")).toEqual(
			responseFixture(),
		);
	});

	test("rejects a malformed or mismatched receipt before it can enter the ledger", () => {
		const wrongRequest = { ...responseFixture(), request_id: "different" };
		const invalidScore = { ...responseFixture(), score: 1.5 };

		for (const value of [wrongRequest, invalidScore, { score: 1 }]) {
			expect(() => validateActivityEventWorkerResponse(value, "request-1")).toThrow(
				ActivityEventWorkerClientError,
			);
		}
	});
});
