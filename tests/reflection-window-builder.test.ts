import { describe, expect, test } from "bun:test";
import {
	type ActiveGoalContextV1,
	conservativeTokenEstimate,
	DEFAULT_MODEL_INPUT_BYTE_LIMIT,
	DEFAULT_MODEL_INPUT_TOKEN_LIMIT,
	DESKTOP_EVENT_SCHEMA_VERSION,
	type DesktopEventForKind,
	type DesktopEventKind,
	type DesktopEventV1,
	renderModelInput,
} from "../src/agent/reflection";

const BASE_MS = 1_795_788_000_000;

function desktopEvent<K extends DesktopEventKind>(
	index: number,
	kind: K,
	payload: DesktopEventForKind<K>["payload"],
): DesktopEventForKind<K> {
	return {
		schemaVersion: DESKTOP_EVENT_SCHEMA_VERSION,
		eventId: `${kind}-${index}`,
		cursor: `cursor-${index.toString().padStart(4, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind,
		source: "activity.sensor",
		occurredAtMs: BASE_MS + index * 2_400,
		observedAtMs: BASE_MS + index * 2_400,
		goalVersion: 11,
		sensitivity: "metadata",
		payload,
	};
}

const inputBucket = (index: number) =>
	desktopEvent(index, "input.activityAggregated", {
		bucketStartedAtMs: BASE_MS + index * 2_400,
		bucketEndedAtMs: BASE_MS + index * 2_400 + 5_000,
		keyCount: 3,
		clickCount: 1,
		scrollDelta: 0,
		mouseDistance: 12.5,
	});

const processBatch = (index: number) =>
	desktopEvent(index, "application.processObservedBatch", {
		started: [
			{
				processId: 100 + index,
				appId: "com.example.editor",
				appName: "Editor",
			},
		],
		exited: [],
	});

const pendingTasksGoal: ActiveGoalContextV1 = {
	goalId: "pending-tasks:plan-1",
	planId: "plan-1",
	version: 11,
	text: `待办任务：${Array.from(
		{ length: 5 },
		(_, index) => `${index + 1}. 完成第${index + 1}项任务的联调验证与回归`,
	).join("；")}`,
	activatedAtMs: BASE_MS,
};

function eventLines(input: string): Array<Record<string, unknown>> {
	const section = input.split("\n[EVENTS]\n")[1];
	expect(section).toBeDefined();
	return (section ?? "").split("\n").map((line) => JSON.parse(line));
}

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
		const renderedEvents = eventSection
			?.split("\n")
			.map((line) => JSON.parse(line));
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

	// Five minutes of mirrored input buckets and process batches is what the
	// collector hands over in an ordinary working session.
	function denseWindow() {
		const events: DesktopEventV1[] = [];
		let index = 0;
		for (let bucket = 0; bucket < 62; bucket += 1) {
			events.push(
				processBatch(index),
				processBatch(index + 1),
				inputBucket(index + 2),
			);
			index += 3;
		}
		return events;
	}

	test("fits a dense window by listing non-counted runs instead of one line each", () => {
		const events = denseWindow();
		const first = renderModelInput(pendingTasksGoal, events, []);
		const second = renderModelInput(pendingTasksGoal, events, []);

		expect(second).toBe(first);
		expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(
			DEFAULT_MODEL_INPUT_BYTE_LIMIT,
		);
		expect(conservativeTokenEstimate(first)).toBeLessThanOrEqual(
			DEFAULT_MODEL_INPUT_TOKEN_LIMIT,
		);
		const lines = eventLines(first);
		const counted = lines.filter(
			(line) => line.kind === "input.activityAggregated",
		);
		expect(counted).toHaveLength(62);
		const batches = lines.filter(
			(line) => line.kind === "application.processObservedBatch",
		);
		expect(batches.every((line) => Array.isArray(line.occurredAtMs))).toBe(
			true,
		);
		expect(
			batches.reduce(
				(total, line) => total + (line.occurredAtMs as number[]).length,
				0,
			),
		).toBe(124);
		expect(lines.some((line) => "omittedNonCountedEvents" in line)).toBe(false);
	});

	test("drops the oldest non-counted runs with an explicit count when nothing else is left", () => {
		const events: DesktopEventV1[] = [];
		for (let index = 0; index < 64; index += 1) {
			events.push(browserNavigation(index, `https://example.test/${index}`));
			for (let step = 0; step < 5; step += 1) {
				events.push(
					desktopEvent(100 + index * 5 + step, "tool.started", {
						callId: `call-${index}`,
					}),
					desktopEvent(500 + index * 5 + step, "system.cursorCheckpoint", {}),
				);
			}
		}

		const first = renderModelInput(null, events, []);
		const second = renderModelInput(null, events, []);

		expect(second).toBe(first);
		expect(conservativeTokenEstimate(first)).toBeLessThanOrEqual(
			DEFAULT_MODEL_INPUT_TOKEN_LIMIT,
		);
		const lines = eventLines(first);
		expect(
			lines.filter((line) => line.kind === "browser.tabNavigated"),
		).toHaveLength(64);
		const omitted = lines.filter((line) => "omittedNonCountedEvents" in line);
		expect(omitted).toHaveLength(1);
		expect(omitted[0]?.omittedNonCountedEvents).toBeGreaterThan(0);
	});

	test("refuses only when the counted evidence alone cannot fit", () => {
		const events = Array.from({ length: 64 }, (_, index) =>
			browserNavigation(index, `https://example.test/${index}`),
		);

		expect(() =>
			renderModelInput(null, events, [], { tokenLimit: 40 }),
		).toThrow(
			"Goal and semantic event skeleton exceed the deterministic model input budget.",
		);
	});
});
