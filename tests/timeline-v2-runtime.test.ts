import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "../src/agent/agent-runtime";
import { WHALEHALL_TEACHER_MODEL_LOCK } from "../src/agent/model/ollama-model-lock";
import {
	createTimelineV2Runtime,
	type TimelineV2Runtime,
} from "../src/agent/timeline-v2";

const directories: string[] = [];
const runtimes: TimelineV2Runtime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function dataDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "whalehall-qwen-runtime-"));
	directories.push(directory);
	return directory;
}

function lockedMetadata(input: string | URL | Request): Response | null {
	const url = String(input);
	if (url.endsWith("/api/version")) {
		return Response.json({
			version: WHALEHALL_TEACHER_MODEL_LOCK.ollamaVersion,
		});
	}
	if (url.endsWith("/api/tags")) {
		return Response.json({
			models: [
				{
					name: WHALEHALL_TEACHER_MODEL_LOCK.model,
					digest: WHALEHALL_TEACHER_MODEL_LOCK.digest,
					details: {
						parameter_size:
							WHALEHALL_TEACHER_MODEL_LOCK.parameterSize,
						quantization_level:
							WHALEHALL_TEACHER_MODEL_LOCK.quantizationLevel,
					},
				},
			],
		});
	}
	return null;
}

describe("Timeline v2 Qwen runtime readiness", () => {
	test("keeps the verified lock distinct from a failed production-schema probe", async () => {
		const errors: unknown[] = [];
		const runtime = await createTimelineV2Runtime({
			agent: {} as AgentRuntime,
			dataDirectory: dataDirectory(),
			onError: (error) => errors.push(error),
			teacherFetch: async (input) =>
				lockedMetadata(input) ??
				Response.json({ message: { content: "{}" } }),
		});
		runtimes.push(runtime);

		expect(runtime.modelLockVerified).toBeTrue();
		expect(runtime.teacherVerified).toBeTrue();
		expect(runtime.inferenceReady).toBeFalse();
		expect(runtime.diagnostics).toEqual([
			{
				source: "qwen3:4b",
				stage: "readiness_probe",
				code: "ollama.schema_mismatch",
				retryable: true,
				httpStatus: null,
				affectedEpisodeCount: null,
			},
		]);
		expect(errors).toHaveLength(1);
	});

	test("enables Qwen only after the synthetic production-schema probe succeeds", async () => {
		let chatCalls = 0;
		const runtime = await createTimelineV2Runtime({
			agent: {} as AgentRuntime,
			dataDirectory: dataDirectory(),
			teacherFetch: async (input, init) => {
				const metadata = lockedMetadata(input);
				if (metadata) return metadata;
				chatCalls += 1;
				const body = JSON.parse(String(init?.body)) as {
					format: unknown;
					messages: Array<{ content: string }>;
					options: { num_predict?: number };
				};
				expect(JSON.stringify(body.format)).not.toContain('"pattern"');
				expect(body.messages[1]!.content).toContain('"episodeId":"e1"');
				expect(body.options.num_predict).toBeGreaterThan(0);
				return Response.json({
					message: {
						content: JSON.stringify({
							episodes: [
								{
									episodeId: "e1",
									hypothesis: "可能在进行当前可见操作",
									citedFactIds: ["f1"],
								},
							],
						}),
					},
				});
			},
		});
		runtimes.push(runtime);

		expect(chatCalls).toBe(1);
		expect(runtime.modelLockVerified).toBeTrue();
		expect(runtime.teacherVerified).toBeTrue();
		expect(runtime.inferenceReady).toBeTrue();
		expect(runtime.diagnostics).toEqual([]);
	});
});
