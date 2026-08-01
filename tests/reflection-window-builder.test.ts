import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MODEL_INPUT_BYTE_LIMIT,
	DEFAULT_MODEL_INPUT_TOKEN_LIMIT,
	DESKTOP_EVENT_SCHEMA_VERSION,
	conservativeTokenEstimate,
	renderModelInput,
	type DesktopEventForKind,
} from "../src/agent/reflection";

function browserNavigation(
	index: number,
	url: string,
): DesktopEventForKind<"browser.tabNavigated"> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `browser-${index}`,
		cursor: `cursor-${index.toString().padStart(4, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "browser.tabNavigated",
		source: "browser.activity.sensor",
		occurredAtMs: index,
		observedAtMs: index,
		goalVersion: null,
		sensitivity: "content",
		payload: {
			browserId: "browser-1",
			tabId: `tab-${index}`,
			title: `Page ${index}`,
			url,
		},
	};
}

describe("deterministic model input bounds", () => {
	test("retains all 64 semantic events while bounding adversarial content", () => {
		const events = Array.from({ length: 64 }, (_, index) =>
			browserNavigation(
				index,
				`https://example.test/${index}?value=${"x".repeat(16_000)}`,
			),
		);

		const first = renderModelInput(null, events, []);
		const second = renderModelInput(null, events, []);

		expect(second).toBe(first);
		expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(
			DEFAULT_MODEL_INPUT_BYTE_LIMIT,
		);
		expect(conservativeTokenEstimate(first)).toBeLessThanOrEqual(
			DEFAULT_MODEL_INPUT_TOKEN_LIMIT,
		);
		const eventSection = first.split("\n[EVENTS]\n")[1];
		expect(eventSection).toBeDefined();
		const renderedEvents = eventSection?.split("\n").map((line) => JSON.parse(line));
		expect(renderedEvents).toHaveLength(64);
		expect(
			renderedEvents?.every(
				(event) =>
					event.kind === "browser.tabNavigated" &&
					Number.isSafeInteger(event.occurredAtMs),
			),
		).toBe(true);
	});

	test("keeps the immutable rich event representation when it already fits", () => {
		const event = browserNavigation(1, "https://example.test/whalehall");
		const input = renderModelInput(null, [event], []);

		expect(input).toContain('"eventId":"browser-1"');
		expect(input).toContain('"url":"https://example.test/whalehall"');
	});
});
