import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { ReflectionClock } from "../src/agent/reflection/collector";
import { WebCryptoReflectionHasher } from "../src/agent/reflection/hash";
import {
	DeterministicEpisodeAssembler,
	DeterministicEvidenceRenderer,
	DeterministicTimelineHypothesisGenerator,
	SqliteTimelineV2Repository,
	TimelineFiveMinuteAuditExporter,
	TimelineV2Collector,
	TimelineV2JobRunner,
	TimelineV2Processor,
	type RawFiveMinuteAuditSource,
	type SemanticEventV2,
	type TimelineV2Repository,
	type TimelineVault,
	type TimelineVaultOpenRequest,
	type TimelineVaultSealRequest,
} from "../src/agent/timeline-v2";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

class MemoryVault implements TimelineVault {
	readonly seals: TimelineVaultSealRequest[] = [];
	private readonly byId = new Map<
		string,
		{ ref: string; request: TimelineVaultSealRequest }
	>();
	private readonly byRef = new Map<string, TimelineVaultSealRequest>();

	async seal(request: TimelineVaultSealRequest): Promise<string> {
		this.seals.push(structuredClone(request));
		const key = `${request.purpose}:${request.recordId}`;
		const existing = this.byId.get(key);
		if (existing) {
			if (existing.request.plaintext !== request.plaintext) {
				throw new Error("vault record id reused with different content");
			}
			return existing.ref;
		}
		const ref = `vaultref_${this.byId.size + 1}`;
		const copy = structuredClone(request);
		this.byId.set(key, { ref, request: copy });
		this.byRef.set(ref, copy);
		return ref;
	}

	async open(request: TimelineVaultOpenRequest): Promise<string> {
		const sealed = this.byRef.get(request.sealedPayload);
		if (
			!sealed ||
			sealed.recordId !== request.recordId ||
			sealed.purpose !== request.purpose ||
			sealed.schemaVersion !== request.schemaVersion ||
			JSON.stringify(sealed.aad) !== JSON.stringify(request.aad)
		) {
			throw new Error("vault AAD mismatch");
		}
		return sealed.plaintext;
	}
}

class Clock implements ReflectionClock {
	constructor(private readonly value = 400_000) {}
	nowMs(): number {
		return this.value;
	}
	setTimer(): ReturnType<typeof setTimeout> {
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}
	clearTimer(): void {}
}

function semantic(
	index: number,
	atMs: number,
	kind: "application.foregroundChanged" | "application.textValueChanged",
): SemanticEventV2 {
	const common = {
		schemaVersion: "semantic-event.v2" as const,
		eventId: `event-${index}`,
		cursor: `sec2_${index.toString(16).padStart(16, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		source: "observer.ax",
		occurredAtMs: atMs,
		observedAtMs: atMs,
		goalVersion: null,
		countClass: "effective" as const,
		reliability: "high" as const,
		coverage: ["content", "metadata"] as const,
		contentState: "available" as const,
		sourceObservationIds: [`observation-${index}`],
		taxonomyVersion: "activity-taxonomy.v2",
		projectorVersion: "semantic-projector.v2",
	};
	if (kind === "application.foregroundChanged") {
		return {
			...common,
			coverage: [...common.coverage],
			kind,
			payload: {
				appId: "com.microsoft.VSCode",
				appName: "Visual Studio Code",
				opaqueWindowId: "window-1",
				windowTitle: "绝不能出现在 SQLite 的敏感项目",
			},
		};
	}
	return {
		...common,
		coverage: [...common.coverage],
		kind,
		payload: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			opaqueWindowId: "window-1",
			opaqueControlId: "editor",
			role: "AXTextArea",
			insertedChars: 8,
			deletedChars: 0,
			deltaAvailable: true,
			inputMethod: "unknown",
			label: "代码编辑区",
			addedText: "秘密文本 ABC-123",
			finalValue: "秘密文本 ABC-123",
		},
	};
}

function rawObservation(
	index: number,
	atMs: number,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: "raw-observation.v2",
		observationId: `observation-${index}`,
		cursor: `raw2_${index.toString(16).padStart(16, "0")}`,
		deviceId: "device-1",
		sessionId: "session-1",
		kind: "workspace.foregroundChanged",
		interval: { startedAtMs: atMs, endedAtMs: atMs },
		source: { sensor: "workspace", adapterVersion: "audit-test.v2" },
		subject: {
			appId: "com.microsoft.VSCode",
			appName: "Visual Studio Code",
			opaqueWindowId: "window-1",
		},
		reliability: "high",
		coverage: ["metadata"],
		redactions: [],
		metadata: { processId: 42 },
		contentState: "available",
		dedupHash: `raw-hash-${index}`,
		...overrides,
	};
}

async function populate(
	repository: SqliteTimelineV2Repository,
	clock: Clock,
): Promise<{ windowId: string; events: SemanticEventV2[] }> {
	const hasher = new WebCryptoReflectionHasher();
	const collector = new TimelineV2Collector({
		collectorId: "collector.timeline-v2",
		deviceId: "device-1",
		sessionId: "session-1",
		repository,
		hasher,
		clock,
		effectiveEventThreshold: 2,
	});
	await collector.recover();
	const events = [
		semantic(1, 100_000, "application.foregroundChanged"),
		semantic(2, 100_010, "application.textValueChanged"),
	];
	await collector.ingest(events[0]!);
	const window = await collector.ingest(events[1]!);
	const evidence = new DeterministicEvidenceRenderer(hasher);
	const episodes = new DeterministicEpisodeAssembler({
		hasher,
		hypotheses: new DeterministicTimelineHypothesisGenerator(),
	});
	const processor = new TimelineV2Processor({
		repository,
		evidence,
		episodes,
		hasher,
		clock,
		formatTime: (timestamp) => String(timestamp),
	});
	const runner = new TimelineV2JobRunner({
		repository,
		processor,
		clock,
		jitter: () => 0,
	});
	expect(await runner.runNext()).toBe("completed");
	return { windowId: window!.windowId, events };
}

describe("Timeline v2 encrypted SQLite and audit", () => {
	test("persists only vault references and recovers Timeline/AgentInput", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-timeline-v2-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "timeline-v2.sqlite3");
		const vault = new MemoryVault();
		const clock = new Clock();
		const repository = new SqliteTimelineV2Repository(
			path,
			vault,
			clock.nowMs.bind(clock),
		);
		const { windowId } = await populate(repository, clock);
		expect(await repository.getJob(windowId)).toMatchObject({
			state: "COMMITTED",
			attempt: 1,
			leaseExpiresAtMs: null,
		});
		const result = await repository.getTimelineResult(windowId);
		expect(result?.summary.renderedText).toContain("秘密文本 ABC-123");
		expect(
			await repository.completeWindow(result!, clock.nowMs()),
		).toMatchObject({
			state: "COMMITTED",
			attempt: 1,
		});
		const held = await repository.queryAgentInputs({
			nowMs: clock.nowMs(),
			includeHeldLocal: true,
		});
		expect(held.inputs[0]?.state).toBe("HELD_LOCAL");

		const sqliteBytes = [path, `${path}-wal`, `${path}-shm`]
			.filter(existsSync)
			.map((file) => readFileSync(file))
			.map((buffer) => buffer.toString("utf8"))
			.join("");
		expect(sqliteBytes).not.toContain("秘密文本 ABC-123");
		expect(sqliteBytes).not.toContain("绝不能出现在 SQLite");
		expect(sqliteBytes).toContain("vaultref_");
		expect(
			vault.seals.some(
				(seal) =>
					seal.purpose === "timeline.window.v2" &&
					seal.expiresAtMs === clock.nowMs() + 7 * 24 * 60 * 60 * 1000,
			),
		).toBeTrue();
		expect(
			vault.seals.some(
				(seal) =>
					seal.purpose === "timeline.summary.v2" &&
					seal.expiresAtMs === clock.nowMs() + 30 * 24 * 60 * 60 * 1000,
			),
		).toBeTrue();
		repository.close();

		const reopened = new SqliteTimelineV2Repository(
			path,
			vault,
			clock.nowMs.bind(clock),
		);
		expect(
			(await reopened.getTimelineResult(windowId))?.agentInput.renderedText,
		).toContain("秘密文本 ABC-123");
		expect(await reopened.getJob(windowId)).toMatchObject({
			state: "COMMITTED",
			attempt: 1,
		});
		reopened.close();
	});

	test("exports exactly five minutes with full lineage and redacts by default", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-timeline-v2-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "timeline-v2.sqlite3");
		const vault = new MemoryVault();
		const clock = new Clock();
		const repository = new SqliteTimelineV2Repository(
			path,
			vault,
			clock.nowMs.bind(clock),
		);
		const populated = await populate(repository, clock);
		const ignoredEvent: SemanticEventV2 = {
			...populated.events[0]!,
			eventId: "event-3",
			cursor: "sec2_0000000000000003",
			kind: "application.processObservedBatch",
			countClass: "ignored",
			sourceObservationIds: ["observation-3"],
			payload: { processCount: 10 },
		};
		const raw: RawFiveMinuteAuditSource = {
			queryAuditRange: async ({ includeDecryptedContent }) => ({
				permissions: { accessibility: true },
				coverage: ["content"],
				rawObservations: [
					rawObservation(1, 100_000, {
						subject: {
							appId: "com.microsoft.VSCode",
							appName: "仅在范围外的原始敏感标题",
							opaqueWindowId: "window-1",
						},
					}),
					rawObservation(2, 100_010, {
						kind: "ax.valueChanged",
						source: {
							sensor: "ax",
							adapterVersion: "audit-test.v2",
						},
						coverage: ["content", "metadata"],
						metadata: {
							processId: 42,
							protectedInput: false,
							focusedRole: "AXTextArea",
							opaqueControlId: "editor",
							finalValueAvailable: true,
						},
						contentState: "available",
						...(includeDecryptedContent
							? {
									content: {
										finalValue: "秘密文本 ABC-123",
										inputOrigin: "unknown",
									},
								}
							: {}),
					}),
					rawObservation(3, 100_000, {
						kind: "application.processObservedBatch",
						subject: {
							appId: "system.processes",
							appName: "Processes",
						},
						metadata: {
							started: [
								{
									processId: 42,
									appId: "com.example.App",
									appName: "Example",
								},
							],
							exited: [],
						},
					}),
					rawObservation(4, 100_020),
					rawObservation(5, 100_030, {
						kind: "ax.focusChanged",
						source: {
							sensor: "ax",
							adapterVersion: "audit-test.v2",
						},
						metadata: {
							processId: 42,
							protectedInput: false,
						},
						content: {
							screenshot_bytes: "绝不能导出的像素",
							temporaryFilePath: "绝不能导出的临时路径",
							screenCapturePath: "绝不能导出的屏幕路径",
						},
						screenshot_bytes: "绝不能导出的顶层像素",
					}),
					rawObservation(6, 100_040, {
						kind: "input.activityBucket",
						interval: {
							startedAtMs: 100_040,
							endedAtMs: 105_040,
						},
						source: {
							sensor: "cg_activity",
							adapterVersion: "audit-test.v2",
						},
						metadata: {
							keyCount: 1,
							clickCount: 0,
							scrollDelta: 0,
							mouseDistance: 1,
							coalescedBucketCount: 1,
						},
					}),
					rawObservation(7, 100_050, {
						source: {
							sensor: "ax",
							adapterVersion: "audit-test.v2",
						},
					}),
					rawObservation(8, 100_060, {
						kind: "input.activityBucket",
						interval: {
							startedAtMs: 100_060,
							endedAtMs: 110_060,
						},
						source: {
							sensor: "cg_activity",
							adapterVersion: "audit-test.v2",
						},
						metadata: {
							keyCount: 2,
							clickCount: 0,
							scrollDelta: 0,
							mouseDistance: 2,
							coalescedBucketCount: 2,
						},
					}),
				],
				semanticEvents: [...populated.events, ignoredEvent],
			}),
		};
		const sourceRange = await repository.readAuditRange(0, 300_000);
		const sourceEpisode = sourceRange.episodes[0]!;
		const sourceSummary = sourceRange.summaries[0]!;
		const sourceFirstFactId = sourceRange.facts[0]!.factId;
		const sourceSecondFact = sourceRange.facts[1]!;
		sourceEpisode.classification.activity = "commerce";
		sourceEpisode.classification.goalRelevance = "direct";
		sourceEpisode.hypothesis = {
			text: "Qwen source inference must not survive a range slice",
			citedFactIds: [sourceFirstFactId],
			generator: "qwen3:4b-cited.v2",
		};
		sourceSummary.segments[0]!.activity = "commerce";
		sourceSummary.segments[0]!.goalRelevance = "direct";
		sourceSummary.segments[0]!.hypothesis = structuredClone(
			sourceEpisode.hypothesis,
		);
		sourceSummary.segments[0]!.evidence = [structuredClone(sourceSecondFact)];
		const auditRepository = {
			readAuditRange: async () => structuredClone(sourceRange),
		} as unknown as TimelineV2Repository;
		const exporter = new TimelineFiveMinuteAuditExporter(
			raw,
			auditRepository,
			clock.nowMs.bind(clock),
		);
		const redacted = await exporter.exportFiveMinutes(0);
		expect(redacted.manifest.toMs).toBe(300_000);
		expect(redacted.manifest.decryptedContentIncluded).toBeFalse();
		expect(JSON.stringify(redacted)).not.toContain("秘密文本 ABC-123");
		const redactedRawMetadataObservation = redacted.rawObservations.find(
			(observation) => observation.observationId === "observation-1",
		);
		expect(redactedRawMetadataObservation).toMatchObject({
			contentState: "available",
			coverage: ["metadata"],
			metadata: { processId: 42 },
		});
		const redactedRawTextObservation = redacted.rawObservations.find(
			(observation) => observation.observationId === "observation-2",
		);
		expect(redactedRawTextObservation).toMatchObject({
			contentState: "available",
			coverage: ["content", "metadata"],
		});
		expect(redactedRawTextObservation).not.toHaveProperty("content");
		expect(
			redacted.rawObservations.find(
				(observation) => observation.observationId === "observation-3",
			),
		).toMatchObject({
			metadata: {
				started: [{ appName: "Example" }],
			},
		});
		expect(redacted.lineage.length).toBeGreaterThan(0);
		expect(redacted.lineage).toContainEqual({
			observationId: "observation-3",
			eventId: "event-3",
			factId: null,
			sourceEpisodeId: null,
			sourceEpisodeRevisionId: null,
			episodeSliceId: null,
			sourceTimelineId: null,
			timelineSliceId: null,
			timelineSegmentSliceId: null,
			status: "ignored",
		});
		expect(redacted.lineage).toContainEqual({
			observationId: "observation-4",
			eventId: null,
			factId: null,
			sourceEpisodeId: null,
			sourceEpisodeRevisionId: null,
			episodeSliceId: null,
			sourceTimelineId: null,
			timelineSliceId: null,
			timelineSegmentSliceId: null,
			status: "unreferenced_raw",
		});

		const decrypted = await exporter.exportFiveMinutes(0, {
			includeDecryptedContent: true,
		});
		expect(JSON.stringify(decrypted)).toContain("秘密文本 ABC-123");
		expect(JSON.stringify(decrypted)).not.toContain("绝不能导出的像素");
		expect(JSON.stringify(decrypted)).not.toContain("绝不能导出的顶层像素");
		expect(JSON.stringify(decrypted)).not.toContain("绝不能导出的临时路径");
		expect(JSON.stringify(decrypted)).not.toContain("绝不能导出的屏幕路径");
		expect(
			decrypted.rawObservations.map(
				(observation) =>
					(observation as { observationId: string }).observationId,
			),
		).not.toContain("observation-6");
		expect(
			decrypted.rawObservations.map(
				(observation) =>
					(observation as { observationId: string }).observationId,
			),
		).not.toContain("observation-7");
		expect(
			decrypted.rawObservations.map(
				(observation) =>
					(observation as { observationId: string }).observationId,
			),
		).toContain("observation-8");
		expect(decrypted.manifest.timelineSliceCount).toBe(1);
		expect(decrypted.manifest.sourceTimelineSummaryCount).toBe(1);
		expect(decrypted.episodeSlices).toHaveLength(1);
		expect(decrypted.timelineSlices).toHaveLength(1);
		const fullEpisodeSlice = decrypted.episodeSlices[0]!;
		const fullTimelineSlice = decrypted.timelineSlices[0]!;
		expect(fullEpisodeSlice).toMatchObject({
			inferenceScope: "range_recomputed",
			classification: {
				activity: "development",
				goalRelevance: null,
			},
			hypothesis: {
				generator: "deterministic-template.v2",
			},
		});
		expect(fullEpisodeSlice.episodeSliceId).not.toBe(
			fullEpisodeSlice.sourceEpisodeRevisionId,
		);
		expect(fullTimelineSlice.segments[0]?.segmentSliceId).not.toBe(
			fullTimelineSlice.segments[0]?.sourceEpisodeRevisionId,
		);
		expect(fullTimelineSlice.segments[0]?.evidenceFactIds).toEqual([
			sourceSecondFact.factId,
		]);
		expect(
			decrypted.lineage.find((entry) => entry.factId === sourceFirstFactId),
		).toMatchObject({
			episodeSliceId: fullEpisodeSlice.episodeSliceId,
			timelineSliceId: null,
			timelineSegmentSliceId: null,
			status: "episode_only",
		});
		expect(decrypted.manifest.rawObservationCount).toBe(
			decrypted.rawObservations.length,
		);
		expect(decrypted.manifest.includedCounts).toEqual({
			rawObservations: decrypted.rawObservations.length,
			semanticEvents: decrypted.semanticEvents.length,
			evidenceFacts: decrypted.evidenceFacts.length,
			sourceEpisodes: decrypted.episodes.length,
			episodeSlices: decrypted.episodeSlices.length,
			sourceTimelineSummaries: decrypted.timelineSummaries.length,
			timelineSlices: decrypted.timelineSlices.length,
		});
		expect(decrypted.manifest.rangeBoundaryOmissions).toEqual({
			rawObservations: 3,
			semanticEvents: 0,
			evidenceFacts: 0,
			sourceEpisodes: 0,
			episodeSlices: 0,
			sourceTimelineSummaries: 0,
			timelineSlices: 0,
		});
		const rawIds = new Set(
			decrypted.rawObservations.map((observation) =>
				String((observation as { observationId: string }).observationId),
			),
		);
		const eventIds = new Set(
			decrypted.semanticEvents.map((event) => event.eventId),
		);
		const factIds = new Set(decrypted.evidenceFacts.map((fact) => fact.factId));
		const episodeSliceIds = new Set(
			decrypted.episodeSlices.map((slice) => slice.episodeSliceId),
		);
		const timelineSliceIds = new Set(
			decrypted.timelineSlices.map((slice) => slice.timelineSliceId),
		);
		const segmentSliceIds = new Set(
			decrypted.timelineSlices.flatMap((slice) =>
				slice.segments.map((segment) => segment.segmentSliceId),
			),
		);
		for (const entry of decrypted.lineage) {
			expect(rawIds.has(entry.observationId)).toBeTrue();
			if (entry.eventId) {
				expect(eventIds.has(entry.eventId)).toBeTrue();
			}
			if (entry.factId) {
				expect(factIds.has(entry.factId)).toBeTrue();
			}
			if (entry.episodeSliceId) {
				expect(episodeSliceIds.has(entry.episodeSliceId)).toBeTrue();
			}
			if (entry.timelineSliceId) {
				expect(timelineSliceIds.has(entry.timelineSliceId)).toBeTrue();
			}
			if (entry.timelineSegmentSliceId) {
				expect(segmentSliceIds.has(entry.timelineSegmentSliceId)).toBeTrue();
			}
		}

		const clipped = await exporter.exportFiveMinutes(100_005, {
			includeDecryptedContent: true,
		});
		expect(JSON.stringify(clipped)).not.toContain("仅在范围外的原始敏感标题");
		expect(JSON.stringify(clipped)).not.toContain(
			"绝不能出现在 SQLite 的敏感项目",
		);
		expect(clipped.manifest.timelineSliceCount).toBe(1);
		expect(clipped.timelineSummaries).toHaveLength(0);
		expect(clipped.episodeSlices).toHaveLength(1);
		expect(clipped.timelineSlices).toHaveLength(1);
		expect(clipped.timelineSlices[0]).toMatchObject({
			clippedAtStart: true,
			clippedAtEnd: false,
		});
		const clippedEpisodeSlice = clipped.episodeSlices[0]!;
		expect(clippedEpisodeSlice.inferenceScope).toBe("range_recomputed");
		expect(clippedEpisodeSlice.classification.activity).toBe("development");
		expect(clippedEpisodeSlice.classification.goalRelevance).toBeNull();
		expect(clippedEpisodeSlice.hypothesis.generator).toBe(
			"deterministic-template.v2",
		);
		expect(clippedEpisodeSlice.hypothesis.citedFactIds).not.toContain(
			sourceFirstFactId,
		);
		expect(
			clippedEpisodeSlice.hypothesis.citedFactIds.every((factId) =>
				clipped.evidenceFacts.some((fact) => fact.factId === factId),
			),
		).toBeTrue();
		expect(clipped.manifest.rangeBoundaryOmissions.rawObservations).toBe(5);
		expect(clipped.manifest.rangeBoundaryOmissions.timelineSlices).toBe(0);
		expect(clipped.manifest.exportWarnings).toContain(
			"derived_timeline_clipped_to_exact_range",
		);
		expect(clipped.coverage).not.toContain("unavailable");
		repository.close();
	});

	test("reopens RESULT_PERSISTED and COMMITTING jobs by finalizing without inference", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-timeline-v2-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "timeline-v2.sqlite3");
		const vault = new MemoryVault();
		const clock = new Clock();
		const repository = new SqliteTimelineV2Repository(
			path,
			vault,
			clock.nowMs.bind(clock),
		);
		const { windowId } = await populate(repository, clock);
		repository.close();

		for (const recoverableState of [
			"RESULT_PERSISTED",
			"COMMITTING",
		] as const) {
			const database = new Database(path, { strict: true });
			database
				.query("UPDATE timeline_jobs SET state = ? WHERE window_id = ?")
				.run(recoverableState, windowId);
			database.close();

			const reopened = new SqliteTimelineV2Repository(
				path,
				vault,
				clock.nowMs.bind(clock),
			);
			const hasher = new WebCryptoReflectionHasher();
			const processor = new TimelineV2Processor({
				repository: reopened,
				evidence: new DeterministicEvidenceRenderer(hasher),
				episodes: new DeterministicEpisodeAssembler({
					hasher,
					hypotheses: new DeterministicTimelineHypothesisGenerator(),
				}),
				hasher,
				clock,
			});
			const runner = new TimelineV2JobRunner({
				repository: reopened,
				processor,
				clock,
				jitter: () => 0,
			});

			expect(await runner.runNext()).toBe("completed");
			expect(await reopened.getJob(windowId)).toMatchObject({
				state: "COMMITTED",
				// Re-running inference would claim RUNNING and increment this.
				attempt: 1,
			});
			expect(
				(
					await reopened.queryAgentInputs({
						nowMs: clock.nowMs(),
						includeHeldLocal: true,
					})
				).inputs,
			).toHaveLength(1);
			reopened.close();
		}
	});

	test("resets an expired raw collector and removes derived index rows after 30 days", async () => {
		const directory = mkdtempSync(
			join(tmpdir(), "whalehall-timeline-v2-retention-"),
		);
		temporaryDirectories.push(directory);
		const path = join(directory, "timeline-v2.sqlite3");
		const vault = new MemoryVault();
		const initialClock = new Clock();
		const repository = new SqliteTimelineV2Repository(
			path,
			vault,
			initialClock.nowMs.bind(initialClock),
		);
		const { windowId } = await populate(repository, initialClock);
		repository.close();

		const eightDaysLater = new Clock(
			initialClock.nowMs() + 8 * 24 * 60 * 60 * 1000,
		);
		const afterRawExpiry = new SqliteTimelineV2Repository(
			path,
			vault,
			eightDaysLater.nowMs.bind(eightDaysLater),
		);
		expect(
			await afterRawExpiry.loadCollector("collector.timeline-v2"),
		).toBeNull();
		const collector = new TimelineV2Collector({
			collectorId: "collector.timeline-v2",
			deviceId: "device-1",
			sessionId: "session-1",
			repository: afterRawExpiry,
			hasher: new WebCryptoReflectionHasher(),
			clock: eightDaysLater,
		});
		await collector.recover();
		expect(collector.getSnapshot()).toMatchObject({
			openWindow: null,
			recentEventIds: [],
		});
		expect(collector.getSnapshot().revision).toBeGreaterThan(0);
		// Derived material remains available for the 30-day policy.
		expect(await afterRawExpiry.getTimelineResult(windowId)).not.toBeNull();
		const auditAfterRawExpiry = await afterRawExpiry.readAuditRange(0, 300_000);
		expect(auditAfterRawExpiry.windows).toHaveLength(0);
		expect(auditAfterRawExpiry.facts.length).toBeGreaterThan(0);
		expect(auditAfterRawExpiry.episodes.length).toBeGreaterThan(0);
		expect(auditAfterRawExpiry.summaries).toHaveLength(1);
		afterRawExpiry.close();

		const thirtyOneDaysLater = new Clock(
			initialClock.nowMs() + 31 * 24 * 60 * 60 * 1000,
		);
		const afterDerivedExpiry = new SqliteTimelineV2Repository(
			path,
			vault,
			thirtyOneDaysLater.nowMs.bind(thirtyOneDaysLater),
		);
		expect(await afterDerivedExpiry.getTimelineResult(windowId)).toBeNull();
		expect(await afterDerivedExpiry.getJob(windowId)).toBeNull();
		expect(
			(
				await afterDerivedExpiry.queryAgentInputs({
					nowMs: thirtyOneDaysLater.nowMs(),
					includeHeldLocal: true,
				})
			).inputs,
		).toHaveLength(0);
		afterDerivedExpiry.close();
	});
});
