import { describe, expect, test } from "bun:test";
import { parseLocalMessage } from "../src/agent/local-protocol";
import {
	OllamaClientError,
	type OllamaJsonRequest,
} from "../src/agent/model/ollama-json-client";
import {
	QwenCitedHypothesisGenerator,
	QWEN_HYPOTHESIS_DEFAULT_MAX_PACKS,
	QWEN_HYPOTHESIS_EPISODES_PER_PACK,
	QWEN_HYPOTHESIS_INPUT_TOKEN_LIMIT,
	QWEN_HYPOTHESIS_MAX_OUTPUT_TOKENS,
	buildHypothesisPacks,
	isSemanticEventV2,
	probeQwenHypothesisReadiness,
	type ActivityEpisodeV2,
	type EvidenceFactV2,
	type SemanticEventV2,
} from "../src/agent/timeline-v2";

function semanticEvent(): SemanticEventV2 {
	return {
		schemaVersion: "semantic-event.v2",
		eventId: "event-1",
		cursor: "sec2_0000000000000001",
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "browser.visiblePageChanged",
		source: "observer.browser",
		occurredAtMs: 1_000,
		observedAtMs: 1_010,
		goalVersion: null,
		countClass: "effective",
		reliability: "medium",
		coverage: ["content", "metadata"],
		contentState: "available",
		sourceObservationIds: ["observation-1"],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "semantic-projector.v2",
		payload: {
			appId: "com.google.Chrome",
			appName: "Google Chrome",
			opaqueWindowId: "window-1",
			domain: "example.com",
			contentHash: "hash-1",
			changeKind: "navigated",
			url: "https://example.com/docs",
			title: "Documentation",
			visibleText: "Semantic events",
		},
	};
}

function textValueEvent(
	deltaAvailable: boolean,
): SemanticEventV2 {
	return {
		...semanticEvent(),
		kind: "application.textValueChanged",
		source: "observer.ax",
		payload: {
			appId: "com.example.Editor",
			appName: "Editor",
			opaqueWindowId: "window-1",
			opaqueControlId: "control-1",
			role: "AXTextArea",
			insertedChars: deltaAvailable ? 1 : 0,
			deletedChars: 0,
			deltaAvailable,
			inputMethod: "unknown",
			finalValue: "draft",
			...(deltaAvailable ? { addedText: "t" } : {}),
		},
	};
}

function authorizationEvent(): SemanticEventV2 {
	return {
		...semanticEvent(),
		kind: "authorization.changed",
		source: "workspace.observer-authorization.v2",
		countClass: "boundary",
		reliability: "high",
		coverage: ["metadata"],
		contentState: "available",
		sourceObservationIds: ["authorization-observation-1"],
		payload: {
			permissions: {
				accessibility: "granted",
				screenRecording: "denied",
				inputMonitoring: "not_determined",
				automation: "unsupported",
			},
			changedPermissions: [
				"accessibility",
				"screenRecording",
				"inputMonitoring",
				"automation",
			],
			transition: "revoked",
			reason: "startup_snapshot",
		},
	};
}

describe("semantic-event.v2 protocol mirror", () => {
	test("accepts the exact Rust contract and parses semantic push frames", () => {
		const event = semanticEvent();
		expect(isSemanticEventV2(event)).toBeTrue();
		expect(
			parseLocalMessage(
				JSON.stringify({ event: "semantic.event", data: event }),
			),
		).toEqual({ event: "semantic.event", data: event });
	});

	test("rejects forged count classes, unknown payload fields, and raw key data", () => {
		expect(
			isSemanticEventV2({
				...semanticEvent(),
				countClass: "ignored",
			}),
		).toBeFalse();
		expect(
			isSemanticEventV2({
				...semanticEvent(),
				cursor: "sc2_0000000000000001",
			}),
		).toBeFalse();
		expect(
			isSemanticEventV2({
				...semanticEvent(),
				payload: {
					...semanticEvent().payload,
					hiddenDom: "not allowed",
				},
			}),
		).toBeFalse();
		expect(
			isSemanticEventV2({
				...semanticEvent(),
				payload: {
					...semanticEvent().payload,
					keyCode: 42,
				},
			}),
		).toBeFalse();
	});

	test("allows metadata-only goal boundary but the collector can fail closed", () => {
		const event: SemanticEventV2 = {
			...semanticEvent(),
			kind: "goal.changed",
			countClass: "boundary",
			contentState: "unavailable",
			coverage: ["metadata", "unavailable"],
			payload: {},
		};
		expect(isSemanticEventV2(event)).toBeTrue();
	});

	test("accepts only the metadata-only authorization boundary shape", () => {
		const event = authorizationEvent();
		expect(isSemanticEventV2(event)).toBeTrue();
		expect(
			parseLocalMessage(
				JSON.stringify({ event: "semantic.event", data: event }),
			),
		).toEqual({ event: "semantic.event", data: event });
		for (const invalid of [
			{ ...event, countClass: "effective" },
			{ ...event, source: "workspace.untrusted" },
			{ ...event, coverage: ["metadata", "denied"] },
			{
				...event,
				payload: { ...event.payload, windowTitle: "private" },
			},
			{
				...event,
				payload: {
					...event.payload,
					permissions: {
						...(event.payload.permissions as Record<string, string>),
						automation: "authorized",
					},
				},
			},
			{
				...event,
				payload: {
					...event.payload,
					changedPermissions: ["automation", "automation"],
				},
			},
			{
				...event,
				payload: {
					...event.payload,
					reason: "captured_path",
				},
			},
		]) {
			expect(isSemanticEventV2(invalid)).toBeFalse();
		}
	});

	test("accepts only an empty, permanently ignored coverage gap", () => {
		const event: SemanticEventV2 = {
			...semanticEvent(),
			kind: "coverage.gap",
			countClass: "ignored",
			contentState: "redacted",
			coverage: ["redacted"],
			payload: {},
		};
		expect(isSemanticEventV2(event)).toBeTrue();
		expect(
			isSemanticEventV2({
				...event,
				countClass: "effective",
			}),
		).toBeFalse();
		expect(
			isSemanticEventV2({
				...event,
				payload: { application: "secret.example" },
			}),
		).toBeFalse();
	});

	test("requires an explicit and internally consistent text delta availability", () => {
		const knownDelta = textValueEvent(true);
		const missingBaseline = textValueEvent(false);
		expect(isSemanticEventV2(knownDelta)).toBeTrue();
		expect(isSemanticEventV2(missingBaseline)).toBeTrue();

		const withoutAvailability = Object.fromEntries(
			Object.entries(missingBaseline.payload).filter(
				([key]) => key !== "deltaAvailable",
			),
		);
		expect(
			isSemanticEventV2({
				...missingBaseline,
				payload: withoutAvailability,
			}),
		).toBeFalse();
		expect(
			isSemanticEventV2({
				...missingBaseline,
				payload: {
					...missingBaseline.payload,
					insertedChars: 1,
				},
			}),
		).toBeFalse();
		expect(
			isSemanticEventV2({
				...missingBaseline,
				payload: {
					...missingBaseline.payload,
					addedText: "invented",
				},
			}),
		).toBeFalse();
	});

	test("accepts only exact five-second or strictly coalesced input buckets", () => {
		const inputBucket: SemanticEventV2 = {
			...semanticEvent(),
			kind: "input.activityBucket",
			source: "cg_activity.observer-0.1.0",
			occurredAtMs: 10_000,
			observedAtMs: 15_000,
			coverage: ["metadata"],
			payload: {
				bucketStartedAtMs: 10_000,
				bucketEndedAtMs: 15_000,
				keyCount: 4,
				clickCount: 1,
				scrollDelta: 2.5,
				mouseDistance: 10,
			},
		};
		expect(isSemanticEventV2(inputBucket)).toBeTrue();

		const coalesced: SemanticEventV2 = {
			...inputBucket,
			observedAtMs: 25_000,
			payload: {
				...inputBucket.payload,
				bucketEndedAtMs: 25_000,
				coalescedBucketCount: 3,
			},
		};
		expect(isSemanticEventV2(coalesced)).toBeTrue();
		for (const payload of [
			{ ...coalesced.payload, coalescedBucketCount: 1 },
			{ ...coalesced.payload, coalescedBucketCount: 257 },
			{ ...coalesced.payload, coalescedBucketCount: 3.5 },
			{ ...coalesced.payload, bucketEndedAtMs: 24_999 },
			{ ...coalesced.payload, coalescedUnderBackpressure: true },
		]) {
			expect(isSemanticEventV2({ ...coalesced, payload })).toBeFalse();
		}
	});
});

describe("Qwen cited hypothesis guard", () => {
	test("falls back to a deterministic hypothesis when citations escape evidence", async () => {
		const fact: EvidenceFactV2 = {
			schemaVersion: "evidence-fact.v2",
			factId: "fact-1",
			eventIds: ["event-1"],
			sourceObservationIds: ["observation-1"],
			startedAtMs: 1_000,
			endedAtMs: 1_010,
			templateCode: "browser.visible_page",
			templateArgs: { title: "Documentation" },
			renderedText: "在浏览器查看当前可见页面“Documentation”",
			anchor: {
				appId: "com.google.Chrome",
				windowId: "window-1",
				documentId: null,
				pageId: "hash-1",
			},
			role: "primary",
			reliability: "medium",
			coverage: ["content"],
		};
		const episode: ActivityEpisodeV2 = {
			schemaVersion: "activity-episode.v2",
			episodeId: "episode-1",
			revisionId: "episode-revision-1",
			revision: 1,
			supersedesRevisionId: null,
			sourceWindowIds: ["window-1"],
			startedAtMs: 1_000,
			endedAtMs: 1_010,
			goalVersion: null,
			anchor: fact.anchor,
			classification: {
				activity: "research",
				goalRelevance: null,
				confidence: 0.6,
				entropy: 0.5,
				oodScore: 0.4,
				abstain: false,
				modelVersion: "test",
			},
			hypothesis: {
				text: "可能在查阅资料",
				citedFactIds: ["fact-1"],
				generator: "deterministic-template.v2",
			},
			evidenceFactIds: ["fact-1"],
			supportingFactIds: [],
			coverage: ["content"],
		};
		let callCount = 0;
		const client = {
			generateJson: async <T>(request: OllamaJsonRequest<T>): Promise<T> => {
				callCount += 1;
				const invalid = {
					episodes: [
						{
							episodeId: "episode-1",
							hypothesis: "可能在查阅资料",
							citedFactIds: ["invented-fact"],
						},
					],
				};
				if (!request.validate(invalid)) {
					throw new Error("schema validation failed");
				}
				return invalid as T;
			},
		};
		const generated = await new QwenCitedHypothesisGenerator(
			client,
		).generate([episode], [fact], null);
		expect(generated.get("episode-1")).toEqual({
			text: "可能在查阅和研究资料",
			citedFactIds: ["fact-1"],
			generator: "deterministic-template.v2",
			diagnostics: [
				{
					source: "qwen3:4b",
					stage: "generation",
					code: "unexpected_failure",
					retryable: true,
					httpStatus: null,
					affectedEpisodeCount: 1,
				},
			],
		});
		expect(callCount).toBe(1);

		const abstained = {
			...episode,
			classification: {
				...episode.classification,
				activity: "development" as const,
				goalRelevance: "unrelated" as const,
				confidence: 0.2,
				entropy: 0.95,
				oodScore: 0.98,
				abstain: true,
			},
		};
		const neutral = await new QwenCitedHypothesisGenerator(
			client,
		).generate([abstained], [fact], {
			goalId: "goal-1",
			planId: null,
			version: 1,
			text: "完成 Timeline",
			activatedAtMs: 500,
		});
		expect(callCount).toBe(1);
		expect(neutral.get("episode-1")).toEqual({
			text: "可能在进行当前可见操作（活动类型暂不确定）",
			citedFactIds: ["fact-1"],
			generator: "deterministic-template.v2",
		});
	});

	test("packs one to four episodes under the 2200-token input budget", async () => {
		const seedFact: EvidenceFactV2 = {
			schemaVersion: "evidence-fact.v2",
			factId: "fact-0",
			eventIds: ["event-0"],
			sourceObservationIds: ["observation-0"],
			startedAtMs: 1_000,
			endedAtMs: 1_010,
			templateCode: "application.visible_content",
			templateArgs: {},
			renderedText: "可见正文".repeat(100),
			anchor: {
				appId: "app",
				windowId: "window",
				documentId: "document",
				pageId: null,
			},
			role: "primary",
			reliability: "medium",
			coverage: ["content"],
		};
		const seedEpisode: ActivityEpisodeV2 = {
			schemaVersion: "activity-episode.v2",
			episodeId: "episode-0",
			revisionId: "revision-0",
			revision: 1,
			supersedesRevisionId: null,
			sourceWindowIds: ["window-0"],
			startedAtMs: 1_000,
			endedAtMs: 1_010,
			goalVersion: null,
			anchor: seedFact.anchor,
			classification: {
				activity: "research",
				goalRelevance: null,
				confidence: 0.6,
				entropy: 0.5,
				oodScore: 0.4,
				abstain: false,
				modelVersion: "test",
			},
			hypothesis: {
				text: "可能在查阅资料",
				citedFactIds: ["fact-0"],
				generator: "deterministic-template.v2",
			},
			evidenceFactIds: ["fact-0"],
			supportingFactIds: [],
			coverage: ["content"],
		};
		const facts = Array.from({ length: 9 }, (_, index) => ({
			...seedFact,
			factId: `fact-${index}`,
			eventIds: [`event-${index}`],
			sourceObservationIds: [`observation-${index}`],
		}));
		const episodes = Array.from({ length: 9 }, (_, index) => ({
			...seedEpisode,
			episodeId: `episode-${index}`,
			revisionId: `revision-${index}`,
			evidenceFactIds: [`fact-${index}`],
			hypothesis: {
				...seedEpisode.hypothesis,
				citedFactIds: [`fact-${index}`],
			},
		}));
		const packs = buildHypothesisPacks(episodes, facts, null);
		expect(packs.length).toBeGreaterThanOrEqual(3);
		expect(
			packs.every(
				(pack) =>
					pack.episodes.length >= 1 &&
					pack.episodes.length <=
						QWEN_HYPOTHESIS_EPISODES_PER_PACK &&
					pack.estimatedInputTokens <=
						QWEN_HYPOTHESIS_INPUT_TOKEN_LIMIT,
			),
		).toBeTrue();
		expect(packs.flatMap((pack) => pack.episodes)).toHaveLength(9);

		let calls = 0;
		const client = {
			generateJson: async <T>(request: OllamaJsonRequest<T>): Promise<T> => {
				calls += 1;
				const payload = JSON.parse(
					request.messages[1]!.content,
				) as {
					episodes: Array<{
						episodeId: string;
						activity: string;
						goalRelevance: string | null;
						allowedFactIds: string[];
					}>;
				};
				const response = {
					episodes: payload.episodes.map((episode) => ({
						episodeId: episode.episodeId,
						hypothesis: "可能在查阅资料",
						citedFactIds: [episode.allowedFactIds[0]!],
					})),
				};
				expect(
					payload.episodes.every(
						(episode) =>
							/^e\d+$/u.test(episode.episodeId) &&
							episode.allowedFactIds.every((factId) =>
								/^f\d+$/u.test(factId),
							),
					),
				).toBeTrue();
				expect(JSON.stringify(request.schema)).not.toContain(
					'"pattern"',
				);
				expect(JSON.stringify(request.schema)).toContain(
					'"maxLength":64',
				);
				expect(request.maxOutputTokens).toBe(
					QWEN_HYPOTHESIS_MAX_OUTPUT_TOKENS,
				);
				const wrongPrefix = structuredClone(response);
				wrongPrefix.episodes[0]!.hypothesis = "正在查阅资料";
				expect(request.validate(wrongPrefix)).toBeFalse();
				const tooLong = structuredClone(response);
				tooLong.episodes[0]!.hypothesis =
					`可能在${"查".repeat(62)}`;
				expect(request.validate(tooLong)).toBeFalse();
				if (!request.validate(response)) {
					throw new Error("generated response failed validation");
				}
				return response as T;
			},
		};
		const generated = await new QwenCitedHypothesisGenerator(
			client,
		).generate(episodes, facts, null);
		expect(generated.size).toBe(9);
		expect(calls).toBe(QWEN_HYPOTHESIS_DEFAULT_MAX_PACKS);
		const selectedIds = new Set(
			packs[0]!.episodes.map((episode) => episode.episodeId),
		);
		for (const episode of episodes) {
			const hypothesis = generated.get(episode.episodeId)!;
			if (selectedIds.has(episode.episodeId)) {
				expect(hypothesis.generator).toBe("qwen3:4b-cited.v2");
				expect(hypothesis.diagnostics).toBeUndefined();
			} else {
				expect(hypothesis.generator).toBe(
					"deterministic-template.v2",
				);
				expect(hypothesis.diagnostics?.[0]?.code).toBe(
					"pack_limit",
				);
			}
		}

		let multiPackCalls = 0;
		const partiallyFailingClient = {
			generateJson: async <T>(request: OllamaJsonRequest<T>): Promise<T> => {
				multiPackCalls += 1;
				if (multiPackCalls === 2) {
					throw new OllamaClientError(
						"Ollama request failed.",
						true,
						"transport_error",
					);
				}
				const payload = JSON.parse(
					request.messages[1]!.content,
					) as {
						episodes: Array<{
							episodeId: string;
							activity: string;
							goalRelevance: string | null;
							allowedFactIds: string[];
						}>;
				};
				return {
					episodes: payload.episodes.map((episode) => ({
						episodeId: episode.episodeId,
						hypothesis: "可能在查阅资料",
						citedFactIds: [episode.allowedFactIds[0]!],
					})),
				} as T;
			},
		};
		const partial = await new QwenCitedHypothesisGenerator(
			partiallyFailingClient,
			{ maxPacks: 2 },
		).generate(episodes, facts, null);
		expect(multiPackCalls).toBe(2);
		expect(
			packs[0]!.episodes.every(
				(episode) =>
					partial.get(episode.episodeId)?.generator ===
					"qwen3:4b-cited.v2",
			),
		).toBeTrue();
		expect(
			packs[1]!.episodes.every(
				(episode) =>
					partial.get(episode.episodeId)?.diagnostics?.[0]
						?.code === "ollama.transport_error",
			),
		).toBeTrue();
		expect(
			packs[2]!.episodes.every(
				(episode) =>
					partial.get(episode.episodeId)?.diagnostics?.[0]
						?.code === "pack_limit",
			),
		).toBeTrue();
	});

	test("probes the production schema with synthetic aliases only", async () => {
		let inspected = false;
		await probeQwenHypothesisReadiness({
			generateJson: async <T>(request: OllamaJsonRequest<T>): Promise<T> => {
				inspected = true;
				const payload = JSON.parse(
					request.messages[1]!.content,
					) as {
						episodes: Array<{
							episodeId: string;
							activity: string;
							goalRelevance: string | null;
							allowedFactIds: string[];
						}>;
						facts: Array<{ factId: string; text: string }>;
				};
				expect(payload.episodes).toEqual([
					{
						episodeId: "e1",
						activity: "other_unknown",
						goalRelevance: null,
						allowedFactIds: ["f1"],
					},
				]);
				expect(payload.facts[0]).toMatchObject({
					factId: "f1",
					text: "当前可见操作",
				});
				expect(JSON.stringify(request.schema)).not.toContain(
					'"pattern"',
				);
				const response = {
					episodes: [
						{
							episodeId: "e1",
							hypothesis: "可能在进行当前可见操作",
							citedFactIds: ["f1"],
						},
					],
				};
				expect(request.validate(response)).toBeTrue();
				return response as T;
			},
		});
		expect(inspected).toBeTrue();
	});
});
