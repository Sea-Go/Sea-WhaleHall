import { describe, expect, test } from "bun:test";
import {
	OllamaModelLockError,
	verifyOllamaModelLock,
	WHALEHALL_TEACHER_MODEL_LOCK,
} from "../src/agent/model/ollama-model-lock";

describe("verifyOllamaModelLock", () => {
	test("accepts the exact reviewed version, digest, size, and quantization", async () => {
		const fetch = async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/version")) {
				return Response.json({
					version: WHALEHALL_TEACHER_MODEL_LOCK.ollamaVersion,
				});
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
				return Response.json({
					version: WHALEHALL_TEACHER_MODEL_LOCK.ollamaVersion,
				});
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

	test("rejects untrusted metadata before it can enter an error message", async () => {
		const untrustedDigest = `digest\\n${"a".repeat(2_000)}`;
		const fetch = async (input: string | URL | Request): Promise<Response> => {
			if (String(input).endsWith("/api/version")) {
				return Response.json({
					version: WHALEHALL_TEACHER_MODEL_LOCK.ollamaVersion,
				});
			}
			return Response.json({
				models: [
					{
						name: WHALEHALL_TEACHER_MODEL_LOCK.model,
						digest: untrustedDigest,
						details: {
							parameter_size: WHALEHALL_TEACHER_MODEL_LOCK.parameterSize,
							quantization_level:
								WHALEHALL_TEACHER_MODEL_LOCK.quantizationLevel,
						},
					},
				],
			});
		};
		let observed: unknown;
		try {
			await verifyOllamaModelLock(WHALEHALL_TEACHER_MODEL_LOCK, { fetch });
		} catch (error) {
			observed = error;
		}
		expect(observed).toBeInstanceOf(OllamaModelLockError);
		expect((observed as Error).message).toContain("invalid metadata");
		expect((observed as Error).message).not.toContain(untrustedDigest);
	});

	test("rejects unallowlisted remote lock destinations before any request", async () => {
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
		).rejects.toThrow("allowlisted");
		expect(calls).toBe(0);
	});

	test("uses an allowlisted HTTPS destination and environment-only token", async () => {
		const authorizations: string[] = [];
		await expect(
			verifyOllamaModelLock(
				{
					...WHALEHALL_TEACHER_MODEL_LOCK,
					baseUrl: "https://models.example.test",
				},
				{
					allowedRemoteOrigins: ["https://models.example.test"],
					authorizationToken: "remote-only-token",
					fetch: async (input, init) => {
						authorizations.push(
							new Headers(init?.headers).get("authorization") ?? "",
						);
						if (String(input).endsWith("/api/version")) {
							return Response.json({
								version: WHALEHALL_TEACHER_MODEL_LOCK.ollamaVersion,
							});
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
					},
				},
			),
		).resolves.toMatchObject({ model: WHALEHALL_TEACHER_MODEL_LOCK.model });
		expect(authorizations).toEqual([
			"Bearer remote-only-token",
			"Bearer remote-only-token",
		]);
	});
});
