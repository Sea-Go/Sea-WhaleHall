import { describe, expect, test } from "bun:test";
import { parseLocalMessage } from "../src/agent/local-protocol";
import {
	isSemanticEventV2,
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

function textValueEvent(deltaAvailable: boolean): SemanticEventV2 {
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
