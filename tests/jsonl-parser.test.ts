import { describe, expect, test } from "bun:test";
import { JsonlParser, JsonlProtocolError } from "../src/bun/agent/jsonl-parser";

const encoder = new TextEncoder();

describe("JsonlParser", () => {
	test("reassembles fragmented input and emits multiple lines", () => {
		const lines: string[] = [];
		const parser = new JsonlParser((line) => lines.push(line), 1024);
		parser.feed(encoder.encode('{"id":"1"'));
		parser.feed(encoder.encode('}\n{"id":"2"}\r\n'));
		expect(lines).toEqual(['{"id":"1"}', '{"id":"2"}']);
	});

	test("accepts a final line without a trailing newline", () => {
		const lines: string[] = [];
		const parser = new JsonlParser((line) => lines.push(line), 1024);
		parser.feed(encoder.encode('{"ok":true}'));
		parser.finish();
		expect(lines).toEqual(['{"ok":true}']);
	});

	test("rejects lines larger than the configured maximum", () => {
		const parser = new JsonlParser(() => {}, 4);
		expect(() => parser.feed(encoder.encode("12345"))).toThrow(JsonlProtocolError);
	});
});
