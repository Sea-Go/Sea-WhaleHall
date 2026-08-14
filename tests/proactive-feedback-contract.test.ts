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

	test("uses a 64 KiB UTF-8 byte limit instead of JavaScript string length", () => {
		const base = { id: "feedback-1", generatedAtMs: 1_800_000_000_000 };
		const exactAscii = "a".repeat(PROACTIVE_FEEDBACK_MESSAGE_MAX_BYTES);
		const exactChinese = "鲸".repeat(
			Math.floor(PROACTIVE_FEEDBACK_MESSAGE_MAX_BYTES / 3),
		);
		const tooManyChineseBytes = `${exactChinese}鲸`;
		expect(isProactiveFeedbackItem({ ...base, message: exactAscii })).toBe(
			true,
		);
		expect(isProactiveFeedbackItem({ ...base, message: exactChinese })).toBe(
			true,
		);
		expect(tooManyChineseBytes.length).toBeLessThan(
			PROACTIVE_FEEDBACK_MESSAGE_MAX_BYTES,
		);
		expect(
			isProactiveFeedbackItem({ ...base, message: tooManyChineseBytes }),
		).toBe(false);
		expect(
			isProactiveFeedbackItem({ ...base, message: "有效\u0000无效" }),
		).toBe(false);
		expect(
			isProactiveFeedbackItem({ ...base, message: "有效\u007f无效" }),
		).toBe(false);
		expect(
			isProactiveFeedbackItem({ ...base, message: "有效\u0085无效" }),
		).toBe(false);
	});

	test("validates descending keyset pages with a cursor matching the last item", () => {
		const first = { id: "feedback-b", generatedAtMs: 200, message: "较新" };
		const second = {
			id: "feedback-a",
			generatedAtMs: 200,
			message: "同一时刻较后",
		};
		const third = { id: "feedback-z", generatedAtMs: 100, message: "较早" };
		expect(
			isProactiveFeedbackPage({
				items: [first, second, third],
				nextCursor: { generatedAtMs: third.generatedAtMs, id: third.id },
			}),
		).toBe(true);
		expect(
			isProactiveFeedbackPage({ items: [third, first], nextCursor: null }),
		).toBe(false);
		expect(
			isProactiveFeedbackPage({
				items: [first],
				nextCursor: { generatedAtMs: 0, id: "unrelated" },
			}),
		).toBe(false);
	});
});
