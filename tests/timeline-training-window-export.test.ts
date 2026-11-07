import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ReflectionClock,
	ReflectionTimerHandle,
} from "../src/agent/reflection/collector";
import {
	canonicalJson,
	WebCryptoReflectionHasher,
} from "../src/agent/reflection/hash";
import {
	type ActivityEpisodeV2,
	DeterministicEpisodeAssembler,
	DeterministicEvidenceRenderer,
	DeterministicTimelineHypothesisGenerator,
	type EvidenceFactV2,
	InMemoryTimelineV2Repository,
	type JsonValue,
	type PersistTimelineResult,
	PrivateTrainingWindowExporter,
	type RawFiveMinuteAuditSource,
	type SemanticEventV2,
	type TimelineJobV2,
	type TimelineSummaryV2,
	TimelineV2Collector,
	TimelineV2JobRunner,
	TimelineV2Processor,
	type TimelineWindowV2,
} from "../src/agent/timeline";

const temporaryDirectories: string[] = [];

class ExportReplayClock implements ReflectionClock {
	private timerId = 0;

	constructor(private currentMs = 0) {}

	nowMs(): number {
		return this.currentMs;
	}

	setNowMs(value: number): void {
		this.currentMs = value;
	}

	setTimer(_callback: () => void, _delayMs: number): ReflectionTimerHandle {
		this.timerId += 1;
		return this.timerId as unknown as ReflectionTimerHandle;
	}

	clearTimer(_handle: ReflectionTimerHandle): void {}
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function continuationEvent(
	index: number,
	atMs: number,
	text: string,
): SemanticEventV2 {
	return {
		schemaVersion: "semantic-event.v2",
		eventId: `continuation-event-${index}`,
		cursor: `sec2_${index.toString(16).padStart(16, "0")}`,
		deviceId: "continuation-device",
		sessionId: "continuation-session",
		kind: "application.textValueChanged",
		source: "observer.ax",
		occurredAtMs: atMs,
		observedAtMs: atMs + 1,
		goalVersion: null,
		countClass: "effective",
		reliability: "high",
		coverage: ["content", "metadata"],
		contentState: "available",
		sourceObservationIds: [`continuation-observation-${index}`],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "semantic-projector.v2",
		payload: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			opaqueWindowId: "continuation-window",
			opaqueControlId: "continuation-editor",
			role: "AXTextArea",
			insertedChars: text.length,
			deletedChars: 0,
			deltaAvailable: true,
			inputMethod: "unknown",
			label: "代码编辑区",
			addedText: text,
			finalValue: text,
		},
	};
}

function continuationObservation(
	event: SemanticEventV2,
): Record<string, JsonValue> {
	return {
		schemaVersion: "raw-observation.v2",
		observationId: event.sourceObservationIds[0]!,
		cursor: event.cursor.replace("sec2_", "sc2_"),
		deviceId: event.deviceId,
		sessionId: event.sessionId,
		kind: "ax.textValueChanged",
		interval: {
			startedAtMs: event.occurredAtMs,
			endedAtMs: event.observedAtMs,
		},
		source: { sensor: "ax", adapterVersion: "observer.v2" },
		subject: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			opaqueWindowId: "continuation-window",
		},
		reliability: "high",
		coverage: ["content", "metadata"],
		redactions: [],
		metadata: {},
		contentState: "available",
		content: { finalValue: String(event.payload.finalValue ?? "") },
		dedupHash: `dedup-${event.eventId}`,
	};
}

function fixture() {
	const event: SemanticEventV2 = {
		schemaVersion: "semantic-event.v2",
		eventId: "event-1",
		cursor: "sec2_0000000000000001",
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "application.textValueChanged",
		source: "observer.ax",
		occurredAtMs: 1_800_000_000_000,
		observedAtMs: 1_800_000_000_010,
		goalVersion: 1,
		countClass: "effective",
		reliability: "high",
		coverage: ["content", "metadata"],
		contentState: "available",
		sourceObservationIds: ["observation-1"],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "timeline-projector.v2",
		payload: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			finalValue: "PRIVATE EDITOR TEXT",
			numericCanonicalizationProbe: {
				integralFloat: 1.0,
				negativeZero: -0,
				smallExponent: 1e-7,
			},
			unicodeLineSeparatorProbe: "left\u2028right",
		},
	};
	const goal = {
		goalId: "goal-1",
		planId: "plan-1",
		version: 1,
		text: "实现 WhaleHall 训练导出",
		activatedAtMs: event.occurredAtMs - 1_000,
	};
	const windowWithoutHash = {
		schemaVersion: "timeline-window.v2" as const,
		windowId: "timeline_window_1",
		collectorId: "collector-1",
		deviceId: "device-1",
		sessionId: "session-1",
		triggerReason: "goal_boundary" as const,
		goal,
		goalVersion: 1,
		startedAtMs: event.occurredAtMs,
		endedAtMs: event.occurredAtMs + 1_000,
		deadlineAtMs: event.occurredAtMs + 300_000,
		eventCount: 1,
		firstCursor: event.cursor,
		lastCursor: event.cursor,
		events: [event],
		contextOnly: [],
	};
	const window: TimelineWindowV2 = {
		...windowWithoutHash,
		inputHash: sha256(
			canonicalJson({
				goal,
				events: [event],
				contextOnly: [],
			}),
		),
	};
	const fact: EvidenceFactV2 = {
		schemaVersion: "evidence-fact.v2" as const,
		factId: "fact-1",
		eventIds: ["event-1"],
		sourceObservationIds: ["observation-1"],
		startedAtMs: event.occurredAtMs,
		endedAtMs: event.occurredAtMs + 1_000,
		templateCode: "application.text_value" as const,
		templateArgs: {
			appName: "Visual Studio Code",
			text: "PRIVATE EDITOR TEXT",
		},
		renderedText: "焦点控件最终增加了文本 PRIVATE EDITOR TEXT，输入方式未知",
		anchor: {
			appId: "com.microsoft.VSCode",
			windowId: "window-1",
			documentId: "document-1",
			pageId: null,
		},
		role: "primary" as const,
		reliability: "high" as const,
		coverage: ["content", "metadata"],
	};
	const classification = {
		activity: "development" as const,
		goalRelevance: "direct" as const,
		confidence: 0.95,
		entropy: 0.05,
		oodScore: 0.01,
		abstain: false,
		modelVersion: "modernbert-whalehall-episode-v2",
	};
	const hypothesis = {
		text: "可能在实现 WhaleHall 训练导出",
		citedFactIds: ["fact-1"],
		generator: "deterministic-template.v2" as const,
	};
	const episode: ActivityEpisodeV2 = {
		schemaVersion: "activity-episode.v2" as const,
		episodeId: "episode-1",
		revisionId: "episode-revision-1",
		revision: 1,
		supersedesRevisionId: null,
		sourceWindowIds: [window.windowId],
		startedAtMs: fact.startedAtMs,
		endedAtMs: fact.endedAtMs,
		goalVersion: 1,
		anchor: structuredClone(fact.anchor),
		classification,
		hypothesis,
		evidenceFactIds: ["fact-1"],
		supportingFactIds: [],
		coverage: ["content", "metadata"],
	};
	const summary: TimelineSummaryV2 = {
		schemaVersion: "timeline-summary.v2" as const,
		timelineId: "timeline-1",
		windowId: window.windowId,
		triggerReason: window.triggerReason,
		triggeredAtMs: window.endedAtMs,
		deadlineAtMs: window.deadlineAtMs,
		period: {
			startedAtMs: fact.startedAtMs,
			endedAtMs: fact.endedAtMs,
		},
		goalVersion: 1,
		segments: [
			{
				episodeId: episode.episodeId,
				episodeRevisionId: episode.revisionId,
				startedAtMs: episode.startedAtMs,
				endedAtMs: episode.endedAtMs,
				activity: "development" as const,
				goalRelevance: "direct" as const,
				classification,
				hypothesis,
				evidence: [fact],
			},
		],
		coverage: ["content", "metadata"],
		coverageWarnings: [],
		renderedText: "可能在实现 WhaleHall 训练导出",
		modelVersions: [
			"modernbert-whalehall-episode-v2",
			"hypothesis:deterministic-template.v2",
		],
		inferenceDiagnostics: [],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "timeline-projector.v2",
		createdAtMs: window.endedAtMs + 100,
		revision: 1,
		correctsTimelineId: null,
	};
	const agentInputPayload = {
		schemaVersion: "agent-input.v1" as const,
		timelineId: summary.timelineId,
		windowId: window.windowId,
		triggerReason: window.triggerReason,
		triggeredAtMs: summary.triggeredAtMs,
		deadlineAtMs: summary.deadlineAtMs,
		period: summary.period,
		goal,
		segments: summary.segments,
		renderedText: summary.renderedText,
		coverage: [...summary.coverage],
		modelVersions: summary.modelVersions,
		inferenceDiagnostics: [],
		taxonomyVersion: summary.taxonomyVersion,
		projectorVersion: summary.projectorVersion,
		createdAtMs: summary.createdAtMs,
	};
	const result: PersistTimelineResult = {
		windowId: window.windowId,
		facts: [structuredClone(fact)],
		episodes: [structuredClone(episode)],
		summary: structuredClone(summary),
		agentInput: {
			...agentInputPayload,
			agentInputId: "agent-input-1",
			idempotencyKey: "agent-input-1",
			payloadHash: sha256(canonicalJson(agentInputPayload)),
		},
	};
	const job: TimelineJobV2 = {
		schemaVersion: "timeline-job.v2",
		windowId: window.windowId,
		state: "COMMITTED",
		attempt: 1,
		createdAtMs: window.endedAtMs,
		updatedAtMs: window.endedAtMs + 100,
		nextAttemptAtMs: null,
		leaseExpiresAtMs: null,
		firstAttemptAtMs: window.endedAtMs,
		failureCode: null,
		failureMessage: null,
	};
	const rawObservation = {
		schemaVersion: "raw-observation.v2",
		observationId: "observation-1",
		cursor: "sc2_0000000000000001",
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "ax.textValueChanged",
		interval: {
			startedAtMs: event.occurredAtMs,
			endedAtMs: event.observedAtMs,
		},
		source: { sensor: "ax", adapterVersion: "observer.v2" },
		subject: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			opaqueWindowId: "window-1",
		},
		reliability: "high",
		coverage: ["content", "metadata"],
		redactions: [],
		metadata: {},
		contentState: "available",
		content: { finalValue: "PRIVATE EDITOR TEXT" },
		dedupHash: "dedup-1",
	};
	return { window, job, result, rawObservation, event };
}

function dependencies(state: TimelineJobV2["state"] = "COMMITTED") {
	const value = fixture();
	const raw: RawFiveMinuteAuditSource = {
		async queryAuditRange() {
			return {
				permissions: {},
				coverage: ["content"],
				// Deliberately return content even for a redacted request. The
				// Bun exporter must enforce redaction independently of its source.
				rawObservations: [structuredClone(value.rawObservation)],
				semanticEvents: [value.event],
			};
		},
	};
	return {
		value,
		raw,
		repository: {
			async getWindow() {
				return structuredClone(value.window);
			},
			async getJob() {
				return { ...structuredClone(value.job), state };
			},
			async getTimelineResult() {
				return structuredClone(value.result);
			},
		},
	};
}

function expectPrivatePath(path: string, expectedMode: 0o600 | 0o700): void {
	const metadata = statSync(path);
	if (expectedMode === 0o700) {
		expect(metadata.isDirectory()).toBeTrue();
	} else {
		expect(metadata.isFile()).toBeTrue();
	}
	if (process.platform !== "win32") {
		expect(metadata.mode & 0o777).toBe(expectedMode);
	}
}

describe("private COMMITTED Timeline training export", () => {
	test("writes a mode-0600 manifest-bound full-window package", async () => {
		const root = mkdtempSync(join(tmpdir(), "whalehall-training-export-"));
		temporaryDirectories.push(root);
		const target = join(root, "package");
		const { value, raw, repository } = dependencies();
		const exporter = new PrivateTrainingWindowExporter(
			raw,
			repository,
			() => value.window.endedAtMs + 1_000,
			() => "export-1",
		);
		const progress: Array<{ completedWindows: number; totalWindows: number }> =
			[];
		const exported = await exporter.exportToNewDirectory({
			directory: target,
			windowIds: [value.window.windowId],
			participantId: "participant-1",
			sessionTimezone: "Asia/Shanghai",
			includeDecryptedContent: true,
			onProgress(value) {
				progress.push(value);
			},
		});

		expectPrivatePath(target, 0o700);
		expectPrivatePath(exported.manifestPath, 0o600);
		expectPrivatePath(exported.recordsPath, 0o600);
		expect(exported.manifest.trainingEligible).toBeTrue();
		expect(exported.manifest.sourceWindows[0]?.inputHash).toBe(
			value.window.inputHash,
		);
		expect(exported.manifest.overlapGroups).toEqual([
			{
				groupId: `overlap_${sha256(canonicalJson([value.window.windowId]))}`,
				windowIds: [value.window.windowId],
				sharedIdentityHash: sha256(
					canonicalJson([
						"episode:episode-1",
						"event:event-1",
						"observation:observation-1",
					]),
				),
			},
		]);
		expect(progress).toEqual([{ completedWindows: 1, totalWindows: 1 }]);
		const line = readFileSync(exported.recordsPath, "utf8").trim();
		const record = JSON.parse(line);
		expect(record.authority.job.state).toBe("COMMITTED");
		expect(record.goalSnapshot).toEqual(value.window.goal);
		expect(record.rawObservations).toHaveLength(1);
		expect(record.episodes).toEqual(value.result.episodes);
		expect(record.timelineSummary).toEqual(value.result.summary);
		expect(record.lineage).toEqual([
			expect.objectContaining({
				observationId: "observation-1",
				eventId: "event-1",
				scope: "window",
			}),
		]);
		expect(line).toContain("PRIVATE EDITOR TEXT");
		expect(line).toContain('"negativeZero":0');
		expect(line).toContain('"smallExponent":1e-7');
	});

	test("rejects relative destinations and never overwrites an existing package", async () => {
		const root = mkdtempSync(join(tmpdir(), "whalehall-training-export-"));
		temporaryDirectories.push(root);
		const target = join(root, "package");
		mkdirSync(target);
		const sentinel = join(target, "sentinel.txt");
		writeFileSync(sentinel, "keep");
		const { value, raw, repository } = dependencies();
		const exporter = new PrivateTrainingWindowExporter(
			raw,
			repository,
			() => value.window.endedAtMs + 1_000,
			() => "export-no-overwrite",
		);
		const options = {
			windowIds: [value.window.windowId],
			participantId: "participant-1",
			sessionTimezone: "Asia/Shanghai",
			includeDecryptedContent: true,
		};

		await expect(
			exporter.exportToNewDirectory({
				...options,
				directory: "relative-package",
			}),
		).rejects.toThrow("must be absolute");
		await expect(
			exporter.exportToNewDirectory({ ...options, directory: target }),
		).rejects.toThrow("must not already exist");
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
		expect(readdirSync(root)).toEqual(["package"]);
	});

	const trainingRepository = resolve(
		import.meta.dir,
		"..",
		"..",
		"WhaleHall-Training",
	);
});
