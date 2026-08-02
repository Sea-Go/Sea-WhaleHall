import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type {
	ReflectionClock,
	ReflectionTimerHandle,
} from "../src/agent/reflection/collector";
import {
	canonicalJson,
	WebCryptoReflectionHasher,
} from "../src/agent/reflection/hash";
import {
	DeterministicEpisodeAssembler,
	DeterministicEvidenceRenderer,
	DeterministicTimelineHypothesisGenerator,
	InMemoryTimelineV2Repository,
	PrivateTrainingWindowExporter,
	TimelineV2Collector,
	TimelineV2JobRunner,
	TimelineV2Processor,
	type ActivityEpisodeV2,
	type EvidenceFactV2,
	type JsonValue,
	type PersistTimelineResult,
	type RawFiveMinuteAuditSource,
	type SemanticEventV2,
	type TimelineJobV2,
	type TimelineSummaryV2,
	type TimelineWindowV2,
} from "../src/agent/timeline-v2";

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

	setTimer(
		_callback: () => void,
		_delayMs: number,
	): ReflectionTimerHandle {
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
		renderedText:
			"焦点控件最终增加了文本 PRIVATE EDITOR TEXT，输入方式未知",
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
		const progress: Array<{ completedWindows: number; totalWindows: number }> = [];
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

		expect(statSync(target).mode & 0o777).toBe(0o700);
		expect(statSync(exported.manifestPath).mode & 0o777).toBe(0o600);
		expect(statSync(exported.recordsPath).mode & 0o777).toBe(0o600);
		expect(exported.manifest.trainingEligible).toBeTrue();
		expect(exported.manifest.sourceWindows[0]?.inputHash).toBe(
			value.window.inputHash,
		);
		expect(exported.manifest.overlapGroups).toEqual([
			{
				groupId: `overlap_${sha256(
					canonicalJson([value.window.windowId]),
				)}`,
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

	test("exports a real two-window continuation as an auditable current-window slice", async () => {
		const root = mkdtempSync(join(tmpdir(), "whalehall-training-continuation-"));
		temporaryDirectories.push(root);
		const target = join(root, "package");
		const events = [
			continuationEvent(1, 1_000, "first-window"),
			continuationEvent(2, 1_100, "second-window"),
		];
		const clock = new ExportReplayClock();
		const repository = new InMemoryTimelineV2Repository();
		const hasher = new WebCryptoReflectionHasher();
		const collector = new TimelineV2Collector({
			collectorId: "collector.private-training-continuation",
			deviceId: "continuation-device",
			sessionId: "continuation-session",
			repository,
			hasher,
			clock,
		});
		await collector.recover();
		const windowIds: string[] = [];
		for (let index = 0; index < events.length; index += 1) {
			const event = events[index]!;
			clock.setNowMs(
				index === 0 ? event.observedAtMs : events[0]!.occurredAtMs + 300_001,
			);
			expect(await collector.ingest(event)).toBeNull();
			clock.setNowMs(event.occurredAtMs + 300_000);
			const sealed = await collector.flushDue();
			expect(sealed).not.toBeNull();
			windowIds.push(sealed!.windowId);
		}
		expect(windowIds).toHaveLength(2);

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
		const [firstResult, secondResult] = await Promise.all(
			windowIds.map((windowId) => repository.getTimelineResult(windowId)),
		);
		const firstEpisode = firstResult!.episodes[0]!;
		const sourceContinuation = secondResult!.episodes[0]!;
		expect(sourceContinuation).toMatchObject({
			episodeId: firstEpisode.episodeId,
			revision: 2,
			supersedesRevisionId: firstEpisode.revisionId,
			sourceWindowIds: windowIds,
		});

		const observations = events.map(continuationObservation);
		const raw: RawFiveMinuteAuditSource = {
			async queryAuditRange() {
				return {
					permissions: {},
					coverage: ["content"],
					rawObservations: structuredClone(observations),
					semanticEvents: structuredClone(events),
				};
			},
		};
		const exported = await new PrivateTrainingWindowExporter(
			raw,
			repository,
			() => 2_000,
			() => "continuation-export",
		).exportToNewDirectory({
			directory: target,
			windowIds,
			participantId: "participant-continuation",
			sessionTimezone: "Asia/Shanghai",
			includeDecryptedContent: true,
		});
		const records = readFileSync(exported.recordsPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const recordByWindow = new Map(
			records.map((record) => [record.window.windowId, record]),
		);
		const secondRecord = recordByWindow.get(windowIds[1]!)!;
		const slicedEpisode = secondRecord.episodes[0];
		const currentFactIds = new Set(
			secondRecord.evidenceFacts.map((fact: { factId: string }) => fact.factId),
		);
		const currentEventIds = new Set(
			secondRecord.semanticEvents.map((event: { eventId: string }) => event.eventId),
		);
		expect(slicedEpisode).toMatchObject({
			episodeId: sourceContinuation.episodeId,
			revision: 1,
			supersedesRevisionId: null,
			sourceWindowIds: [windowIds[1]],
				exportSlice: {
					schemaVersion: "private-training-episode-slice.v1",
					scope: "current_window",
					sourceEpisodeRevisionId: sourceContinuation.revisionId,
					sourceEpisodeHash: sha256(canonicalJson(sourceContinuation)),
					continuesFromEpisodeRevisionId: firstEpisode.revisionId,
				sourcePeriod: {
					startedAtMs: sourceContinuation.startedAtMs,
					endedAtMs: sourceContinuation.endedAtMs,
				},
			},
		});
		expect(slicedEpisode.revisionId).not.toBe(
			sourceContinuation.revisionId,
		);
		expect(
			[
				...slicedEpisode.evidenceFactIds,
				...slicedEpisode.supportingFactIds,
			].every((factId: string) => currentFactIds.has(factId)),
		).toBeTrue();
		expect(
			secondRecord.evidenceFacts.every((fact: { eventIds: string[] }) =>
				fact.eventIds.every((eventId) => currentEventIds.has(eventId)),
			),
		).toBeTrue();
		expect(secondRecord.timelineSummary).toMatchObject({
			exportSlice: {
				schemaVersion: "private-training-timeline-slice.v1",
				scope: "current_window",
				sourceTimelineId: secondResult!.summary.timelineId,
				sourceTimelineHash: sha256(
					canonicalJson(secondResult!.summary),
				),
				sourcePeriod: secondResult!.summary.period,
			},
		});
		expect(
			secondRecord.timelineSummary.segments[0].exportSlice
				.sourceEpisodeRevisionId,
		).toBe(sourceContinuation.revisionId);
		expect(
			secondRecord.timelineSummary.segments[0].exportSlice
				.sourceEpisodeHash,
		).toBe(sha256(canonicalJson(sourceContinuation)));

		await expect(
			new PrivateTrainingWindowExporter(raw, {
				getWindow: (windowId) => repository.getWindow(windowId),
				getJob: (windowId) => repository.getJob(windowId),
				async getTimelineResult(windowId) {
					const persisted = await repository.getTimelineResult(windowId);
					if (persisted !== null && windowId === windowIds[0]) {
						persisted.facts[0] = {
							...persisted.facts[0]!,
							renderedText: "tampered historical fact",
						};
					}
					return persisted;
				},
			}).exportToNewDirectory({
				directory: join(root, "tampered-package"),
				windowIds: [windowIds[1]!],
				participantId: "participant-continuation",
				sessionTimezone: "Asia/Shanghai",
				includeDecryptedContent: true,
			}),
		).rejects.toThrow("Timeline segment");

		await expect(
			new PrivateTrainingWindowExporter(raw, {
				async getWindow(windowId) {
					const persisted = await repository.getWindow(windowId);
					return persisted !== null && windowId === windowIds[0]
						? { ...persisted, sessionId: "tampered-session" }
						: persisted;
				},
				getJob: (windowId) => repository.getJob(windowId),
				getTimelineResult: (windowId) =>
					repository.getTimelineResult(windowId),
			}).exportToNewDirectory({
				directory: join(root, "cross-authority-package"),
				windowIds: [windowIds[1]!],
				participantId: "participant-continuation",
				sessionTimezone: "Asia/Shanghai",
				includeDecryptedContent: true,
			}),
		).rejects.toThrow("authority boundary");

		const trainingRepository = resolve(
			import.meta.dir,
			"..",
			"..",
			"WhaleHall-Training",
		);
		if (existsSync(join(trainingRepository, "whalehall_training"))) {
			const imported = spawnSync(
				"python3",
				[
					"-m",
					"whalehall_training",
					"timeline-v2",
					"import-private",
					target,
					join(root, "timelines.jsonl"),
					"--manifest",
					join(root, "timelines.manifest.json"),
					"--participant-id",
					"participant-continuation",
					"--session-timezone",
					"Asia/Shanghai",
				],
				{
					cwd: trainingRepository,
					encoding: "utf8",
					env: {
						...process.env,
						PYTHONPATH: trainingRepository,
					},
				},
			);
			expect(imported.status, imported.stderr).toBe(0);
		}
	});

	test.skipIf(process.platform === "win32")(
		"reclaims only expired owner-only crash staging before a new export",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "whalehall-training-stale-"));
			temporaryDirectories.push(root);
			const { value, raw, repository } = dependencies();
			const nowMs = value.window.endedAtMs + 1_000;
			const oldMs = nowMs - 8 * 24 * 60 * 60 * 1000;
			const oldDate = new Date(oldMs);
			const stagingName = (timestamp: number, id: string) =>
				`.whalehall-private-training-export-${timestamp}-${id}.tmp`;
			const createPartialStaging = (
				name: string,
				mode: number,
				modifiedAt: Date,
			) => {
				const directory = join(root, name);
				mkdirSync(directory, { mode });
				chmodSync(directory, mode);
				writeFileSync(
					join(directory, "committed-timeline-windows.v1.jsonl"),
					"partial crash record\n",
					{ mode: 0o600 },
				);
				utimesSync(directory, modifiedAt, modifiedAt);
				return directory;
			};

			const stale = createPartialStaging(
				stagingName(oldMs, "crashed001"),
				0o700,
				oldDate,
			);
			const recent = createPartialStaging(
				stagingName(nowMs - 1_000, "recent0001"),
				0o700,
				new Date(nowMs - 1_000),
			);
			const wrongMode = createPartialStaging(
				stagingName(oldMs, "wrongmode1"),
				0o750,
				oldDate,
			);
			const wrongName = createPartialStaging(
				`.unrelated-${oldMs}-crashed001.tmp`,
				0o700,
				oldDate,
			);
			const symlinkTarget = join(root, "symlink-target");
			mkdirSync(symlinkTarget, { mode: 0o700 });
			writeFileSync(join(symlinkTarget, "sentinel"), "keep", {
				mode: 0o600,
			});
			const linkedStaging = join(
				root,
				stagingName(oldMs, "symlink001"),
			);
			symlinkSync(symlinkTarget, linkedStaging, "dir");

			await new PrivateTrainingWindowExporter(
				raw,
				repository,
				() => nowMs,
				() => "newexport1",
			).exportToNewDirectory({
				directory: join(root, "package"),
				windowIds: [value.window.windowId],
				participantId: "participant-1",
				sessionTimezone: "Asia/Shanghai",
				includeDecryptedContent: true,
			});

			expect(existsSync(stale)).toBeFalse();
			expect(existsSync(recent)).toBeTrue();
			expect(existsSync(wrongMode)).toBeTrue();
			expect(existsSync(wrongName)).toBeTrue();
			expect(existsSync(linkedStaging)).toBeTrue();
			expect(readFileSync(join(symlinkTarget, "sentinel"), "utf8")).toBe(
				"keep",
			);
			expect(
				readdirSync(root).some((name) =>
					name.includes(`${nowMs}-newexport1.tmp`),
				),
			).toBeFalse();
		},
	);

	test("marks redacted packages ineligible without leaking text", async () => {
		const root = mkdtempSync(join(tmpdir(), "whalehall-training-export-"));
		temporaryDirectories.push(root);
		const target = join(root, "redacted-package");
		const { value, raw, repository } = dependencies();
		const exported = await new PrivateTrainingWindowExporter(
			raw,
			repository,
			() => value.window.endedAtMs + 1_000,
			() => "export-redacted",
		).exportToNewDirectory({
			directory: target,
			windowIds: [value.window.windowId],
			participantId: "participant-1",
			sessionTimezone: "Asia/Shanghai",
		});

		expect(exported.manifest.trainingEligible).toBeFalse();
		expect(exported.manifest.ineligibilityReasons).toEqual([
			"decrypted_content_not_included",
		]);
		const encodedRecord = readFileSync(exported.recordsPath, "utf8").trim();
		expect(encodedRecord).not.toContain(
			"PRIVATE EDITOR TEXT",
		);
		const record = JSON.parse(encodedRecord);
		const redactedInputHash = sha256(
			canonicalJson({
				goal: record.window.goal,
				events: record.window.events,
				contextOnly: record.window.contextOnly,
			}),
		);
		expect(record.window.inputHash).toBe(redactedInputHash);
		expect(record.authority).toMatchObject({
			inputHash: redactedInputHash,
			recomputedInputHash: redactedInputHash,
			goalSnapshotHash: sha256(canonicalJson(record.goalSnapshot)),
			eventSetHash: sha256(canonicalJson(record.semanticEvents)),
			factSetHash: sha256(canonicalJson(record.evidenceFacts)),
			episodeSetHash: sha256(canonicalJson(record.episodes)),
			summaryHash: sha256(canonicalJson(record.timelineSummary)),
			rawObservationSetHash: sha256(
				canonicalJson(record.rawObservations),
			),
			lineageHash: sha256(canonicalJson(record.lineage)),
		});
	});

	test("refuses non-COMMITTED source windows", async () => {
		const root = mkdtempSync(join(tmpdir(), "whalehall-training-export-"));
		temporaryDirectories.push(root);
		const { value, raw, repository } = dependencies("RESULT_PERSISTED");
		await expect(
			new PrivateTrainingWindowExporter(raw, repository).exportToNewDirectory({
				directory: join(root, "package"),
				windowIds: [value.window.windowId],
				participantId: "participant-1",
				sessionTimezone: "Asia/Shanghai",
				includeDecryptedContent: true,
			}),
		).rejects.toThrow("not COMMITTED");
		expect(readdirSync(root)).toEqual([]);
	});

	test("rejects non-exact fact, summary, and AgentInput authority", async () => {
		const cases: Array<{
			name: string;
			change: (result: PersistTimelineResult) => void;
			message: string;
		}> = [
			{
				name: "fact observation union",
				change(result) {
					result.facts[0]!.sourceObservationIds = [
						"observation-1",
						"observation-invented",
					];
				},
				message: "exact event union",
			},
			{
				name: "summary evidence object",
				change(result) {
					result.summary.segments[0]!.evidence[0]!.renderedText =
						"invented summary evidence";
					result.agentInput.segments =
						structuredClone(result.summary.segments);
				},
				message: "Timeline segment",
			},
			{
				name: "AgentInput payload hash",
				change(result) {
					result.agentInput.payloadHash = "0".repeat(64);
				},
				message: "payload hash",
			},
		];
		for (const testCase of cases) {
			const root = mkdtempSync(
				join(tmpdir(), "whalehall-training-export-invalid-"),
			);
			temporaryDirectories.push(root);
			const { value, raw, repository } = dependencies();
			testCase.change(value.result);
			repository.getTimelineResult = async () =>
				structuredClone(value.result);
			await expect(
				new PrivateTrainingWindowExporter(
					raw,
					repository,
				).exportToNewDirectory({
					directory: join(root, testCase.name.replaceAll(" ", "-")),
					windowIds: [value.window.windowId],
					participantId: "participant-1",
					sessionTimezone: "Asia/Shanghai",
					includeDecryptedContent: true,
				}),
			).rejects.toThrow(testCase.message);
		}
	});

	const trainingRepository = resolve(
		import.meta.dir,
		"..",
		"..",
		"WhaleHall-Training",
	);
	test.skipIf(!existsSync(join(trainingRepository, "whalehall_training")))(
		"round-trips a real JavaScript package through the Python importer",
		async () => {
			const root = mkdtempSync(
				join(tmpdir(), "whalehall-training-export-interop-"),
			);
			temporaryDirectories.push(root);
			const target = join(root, "package");
			const output = join(root, "timelines.jsonl");
			const outputManifest = join(root, "timelines.manifest.json");
			const { value, raw, repository } = dependencies();
			await new PrivateTrainingWindowExporter(
				raw,
				repository,
				() => value.window.endedAtMs + 1_000,
				() => "export-interop",
			).exportToNewDirectory({
				directory: target,
				windowIds: [value.window.windowId],
				participantId: "participant-1",
				sessionTimezone: "Asia/Shanghai",
				includeDecryptedContent: true,
			});

			const imported = spawnSync(
				"python3",
				[
					"-m",
					"whalehall_training",
					"timeline-v2",
					"import-private",
					target,
					output,
					"--manifest",
					outputManifest,
					"--participant-id",
					"participant-1",
					"--session-timezone",
					"Asia/Shanghai",
				],
				{
					cwd: trainingRepository,
					encoding: "utf8",
					env: {
						...process.env,
						PYTHONPATH: trainingRepository,
					},
				},
			);
			expect(imported.status).toBe(0);
			expect(imported.stderr).toBe("");
			expect(readFileSync(output, "utf8")).toContain(
				"PRIVATE EDITOR TEXT",
			);
			expect(
				JSON.parse(readFileSync(outputManifest, "utf8")).authority,
			).toEqual(
				expect.objectContaining({
					inputHashesVerified: true,
					lineageVerified: true,
				}),
			);
		},
	);
});
