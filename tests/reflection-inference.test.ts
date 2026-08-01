import { describe, expect, test } from "bun:test";
import { OllamaJsonClient } from "../src/agent/model/ollama-json-client";
import {
	ACTIVITY_LABELS,
	DEFAULT_REFLECTION_TAXONOMY_VERSION,
	GOAL_RELEVANCE_LABELS,
	MODERNBERT_INFERENCE_SCHEMA_VERSION,
	ModernBertHttpClient,
	ModernBertInferenceError,
	ReflectionInference,
	ReflectionInferenceUnavailableError,
	ReflectionReminderDeduper,
	chineseFeedbackTemplate,
	selectFeedbackCode,
	validateModernBertInference,
	type ActivityProbabilities,
	type GoalRelevanceProbabilities,
	type ModernBertInferenceProvider,
	type ModernBertInferenceV1,
} from "../src/agent/reflection/inference";
import {
	DESKTOP_EVENT_SCHEMA_VERSION,
	EVENT_WINDOW_SCHEMA_VERSION,
	type ActivityLabel,
	type DesktopEventV1,
	type EventWindowV1,
	type GoalRelevanceLabel,
} from "../src/agent/reflection/types";

function probabilityDistribution<L extends string>(
	labels: readonly L[],
	winner: L,
	confidence: number,
): Record<L, number> {
	const result = {} as Record<L, number>;
	const remainder = (1 - confidence) / (labels.length - 1);
	for (const label of labels) {
		result[label] = label === winner ? confidence : remainder;
	}
	return result;
}

function embedding(axis = 0): number[] {
	return Array.from({ length: 256 }, (_, index) => (index === axis ? 1 : 0));
}

function primaryOutput(options: {
	activity?: ActivityLabel;
	activityConfidence?: number;
	relevance?: GoalRelevanceLabel | null;
	relevanceConfidence?: number;
	oodScore?: number;
	embeddingAxis?: number;
} = {}): ModernBertInferenceV1 {
	const relevance = options.relevance === undefined ? "direct" : options.relevance;
	return {
		schemaVersion: MODERNBERT_INFERENCE_SCHEMA_VERSION,
		modelVersion: "modernbert-whalehall-test",
		taxonomyVersion: DEFAULT_REFLECTION_TAXONOMY_VERSION,
		activityProbabilities: probabilityDistribution(
			ACTIVITY_LABELS,
			options.activity ?? "development",
			options.activityConfidence ?? 0.92,
		) as ActivityProbabilities,
		goalRelevanceProbabilities:
			relevance === null
				? null
				: (probabilityDistribution(
						GOAL_RELEVANCE_LABELS,
						relevance,
						options.relevanceConfidence ?? 0.91,
					) as GoalRelevanceProbabilities),
		embedding: embedding(options.embeddingAxis),
		oodScore: options.oodScore ?? 0.05,
	};
}

function foregroundEvent(id = "event-1"): DesktopEventV1 {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: id,
		cursor: id.replace("event", "cursor"),
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "application.foregroundChanged",
		source: "activity",
		occurredAtMs: 1_000,
		observedAtMs: 1_001,
		goalVersion: 1,
		sensitivity: "metadata",
		payload: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			windowTitle: "project",
		},
	};
}

function windowFixture(hasGoal = true): EventWindowV1 {
	const event = foregroundEvent();
	if (!hasGoal) event.goalVersion = null;
	return {
		schemaVersion: EVENT_WINDOW_SCHEMA_VERSION,
		windowId: hasGoal ? "window-with-goal" : "window-without-goal",
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
		triggerReason: "event_count",
		goal: hasGoal
			? {
					goalId: "goal-1",
					planId: "plan-1",
					version: 1,
					text: "完成 WhaleHall 推理层",
					activatedAtMs: 500,
				}
			: null,
		goalVersion: hasGoal ? 1 : null,
		startedAtMs: 1_000,
		endedAtMs: 61_000,
		deadlineAtMs: 301_000,
		eventCount: 1,
		firstCursor: event.cursor,
		lastCursor: event.cursor,
		events: [event],
		contextOnly: [],
		modelInput: "foreground app=VS Code; semantic action=editing",
		inputHash: "sha256:test-window",
	};
}

function provider(
	value: ModernBertInferenceV1 | Error,
): ModernBertInferenceProvider {
	return {
		async infer() {
			if (value instanceof Error) throw value;
			return structuredClone(value);
		},
	};
}

function qwenClient(
	label: {
		activity: ActivityLabel;
		goalRelevance: GoalRelevanceLabel | null;
		ambiguous?: boolean;
		reasonCodes?: string[];
	},
	requests: Array<Record<string, unknown>> = [],
): OllamaJsonClient {
	return new OllamaJsonClient({
		fetch: async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(
				JSON.stringify({
					message: {
						content: JSON.stringify({
							activity: label.activity,
							goalRelevance: label.goalRelevance,
							ambiguous: label.ambiguous ?? false,
							reasonCodes: label.reasonCodes ?? ["app_identity"],
						}),
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	});
}

describe("ModernBertHttpClient", () => {
	test("allows loopback by default and sends a bounded strict request", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const output = {
			...primaryOutput(),
			windowId: "window-with-goal",
			inputHash: "sha256:test-window",
		};
		const client = new ModernBertHttpClient({
			fetch: async (input, init) => {
				requests.push({ url: String(input), init });
				return new Response(JSON.stringify(output), {
					status: 200,
					headers: {
						"content-type": "application/json",
						"content-length": String(JSON.stringify(output).length),
					},
				});
			},
		});

		const result = await client.infer(windowFixture());

		expect(result.modelVersion).toBe("modernbert-whalehall-test");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"http://127.0.0.1:8765/v1/reflections:infer",
		);
		expect(requests[0]?.init?.redirect).toBe("error");
		const body = JSON.parse(String(requests[0]?.init?.body)) as Record<
			string,
			unknown
		>;
		expect(body).toMatchObject({
			schemaVersion: "modernbert-request.v1",
			windowId: "window-with-goal",
			hasGoal: true,
			goalText: "完成 WhaleHall 推理层",
			goalVersion: 1,
			taxonomyVersion: DEFAULT_REFLECTION_TAXONOMY_VERSION,
		});
	});

	test("rejects a valid-looking response correlated to another window", async () => {
		const output = {
			...primaryOutput(),
			windowId: "stale-window",
			inputHash: "sha256:stale",
		};
		const client = new ModernBertHttpClient({
			fetch: async () =>
				new Response(JSON.stringify(output), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});

		await expect(client.infer(windowFixture())).rejects.toThrow(
			"correlation",
		);
	});

	test("requires an exact allowlist and HTTPS for non-loopback endpoints", () => {
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "https://models.example.test/v1/infer",
				}),
		).toThrow("explicitly allowlisted");
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "https://models.example.test/v1/infer",
					allowedOrigins: ["https://other.example.test"],
				}),
		).toThrow("explicitly allowlisted");
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "http://models.example.test/v1/infer",
					allowedOrigins: ["http://models.example.test"],
				}),
		).toThrow("must use HTTPS");
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "https://models.example.test/v1/infer",
					allowedOrigins: ["https://models.example.test"],
				}),
		).not.toThrow();
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "http://models.example.test/v1/infer",
					allowedOrigins: ["http://models.example.test"],
					allowInsecureAllowlistedOrigins: true,
				}),
		).not.toThrow();
	});

	test("rejects credentials, query strings, and redirect-capable URL tricks", () => {
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "http://user:secret@127.0.0.1:8765/v1/infer",
				}),
		).toThrow("without credentials");
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "http://127.0.0.1:8765/v1/infer?next=example.test",
				}),
		).toThrow("without credentials");
		expect(
			() =>
				new ModernBertHttpClient({
					endpoint: "http://127.0.0.1.example.test/v1/infer",
				}),
		).toThrow("explicitly allowlisted");
	});
});

describe("ModernBERT result validation", () => {
	test("requires all 12 activity classes, all 4 relevance classes, and a normalized 256-vector", () => {
		const valid = primaryOutput();
		expect(
			validateModernBertInference(valid, true).activityProbabilities,
		).toHaveProperty("other_unknown");

		const missingActivity = structuredClone(valid) as unknown as Record<
			string,
			unknown
		>;
		delete (
			missingActivity.activityProbabilities as Record<string, unknown>
		).commerce;
		expect(() => validateModernBertInference(missingActivity, true)).toThrow(
			"exactly 12",
		);

		const shortEmbedding = {
			...valid,
			embedding: valid.embedding.slice(0, 255),
		};
		expect(() => validateModernBertInference(shortEmbedding, true)).toThrow(
			"exactly 256",
		);

		const unnormalizedEmbedding = {
			...valid,
			embedding: Array.from({ length: 256 }, () => 1),
		};
		expect(() =>
			validateModernBertInference(unnormalizedEmbedding, true),
		).toThrow("L2-normalized");
	});

	test("rejects malformed distributions and relevance output without a goal", () => {
		const malformed = primaryOutput();
		malformed.activityProbabilities.development = 0.5;
		expect(() => validateModernBertInference(malformed, true)).toThrow(
			"must sum to 1",
		);
		expect(() =>
			validateModernBertInference(primaryOutput(), false),
		).toThrow("must be null");
		expect(() =>
			validateModernBertInference(primaryOutput({ relevance: null }), false),
		).not.toThrow();
	});
});

describe("ReflectionInference", () => {
	test("derives labels, confidence, entropy, evidence, and feedback from calibrated primary output", async () => {
		const inference = new ReflectionInference({
			primary: provider(primaryOutput()),
		});

		const reflection = await inference.infer(windowFixture());

		expect(reflection.activity.label).toBe("development");
		expect(reflection.goalRelevance?.label).toBe("direct");
		expect(reflection.confidence).toBeCloseTo(0.91);
		expect(reflection.entropy).toBeGreaterThan(0);
		expect(reflection.abstain).toBeFalse();
		expect(reflection.feedbackCode).toBe("encourage");
		expect(reflection.evidenceEventIds).toEqual(["event-1"]);
		expect(reflection.embedding).toHaveLength(256);
		expect(Math.hypot(...reflection.embedding)).toBeCloseTo(1);
		expect(reflection.modelVersion).toBe("modernbert-whalehall-test");
	});

	test("forces relevance to null and never emits refocus when no goal exists", async () => {
		const inference = new ReflectionInference({
			primary: provider(primaryOutput({ relevance: null })),
		});

		const reflection = await inference.infer(windowFixture(false));

		expect(reflection.goalVersion).toBeNull();
		expect(reflection.goalRelevance).toBeNull();
		expect(reflection.feedbackCode).toBe("silent");
		expect(
			selectFeedbackCode({
				hasGoal: false,
				activity: "gaming",
				goalRelevance: "unrelated",
				abstain: false,
			}),
		).toBe("silent");
	});

	test("uses Qwen categorical fallback when primary is unavailable without trusting probabilities", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const inference = new ReflectionInference({
			primary: provider(new Error("connection refused")),
			fallback: qwenClient(
				{
					activity: "gaming",
					goalRelevance: "unrelated",
					reasonCodes: ["app_identity", "goal_context_support"],
				},
				requests,
			),
		});

		const reflection = await inference.infer(windowFixture());

		expect(reflection.activity.label).toBe("gaming");
		expect(reflection.goalRelevance?.label).toBe("unrelated");
		expect(reflection.embedding).toHaveLength(256);
		expect(Math.hypot(...reflection.embedding)).toBeCloseTo(1);
		expect(reflection.confidence).toBeLessThan(0.1);
		expect(reflection.entropy).toBeGreaterThan(0.99);
		expect(reflection.abstain).toBeTrue();
		expect(reflection.feedbackCode).toBe("silent");
		expect(reflection.modelVersion).toContain("qwen3:4b-categorical");
		expect(reflection.modelVersion).toContain("hash-embedding.v1");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.think).toBeFalse();
		expect(requests[0]?.options).toMatchObject({
			num_ctx: 4096,
			temperature: 0,
		});
		const schema = requests[0]?.format as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(schema.properties).sort()).toEqual(
			["activity", "ambiguous", "goalRelevance", "reasonCodes"].sort(),
		);
		expect(JSON.stringify(schema)).not.toContain("probab");
	});

	test("uses Qwen to relabel low-confidence primary output but preserves calibration and abstention", async () => {
		const lowConfidence = primaryOutput({
			activity: "other_unknown",
			activityConfidence: 0.3,
			relevance: "uncertain",
			relevanceConfidence: 0.4,
			embeddingAxis: 7,
		});
		const inference = new ReflectionInference({
			primary: provider(lowConfidence),
			fallback: qwenClient({
				activity: "writing",
				goalRelevance: "direct",
				ambiguous: false,
				reasonCodes: ["document_edit", "goal_term_match"],
			}),
		});

		const reflection = await inference.infer(windowFixture());

		expect(reflection.activity.label).toBe("writing");
		expect(reflection.goalRelevance?.label).toBe("direct");
		expect(reflection.embedding[7]).toBe(1);
		expect(reflection.confidence).toBeCloseTo(0.3);
		expect(reflection.abstain).toBeTrue();
		expect(reflection.feedbackCode).toBe("silent");
		expect(reflection.modelVersion).toBe(
			"modernbert-whalehall-test+fallback:qwen3:4b",
		);
	});

	test("journals a valid primary abstention if optional Qwen fails", async () => {
		const fallback = new OllamaJsonClient({
			fetch: async () => {
				throw new Error("Ollama unavailable");
			},
		});
		const inference = new ReflectionInference({
			primary: provider(
				primaryOutput({
					activityConfidence: 0.3,
					relevanceConfidence: 0.4,
				}),
			),
			fallback,
		});

		const reflection = await inference.infer(windowFixture());

		expect(reflection.modelVersion).toBe("modernbert-whalehall-test");
		expect(reflection.abstain).toBeTrue();
		expect(reflection.feedbackCode).toBe("silent");
	});

	test("fails retryably at the job boundary when no inference provider produces a result", async () => {
		const inference = new ReflectionInference({
			primary: provider(new ModernBertInferenceError("offline", true)),
		});

		await expect(inference.infer(windowFixture())).rejects.toBeInstanceOf(
			ReflectionInferenceUnavailableError,
		);
	});

	test("uses Qwen on OOD output while retaining the primary embedding", async () => {
		const inference = new ReflectionInference({
			primary: provider(
				primaryOutput({
					activity: "development",
					relevance: "direct",
					oodScore: 0.9,
					embeddingAxis: 12,
				}),
			),
			fallback: qwenClient({
				activity: "research",
				goalRelevance: "supporting",
				reasonCodes: ["browser_navigation"],
			}),
		});

		const reflection = await inference.infer(windowFixture());

		expect(reflection.activity.label).toBe("research");
		expect(reflection.goalRelevance?.label).toBe("supporting");
		expect(reflection.embedding[12]).toBe(1);
		expect(reflection.abstain).toBeTrue();
	});
});

describe("fixed feedback and reminder suppression", () => {
	test("renders only fixed Chinese templates", () => {
		expect(chineseFeedbackTemplate("silent")).toBeNull();
		expect(chineseFeedbackTemplate("encourage")).toBe(
			"你正在推进当前目标，保持这个节奏。",
		);
		expect(chineseFeedbackTemplate("refocus")).toContain("偏离目标");
	});

	test("suppresses the same active reminder for ten minutes without suppressing persistence", async () => {
		const inference = new ReflectionInference({
			primary: provider(primaryOutput()),
		});
		const reflection = await inference.infer(windowFixture());
		const deduper = new ReflectionReminderDeduper();

		expect(deduper.shouldNotify(reflection, 1_000)).toBeTrue();
		expect(deduper.shouldNotify(reflection, 600_999)).toBeFalse();
		expect(deduper.shouldNotify(reflection, 601_000)).toBeTrue();

		const different = structuredClone(reflection);
		different.feedbackCode = "clarifyGoal";
		expect(deduper.shouldNotify(different, 601_001)).toBeTrue();

		const silent = structuredClone(reflection);
		silent.feedbackCode = "silent";
		expect(deduper.shouldNotify(silent, 601_002)).toBeFalse();
	});
});
