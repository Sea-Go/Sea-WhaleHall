import { describe, expect, test } from "bun:test";
import { parseLocalMessage } from "../src/agent/local-protocol";
import {
	isSemanticEventV2,
	type SemanticEventV2,
} from "../src/agent/timeline";

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





});
