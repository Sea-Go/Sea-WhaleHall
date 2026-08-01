import { describe, expect, test } from "bun:test";
import {
	DESKTOP_EVENT_SCHEMA_VERSION,
	DESKTOP_OBSERVATION_SCHEMA_VERSION,
	SemanticEventCoalescer,
	type DesktopEventForKind,
	type EditorDocumentDeltaObservationV1,
	type EventIdentityFactory,
	type InputActivityObservationV1,
	type ProcessScanObservationV1,
} from "../src/agent/reflection";

class TestIdentityFactory implements EventIdentityFactory {
	private sequence = 0;

	create() {
		this.sequence += 1;
		return {
			eventId: `coalesced-${this.sequence}`,
			cursor: `cursor-${this.sequence}`,
		};
	}
}

function createCoalescer(): SemanticEventCoalescer {
	return new SemanticEventCoalescer({ identityFactory: new TestIdentityFactory() });
}

function inputSample(
	index: number,
	atMs: number,
	overrides: Partial<InputActivityObservationV1["payload"]> = {},
): InputActivityObservationV1 {
	return {
		schemaVersion: DESKTOP_OBSERVATION_SCHEMA_VERSION,
		observationId: `input-${index}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "input.activitySample",
		source: "macos-input",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		sensitivity: "metadata",
		payload: {
			keyCount: 1,
			clickCount: 0,
			scrollDelta: 0,
			mouseDistance: 1,
			...overrides,
		},
	};
}

function editDelta(
	index: number,
	atMs: number,
	text = "x",
	sensitivity: EditorDocumentDeltaObservationV1["sensitivity"] = "content",
): EditorDocumentDeltaObservationV1 {
	return {
		schemaVersion: DESKTOP_OBSERVATION_SCHEMA_VERSION,
		observationId: `edit-${index}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "editor.documentDelta",
		source: "vscode-extension",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		sensitivity,
		payload: {
			editorId: "vscode",
			documentId: "doc-1",
			relativePath: "src/index.ts",
			language: "typescript",
			insertedChars: text.length,
			deletedChars: 0,
			text,
		},
	};
}

function foregroundEvent(
	index: number,
	appId: string,
	windowTitle?: string,
): DesktopEventForKind<"application.foregroundChanged"> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `foreground-${index}`,
		cursor: `raw-${index}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "application.foregroundChanged",
		source: "activity",
		occurredAtMs: index,
		observedAtMs: index,
		goalVersion: null,
		sensitivity: windowTitle ? "content" : "metadata",
		payload: { appId, appName: appId, ...(windowTitle ? { windowTitle } : {}) },
	};
}

function browserEvent(
	index: number,
	kind: "browser.tabOpened" | "browser.tabNavigated" | "browser.tabClosed",
	options: { title?: string; url?: string } = {},
): DesktopEventForKind<typeof kind> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `browser-${index}`,
		cursor: `browser-raw-${index}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind,
		source: "browser.activity.sensor",
		occurredAtMs: index,
		observedAtMs: index,
		goalVersion: null,
		sensitivity:
			options.title === undefined && options.url === undefined
				? "metadata"
				: "content",
		payload: {
			browserId: "browser-1",
			tabId: "tab-1",
			...options,
		},
	};
}

describe("SemanticEventCoalescer input aggregation", () => {
	test("1000 raw input observations become one counted five-second event", () => {
		const coalescer = createCoalescer();
		for (let index = 0; index < 1_000; index += 1) {
			expect(coalescer.push(inputSample(index, index % 5_000))).toEqual([]);
		}
		const output = coalescer.flush(5_000);
		expect(output).toHaveLength(1);
		expect(output[0]).toMatchObject({
			kind: "input.activityAggregated",
			payload: {
				bucketStartedAtMs: 0,
				bucketEndedAtMs: 5_000,
				keyCount: 1_000,
				clickCount: 0,
				mouseDistance: 1_000,
			},
		});
	});

	test("fixed epoch buckets are emitted independently and in time order", () => {
		const coalescer = createCoalescer();
		coalescer.push(inputSample(1, 4_999));
		const crossed = coalescer.push(inputSample(2, 5_000));
		expect(crossed).toHaveLength(1);
		expect(crossed[0]?.kind).toBe("input.activityAggregated");
		const second = coalescer.flush(10_000);
		expect(second).toHaveLength(1);
		if (crossed[0]?.kind === "input.activityAggregated" && second[0]?.kind === "input.activityAggregated") {
			expect(crossed[0].payload.bucketStartedAtMs).toBe(0);
			expect(second[0].payload.bucketStartedAtMs).toBe(5_000);
		}
	});
});

describe("SemanticEventCoalescer editor bursts", () => {
	test("two seconds of edit silence finalizes one document burst", () => {
		const coalescer = createCoalescer();
		coalescer.push(editDelta(1, 0, "hello"));
		coalescer.push(editDelta(2, 1_000, " world"));
		expect(coalescer.flush(2_999)).toEqual([]);
		const output = coalescer.flush(3_000);
		expect(output).toHaveLength(1);
		expect(output[0]).toMatchObject({
			kind: "editor.documentChanged",
			sensitivity: "content",
			payload: {
				documentId: "doc-1",
				insertedChars: 11,
				text: "hello world",
				burstStartedAtMs: 0,
				burstEndedAtMs: 3_000,
			},
		});
	});

	test("continuous edits force-close at ten seconds", () => {
		const coalescer = createCoalescer();
		for (let second = 0; second < 10; second += 1) {
			expect(coalescer.push(editDelta(second, second * 1_000))).toEqual([]);
		}
		const output = coalescer.push(editDelta(10, 10_000));
		expect(output).toHaveLength(1);
		expect(output[0]).toMatchObject({
			kind: "editor.documentChanged",
			payload: {
				insertedChars: 10,
				burstStartedAtMs: 0,
				burstEndedAtMs: 10_000,
			},
		});
		expect(coalescer.flush(12_000)).toHaveLength(1);
	});

	test("metadata edit observations cannot smuggle text into a burst", () => {
		const coalescer = createCoalescer();
		coalescer.push(editDelta(1, 0, "secret", "metadata"));

		const output = coalescer.flush(2_000);

		expect(output).toHaveLength(1);
		expect(output[0]).toMatchObject({
			kind: "editor.documentChanged",
			sensitivity: "metadata",
			payload: { insertedChars: 6 },
		});
		if (output[0]?.kind === "editor.documentChanged") {
			expect("text" in output[0].payload).toBe(false);
		}
	});
});

describe("SemanticEventCoalescer process batching and deduplication", () => {
	test("one process scan becomes one started/exited batch", () => {
		const coalescer = createCoalescer();
		const scan: ProcessScanObservationV1 = {
			schemaVersion: DESKTOP_OBSERVATION_SCHEMA_VERSION,
			observationId: "scan-1",
			deviceId: "device-1",
			sessionId: "session-1",
			kind: "application.processScan",
			source: "process-monitor",
			occurredAtMs: 0,
			observedAtMs: 0,
			goalVersion: null,
			sensitivity: "metadata",
			payload: {
				started: [{ processId: 1, appId: "vscode", appName: "VS Code" }],
				exited: [{ processId: 2, appId: "qq", appName: "QQ" }],
			},
		};
		const output = coalescer.push(scan);
		expect(output).toHaveLength(1);
		expect(output[0]).toMatchObject({
			kind: "application.processObservedBatch",
			payload: {
				started: [{ appId: "vscode" }],
				exited: [{ appId: "qq" }],
			},
		});
	});

	test("empty process scans do not invent semantic events", () => {
		const coalescer = createCoalescer();
		const scan: ProcessScanObservationV1 = {
			schemaVersion: DESKTOP_OBSERVATION_SCHEMA_VERSION,
			observationId: "scan-empty",
			deviceId: "device-1",
			sessionId: "session-1",
			kind: "application.processScan",
			source: "process-monitor",
			occurredAtMs: 0,
			observedAtMs: 0,
			goalVersion: null,
			sensitivity: "metadata",
			payload: { started: [], exited: [] },
		};
		expect(coalescer.push(scan)).toEqual([]);
	});

	test("exact repeated foreground observations are suppressed but A-B-A is retained", () => {
		const coalescer = createCoalescer();
		expect(coalescer.push(foregroundEvent(1, "vscode"))).toHaveLength(1);
		expect(coalescer.push(foregroundEvent(2, "vscode"))).toEqual([]);
		expect(coalescer.push(foregroundEvent(3, "browser"))).toHaveLength(1);
		expect(coalescer.push(foregroundEvent(4, "vscode"))).toHaveLength(1);
	});

	test("a foreground title transition is retained when content consent is active", () => {
		const coalescer = createCoalescer();
		expect(coalescer.push(foregroundEvent(1, "vscode", "one.ts"))).toHaveLength(1);
		expect(coalescer.push(foregroundEvent(2, "vscode", "one.ts"))).toEqual([]);
		expect(coalescer.push(foregroundEvent(3, "vscode", "two.ts"))).toHaveLength(1);
	});

	test("metadata-only browser navigation transitions are never mistaken for poll duplicates", () => {
		const coalescer = createCoalescer();
		expect(coalescer.push(browserEvent(1, "browser.tabOpened"))).toHaveLength(1);
		expect(coalescer.push(browserEvent(2, "browser.tabNavigated"))).toHaveLength(1);
		expect(coalescer.push(browserEvent(3, "browser.tabNavigated"))).toHaveLength(1);
	});

	test("closing a tab clears content dedupe state before the same tab id reopens", () => {
		const coalescer = createCoalescer();
		const content = { title: "WhaleHall", url: "https://example.test/whalehall" };
		expect(coalescer.push(browserEvent(1, "browser.tabOpened", content))).toHaveLength(1);
		expect(coalescer.push(browserEvent(2, "browser.tabOpened", content))).toEqual([]);
		expect(coalescer.push(browserEvent(3, "browser.tabClosed"))).toHaveLength(1);
		expect(coalescer.push(browserEvent(4, "browser.tabOpened", content))).toHaveLength(1);
	});

	test("dedupe state is not advanced until a prepared event is durably committed", () => {
		const coalescer = createCoalescer();
		const event = foregroundEvent(1, "vscode");
		const failedAttempt = coalescer.prepareDesktopEvent(event);
		expect(failedAttempt.events).toHaveLength(1);

		const replay = coalescer.prepareDesktopEvent(event);
		expect(replay.events).toHaveLength(1);
		replay.commit();

		expect(coalescer.prepareDesktopEvent(event).events).toEqual([]);
	});
});
