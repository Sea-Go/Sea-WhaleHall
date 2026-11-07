import { describe, expect, test } from "bun:test";
import { WebCryptoReflectionHasher } from "../src/agent/reflection/hash";
import {
	type ActivityEpisodeV2,
	DeterministicEpisodeAssembler,
	DeterministicEvidenceRenderer,
	DeterministicTimelineHypothesisGenerator,
	type EvidenceFactV2,
	HeuristicTimelineEpisodeClassifier,
	InMemoryTimelineV2Repository,
	type SemanticEventV2,
	TimelineV2Processor,
	type TimelineWindowV2,
} from "../src/agent/timeline";

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
				options.url ?? "https://example.invalid/research?topic=graph#section",
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
			...(options.contentState === "unavailable" ? {} : { label: "编辑区" }),
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
});
