import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLocalMessage } from "../src/agent/local-protocol";

function fixture(name: string) {
	return readFileSync(resolve(import.meta.dir, "fixtures/local-protocol", name), "utf8")
		.trim()
		.split("\n")
		.map(parseLocalMessage);
}

describe("shared local protocol fixtures", () => {
	test("parses the success response", () => {
		expect(fixture("success.jsonl")[0]).toMatchObject({ id: "call-1", ok: true });
	});

	test("parses the failure response", () => {
		expect(fixture("failure.jsonl")[0]).toMatchObject({
			id: "call-1",
			ok: false,
			error: { code: "TOOL_NOT_FOUND" },
		});
	});

	test("parses every event kind", () => {
		expect(fixture("events.jsonl").map((message) => ("event" in message ? message.event : null))).toEqual([
			"tool.started",
			"tool.progress",
			"tool.completed",
			"tool.failed",
			"tool.cancelled",
		]);
	});
});
