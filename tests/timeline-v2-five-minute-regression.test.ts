import { describe, expect, test } from "bun:test";
import type {
	ReflectionClock,
	ReflectionTimerHandle,
} from "../src/agent/reflection/collector";
import { WebCryptoReflectionHasher } from "../src/agent/reflection/hash";
import {
	DeterministicEpisodeAssembler,
	DeterministicEvidenceRenderer,
	DeterministicTimelineHypothesisGenerator,
	InMemoryTimelineV2Repository,
	TimelineV2Collector,
	TimelineV2JobRunner,
	TimelineV2Processor,
	type SemanticEventV2,
} from "../src/agent/timeline-v2";

class ReplayClock implements ReflectionClock {
	private timerId = 0;

	constructor(private currentMs = 0) {}

	nowMs(): number {
		return this.currentMs;
	}

	setNowMs(value: number): void {
		this.currentMs = value;
	}

	setTimer(
		_callback: () => void,
		_delayMs: number,
	): ReflectionTimerHandle {
		this.timerId += 1;
		return this.timerId as unknown as ReflectionTimerHandle;
	}

	clearTimer(_handle: ReflectionTimerHandle): void {}
}

function replayEvent(index: number, atMs: number): SemanticEventV2 {
	const base = {
		schemaVersion: "semantic-event.v2" as const,
		eventId: `replay-event-${index}`,
		cursor: `sec2_${index.toString(16).padStart(16, "0")}`,
		deviceId: "fixture-device",
		sessionId: "fixture-session",
		occurredAtMs: atMs,
		observedAtMs: atMs + 1_000,
		goalVersion: null,
		countClass: "effective" as const,
		reliability: "high" as const,
		coverage: ["content", "metadata"] as const,
		contentState: "available" as const,
		sourceObservationIds: [`replay-observation-${index}`],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "semantic-projector.v2",
	};
	if (index % 8 === 0) {
		return {
			...base,
			kind: "application.visibleContentChanged",
			source: "observer.ocr",
			payload: {
				appId: "com.example.Editor",
				appName: "Example Editor",
				opaqueWindowId: "editor-window",
				windowTitle: "Sanitized document",
				visibleText: `sanitized visible block ${index}`,
				contentHash: `editor-frame-${index}`,
			},
		};
	}
	if (index % 4 === 0) {
		return {
			...base,
			kind: "browser.visiblePageChanged",
			source: "observer.browser",
			payload: {
				appId: "com.google.Chrome",
				appName: "Google Chrome",
				opaqueWindowId: "browser-window",
				domain: "example.invalid",
				url: "https://example.invalid/research?topic=fixture",
				title: "Sanitized research page",
				visibleText: `文件一词只是研究正文的一部分 ${index}`,
				contentHash: `browser-frame-${index}`,
				changeKind: "content_changed",
			},
		};
	}
	return {
		...base,
		kind: "input.activityBucket",
		source: "observer.cg_activity",
		payload: {
			keyCount: index % 3,
			clickCount: index % 2,
			scrollDelta: 0,
			mouseDistance: 10,
			bucketStartedAtMs: atMs,
			bucketEndedAtMs: atMs + 5_000,
		},
	};
}

describe("Timeline v2 sanitized five-minute replay", () => {
	test("keeps the real 64 plus 40 trigger shape without fragmented or false-correction summaries", async () => {
		const clock = new ReplayClock();
		const repository = new InMemoryTimelineV2Repository();
		const hasher = new WebCryptoReflectionHasher();
		const collector = new TimelineV2Collector({
			collectorId: "collector.sanitized-five-minute",
			deviceId: "fixture-device",
			sessionId: "fixture-session",
			repository,
			hasher,
			clock,
		});
		await collector.recover();

		const events = Array.from({ length: 104 }, (_, offset) => {
			const index = offset + 1;
			const atMs =
				index <= 64
					? (index - 1) * 2_500
					: 160_000 + (index - 65) * 5_000;
			return replayEvent(index, atMs);
		});
		let firstWindowId: string | null = null;
		for (const event of events) {
			clock.setNowMs(event.observedAtMs);
			const sealed = await collector.ingest(event);
			if (sealed) firstWindowId = sealed.windowId;
		}
		expect(firstWindowId).not.toBeNull();

		const open = collector.getSnapshot().openWindow;
		expect(open?.effectiveEventCount).toBe(40);
		clock.setNowMs(open!.deadlineAtMs);
		const secondWindow = await collector.flushDue();
		expect(secondWindow).not.toBeNull();

		const processor = new TimelineV2Processor({
			repository,
			evidence: new DeterministicEvidenceRenderer(hasher),
			episodes: new DeterministicEpisodeAssembler({
				hasher,
				hypotheses:
					new DeterministicTimelineHypothesisGenerator(),
			}),
			hasher,
			clock,
			formatTime: String,
		});
		const runner = new TimelineV2JobRunner({
			repository,
			processor,
			clock,
			jitter: () => 0,
		});
		expect(await runner.runUntilIdle()).toBe(2);

		const first = await repository.getTimelineResult(firstWindowId!);
		const second = await repository.getTimelineResult(
			secondWindow!.windowId,
		);
		expect(await repository.getWindow(firstWindowId!)).toMatchObject({
			triggerReason: "event_count",
			eventCount: 64,
		});
		expect(await repository.getWindow(secondWindow!.windowId)).toMatchObject({
			triggerReason: "max_wait",
			eventCount: 40,
		});
		expect(first?.episodes.length).toBeLessThanOrEqual(8);
		expect(second?.episodes.length).toBeLessThanOrEqual(8);
		expect(second?.summary.correctsTimelineId).toBeNull();
		expect(
			[...(first?.episodes ?? []), ...(second?.episodes ?? [])].every(
				(episode) => episode.endedAtMs > episode.startedAtMs,
			),
		).toBeTrue();
		expect(
			[...(first?.episodes ?? []), ...(second?.episodes ?? [])].every(
				(episode) =>
					episode.classification.activity !== "system_file_ops",
			),
		).toBeTrue();
		expect(second?.summary.period.endedAtMs).toBeLessThan(
			secondWindow!.deadlineAtMs,
		);
	});
});
