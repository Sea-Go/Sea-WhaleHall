import { describe, expect, test } from "bun:test";
import {
	DESKTOP_EVENT_SCHEMA_VERSION,
	DESKTOP_OBSERVATION_SCHEMA_VERSION,
	type DesktopEventForKind,
	type EventIdentityFactory,
	type InputActivityObservationV1,
	type ProcessScanObservationV1,
	SemanticEventCoalescer,
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
	return new SemanticEventCoalescer({
		identityFactory: new TestIdentityFactory(),
	});
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
		if (
			crossed[0]?.kind === "input.activityAggregated" &&
			second[0]?.kind === "input.activityAggregated"
		) {
			expect(crossed[0].payload.bucketStartedAtMs).toBe(0);
			expect(second[0].payload.bucketStartedAtMs).toBe(5_000);
		}
	});
});

describe("SemanticEventCoalescer process batching and deduplication", () => {});
