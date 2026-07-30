import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "../src/agent/agent-runtime";
import { WHALEHALL_TEACHER_MODEL_LOCK } from "../src/agent/model/ollama-model-lock";
import {
	AGENT_INPUT_QUERY_REQUEST_VERSION,
	MODERNBERT_ACTIVITY_LABELS,
	MODERNBERT_EVIDENCE_PROJECTOR_VERSION,
	MODERNBERT_GOAL_RELEVANCE_LABELS,
	MODERNBERT_INPUT_SCHEMA_VERSION,
	MODERNBERT_MANIFEST_SCHEMA_VERSION,
	MODERNBERT_MODEL_INPUT_FORMAT,
	MODERNBERT_REQUEST_SCHEMA_VERSION,
	MODERNBERT_RESPONSE_SCHEMA_VERSION,
	MODERNBERT_RUNTIME_SCHEMA_VERSION,
	createTimelineV2Runtime,
	type ModernBertArtifactManifestV1,
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

function modernBertManifest(): ModernBertArtifactManifestV1 {
	return {
		schemaVersion: MODERNBERT_MANIFEST_SCHEMA_VERSION,
		artifactId: "runtime-test-artifact",
		artifactSha256: "a".repeat(64),
		runtime: {
			schemaVersion: MODERNBERT_RUNTIME_SCHEMA_VERSION,
			modelVersion: "modernbert-runtime-test",
			modelFamily: "ModernBERT",
			maximumTokens: 8_192,
			tokenizerSha256: "b".repeat(64),
			inputFormat: MODERNBERT_MODEL_INPUT_FORMAT,
			projectorVersion: MODERNBERT_EVIDENCE_PROJECTOR_VERSION,
			architecture: {
				activityClasses: 12,
				relevanceClasses: 4,
				embeddingDimensions: 256,
				heads: [
					"boundary",
					"activity",
					"relevance",
					"evidence",
					"summary",
					"embedding",
				],
			},
			taxonomy: {
				version: "activity-taxonomy.v2",
				activities: [...MODERNBERT_ACTIVITY_LABELS],
				goalRelevance: [
					...MODERNBERT_GOAL_RELEVANCE_LABELS,
				],
			},
			oodScoring:
				"calibrated-energy-plus-cluster-distance.v1",
			calibrationVersion: "temperature-scaling.v1",
		},
		requestSchemaVersion: MODERNBERT_REQUEST_SCHEMA_VERSION,
		inputSchemaVersion: MODERNBERT_INPUT_SCHEMA_VERSION,
		responseSchemaVersion: MODERNBERT_RESPONSE_SCHEMA_VERSION,
		maximumFacts: 64,
		maximumInputBytes: 64 * 1024,
	};
}

describe("Timeline v2 model runtime readiness", () => {
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

	test("keeps episode classification on deterministic cold-start by default", async () => {
		const runtime = await createTimelineV2Runtime({
			agent: {} as AgentRuntime,
			dataDirectory: dataDirectory(),
			verifyTeacher: false,
		});
		runtimes.push(runtime);

		expect(runtime.episodeClassifier).toEqual({
			configured: false,
			artifactVerified: false,
			activeClassifier: "deterministic-cold-start",
			modelVersion: "deterministic-cold-start.v2",
			code: "disabled",
		});
		expect(
			await runtime.agentInput.query({
				schemaVersion: AGENT_INPUT_QUERY_REQUEST_VERSION,
			}),
		).toEqual({
			schemaVersion: "agent-input.query-result.v1",
			inputs: [],
		});
	});

	test("activates ModernBERT only after the pinned deployment manifest verifies", async () => {
		const expected = modernBertManifest();
		let manifestCalls = 0;
		const runtime = await createTimelineV2Runtime({
			agent: {} as AgentRuntime,
			dataDirectory: dataDirectory(),
			verifyTeacher: false,
			modernBert: {
				enabled: true,
				endpoint:
					"http://127.0.0.1:9417/v1/episodes:classify",
				manifestEndpoint:
					"http://127.0.0.1:9417/manifest",
				expectedArtifact: expected,
				fetch: async () => {
					manifestCalls += 1;
					return Response.json(expected);
				},
			},
		});
		runtimes.push(runtime);

		expect(manifestCalls).toBe(1);
		expect(runtime.episodeClassifier).toEqual({
			configured: true,
			artifactVerified: true,
			activeClassifier: "modernbert",
			modelVersion: "modernbert-runtime-test",
			code: null,
		});
	});

	test("records a content-free verification code and retains cold-start on mismatch", async () => {
		const expected = modernBertManifest();
		const errors: unknown[] = [];
		let manifestCalls = 0;
		const runtime = await createTimelineV2Runtime({
			agent: {} as AgentRuntime,
			dataDirectory: dataDirectory(),
			verifyTeacher: false,
			onError: (error) => errors.push(error),
			modernBert: {
				enabled: true,
				endpoint:
					"http://127.0.0.1:9417/v1/episodes:classify",
				manifestEndpoint:
					"http://127.0.0.1:9417/manifest",
				expectedArtifact: expected,
				fetch: async () => {
					manifestCalls += 1;
					return Response.json({
						...expected,
						artifactSha256: "c".repeat(64),
					});
				},
			},
		});
		runtimes.push(runtime);

		expect(runtime.episodeClassifier).toEqual({
			configured: true,
			artifactVerified: false,
			activeClassifier: "deterministic-cold-start",
			modelVersion: "deterministic-cold-start.v2",
			code: "modernbert.artifact_manifest_mismatch",
		});
		expect(errors).toHaveLength(1);
		expect(manifestCalls).toBe(1);
		expect(JSON.stringify(runtime.episodeClassifier)).not.toContain(
			"artifactSha256",
		);
	});
});
