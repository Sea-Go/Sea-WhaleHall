import { describe, expect, test } from "bun:test";
import { parseLocalMessage } from "../src/agent/local-protocol";
import type { OllamaJsonRequest } from "../src/agent/model/ollama-json-client";
import {
	QwenCitedHypothesisGenerator,
	QWEN_HYPOTHESIS_EPISODES_PER_PACK,
	QWEN_HYPOTHESIS_INPUT_TOKEN_LIMIT,
	buildHypothesisPacks,
	isSemanticEventV2,
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
		const client = {
			generateJson: async <T>(request: OllamaJsonRequest<T>): Promise<T> => {
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
		expect(calls).toBe(packs.length);
	});
});
