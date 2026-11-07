import { describe, expect, test } from "bun:test";
import { ReasoningDeltaExtractor } from "../src/bun/reasoning-delta-extractor";

describe("reasoning delta extractor", () => {
	test("extracts reasoning_content deltas across chunk boundaries", () => {
		const extractor = new ReasoningDeltaExtractor();
		expect(extractor.feed(Buffer.from('data: {"choices":[{"delta":{"reason'))).toBe("");
		expect(
			extractor.feed(
				Buffer.from('ing_content":"需要先查资料"}}]}\n\ndata: {"choices":[{"delta":{"content":"答案"}}]}\n\n'),
			),
		).toBe("需要先查资料");
		expect(extractor.feed(Buffer.from("data: [DONE]\n\n"))).toBe("");
	});

	test("extracts gateway research progress frames", () => {
		const extractor = new ReasoningDeltaExtractor();
		const chunk = Buffer.from(
			'data: {"choices":[{"delta":{"reasoning_content":"[调研] zhipu.web_search_prime search_query=马拉松 训练"}}]}\n\n',
		);
		expect(extractor.feed(chunk)).toContain("[调研] zhipu.web_search_prime");
	});

	test("clears oversized non-SSE buffers instead of growing forever", () => {
		const extractor = new ReasoningDeltaExtractor();
		expect(extractor.feed(Buffer.alloc(1_100_000, 0x61))).toBe("");
		// 下一帧正常解析（缓冲已清空）。
		expect(
			extractor.feed(
				Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"ok"}}]}\n'),
			),
		).toBe("ok");
	});
});
