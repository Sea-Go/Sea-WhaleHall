import { describe, expect, test } from "bun:test";
import { PlanningProgressParser } from "../src/views/client/features/planning/progress-steps";

describe("planning progress parser", () => {
	test("parses thinking text and tool call/result blocks into a DAG timeline", () => {
		const parser = new PlanningProgressParser();
		parser.feed("需要先查开放时间，\n再排动线。");
		parser.feed(
			"[调研] zhipu.web_search_prime search_query=Fushimi Inari hours",
		);
		parser.feed("[调研] zhipu.web_search_prime 完成（4183 字结果）");
		parser.feed("查到了，开始排三天行程。");

		const steps = parser.feed("");
		expect(steps).toHaveLength(3);

		expect(steps[0]?.kind).toBe("thinking");
		if (steps[0]?.kind === "thinking") {
			expect(steps[0].text).toContain("需要先查开放时间");
			expect(steps[0].text).toContain("再排动线");
		}

		expect(steps[1]?.kind).toBe("tool");
		if (steps[1]?.kind === "tool") {
			expect(steps[1].tool).toBe("zhipu.web_search_prime");
			expect(steps[1].args).toBe("search_query=Fushimi Inari hours");
			expect(steps[1].status).toBe("done");
			expect(steps[1].result).toBe("4183 字结果");
		}

		expect(steps[2]?.kind).toBe("thinking");
		if (steps[2]?.kind === "thinking") {
			expect(steps[2].text).toContain("开始排三天行程");
		}
	});

	test("keeps a tool block running until its completion frame arrives", () => {
		const parser = new PlanningProgressParser();
		parser.feed("[调研] zhipu.web_search_prime search_query=teamlab tickets");
		let steps = parser.feed("");
		expect(steps[0]?.kind).toBe("tool");
		if (steps[0]?.kind === "tool") expect(steps[0].status).toBe("running");

		steps = parser.feed("[调研] zhipu.web_search_prime 完成（120 字结果）");
		expect(steps[0]?.kind).toBe("tool");
		if (steps[0]?.kind === "tool") expect(steps[0].status).toBe("done");
	});

	test("marks failed research and matches the most recent running call of the same tool", () => {
		const parser = new PlanningProgressParser();
		parser.feed("[调研] zhipu.web_search_prime search_query=a");
		parser.feed("[调研] zhipu.web_search_prime 完成（10 字结果）");
		parser.feed("[调研] zhipu.web_search_prime search_query=b");
		parser.feed("[调研] zhipu.web_search_prime 失败（网关超时）");

		const steps = parser.feed("");
		expect(steps).toHaveLength(2);
		if (steps[0]?.kind === "tool") expect(steps[0].status).toBe("done");
		if (steps[1]?.kind === "tool") {
			expect(steps[1].status).toBe("failed");
			expect(steps[1].result).toContain("网关超时");
		}
	});

	test("non-marker research notes fold into thinking text", () => {
		const parser = new PlanningProgressParser();
		parser.feed("[调研] 上游返回错误，本轮中断。");
		const steps = parser.feed("");
		expect(steps).toHaveLength(1);
		expect(steps[0]?.kind).toBe("thinking");
	});
});
