import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
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
			inputMethod: "unknown",
			label: "代码编辑区",
			addedText: "秘密文本 ABC-123",
			finalValue: "秘密文本 ABC-123",
		},
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
		hypotheses:
			new DeterministicTimelineHypothesisGenerator(),
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
		const directory = mkdtempSync(
			join(tmpdir(), "whalehall-timeline-v2-"),
		);
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

		const sqliteBytes = [
			path,
			`${path}-wal`,
			`${path}-shm`,
		]
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
					seal.expiresAtMs ===
						clock.nowMs() + 7 * 24 * 60 * 60 * 1000,
			),
		).toBeTrue();
		expect(
			vault.seals.some(
				(seal) =>
					seal.purpose === "timeline.summary.v2" &&
					seal.expiresAtMs ===
						clock.nowMs() + 30 * 24 * 60 * 60 * 1000,
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
		const directory = mkdtempSync(
			join(tmpdir(), "whalehall-timeline-v2-"),
		);
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
					{
						observationId: "observation-1",
						interval: { startedAtMs: 100_000, endedAtMs: 100_000 },
						content: includeDecryptedContent
							? {
									visibleText: "仅在范围外的原始敏感标题",
									screenshotBytes: "绝不能导出的像素",
								}
							: "[redacted]",
						screenshotBytes: "绝不能导出的顶层像素",
					},
					{
						observationId: "observation-2",
						interval: { startedAtMs: 100_010, endedAtMs: 100_010 },
					},
					{
						observationId: "observation-3",
						interval: { startedAtMs: 100_000, endedAtMs: 100_000 },
					},
					{
						observationId: "observation-4",
						interval: { startedAtMs: 100_020, endedAtMs: 100_020 },
					},
				],
				semanticEvents: [...populated.events, ignoredEvent],
			}),
		};
		const exporter = new TimelineFiveMinuteAuditExporter(
			raw,
			repository,
			clock.nowMs.bind(clock),
		);
		const redacted = await exporter.exportFiveMinutes(0);
		expect(redacted.manifest.toMs).toBe(300_000);
		expect(redacted.manifest.decryptedContentIncluded).toBeFalse();
		expect(JSON.stringify(redacted)).not.toContain("秘密文本 ABC-123");
		expect(redacted.lineage.length).toBeGreaterThan(0);
		expect(redacted.lineage).toContainEqual({
			observationId: "observation-3",
			eventId: "event-3",
			factId: null,
			episodeRevisionId: null,
			timelineId: null,
			status: "ignored",
		});
		expect(redacted.lineage).toContainEqual({
			observationId: "observation-4",
			eventId: null,
			factId: null,
			episodeRevisionId: null,
			timelineId: null,
			status: "unreferenced_raw",
		});

		const decrypted = await exporter.exportFiveMinutes(0, {
			includeDecryptedContent: true,
		});
		expect(JSON.stringify(decrypted)).toContain("秘密文本 ABC-123");
		expect(JSON.stringify(decrypted)).not.toContain("绝不能导出的像素");
		expect(JSON.stringify(decrypted)).not.toContain(
			"绝不能导出的顶层像素",
		);
		expect(decrypted.manifest.timelineCount).toBe(1);
		expect(decrypted.manifest.rangeBoundaryOmissions).toEqual({
			rawObservations: 0,
			semanticEvents: 0,
			evidenceFacts: 0,
			episodes: 0,
			timelines: 0,
		});

		const clipped = await exporter.exportFiveMinutes(100_005, {
			includeDecryptedContent: true,
		});
		expect(JSON.stringify(clipped)).not.toContain(
			"仅在范围外的原始敏感标题",
		);
		expect(JSON.stringify(clipped)).not.toContain(
			"绝不能出现在 SQLite 的敏感项目",
		);
		expect(clipped.manifest.timelineCount).toBe(0);
		expect(clipped.manifest.rangeBoundaryOmissions?.rawObservations).toBe(2);
		expect(clipped.manifest.rangeBoundaryOmissions?.timelines).toBe(1);
		expect(clipped.coverage).toContain("unavailable");
		repository.close();
	});

	test("reopens RESULT_PERSISTED and COMMITTING jobs by finalizing without inference", async () => {
		const directory = mkdtempSync(
			join(tmpdir(), "whalehall-timeline-v2-"),
		);
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
				.query(
					"UPDATE timeline_jobs SET state = ? WHERE window_id = ?",
				)
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
					hypotheses:
						new DeterministicTimelineHypothesisGenerator(),
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
		const auditAfterRawExpiry = await afterRawExpiry.readAuditRange(
			0,
			300_000,
		);
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
