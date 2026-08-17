import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("WhaleHall reflection production composition", () => {
	test("has no endpoint or local-model configuration surface", () => {
		const source = readFileSync(
			resolve(import.meta.dir, "../src/bun/reflection-runtime.ts"),
			"utf8",
		);
		expect(source).toContain("new DeterministicReflectionInference()");
		expect(source).not.toContain("MODERNBERT_ENDPOINT");
		expect(source).not.toContain("OllamaJsonClient");
		expect(source).not.toContain("teacherBaseUrl");
	});
});
