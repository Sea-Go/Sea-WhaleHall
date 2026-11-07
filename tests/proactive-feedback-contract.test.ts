import { describe, expect, test } from "bun:test";
import {
	createDefaultProactiveFeedbackPolicy,
	isListProactiveFeedbackRequest,
	isProactiveFeedbackItem,
	isProactiveFeedbackPage,
	isProactiveFeedbackPolicy,
	PROACTIVE_FEEDBACK_HISTORY_DEFAULT_LIMIT,
	PROACTIVE_FEEDBACK_HISTORY_MAX_LIMIT,
	PROACTIVE_FEEDBACK_MESSAGE_MAX_BYTES,
} from "../src/shared/proactive-feedback";

describe("proactive feedback shared contract", () => {
	test("defaults to enabled with a 30-day local retention policy", () => {
		expect(createDefaultProactiveFeedbackPolicy()).toEqual({
			enabled: true,
			retention: 30,
		});
		expect(
			isProactiveFeedbackPolicy({ enabled: true, retention: "forever" }),
		).toBe(true);
		expect(isProactiveFeedbackPolicy({ enabled: true, retention: 365 })).toBe(
			false,
		);
		expect(
			isProactiveFeedbackPolicy({
				enabled: true,
				retention: 30,
				token: "must-not-cross-rpc",
			}),
		).toBe(false);
	});

	test("enforces list bounds without accepting an account identity", () => {
		expect(PROACTIVE_FEEDBACK_HISTORY_DEFAULT_LIMIT).toBe(20);
		expect(PROACTIVE_FEEDBACK_HISTORY_MAX_LIMIT).toBe(50);
		expect(isListProactiveFeedbackRequest({ limit: 20 })).toBe(true);
		expect(isListProactiveFeedbackRequest({ limit: 0 })).toBe(false);
		expect(isListProactiveFeedbackRequest({ limit: 51 })).toBe(false);
		expect(
			isListProactiveFeedbackRequest({
				limit: 20,
				accountId: "must-not-cross-rpc",
			}),
		).toBe(false);
		expect(
			isListProactiveFeedbackRequest({
				limit: 20,
				cursor: { generatedAtMs: 100, id: "feedback", accountId: "smuggled" },
			}),
		).toBe(false);
	});


});
