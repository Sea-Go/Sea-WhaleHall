import { describe, expect, test } from "bun:test";
import { ModernBertHttpClient } from "../src/agent/reflection/inference";

describe("WhaleHall reflection runtime endpoint policy", () => {
	test("keeps model input on loopback by default", () => {
		expect(() => new ModernBertHttpClient()).not.toThrow();
	});

	test("requires an exact HTTPS allowlist entry for a remote deployment", () => {
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "https://models.example.test/v1/reflections:infer",
				}),
		).toThrow("allowlisted");
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "https://models.example.test/v1/reflections:infer",
					allowedOrigins: ["https://models.example.test"],
				}),
		).not.toThrow();
	});
});
