import { describe, expect, test } from "bun:test";
import type { ActivityEventWorkerRequest } from "../src/agent/activity-event-worker";
import {
	activityReflectionOutputToWorkerResponse,
	createActivityReflectionPrompt,
} from "../src/agent/activity-reflection-prompt";
import { deriveActivityReflectionStateHints } from "../src/agent/activity-reflection-state-hints";

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

	const navigation = (offsetMs: number) => ({
		kind: "browser.tabNavigated",
		occurredAtMs: WINDOW.startedAtMs + offsetMs,
		payload: { browserId: "com.example.browser", tabId: "tab-1" },
	});
	const processBatch = (offsetMs: number) => ({
		kind: "application.processObservedBatch",
		occurredAtMs: WINDOW.startedAtMs + offsetMs,
		payload: { started: [], exited: [] },
	});
	// Text changes and input buckets every half second from `offsetMs`.
	function denseEvidence(offsetMs: number, count: number) {
		return Array.from({ length: count }, (_, index) => [
			...textChanges(1, offsetMs + index * 1_000),
			{
				kind: "input.activityAggregated",
				occurredAtMs: WINDOW.startedAtMs + offsetMs + index * 1_000 + 500,
				payload: {
					bucketStartedAtMs: WINDOW.startedAtMs + offsetMs + index * 1_000,
					bucketEndedAtMs: WINDOW.startedAtMs + offsetMs + index * 1_000 + 500,
					keyCount: 6,
					clickCount: 0,
					scrollDelta: 0,
					mouseDistance: 40,
				},
			},
		]).flat();
	}

	const switchAt = (offsetMs: number) => ({
		kind: "application.foregroundChanged",
		occurredAtMs: WINDOW.startedAtMs + offsetMs,
	});

	test("does not let a process batch claim the evidence that follows a switch", () => {
		// The same work continues after the switch: one editable band.
		const continued = signalIndex([
			foregroundSwitch,
			...textChanges(3, 1_000),
			switchAt(20_000),
			processBatch(20_500),
			...denseEvidence(21_000, 30),
		]);
		// Different work follows the switch: the batch rides with the new band.
		const changed = signalIndex([
			navigation(1_000),
			switchAt(20_000),
			processBatch(20_500),
			...denseEvidence(21_000, 30),
		]);
		const band = changed.segments[1];

		expect(continued.segments).toHaveLength(1);
		expect(continued.segments[0]?.candidate_activities).toEqual([
			"writing",
			"development",
			"data_work",
			"communication",
			"other_unknown",
		]);
		expect(continued.segments[0]?.observed_signals).toContainEqual({
			kind: "文本内容变更观察",
			count: 33,
		});
		expect(changed.segments).toHaveLength(2);
		expect(band?.started_at_ms).toBe(WINDOW.startedAtMs + 20_000);
		expect(band?.candidate_activities).toEqual([
			"writing",
			"development",
			"data_work",
			"communication",
			"other_unknown",
		]);
		expect(band?.observed_signals).toEqual(
			expect.arrayContaining([
				{ kind: "前台上下文切换", count: 1 },
				{ kind: "其他脱敏观察", count: 1 },
				{ kind: "文本内容变更观察", count: 30 },
			]),
		);
	});

	test("keeps a window of process batches alone unscorable", () => {
		const index = signalIndex([
			foregroundSwitch,
			processBatch(1_000),
			processBatch(4_000),
		]);

		expect(index.segments).toHaveLength(1);
		expect(index.segments[0]?.candidate_activities).toEqual(["other_unknown"]);
	});

	test("offers the activities of every family that shaped a segment", () => {
		const afterNavigation = signalIndex([
			navigation(0),
			...textChanges(4, 5_000),
		]);
		const afterEditing = signalIndex([
			navigation(40_000),
			...textChanges(4, 0),
		]);

		expect(afterNavigation.segments[0]?.candidate_activities).toEqual([
			"research",
			"other_unknown",
			"writing",
			"development",
			"data_work",
			"communication",
		]);
		expect(afterEditing.segments[0]?.candidate_activities).toEqual([
			"writing",
			"development",
			"data_work",
			"communication",
			"other_unknown",
			"research",
		]);
	});

	test("starts the next band at the boundary without overlapping the previous one", () => {
		const index = signalIndex([
			navigation(0),
			{
				kind: "application.foregroundChanged",
				occurredAtMs: WINDOW.startedAtMs + 20_000,
			},
			...inputBuckets(4, 21_000),
			...textChanges(4, 30_000),
		]);
		const [reading, editing] = index.segments;

		expect(index.segments).toHaveLength(2);
		expect(reading?.ended_at_ms).toBeLessThanOrEqual(
			editing?.started_at_ms ?? 0,
		);
		expect(editing?.started_at_ms).toBe(WINDOW.startedAtMs + 20_000);
		expect(editing?.observed_signals).toContainEqual({
			kind: "连续键鼠交互观察",
			count: 4,
		});
	});

	test("keeps one band when the same family continues after a switch", () => {
		const index = signalIndex([
			navigation(0),
			switchAt(10_000),
			navigation(15_000),
		]);
		const band = index.segments[0];

		expect(index.segments).toHaveLength(1);
		expect(band?.candidate_activities).toEqual(["research", "other_unknown"]);
		expect(band?.ended_at_ms).toBe(WINDOW.startedAtMs + 15_000);
		expect(band?.observed_signals).toEqual(
			expect.arrayContaining([
				{ kind: "前台上下文切换", count: 1 },
				{ kind: "浏览器资料观察", count: 2 },
			]),
		);
	});

	test("counts every boundary that waits for the same evidence", () => {
		// The bridge reports one switch twice, and an AFK period closes on a pair.
		const switchPair = signalIndex([
			...textChanges(1, 1_000),
			switchAt(20_000),
			switchAt(20_500),
			...textChanges(1, 21_000),
		]);
		const afkPair = signalIndex([
			...textChanges(1, 1_000),
			{
				kind: "presence.afkStarted",
				occurredAtMs: WINDOW.startedAtMs + 20_000,
			},
			processBatch(20_500),
			{
				kind: "presence.afkEnded",
				occurredAtMs: WINDOW.startedAtMs + 25_000,
			},
			...textChanges(1, 26_000),
		]);

		for (const index of [switchPair, afkPair]) {
			expect(index.segments).toHaveLength(1);
			expect(index.segments[0]?.observation_count).toBe(
				index.observation_count,
			);
		}
		expect(switchPair.observation_count).toBe(4);
		expect(switchPair.segments[0]?.observed_signals).toContainEqual({
			kind: "前台上下文切换",
			count: 2,
		});
		expect(afkPair.observation_count).toBe(5);
		expect(afkPair.segments[0]?.observed_signals).toContainEqual({
			kind: "设备状态边界",
			count: 2,
		});
	});

	test("keeps a writing action that mentions a document", () => {
		const modelOutput = (activity: string) => ({
			events: [
				{
					action: "推测：正在对文档进行修改",
					activity,
					goal_relevance: "supporting",
					confidence: 0.75,
					reason_codes: ["文档变更", "持续输入"],
					evidence: ["文本变更伴随持续输入"],
					signal_segment_ids: ["segment-1"],
					started_at_ms: null,
					ended_at_ms: null,
				},
			],
			score: 0.5,
			score_reason: "目标直接相关，强交叉证据，持续约 3 分钟，计 0.5 分。",
		});
		const events = [
			foregroundSwitch,
			...textChanges(3, 1_000),
			...inputBuckets(4, 1_000),
		];
		const writing = activityReflectionOutputToWorkerResponse(
			modelOutput("writing"),
			request(events),
		);
		const development = activityReflectionOutputToWorkerResponse(
			modelOutput("development"),
			request(events),
		);

		expect(writing.events[0]?.action).toBe("推测：正在对文档进行修改");
		expect(development.events[0]?.action).toBe("推测：正在进行编程");
	});
});

describe("activity reflection interaction density", () => {
	const density = (events: Array<Record<string, unknown>>) =>
		deriveActivityReflectionStateHints({ events }).interaction_density;

	test("does not call a single text change sustained editing", () => {
		expect(
			density([
				foregroundSwitch,
				...textChanges(1, 1_000),
				...inputBuckets(1, 6_000),
			]),
		).toBe("连续操作");
		expect(density([foregroundSwitch, ...textChanges(3, 1_000)])).toBe(
			"连续创建或编辑",
		);
	});
});
