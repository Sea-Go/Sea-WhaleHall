import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ActiveGoalContextV1 } from "../src/agent/reflection/types";
import { canonicalJson } from "../src/agent/reflection/hash";
import {
	MODERNBERT_ACTIVITY_LABELS,
	MODERNBERT_CHUNKING_STRATEGY,
	MODERNBERT_CHUNK_MERGE_VERSION,
	MODERNBERT_CONTEXT_ONLY_MAXIMUM_TOKENS,
	MODERNBERT_EVIDENCE_PROJECTOR_VERSION,
	MODERNBERT_GOAL_RELEVANCE_LABELS,
	MODERNBERT_INPUT_SCHEMA_VERSION,
	MODERNBERT_MANIFEST_SCHEMA_VERSION,
	MODERNBERT_MODEL_INPUT_FORMAT,
	MODERNBERT_REQUEST_SCHEMA_VERSION,
	MODERNBERT_RESPONSE_SCHEMA_VERSION,
	MODERNBERT_RUNTIME_SCHEMA_VERSION,
	ModernBertClassifierError,
	ModernBertEpisodeClassifier,
	estimateModernBertContextTokens,
	projectModernBertModelInput,
	type EvidenceFactV2,
	type ModernBertArtifactManifestV1,
	type ModernBertClassificationRequest,
	type ModernBertClassifierOptions,
	type ModernBertEpisodeInput,
	type TimelineEpisodeClassificationContext,
} from "../src/agent/timeline-v2";

const MANIFEST_URL = "http://127.0.0.1:9417/manifest";
const INFERENCE_URL = "http://127.0.0.1:9417/v1/episodes:classify";

function manifest(
	overrides: Partial<ModernBertArtifactManifestV1> = {},
): ModernBertArtifactManifestV1 {
	return {
		schemaVersion: MODERNBERT_MANIFEST_SCHEMA_VERSION,
		artifactId: `modernbert_episode_${"a".repeat(64)}`,
		artifactSha256: "a".repeat(64),
		runtime: {
			schemaVersion: MODERNBERT_RUNTIME_SCHEMA_VERSION,
			modelVersion: "modernbert-whalehall-episode-v2-test",
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
		...overrides,
	};
}

function fact(
	index = 1,
	overrides: Partial<EvidenceFactV2> = {},
): EvidenceFactV2 {
	return {
		schemaVersion: "evidence-fact.v2",
		factId: `fact-${index}`,
		eventIds: [`event-${index}`],
		sourceObservationIds: [`observation-${index}`],
		startedAtMs: index * 1_000,
		endedAtMs: index * 1_000 + 500,
		templateCode: "browser.visible_page",
		templateArgs: {
			appId: "com.example.Browser",
			appName: "Browser",
			title: "ModernBERT contract",
		},
		renderedText: "浏览器显示 ModernBERT contract。",
		anchor: {
			appId: "com.example.Browser",
			windowId: "window-1",
			documentId: null,
			pageId: "page-1",
		},
		role: "primary",
		reliability: "high",
		coverage: ["content", "metadata"],
		...overrides,
	};
}

function goal(): ActiveGoalContextV1 {
	return {
		goalId: "goal-1",
		planId: null,
		version: 3,
		text: "完成 Timeline v2 分类适配器",
		activatedAtMs: 500,
	};
}

function classificationContext(
	overrides: Partial<TimelineEpisodeClassificationContext> = {},
): TimelineEpisodeClassificationContext {
	return {
		windowId: "timeline-window-1",
		triggerReason: "event_count",
		startedAtMs: 1_000,
		endedAtMs: 20_000,
		eventCount: 64,
		contextOnlyFacts: [],
		...overrides,
	};
}

function activityProbabilities(): Record<
	(typeof MODERNBERT_ACTIVITY_LABELS)[number],
	number
> {
	return {
		development: 0.7,
		writing: 0,
		research: 0.3,
		communication: 0,
		planning: 0,
		data_work: 0,
		media: 0,
		gaming: 0,
		system_file_ops: 0,
		commerce: 0,
		idle_transition: 0,
		other_unknown: 0,
	};
}

function relevanceProbabilities(): Record<
	(typeof MODERNBERT_GOAL_RELEVANCE_LABELS)[number],
	number
> {
	return {
		direct: 0.6,
		supporting: 0.2,
		unrelated: 0.1,
		uncertain: 0.1,
	};
}

type CapturedRequest = ModernBertClassificationRequest;

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(value)
		.digest("hex");
}

function validResponse(
	request: CapturedRequest,
	hasGoal: boolean,
): Record<string, unknown> {
	const coreFactIds = request.input.facts.map((fact) => fact.factId);
	const modelInput = projectModernBertModelInput(request.input);
	return {
		schemaVersion: MODERNBERT_RESPONSE_SCHEMA_VERSION,
		correlationId: request.correlationId,
		inputHash: request.inputHash,
		artifact: request.artifact,
		analysis: {
			projectorVersion: MODERNBERT_EVIDENCE_PROJECTOR_VERSION,
			strategy: MODERNBERT_CHUNKING_STRATEGY,
			merge: MODERNBERT_CHUNK_MERGE_VERSION,
			projectedTokenCount: 256,
			chunkCount: 1,
			chunks: [
				{
					chunkIndex: 0,
					coreFactIds,
					overlapFactIds: [],
					tokenCount: 256,
					modelInputHash: sha256(modelInput),
				},
			],
		},
		classification: {
			activity: "development",
			activityProbabilities: activityProbabilities(),
			goalRelevance: hasGoal ? "direct" : null,
			goalRelevanceProbabilities: hasGoal
				? relevanceProbabilities()
				: null,
			confidence: 0.7,
			entropy: 0.4,
			oodScore: 0.2,
			abstain: false,
		},
	};
}

function chunkedResponse(
	request: CapturedRequest,
	hasGoal: boolean,
	coreEndIndex: number,
): Record<string, unknown> {
	const response = validResponse(request, hasGoal);
	const firstCore = request.input.facts.slice(0, coreEndIndex);
	const secondCore = request.input.facts.slice(coreEndIndex);
	const overlap = request.input.facts.slice(
		Math.max(0, coreEndIndex - 5),
		coreEndIndex,
	).slice(-3);
	response.analysis = {
		projectorVersion: MODERNBERT_EVIDENCE_PROJECTOR_VERSION,
		strategy: MODERNBERT_CHUNKING_STRATEGY,
		merge: MODERNBERT_CHUNK_MERGE_VERSION,
		projectedTokenCount: 8_700,
		chunkCount: 2,
		chunks: [
			{
				chunkIndex: 0,
				coreFactIds: firstCore.map((fact) => fact.factId),
				overlapFactIds: [],
				tokenCount: 7_900,
				modelInputHash: sha256(
					projectModernBertModelInput(
						request.input,
						firstCore,
					),
				),
			},
			{
				chunkIndex: 1,
				coreFactIds: secondCore.map((fact) => fact.factId),
				overlapFactIds: overlap.map((fact) => fact.factId),
				tokenCount: 7_200,
				modelInputHash: sha256(
					projectModernBertModelInput(request.input, [
						...overlap,
						...secondCore,
					]),
				),
			},
		],
	};
	return response;
}

function options(
	fetch: NonNullable<ModernBertClassifierOptions["fetch"]>,
	expectedArtifact = manifest(),
	overrides: Partial<ModernBertClassifierOptions> = {},
): ModernBertClassifierOptions {
	return {
		endpoint: INFERENCE_URL,
		manifestEndpoint: MANIFEST_URL,
		expectedArtifact,
		fetch,
		...overrides,
	};
}

async function classifierError(
	call: () => Promise<unknown>,
): Promise<ModernBertClassifierError> {
	try {
		await call();
		throw new Error("expected ModernBertClassifierError");
	} catch (error) {
		expect(error).toBeInstanceOf(ModernBertClassifierError);
		return error as ModernBertClassifierError;
	}
}

describe("Timeline v2 ModernBERT episode classifier", () => {
	test("matches the checked-in Python serving projector fixture byte for byte", () => {
		const fixture = JSON.parse(
			readFileSync(
				`${import.meta.dir}/fixtures/modernbert-episode-v2/canonical-input.json`,
				"utf8",
			),
		) as {
			input: ModernBertEpisodeInput;
			expectedInputHash: string;
			expectedModelInputSha256: string;
		};
		expect(sha256(canonicalJson(fixture.input))).toBe(
			fixture.expectedInputHash,
		);
		expect(
			sha256(projectModernBertModelInput(fixture.input)),
		).toBe(fixture.expectedModelInputSha256);
	});

	test("verifies the exact v2 artifact then sends only bounded facts and goal", async () => {
		const expected = manifest();
		let captured: CapturedRequest | null = null;
		const classifier = new ModernBertEpisodeClassifier(
			options(async (input, init) => {
				if (String(input) === MANIFEST_URL) {
					expect(init?.method).toBe("GET");
					return Response.json(expected);
				}
				expect(String(input)).toBe(INFERENCE_URL);
				expect(init?.method).toBe("POST");
				captured = JSON.parse(
					String(init?.body),
				) as CapturedRequest;
				return Response.json(validResponse(captured, true));
			}, expected),
		);

		expect(classifier.artifactVerified).toBeFalse();
		await expect(
			classifier.classify(
				[fact()],
				goal(),
				classificationContext(),
			),
		).rejects.toMatchObject({ code: "artifact_not_verified" });
		await classifier.verifyArtifact();
		expect(classifier.artifactVerified).toBeTrue();
		const result = await classifier.classify(
			[fact()],
			goal(),
			classificationContext(),
		);

		expect(result).toEqual({
			activity: "development",
			goalRelevance: "direct",
			confidence: 0.7,
			entropy: 0.4,
			oodScore: 0.2,
			abstain: false,
			modelVersion: expected.runtime.modelVersion,
		});
		expect(captured).not.toBeNull();
		expect(Object.keys(captured!).sort()).toEqual(
			[
				"schemaVersion",
				"correlationId",
				"inputHash",
				"artifact",
				"input",
			].sort(),
		);
		expect(captured!.schemaVersion).toBe(
			MODERNBERT_REQUEST_SCHEMA_VERSION,
		);
		expect(captured!.input).toMatchObject({
			schemaVersion: MODERNBERT_INPUT_SCHEMA_VERSION,
			window: {
				windowId: "timeline-window-1",
				triggerReason: "event_count",
				startedAtMs: 1_000,
				endedAtMs: 20_000,
			},
			contextOnlyFacts: [],
			goal: {
				goalId: "goal-1",
				version: 3,
				text: "完成 Timeline v2 分类适配器",
			},
		});
		expect(captured!.input.facts).toHaveLength(1);
		const serialized = JSON.stringify(captured);
		expect(serialized).not.toContain("hypothesis");
		expect(serialized).not.toContain("qwen");
	});

	test("keeps shared artifact verification independent from each caller signal", async () => {
		const expected = manifest();
		let releaseManifest: () => void = () => {
			throw new Error("manifest gate was not initialized");
		};
		const manifestGate = new Promise<void>((resolve) => {
			releaseManifest = resolve;
		});
		let markManifestRequested: () => void = () => {
			throw new Error("manifest request gate was not initialized");
		};
		const manifestRequested = new Promise<void>((resolve) => {
			markManifestRequested = resolve;
		});
		let manifestCalls = 0;
		let underlyingSignal: AbortSignal | null | undefined;
		const classifier = new ModernBertEpisodeClassifier(
			options(async (_input, init) => {
				manifestCalls += 1;
				underlyingSignal = init?.signal;
				markManifestRequested();
				await manifestGate;
				return Response.json(expected);
			}, expected),
		);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = classifier.verifyArtifact(firstController.signal);
		const second = classifier.verifyArtifact(secondController.signal);
		await manifestRequested;

		firstController.abort(new DOMException("first caller left", "AbortError"));
		expect(underlyingSignal?.aborted).toBeFalse();
		expect((await classifierError(() => first)).code).toBe(
			"request_cancelled",
		);
		expect(manifestCalls).toBe(1);
		expect(underlyingSignal).not.toBe(firstController.signal);
		expect(underlyingSignal).not.toBe(secondController.signal);
		releaseManifest();

		await expect(second).resolves.toBeUndefined();
		expect(classifier.artifactVerified).toBeTrue();
	});

	test("rejects mismatched manifests and forged response correlation/artifact", async () => {
		const expected = manifest();
		let postMode: "correlation" | "input_hash" | "artifact" =
			"correlation";
		let postCalls = 0;
		const classifier = new ModernBertEpisodeClassifier(
			options(async (input, init) => {
				if (String(input) === MANIFEST_URL) {
					return Response.json(expected);
				}
				postCalls += 1;
				const request = JSON.parse(
					String(init?.body),
				) as CapturedRequest;
				const response = validResponse(request, true);
				if (postMode === "correlation") {
					response.correlationId = `mbc1_${"f".repeat(64)}`;
				} else if (postMode === "input_hash") {
					response.inputHash = "f".repeat(64);
				} else {
					response.artifact = {
						...request.artifact,
						artifactId: `modernbert_episode_${"f".repeat(64)}`,
						artifactSha256: "f".repeat(64),
					};
				}
				return Response.json(response);
			}, expected),
		);
		await classifier.verifyArtifact();

		expect(
			(await classifierError(() =>
				classifier.classify(
					[fact()],
					goal(),
					classificationContext(),
				),
			)).code,
		).toBe("correlation_mismatch");
		expect(classifier.artifactVerified).toBeFalse();
		await classifier.verifyArtifact();
		postMode = "input_hash";
		expect(
			(await classifierError(() =>
				classifier.classify(
					[fact()],
					goal(),
					classificationContext(),
				),
			)).code,
		).toBe("correlation_mismatch");
		expect(classifier.artifactVerified).toBeFalse();
		await classifier.verifyArtifact();
		postMode = "artifact";
		expect(
			(await classifierError(() =>
				classifier.classify(
					[fact()],
					goal(),
					classificationContext(),
				),
			)).code,
		).toBe("artifact_response_mismatch");
		expect(classifier.artifactVerified).toBeFalse();
		expect(postCalls).toBe(3);

		const forgedManifest = {
			...expected,
			artifactSha256: "c".repeat(64),
		};
		let forgedPosts = 0;
		const unverified = new ModernBertEpisodeClassifier(
			options(async (input) => {
				if (String(input) === MANIFEST_URL) {
					return Response.json(forgedManifest);
				}
				forgedPosts += 1;
				return Response.json({});
			}, expected),
		);
		expect(
			(await classifierError(() =>
				unverified.verifyArtifact(),
			)).code,
		).toBe("artifact_manifest_mismatch");
		expect(unverified.artifactVerified).toBeFalse();
		expect(forgedPosts).toBe(0);
	});

	test("invalidates a stale verified listener before any later fact POST", async () => {
		const expected = manifest();
		let servingExpectedArtifact = false;
		let manifestCalls = 0;
		let postCalls = 0;
		const classifier = new ModernBertEpisodeClassifier(
			options(async (input, init) => {
				if (String(input) === MANIFEST_URL) {
					manifestCalls += 1;
					return Response.json(expected);
				}
				expect(init?.method).toBe("POST");
				postCalls += 1;
				const request = JSON.parse(
					String(init?.body),
				) as CapturedRequest;
				const response = validResponse(request, true);
				if (!servingExpectedArtifact) {
					response.artifact = {
						...request.artifact,
						artifactId: `modernbert_episode_${"c".repeat(64)}`,
						artifactSha256: "c".repeat(64),
					};
				}
				return Response.json(response);
			}, expected),
		);
		await classifier.verifyArtifact();

		expect(
			(await classifierError(() =>
				classifier.classify(
					[fact()],
					goal(),
					classificationContext(),
				),
			)).code,
		).toBe("artifact_response_mismatch");
		expect(classifier.artifactVerified).toBeFalse();
		expect(postCalls).toBe(1);

		expect(
			(await classifierError(() =>
				classifier.classify(
					[fact()],
					goal(),
					classificationContext(),
				),
			)).code,
		).toBe("artifact_not_verified");
		expect(postCalls).toBe(1);

		servingExpectedArtifact = true;
		await classifier.verifyArtifact();
		await expect(
			classifier.classify(
				[fact()],
				goal(),
				classificationContext(),
			),
		).resolves.toMatchObject({
			modelVersion: expected.runtime.modelVersion,
		});
		expect(manifestCalls).toBe(2);
		expect(postCalls).toBe(2);
	});

	test("strictly validates probability keys, sums, labels, and scalar bounds", async () => {
		const expected = manifest();
		const mutations: Array<(response: Record<string, unknown>) => void> = [
			(response) => {
				const classification = response.classification as Record<
					string,
					unknown
				>;
				classification.activityProbabilities = {
					...activityProbabilities(),
					development: 0.8,
				};
			},
			(response) => {
				const classification = response.classification as Record<
					string,
					unknown
				>;
				classification.activityProbabilities = {
					...activityProbabilities(),
					forged: 0,
				};
			},
			(response) => {
				const classification = response.classification as Record<
					string,
					unknown
				>;
				classification.activity = "writing";
			},
			(response) => {
				const classification = response.classification as Record<
					string,
					unknown
				>;
				classification.confidence = 1.01;
			},
			(response) => {
				const classification = response.classification as Record<
					string,
					unknown
				>;
				classification.entropy = -0.01;
			},
			(response) => {
				const classification = response.classification as Record<
					string,
					unknown
				>;
				classification.oodScore = Number.NaN;
			},
		];
		let mutationIndex = 0;
		const classifier = new ModernBertEpisodeClassifier(
			options(async (input, init) => {
				if (String(input) === MANIFEST_URL) {
					return Response.json(expected);
				}
				const request = JSON.parse(
					String(init?.body),
				) as CapturedRequest;
				const response = validResponse(request, true);
				mutations[mutationIndex++]?.(response);
				return Response.json(response);
			}, expected),
		);
		await classifier.verifyArtifact();
		for (const _mutation of mutations) {
			if (!classifier.artifactVerified) {
				await classifier.verifyArtifact();
			}
			expect(
				(await classifierError(() =>
					classifier.classify(
						[fact()],
						goal(),
						classificationContext(),
					),
				)).code,
			).toBe("schema_mismatch");
		}
	});

	test("requires null relevance without a goal and accepts the exact null response", async () => {
		const expected = manifest();
		let forgeRelevance = false;
		let capturedGoal: unknown = undefined;
		const classifier = new ModernBertEpisodeClassifier(
			options(async (input, init) => {
				if (String(input) === MANIFEST_URL) {
					return Response.json(expected);
				}
				const request = JSON.parse(
					String(init?.body),
				) as CapturedRequest;
				capturedGoal = request.input.goal;
				const response = validResponse(request, false);
				if (forgeRelevance) {
					const classification =
						response.classification as Record<string, unknown>;
					classification.goalRelevance = "uncertain";
					classification.goalRelevanceProbabilities =
						relevanceProbabilities();
				}
				return Response.json(response);
			}, expected),
		);
		await classifier.verifyArtifact();
		expect(
			await classifier.classify(
				[fact()],
				null,
				classificationContext(),
			),
		).toMatchObject({
			goalRelevance: null,
		});
		expect(capturedGoal).toBeNull();

		forgeRelevance = true;
		expect(
			(await classifierError(() =>
				classifier.classify(
					[fact()],
					null,
					classificationContext(),
				),
			)).code,
		).toBe("schema_mismatch");
	});

	test("cancels an active request even when fetch ignores AbortSignal", async () => {
		const expected = manifest();
		let markInferenceEntered: () => void = () => {
			throw new Error("inference gate was not initialized");
		};
		const inferenceEntered = new Promise<void>((resolve) => {
			markInferenceEntered = resolve;
		});
		const classifier = new ModernBertEpisodeClassifier(
			options(async (input) => {
				if (String(input) === MANIFEST_URL) return Response.json(expected);
				markInferenceEntered();
				return new Promise<Response>(() => {
					// Deliberately ignores AbortSignal.
				});
			}, expected),
		);
		await classifier.verifyArtifact();
		const controller = new AbortController();
		const classifying = classifier.classify(
			[fact()],
			goal(),
			classificationContext(),
			controller.signal,
		);
		await inferenceEntered;
		controller.abort(new DOMException("shutdown", "AbortError"));
		expect((await classifierError(() => classifying)).code).toBe(
			"request_cancelled",
		);
		expect(classifier.artifactVerified).toBeTrue();
	});

	test("times out independently of fetch cooperation and rejects oversized responses", async () => {
		const expected = manifest();
		const timedOut = new ModernBertEpisodeClassifier(
			options(
				async () =>
					new Promise<Response>(() => {
						// Deliberately ignores AbortSignal.
					}),
				expected,
				{ timeoutMs: 5 },
			),
		);
		expect(
			(await classifierError(() =>
				timedOut.verifyArtifact(),
			)).code,
		).toBe("request_timeout");

		const oversized = new ModernBertEpisodeClassifier(
			options(
				async (input) =>
					String(input) === MANIFEST_URL
						? Response.json(expected)
						: new Response("x".repeat(4_097), {
								headers: {
									"content-length": "4097",
								},
							}),
				expected,
				{ maximumResponseBytes: 4_096 },
			),
		);
		await oversized.verifyArtifact();
		expect(
			(await classifierError(() =>
				oversized.classify(
					[fact()],
					goal(),
					classificationContext(),
				),
			)).code,
		).toBe("response_too_large");

		let inferenceCall = false;
		const slowBody = new ModernBertEpisodeClassifier(
			options(
				async (input) => {
					if (String(input) === MANIFEST_URL) {
						return Response.json(expected);
					}
					inferenceCall = true;
					return new Response(
						new ReadableStream<Uint8Array>({
							pull() {
								// Never produces a body and ignores cancellation.
								return new Promise<void>(() => {});
							},
						}),
					);
				},
				expected,
				{ timeoutMs: 5 },
			),
		);
		await slowBody.verifyArtifact();
		expect(
			(await classifierError(() =>
				slowBody.classify(
					[fact()],
					goal(),
					classificationContext(),
				),
			)).code,
		).toBe("request_timeout");
		expect(inferenceCall).toBeTrue();

		const unreadableBody = new ModernBertEpisodeClassifier(
			options(async (input) => {
				if (String(input) === MANIFEST_URL) {
					return Response.json(expected);
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(
								new Error("secret body failure"),
							);
						},
					}),
				);
			}, expected),
		);
		await unreadableBody.verifyArtifact();
		const bodyError = await classifierError(() =>
			unreadableBody.classify(
				[fact()],
				goal(),
				classificationContext(),
			),
		);
		expect(bodyError.code).toBe("transport_error");
		expect(bodyError.message).not.toContain("secret body failure");
	});

	test("rejects byte/fact overflow but delegates exact token chunking without truncation", async () => {
		const expected = manifest({
			maximumFacts: 1,
			maximumInputBytes: 600,
		});
		let postCalls = 0;
		const classifier = new ModernBertEpisodeClassifier(
			options(async (input) => {
				if (String(input) === MANIFEST_URL) {
					return Response.json(expected);
				}
				postCalls += 1;
				return Response.json({});
			}, expected),
		);
		await classifier.verifyArtifact();
		expect(
			(await classifierError(() =>
				classifier.classify(
					[fact(1), fact(2)],
					goal(),
					classificationContext(),
				),
			)).code,
		).toBe("invalid_input");
		expect(
			(await classifierError(() =>
				classifier.classify(
					[
						fact(1, {
							renderedText: "字".repeat(1_000),
						}),
					],
					goal(),
					classificationContext(),
				),
			)).code,
		).toBe("input_too_large");
		expect(postCalls).toBe(0);

		const tokenExpected = manifest({
			runtime: {
				...manifest().runtime,
				maximumTokens: 512,
			},
		});
		let tokenPosts = 0;
		const tokenBounded = new ModernBertEpisodeClassifier(
			options(async (input, init) => {
				if (String(input) === MANIFEST_URL) {
					return Response.json(tokenExpected);
				}
				tokenPosts += 1;
				const request = JSON.parse(
					String(init?.body),
				) as CapturedRequest;
				return Response.json(validResponse(request, false));
			}, tokenExpected),
		);
		await tokenBounded.verifyArtifact();
		const sixtyFourFacts = Array.from({ length: 64 }, (_, index) =>
			fact(index + 1, {
				renderedText: `可见语义事件 ${index + 1}`,
			}),
		);
		await expect(
			tokenBounded.classify(
				sixtyFourFacts,
				null,
				classificationContext(),
			),
		).resolves.toMatchObject({ activity: "development" });
		expect(tokenPosts).toBe(1);

		const exactOverflow = new ModernBertEpisodeClassifier(
			options(async (input) =>
				String(input) === MANIFEST_URL
					? Response.json(tokenExpected)
					: new Response(null, { status: 413 }),
			tokenExpected),
		);
		await exactOverflow.verifyArtifact();
		expect(
			(await classifierError(() =>
				exactOverflow.classify(
					[fact()],
					null,
					classificationContext(),
				),
			)).code,
		).toBe("input_too_large");
	});

	test("passes authoritative window/context and validates complete event-boundary chunks", async () => {
		const expected = manifest();
		let tamperOverlap = false;
		let captured: CapturedRequest | null = null;
		const classifier = new ModernBertEpisodeClassifier(
			options(async (input, init) => {
				if (String(input) === MANIFEST_URL) {
					return Response.json(expected);
				}
				captured = JSON.parse(
					String(init?.body),
				) as CapturedRequest;
				const response = chunkedResponse(captured, true, 6);
				if (tamperOverlap) {
					const analysis = response.analysis as {
						chunks: Array<{ overlapFactIds: string[] }>;
					};
					analysis.chunks[1]!.overlapFactIds = ["fact-1"];
				}
				return Response.json(response);
			}, expected),
		);
		await classifier.verifyArtifact();
		const facts = Array.from({ length: 10 }, (_, index) =>
			fact(index + 1),
		);
		const contextFact = fact(0, {
			factId: "context-later",
			eventIds: ["context-event-later"],
			sourceObservationIds: ["context-observation-later"],
			startedAtMs: 1_000,
			endedAtMs: 1_000,
			renderedText: "上一窗口较晚到达的只读上下文",
		});
		const delayedContextFact = fact(0, {
			factId: "context-earlier",
			eventIds: ["context-event-earlier"],
			sourceObservationIds: ["context-observation-earlier"],
			startedAtMs: 900,
			endedAtMs: 900,
			renderedText: "上一窗口延迟到达的只读上下文",
		});
		const oversizedContextFact = fact(0, {
			factId: "context-oversized",
			eventIds: ["context-event-oversized"],
			sourceObservationIds: ["context-observation-oversized"],
			startedAtMs: 1_100,
			endedAtMs: 1_100,
			renderedText: "超".repeat(400),
		});
		await expect(
			classifier.classify(facts, goal(), {
				...classificationContext(),
				triggerReason: "max_wait",
				contextOnlyFacts: [
					contextFact,
					oversizedContextFact,
					delayedContextFact,
				],
			}),
		).resolves.toMatchObject({
			activity: "development",
			entropy: 0.4,
		});
		expect(captured!.input.window.triggerReason).toBe("max_wait");
		expect(
			captured!.input.contextOnlyFacts.map((item) => item.factId),
		).toEqual(["context-earlier", "context-later"]);
		expect(
			captured!.input.contextOnlyFacts.reduce(
				(total, item) =>
					total +
					estimateModernBertContextTokens(item.renderedText),
				0,
			),
		).toBeLessThanOrEqual(
			MODERNBERT_CONTEXT_ONLY_MAXIMUM_TOKENS,
		);
		expect(
			captured!.input.contextOnlyFacts[0]?.countClass,
		).toBe("context");
		const projected = projectModernBertModelInput(
			captured!.input,
			captured!.input.facts.slice(0, 6),
		);
		expect(projected).toContain('"triggerReason":"max_wait"');
		expect(projected).toContain('"countClass":"context"');

		tamperOverlap = true;
		expect(
			(await classifierError(() =>
				classifier.classify(facts, goal(), {
					...classificationContext(),
					triggerReason: "max_wait",
					contextOnlyFacts: [
						contextFact,
						oversizedContextFact,
						delayedContextFact,
					],
				}),
			)).code,
		).toBe("schema_mismatch");
	});

	test("allows loopback by default and requires an exact HTTPS allowlist remotely", () => {
		const expected = manifest();
		const noFetch = async (): Promise<Response> => Response.json(expected);
		expect(
			() =>
				new ModernBertEpisodeClassifier(
					options(noFetch, expected),
				),
		).not.toThrow();
		expect(
			() =>
				new ModernBertEpisodeClassifier(
					options(noFetch, expected, {
						endpoint: "https://model.example/v1/classify",
						manifestEndpoint:
							"https://model.example/manifest",
						allowedRemoteOrigins: [
							"https://model.example",
						],
					}),
				),
		).not.toThrow();
		for (const unsafe of [
			{
				endpoint: "https://model.example/v1/classify",
				manifestEndpoint: "https://model.example/manifest",
			},
			{
				endpoint: "https://sub.model.example/v1/classify",
				manifestEndpoint: "https://sub.model.example/manifest",
				allowedRemoteOrigins: ["https://model.example"],
			},
			{
				endpoint:
					"http://model.example/v1/classify?secret=present",
				manifestEndpoint: "http://model.example/manifest",
				allowedRemoteOrigins: ["http://model.example"],
				allowInsecureRemote: true,
			},
		]) {
			expect(
				() =>
					new ModernBertEpisodeClassifier(
						options(noFetch, expected, unsafe),
					),
			).toThrow(ModernBertClassifierError);
		}
		expect(
			() =>
				new ModernBertEpisodeClassifier(
					options(noFetch, expected, {
						endpoint: "http://model.example/v1/classify",
						manifestEndpoint:
							"http://model.example/manifest",
						allowedRemoteOrigins: [
							"http://model.example",
						],
						allowInsecureRemote: true,
					}),
				),
		).not.toThrow();
	});

	test("rejects runtime metadata from the current v1 serving contract", async () => {
		const expected = manifest();
		expect(
			() =>
				new ModernBertEpisodeClassifier(
					options(
						async () => Response.json({}),
						{
							...expected,
							runtime: {
								...expected.runtime,
								schemaVersion:
									"modernbert-runtime.v2",
								inputFormat:
									"whalehall-window-jsonl.v1",
							} as never,
						},
					),
				),
			).toThrow(ModernBertClassifierError);

		const v1Endpoint = new ModernBertEpisodeClassifier(
			options(async () =>
				Response.json({
					status: "ok",
					modelVersion: "modernbert-whalehall-v1",
					taxonomyVersion: "activity-taxonomy.v1",
				}),
			),
		);
		expect(
			(await classifierError(() =>
				v1Endpoint.verifyArtifact(),
			)).code,
		).toBe("artifact_manifest_mismatch");
	});

	test("fails closed for uncalibrated or placeholder artifact manifests", async () => {
		const expected = manifest();
		for (const calibrationVersion of [
			"uncalibrated",
			"placeholder",
			"pending",
		]) {
			expect(
				() =>
					new ModernBertEpisodeClassifier(
						options(
							async () => Response.json({}),
							{
								...expected,
								runtime: {
									...expected.runtime,
									calibrationVersion,
								},
							},
						),
					),
			).toThrow(ModernBertClassifierError);
		}

		const endpointUncalibrated =
			new ModernBertEpisodeClassifier(
				options(async () =>
					Response.json({
						...expected,
						runtime: {
							...expected.runtime,
							calibrationVersion: "uncalibrated",
						},
					}),
				),
			);
		expect(
			(await classifierError(() =>
				endpointUncalibrated.verifyArtifact(),
			)).code,
		).toBe("artifact_manifest_mismatch");
	});
});
