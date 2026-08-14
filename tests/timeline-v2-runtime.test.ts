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
	ModernBertClassifierError,
	SwitchableTimelineEpisodeClassifier,
	createTimelineV2Runtime,
	type ModernBertArtifactManifestV1,
	type ModernBertEpisodeClassifier,
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
		artifactId: `modernbert_episode_${"a".repeat(64)}`,
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

	test("atomically falls back when an active artifact loses trust", async () => {
		const invalidations: unknown[] = [];
		let modernCalls = 0;
		const fakeModernBert = {
			artifactVerified: false,
			async classify() {
				modernCalls += 1;
				throw new ModernBertClassifierError(
					"artifact_response_mismatch",
					"swapped listener",
					true,
				);
			},
		} as unknown as ModernBertEpisodeClassifier;
		const classifier = new SwitchableTimelineEpisodeClassifier(
			(error) => invalidations.push(error),
		);
		classifier.useModernBert(fakeModernBert);

		await expect(classifier.classify([], null)).resolves.toMatchObject({
			activity: "other_unknown",
			abstain: true,
			modelVersion: "deterministic-cold-start.v2",
		});
		await expect(classifier.classify([], null)).resolves.toMatchObject({
			modelVersion: "deterministic-cold-start.v2",
		});
		expect(modernCalls).toBe(1);
		expect(invalidations).toHaveLength(1);
	});

	test("promotes after one bounded transient manifest retry", async () => {
		const expected = modernBertManifest();
		let manifestCalls = 0;
		let releaseSecondCall: (() => void) | null = null;
		const secondCall = new Promise<void>((resolve) => {
			releaseSecondCall = resolve;
		});
		const runtime = await createTimelineV2Runtime({
			agent: {} as AgentRuntime,
			dataDirectory: dataDirectory(),
			verifyTeacher: false,
			onError: () => {},
			modernBert: {
				enabled: true,
				endpoint:
					"http://127.0.0.1:9417/v2/episodes:classify",
				manifestEndpoint:
					"http://127.0.0.1:9417/v2/manifest",
				expectedArtifact: expected,
				verificationRetryDelaysMs: [1],
				fetch: async () => {
					manifestCalls += 1;
					if (manifestCalls === 1) {
						throw new Error("transient startup failure");
					}
					releaseSecondCall?.();
					return Response.json(expected);
				},
			},
		});
		runtimes.push(runtime);
		expect(runtime.episodeClassifier).toMatchObject({
			artifactVerified: false,
			activeClassifier: "deterministic-cold-start",
			code: "modernbert.transport_error",
		});

		await secondCall;
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(manifestCalls).toBe(2);
		expect(runtime.episodeClassifier).toEqual({
			configured: true,
			artifactVerified: true,
			activeClassifier: "modernbert",
			modelVersion: "modernbert-runtime-test",
			code: null,
		});
	});

	test("explicit metadata refresh demotes on failure and can safely promote later", async () => {
		const expected = modernBertManifest();
		let mode: "ready" | "offline" = "ready";
		const runtime = await createTimelineV2Runtime({
			agent: {} as AgentRuntime,
			dataDirectory: dataDirectory(),
			verifyTeacher: false,
			onError: () => {},
			modernBert: {
				enabled: true,
				endpoint:
					"http://127.0.0.1:9417/v2/episodes:classify",
				manifestEndpoint:
					"http://127.0.0.1:9417/v2/manifest",
				expectedArtifact: expected,
				verificationRetryDelaysMs: [],
				fetch: async () => {
					if (mode === "offline") {
						throw new Error("offline");
					}
					return Response.json(expected);
				},
			},
		});
		runtimes.push(runtime);
		expect(runtime.episodeClassifier.artifactVerified).toBeTrue();

		mode = "offline";
		await expect(
			runtime.refreshEpisodeClassifier(),
		).resolves.toMatchObject({
			artifactVerified: false,
			activeClassifier: "deterministic-cold-start",
			code: "modernbert.transport_error",
		});
		mode = "ready";
		await expect(
			runtime.refreshEpisodeClassifier(),
		).resolves.toMatchObject({
			artifactVerified: true,
			activeClassifier: "modernbert",
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

	test("forwards the exact abort signal through switchable active and fallback classifiers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const fakeModernBert = {
			artifactVerified: true,
			async classify(
				_facts: unknown,
				_goal: unknown,
				_context: unknown,
				signal?: AbortSignal,
			) {
				receivedSignal = signal;
				return {
					activity: "development" as const,
					goalRelevance: null,
					confidence: 0.8,
					entropy: 0.2,
					oodScore: 0.1,
					abstain: false,
					modelVersion: "modernbert-test",
				};
			},
		} as unknown as ModernBertEpisodeClassifier;
		const classifier = new SwitchableTimelineEpisodeClassifier();
		classifier.useModernBert(fakeModernBert);
		const controller = new AbortController();
		await classifier.classify([], null, undefined, controller.signal);
		expect(receivedSignal).toBe(controller.signal);

		classifier.useFallback();
		controller.abort(new DOMException("shutdown", "AbortError"));
		await expect(
			classifier.classify([], null, undefined, controller.signal),
		).rejects.toHaveProperty("name", "AbortError");
	});

	test("does not close its repository before blocked service shutdown settles", async () => {
		const runtime = await createTimelineV2Runtime({
			agent: {} as AgentRuntime,
			dataDirectory: dataDirectory(),
			verifyTeacher: false,
		});
		runtimes.push(runtime);
		let releaseStop: () => void = () => {
			throw new Error("stop gate was not initialized");
		};
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		runtime.service.stop = () => stopGate;
		const originalRepositoryClose = runtime.repository.close.bind(
			runtime.repository,
		);
		let repositoryCloseCount = 0;
		runtime.repository.close = () => {
			repositoryCloseCount += 1;
			originalRepositoryClose();
		};

		const closing = runtime.close();
		expect(await runtime.service.runJobsNow()).toBe(0);
		await Promise.resolve();
		expect(repositoryCloseCount).toBe(0);
		releaseStop();
		await closing;
		expect(repositoryCloseCount).toBe(1);
		await runtime.close();
		expect(repositoryCloseCount).toBe(1);
	});
});
