import { describe, expect, test } from "bun:test";
import type { ActivityEventWorkerRequest } from "../src/agent/activity-event-worker";
import { createActivityReflectionPrompt } from "../src/agent/activity-reflection-prompt";

type SignalIndex = {
	schema_version: string;
	observation_count: number;
	segments: Array<{
		segment_id: string;
		started_at_ms: number;
		ended_at_ms: number;
		observation_count: number;
		observed_signals: Array<{ kind: string; count: number }>;
		candidate_activities: string[];
		recommended_action: string;
	}>;
};

const WINDOW = {
	startedAtMs: 1_000,
	endedAtMs: 60_000,
} as const;

function request(
	events: Array<Record<string, unknown>>,
): ActivityEventWorkerRequest {
	return {
		schema_version: "activity-event-analysis-request.v1",
		request_id: "activity-window-request-signal-index",
		raw_event: { windowId: "sealed-window-1", events } as never,
		context: {
			goal: { goalId: "goal-1", text: "private goal text" },
			response_contract: {
				source_window_id: "sealed-window-1",
				source_event_ids: [],
				window_started_at_ms: WINDOW.startedAtMs,
				window_ended_at_ms: WINDOW.endedAtMs,
				time_zone: "UTC",
			},
		} as never,
	};
}

function textChanges(
	count: number,
	offsetMs: number,
): Array<Record<string, unknown>> {
	return Array.from({ length: count }, (_, index) => ({
		kind: "accessibility.documentChanged",
		occurredAtMs: WINDOW.startedAtMs + offsetMs + index * 5_000,
		payload: {
			appId: "com.example.notes",
			insertedChars: 12,
			deletedChars: 0,
		},
	}));
}

function inputBuckets(
	count: number,
	offsetMs: number,
): Array<Record<string, unknown>> {
	return Array.from({ length: count }, (_, index) => ({
		kind: "input.activityAggregated",
		occurredAtMs: WINDOW.startedAtMs + offsetMs + index * 5_000,
		payload: {
			bucketStartedAtMs: WINDOW.startedAtMs + offsetMs + index * 5_000,
			bucketEndedAtMs: WINDOW.startedAtMs + offsetMs + (index + 1) * 5_000,
			keyCount: 6,
			clickCount: 0,
			scrollDelta: 0,
			mouseDistance: 40,
		},
	}));
}

function signalIndex(events: Array<Record<string, unknown>>): SignalIndex {
	const prompt = createActivityReflectionPrompt(request(events));
	const line = prompt.userPrompt
		.split("\n")
		.find((candidate) => candidate.startsWith("LOCAL_SIGNAL_INDEX_JSON="));
	if (line === undefined) throw new Error("signal index is missing");
	return JSON.parse(
		line.slice("LOCAL_SIGNAL_INDEX_JSON=".length),
	) as SignalIndex;
}

const foregroundSwitch = {
	kind: "application.foregroundChanged",
	occurredAtMs: WINDOW.startedAtMs,
};

describe("activity reflection signal index", () => {
	test("offers editable activities when a text control's value changes", () => {
		const prompt = createActivityReflectionPrompt(
			request([
				foregroundSwitch,
				...textChanges(3, 1_000),
				...inputBuckets(4, 1_000),
			]),
		);

		expect(prompt.candidateActivities).toEqual([
			"writing",
			"development",
			"data_work",
			"communication",
			"other_unknown",
		]);
		expect(prompt.signalSegmentIds).toEqual(["segment-1"]);
	});

	test("treats an accessibility value change like a document change", () => {
		const prompt = createActivityReflectionPrompt(
			request([
				foregroundSwitch,
				{
					kind: "accessibility.valueChanged",
					occurredAtMs: WINDOW.startedAtMs + 1_000,
					payload: { appId: "com.example.sheets", role: "AXCell" },
				},
			]),
		);

		expect(prompt.candidateActivities).toContain("data_work");
	});

	test("attaches input buckets to the editing segment as cross evidence", () => {
		const index = signalIndex([
			foregroundSwitch,
			...textChanges(3, 1_000),
			...inputBuckets(4, 2_000),
		]);
		const segment = index.segments[0];

		expect(index.observation_count).toBe(8);
		// Signals are reported under privacy-safe labels, never raw kinds.
		expect(segment?.observed_signals).toHaveLength(3);
		expect(segment?.observed_signals).toEqual(
			expect.arrayContaining([
				{ kind: "前台上下文切换", count: 1 },
				{ kind: "文本内容变更观察", count: 3 },
				{ kind: "连续键鼠交互观察", count: 4 },
			]),
		);
		// The pending foreground boundary opens the segment.
		expect(segment?.started_at_ms).toBe(WINDOW.startedAtMs);
		expect(segment?.ended_at_ms).toBe(WINDOW.startedAtMs + 2_000 + 3 * 5_000);
	});

	test("keeps foreground switches and input alone unscorable", () => {
		const prompt = createActivityReflectionPrompt(
			request([foregroundSwitch, ...inputBuckets(4, 1_000)]),
		);

		expect(prompt.candidateActivities).toEqual(["other_unknown"]);
	});

	test("treats accessibility focus changes as auxiliary evidence only", () => {
		const index = signalIndex([
			foregroundSwitch,
			...Array.from({ length: 3 }, (_, index) => ({
				kind: "accessibility.focusChanged",
				occurredAtMs: WINDOW.startedAtMs + 1_000 + index * 5_000,
				payload: { appId: "com.example.notes", role: "AXTextArea" },
			})),
		]);

		expect(index.segments[0]?.candidate_activities).toEqual(["other_unknown"]);
		expect(index.segments[0]?.observed_signals).toEqual(
			expect.arrayContaining([
				{ kind: "前台上下文切换", count: 1 },
				{ kind: "界面焦点变化观察", count: 3 },
			]),
		);
	});

	test("keeps a browser page change a research candidate", () => {
		const prompt = createActivityReflectionPrompt(
			request([
				foregroundSwitch,
				{
					kind: "browser.tabNavigated",
					occurredAtMs: WINDOW.startedAtMs + 1_000,
					payload: { browserId: "com.example.browser", tabId: "tab-1" },
				},
			]),
		);

		expect(prompt.candidateActivities).toEqual(["research", "other_unknown"]);
	});
});
