import { describe, expect, test } from "bun:test";
import { qaControlsEnabled } from "../src/views/client/app/qa-mode";

describe("renderer QA controls", () => {
	test("accepts the HMR query and a fragment form when a normal URL carries it", () => {
		expect(qaControlsEnabled({ search: "?qa=1", hash: "" })).toBe(true);
		expect(qaControlsEnabled({ search: "", hash: "#?qa=1" })).toBe(true);
	});

	test("fails closed for lookalike values and unrelated fragments", () => {
		for (const location of [
			{ search: "?qa=true", hash: "" },
			{ search: "", hash: "#qa=1" },
			{ search: "?notqa=1", hash: "" },
			{ search: "", hash: "#?qa=0" },
		]) {
			expect(qaControlsEnabled(location)).toBe(false);
		}
	});
});
