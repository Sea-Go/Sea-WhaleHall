import { describe, expect, test } from "bun:test";
import { WebCryptoReflectionHasher } from "../src/agent/reflection/hash";
import {
	DeterministicEpisodeAssembler,
	DeterministicEvidenceRenderer,
	DeterministicTimelineHypothesisGenerator,
	HeuristicTimelineEpisodeClassifier,
	InMemoryTimelineV2Repository,
	TimelineV2Processor,
	type EvidenceFactV2,
	type SemanticEventV2,
	type TimelineWindowV2,
} from "../src/agent/timeline-v2";

function browserEvent(
	index: number,
	atMs: number,
	options: {
		url?: string;
		contentHash?: string;
		visibleText?: string;
	} = {},
): SemanticEventV2 {
	return {
		schemaVersion: "semantic-event.v2",
		eventId: `event-${index}`,
		cursor: `sec2_${index.toString(16).padStart(16, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "browser.visiblePageChanged",
		source: "observer.browser",
		occurredAtMs: atMs,
		observedAtMs: atMs + 10,
		goalVersion: null,
		countClass: "effective",
		reliability: "high",
		coverage: ["content", "metadata"],
		contentState: "available",
		sourceObservationIds: [`observation-${index}`],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "semantic-projector.v2",
		payload: {
			appId: "com.google.Chrome",
			appName: "Google Chrome",
			opaqueWindowId: "browser-window",
			domain: "example.invalid",
			url:
				options.url ??
				"https://example.invalid/research?topic=graph#section",
			title: "数据治理与知识图谱",
			visibleText:
				options.visibleText ??
				"研究资料中提到了文件格式，但当前页面用于资料查阅",
			contentHash: options.contentHash ?? `hash-${index}`,
			changeKind: "content_changed",
		},
	};
}

function visibleContentEvent(
	index: number,
	contentHash: string,
): SemanticEventV2 {
	return {
		...browserEvent(index, index * 1_000),
		kind: "application.visibleContentChanged",
		source: "observer.ocr",
		payload: {
			appId: "com.example.Editor",
			appName: "Example Editor",
			opaqueWindowId: "editor-window",
			windowTitle: "Document",
			visibleText: `visible-${index}`,
			contentHash,
		},
	};
}

function textValueEvent(
	index: number,
	options: {
		deltaAvailable: boolean;
		insertedChars: number;
		deletedChars: number;
		addedText?: string;
		finalValue?: string;
		contentState?: SemanticEventV2["contentState"];
	},
): SemanticEventV2 {
	return {
		...browserEvent(index, index * 1_000),
		kind: "application.textValueChanged",
		source: "observer.ax",
		contentState: options.contentState ?? "available",
		coverage:
			options.contentState === "unavailable"
				? ["unavailable"]
				: ["content", "metadata"],
		payload: {
			appId: "com.example.Editor",
			appName: "Editor",
			opaqueWindowId: "editor-window",
			opaqueControlId: "editor-control",
			role: "AXTextArea",
			insertedChars: options.insertedChars,
			deletedChars: options.deletedChars,
			deltaAvailable: options.deltaAvailable,
			inputMethod: "unknown",
			...(options.contentState === "unavailable"
				? {}
				: { label: "编辑区" }),
			...(options.addedText === undefined
				? {}
				: { addedText: options.addedText }),
			...(options.finalValue === undefined
				? {}
				: { finalValue: options.finalValue }),
		},
	};
}

function fact(index: number): EvidenceFactV2 {
	const startedAtMs = index * 15_000;
	return {
		schemaVersion: "evidence-fact.v2",
		factId: `fact-${index}`,
		eventIds: [`event-${index}`],
		sourceObservationIds: [`observation-${index}`],
		startedAtMs,
		endedAtMs: startedAtMs + 1_000,
		templateCode: "application.foreground",
		templateArgs: {
			appId: `com.example.app-${index}`,
			appName: `App ${index}`,
		},
		renderedText: `前台切换到 App ${index}`,
		anchor: {
			appId: `com.example.app-${index}`,
			windowId: `window-${index}`,
			documentId: null,
			pageId: null,
		},
		role: "primary",
		reliability: "high",
		coverage: ["metadata"],
	};
}

function windowFor(
	events: readonly SemanticEventV2[],
	endedAtMs = 300_000,
): TimelineWindowV2 {
	return {
		schemaVersion: "timeline-window.v2",
		windowId: "window-under-test",
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
		triggerReason: "max_wait",
		goal: null,
		goalVersion: null,
		startedAtMs: events[0]?.occurredAtMs ?? 0,
		endedAtMs,
		deadlineAtMs: endedAtMs,
		eventCount: events.length,
		firstCursor: events[0]?.cursor ?? "sec2_0000000000000001",
		lastCursor: events.at(-1)?.cursor ?? "sec2_0000000000000001",
		events: structuredClone([...events]),
		contextOnly: [],
		inputHash: "0".repeat(64),
	};
}

describe("Timeline v2 real-capture regressions", () => {
	test("deterministically skips authorization boundaries during evidence rendering", async () => {
		const renderer = new DeterministicEvidenceRenderer(
			new WebCryptoReflectionHasher(),
		);
		const authorization: SemanticEventV2 = {
			...browserEvent(1, 1_000),
			kind: "authorization.changed",
			source: "workspace.observer-authorization.v2",
			countClass: "boundary",
			reliability: "high",
			coverage: ["metadata"],
			contentState: "available",
			payload: {
				permissions: {
					accessibility: "granted",
					screenRecording: "granted",
					inputMonitoring: "granted",
					automation: "denied",
				},
				changedPermissions: ["automation"],
				transition: "revoked",
				reason: "runtime_change",
			},
		};
		const facts = await renderer.render([
			authorization,
			browserEvent(2, 2_000),
		]);
		expect(facts).toHaveLength(1);
		expect(facts[0]?.eventIds).toEqual(["event-2"]);
	});

	test("uses stable page and window anchors instead of visible content hashes", async () => {
		const renderer = new DeterministicEvidenceRenderer(
			new WebCryptoReflectionHasher(),
		);
		const [first, second, third] = await renderer.render([
			browserEvent(1, 1_000, { contentHash: "ocr-a" }),
			browserEvent(2, 2_000, { contentHash: "ocr-b" }),
			browserEvent(3, 3_000, {
				url: "https://example.invalid/another",
				contentHash: "ocr-c",
			}),
		]);
		expect(first?.anchor.pageId).toBe(second?.anchor.pageId);
		expect(first?.anchor.pageId).not.toBe(third?.anchor.pageId);

		const [visibleA, visibleB] = await renderer.render([
			visibleContentEvent(4, "screen-a"),
			visibleContentEvent(5, "screen-b"),
		]);
		expect(visibleA?.anchor.documentId).toBe("editor-window");
		expect(visibleB?.anchor.documentId).toBe("editor-window");
	});

	test("does not let incidental OCR words override browser research structure", async () => {
		const renderer = new DeterministicEvidenceRenderer(
			new WebCryptoReflectionHasher(),
		);
		const facts = await renderer.render([
			browserEvent(1, 1_000, {
				visibleText: "这里包含文件二字，但页面是在研究知识图谱",
			}),
		]);
		const classification =
			await new HeuristicTimelineEpisodeClassifier().classify(
				facts,
				null,
			);
		expect(classification.activity).toBe("research");
	});

	test("renders text changes according to whether a real delta is available", async () => {
		const renderer = new DeterministicEvidenceRenderer(
			new WebCryptoReflectionHasher(),
		);
		const [missingBaseline, unavailable, inserted, cleared, deleted] =
			await renderer.render([
				textValueEvent(1, {
					deltaAvailable: false,
					insertedChars: 0,
					deletedChars: 0,
					finalValue: "already present",
				}),
				textValueEvent(2, {
					deltaAvailable: false,
					insertedChars: 0,
					deletedChars: 0,
					contentState: "unavailable",
				}),
				textValueEvent(3, {
					deltaAvailable: true,
					insertedChars: 1,
					deletedChars: 0,
					addedText: "!",
					finalValue: "draft!",
				}),
				textValueEvent(4, {
					deltaAvailable: true,
					insertedChars: 0,
					deletedChars: 3,
					finalValue: "",
				}),
				textValueEvent(5, {
					deltaAvailable: true,
					insertedChars: 0,
					deletedChars: 1,
					finalValue: "ab",
				}),
			]);

		expect(missingBaseline?.renderedText).toBe(
			"Editor的“编辑区”控件最终显示为“already present”，因缺少基线无法判断增删或输入方式",
		);
		expect(missingBaseline?.templateArgs.deltaAvailable).toBeFalse();
		expect(unavailable?.renderedText).toBe(
			"Editor的焦点控件最终值不可用，无法判断增删或输入方式",
		);
		expect(inserted?.renderedText).toBe(
			"Editor的“编辑区”控件最终增加了文本“!”，输入方式未知",
		);
		expect(cleared?.renderedText).toBe(
			"Editor的“编辑区”控件最终清空了内容（删除 3 字符），输入方式未知",
		);
		expect(deleted?.renderedText).toBe(
			"Editor的“编辑区”控件最终删除了 1 个字符，当前显示为“ab”，输入方式未知",
		);
	});

	test("bounds a fragmented processing window to eight primary episodes without losing facts", async () => {
		const hasher = new WebCryptoReflectionHasher();
		const facts = Array.from({ length: 12 }, (_, index) => fact(index + 1));
		const assembler = new DeterministicEpisodeAssembler({
			hasher,
			hypotheses:
				new DeterministicTimelineHypothesisGenerator(),
		});
		const episodes = await assembler.assemble(
			windowFor([], 300_000),
			facts,
			null,
		);
		expect(episodes.length).toBeLessThanOrEqual(8);
		expect(
			new Set(
				episodes.flatMap((episode) => [
					...episode.evidenceFactIds,
					...episode.supportingFactIds,
				]),
			).size,
		).toBe(facts.length);
		expect(
			episodes.every(
				(episode) => episode.endedAtMs > episode.startedAtMs,
			),
		).toBeTrue();
	});

	test("uses the actual evidence period instead of the max-wait deadline", async () => {
		const hasher = new WebCryptoReflectionHasher();
		const repository = new InMemoryTimelineV2Repository();
		const events = [browserEvent(1, 1_000), browserEvent(2, 2_000)];
		const processor = new TimelineV2Processor({
			repository,
			evidence: new DeterministicEvidenceRenderer(hasher),
			episodes: new DeterministicEpisodeAssembler({
				hasher,
				hypotheses:
					new DeterministicTimelineHypothesisGenerator(),
			}),
			hasher,
			clock: { nowMs: () => 300_000 },
			formatTime: String,
		});
		const result = await processor.process(windowFor(events, 300_000));
		expect(result.summary.period).toEqual({
			startedAtMs: 1_000,
			endedAtMs: 2_010,
		});
		expect(result.agentInput.period).toEqual(result.summary.period);
	});
});
