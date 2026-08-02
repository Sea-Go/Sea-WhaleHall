import { describe, expect, test } from "bun:test";
import {
	OllamaModelLockError,
	WHALEHALL_TEACHER_MODEL_LOCK,
	verifyOllamaModelLock,
} from "../src/agent/model/ollama-model-lock";

describe("verifyOllamaModelLock", () => {
	test("accepts the exact reviewed version, digest, size, and quantization", async () => {
		const fetch = async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/version")) {
				return Response.json({ version: WHALEHALL_TEACHER_MODEL_LOCK.ollamaVersion });
			}
			return Response.json({
				models: [
					{
						name: WHALEHALL_TEACHER_MODEL_LOCK.model,
						digest: WHALEHALL_TEACHER_MODEL_LOCK.digest,
						details: {
							parameter_size: WHALEHALL_TEACHER_MODEL_LOCK.parameterSize,
							quantization_level:
								WHALEHALL_TEACHER_MODEL_LOCK.quantizationLevel,
						},
					},
				],
			});
		};
		await expect(
			verifyOllamaModelLock(WHALEHALL_TEACHER_MODEL_LOCK, { fetch }),
		).resolves.toMatchObject({
			model: "qwen3:4b",
			quantizationLevel: "Q4_K_M",
		});
	});

	test("fails closed on a changed model digest", async () => {
		const fetch = async (input: string | URL | Request): Promise<Response> => {
			if (String(input).endsWith("/api/version")) {
				return Response.json({ version: WHALEHALL_TEACHER_MODEL_LOCK.ollamaVersion });
			}
			return Response.json({
				models: [
					{
						name: WHALEHALL_TEACHER_MODEL_LOCK.model,
						digest: "changed",
						details: {
							parameter_size: WHALEHALL_TEACHER_MODEL_LOCK.parameterSize,
							quantization_level:
								WHALEHALL_TEACHER_MODEL_LOCK.quantizationLevel,
						},
					},
				],
			});
		};
		await expect(
			verifyOllamaModelLock(WHALEHALL_TEACHER_MODEL_LOCK, { fetch }),
		).rejects.toBeInstanceOf(OllamaModelLockError);
	});

	test("rejects non-loopback lock destinations before any request", async () => {
		let calls = 0;
		await expect(
			verifyOllamaModelLock(
				{ ...WHALEHALL_TEACHER_MODEL_LOCK, baseUrl: "https://example.com" },
				{
					fetch: async () => {
						calls += 1;
						return new Response();
					},
				},
			),
		).rejects.toThrow("loopback");
		expect(calls).toBe(0);
	});
});
