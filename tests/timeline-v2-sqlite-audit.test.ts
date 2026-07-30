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
	test("keeps redacted raw lineage exportable when production-derived vault data is unavailable", async () => {
		const event = semantic(
			1,
			1_000,
			"application.foregroundChanged",
		);
		const raw: RawFiveMinuteAuditSource = {
			async queryAuditRange() {
				return {
					permissions: {
						accessibility: "denied",
						screenRecording: "denied",
						inputMonitoring: "authorized",
						automation: "authorized",
					},
					coverage: ["metadata"],
					rawObservations: [rawObservation(1, 1_000)],
					semanticEvents: [event],
				};
			},
		};
		const unavailableRepository = {
			async readAuditRange() {
				throw new Error("sealed production-derived data unavailable");
			},
		} as unknown as TimelineV2Repository;
		const exported = await new TimelineFiveMinuteAuditExporter(
			raw,
			unavailableRepository,
			() => 400_000,
		).exportFiveMinutes(0);

		expect(exported.manifest.exportWarnings).toContain(
			"production_derived_unavailable",
		);
		expect(exported.manifest.exportWarnings).toContain(
			"audit_only_provisional_projection",
		);
		expect(exported.coverage).toContain("unavailable");
		expect(exported.manifest.sourceEpisodeCount).toBe(0);
		expect(exported.manifest.sourceTimelineSummaryCount).toBe(0);
		expect(exported.evidenceFacts).toHaveLength(1);
		expect(exported.episodeSlices).toHaveLength(1);
		expect(exported.timelineSlices).toHaveLength(1);
		expect(exported.lineage).toContainEqual(
			expect.objectContaining({
				observationId: "observation-1",
				eventId: "event-1",
				status: "summarized",
			}),
		);
	});

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
		const agentInputId = held.inputs[0]!.input.agentInputId;
		expect(
			await repository.releaseAgentInputs(
				[agentInputId],
				clock.nowMs(),
			),
		).toBe(1);
		const leased = await repository.queryAgentInputs({
			nowMs: clock.nowMs(),
		});
		const leaseToken = leased.inputs[0]!.leaseToken!;
		await expect(
			repository.commitAgentInput(
				agentInputId,
				leaseToken,
				clock.nowMs(),
			),
		).resolves.toMatchObject({ state: "ACKED" });
		await expect(
			repository.commitAgentInput(
				agentInputId,
				"wrong_token_after_ack_0001",
				clock.nowMs(),
			),
		).rejects.toThrow("does not match");

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
		await expect(
			reopened.commitAgentInput(
				agentInputId,
				leaseToken,
				clock.nowMs(),
			),
		).resolves.toMatchObject({ state: "ACKED" });
		await expect(
			reopened.commitAgentInput(
				agentInputId,
				"wrong_token_after_ack_0002",
				clock.nowMs(),
			),
		).rejects.toThrow("does not match");
		reopened.close();
	});

	test("migrates v1 ACK leases without weakening token idempotency", async () => {
		const directory = mkdtempSync(join(tmpdir(), "whalehall-timeline-v1-"));
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
		const held = await repository.queryAgentInputs({
			nowMs: clock.nowMs(),
			includeHeldLocal: true,
		});
		const agentInputId = held.inputs[0]!.input.agentInputId;
		await repository.releaseAgentInputs([agentInputId], clock.nowMs());
		const leased = await repository.queryAgentInputs({
			nowMs: clock.nowMs(),
		});
		const leaseToken = leased.inputs[0]!.leaseToken!;
		repository.close();

		const legacy = new Database(path);
		legacy.exec("PRAGMA foreign_keys = ON;");
		const leasedPayload = (
			legacy
				.query(
					"SELECT sealed_payload FROM agent_input_outbox WHERE agent_input_id = ?",
				)
				.get(agentInputId) as { sealed_payload: string }
		).sealed_payload;
		legacy
			.query("UPDATE timeline_schema SET version = 1 WHERE singleton = 1")
			.run();
		legacy.exec(
			"ALTER TABLE agent_input_outbox DROP COLUMN acked_lease_token_hash",
		);
		legacy
			.query(
				`INSERT INTO timeline_windows (
				  window_id, collector_id, device_id, session_id, input_hash,
				  trigger_reason, started_at_ms, ended_at_ms, event_count,
				  first_cursor, last_cursor, sealed_payload
				 )
				 SELECT ?, collector_id, device_id, session_id, ?,
				        trigger_reason, started_at_ms, ended_at_ms, event_count,
				        ?, ?, ?
				   FROM timeline_windows WHERE window_id = ?`,
			)
			.run(
				"legacy-window-acked",
				"legacy-input-hash",
				"legacy-first-cursor",
				"legacy-last-cursor",
				"legacy-window-sealed",
				windowId,
			);
		legacy
			.query(
				`INSERT INTO agent_input_outbox (
				  agent_input_id, window_id, state, created_at_ms, payload_hash,
				  lease_token, lease_expires_at_ms, attempt, acked_at_ms,
				  sealed_payload
				 ) VALUES (?, ?, 'ACKED', ?, ?, NULL, NULL, 1, ?, ?)`,
			)
			.run(
				"legacy_agent_input_acked_0001",
				"legacy-window-acked",
				clock.nowMs(),
				"legacy-payload-hash",
				clock.nowMs(),
				"legacy-agent-input-sealed",
			);
		legacy.close();

		const migrated = new SqliteTimelineV2Repository(
			path,
			vault,
			clock.nowMs.bind(clock),
		);
		await expect(
			migrated.commitAgentInput(
				agentInputId,
				leaseToken,
				clock.nowMs(),
			),
		).resolves.toMatchObject({ state: "ACKED" });
		await expect(
			migrated.commitAgentInput(
				"legacy_agent_input_acked_0001",
				"unknown_legacy_ack_token_0001",
				clock.nowMs(),
			),
		).rejects.toThrow("does not match");
		migrated.close();

		const verified = new Database(path, { readonly: true });
		expect(
			(
				verified
					.query(
						"SELECT version FROM timeline_schema WHERE singleton = 1",
					)
					.get() as { version: number }
			).version,
		).toBe(2);
		expect(
			(
				verified
					.query("PRAGMA table_info(agent_input_outbox)")
					.all() as Array<{ name: string }>
			).some((column) => column.name === "acked_lease_token_hash"),
		).toBeTrue();
		expect(
			(
				verified
					.query(
						"SELECT sealed_payload FROM agent_input_outbox WHERE agent_input_id = ?",
					)
					.get(agentInputId) as { sealed_payload: string }
			).sealed_payload,
		).toBe(leasedPayload);
		expect(
			(
				verified
					.query(
						"SELECT acked_lease_token_hash FROM agent_input_outbox WHERE agent_input_id = ?",
					)
					.get("legacy_agent_input_acked_0001") as {
					acked_lease_token_hash: string | null;
				}
			).acked_lease_token_hash,
		).toBeNull();
		verified.close();
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
		const authorizationEvent: SemanticEventV2 = {
			...populated.events[0]!,
			eventId: "event-9",
			cursor: "sec2_0000000000000009",
			source: "workspace.observer-authorization.v2",
			occurredAtMs: 100_070,
			observedAtMs: 100_070,
			kind: "authorization.changed",
			countClass: "boundary",
			coverage: ["metadata"],
			sourceObservationIds: ["observation-9"],
			payload: {
				permissions: {
					accessibility: "granted",
					screenRecording: "granted",
					inputMonitoring: "denied",
					automation: "not_determined",
				},
				changedPermissions: ["inputMonitoring"],
				transition: "revoked",
				reason: "runtime_change",
			},
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
					rawObservation(9, 100_070, {
						kind: "authorization.changed",
						source: {
							sensor: "workspace",
							adapterVersion: "observer-authorization.v2",
						},
						subject: {
							appId: "system.authorization",
							appName: "macOS",
							opaqueWindowId: null,
						},
						metadata: structuredClone(authorizationEvent.payload),
					}),
					rawObservation(10, 100_080, {
						kind: "authorization.changed",
						source: {
							sensor: "workspace",
							adapterVersion: "observer-authorization.v2",
						},
						subject: {
							appId: "system.authorization",
							appName: "macOS",
							opaqueWindowId: null,
						},
						metadata: structuredClone(authorizationEvent.payload),
						content: {
							windowTitle: "授权边界绝不能携带窗口标题",
						},
					}),
				],
				semanticEvents: [
					...populated.events,
					ignoredEvent,
					authorizationEvent,
				],
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
		expect(JSON.stringify(decrypted)).not.toContain(
			"授权边界绝不能携带窗口标题",
		);
		expect(decrypted.evidenceFacts).toHaveLength(sourceRange.facts.length);
		expect(decrypted.manifest.exportWarnings).not.toContain(
			"audit_only_provisional_projection",
		);
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
		expect(
			decrypted.rawObservations.map(
				(observation) =>
					(observation as { observationId: string }).observationId,
			),
		).toContain("observation-9");
		expect(
			decrypted.rawObservations.map(
				(observation) =>
					(observation as { observationId: string }).observationId,
			),
		).not.toContain("observation-10");
		expect(decrypted.lineage).toContainEqual({
			observationId: "observation-9",
			eventId: "event-9",
			factId: null,
			sourceEpisodeId: null,
			sourceEpisodeRevisionId: null,
			episodeSliceId: null,
			sourceTimelineId: null,
			timelineSliceId: null,
			timelineSegmentSliceId: null,
			status: "semantic_only",
		});
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
			rawObservations: 4,
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
		expect(clipped.manifest.rangeBoundaryOmissions.rawObservations).toBe(6);
		expect(clipped.manifest.rangeBoundaryOmissions.timelineSlices).toBe(0);
		expect(clipped.manifest.exportWarnings).toContain(
			"derived_timeline_clipped_to_exact_range",
		);
		expect(clipped.coverage).not.toContain("unavailable");
		repository.close();
	});

	test("projects unsealed in-range semantic events into an audit-only meeting timeline", async () => {
		const clock = new Clock();
		const activityEvents = [
			semantic(21, 120_000, "application.foregroundChanged"),
			semantic(22, 120_010, "application.textValueChanged"),
		].map((event) => ({ ...event, goalVersion: 7 }));
		const goalContent = {
			previous: {
				goalId: "goal-previous",
				planId: null,
				version: 7,
				text: "检查 WhaleHall 审计",
				activatedAtMs: 110_000,
			},
			next: {
				goalId: "goal-1",
				planId: null,
				version: 8,
				text: "完成 WhaleHall 审计",
				activatedAtMs: 120_020,
			},
		};
		const goalEvent: SemanticEventV2 = {
			...activityEvents[1]!,
			eventId: "event-23",
			cursor: "sec2_0000000000000017",
			source: "workspace.goal.v2",
			occurredAtMs: 120_020,
			observedAtMs: 120_020,
			kind: "goal.changed",
			countClass: "boundary",
			sourceObservationIds: ["observation-23"],
			payload: structuredClone(goalContent),
		};
		const authorizationEvent: SemanticEventV2 = {
			...activityEvents[1]!,
			eventId: "event-24",
			cursor: "sec2_0000000000000018",
			source: "workspace.observer-authorization.v2",
			occurredAtMs: 120_030,
			observedAtMs: 120_030,
			kind: "authorization.changed",
			countClass: "boundary",
			coverage: ["metadata"],
			sourceObservationIds: ["observation-24"],
			payload: {
				permissions: {
					accessibility: "granted",
					screenRecording: "granted",
					inputMonitoring: "granted",
					automation: "granted",
				},
				changedPermissions: ["accessibility"],
				transition: "granted",
				reason: "runtime_change",
			},
		};
		const ignoredEvent: SemanticEventV2 = {
			...activityEvents[1]!,
			eventId: "event-25",
			cursor: "sec2_0000000000000019",
			source: "workspace.process-inventory.v1",
			occurredAtMs: 120_040,
			observedAtMs: 120_040,
			kind: "application.processObservedBatch",
			countClass: "ignored",
			coverage: ["metadata"],
			sourceObservationIds: ["observation-25"],
			payload: { started: [], exited: [] },
		};
		const events = [
			...activityEvents,
			goalEvent,
			authorizationEvent,
			ignoredEvent,
		];
		const raw: RawFiveMinuteAuditSource = {
			queryAuditRange: async ({ includeDecryptedContent }) => ({
				permissions: {
					accessibility: "granted",
					screenRecording: "granted",
				},
				coverage: ["content", "metadata"],
				rawObservations: [
					rawObservation(21, 120_000),
					rawObservation(22, 120_010, {
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
						...(includeDecryptedContent
							? {
									content: {
										finalValue: "秘密文本 ABC-123",
										inputOrigin: "unknown",
									},
								}
							: {}),
					}),
					rawObservation(23, 120_020, {
						kind: "goal.changed",
						metadata: {},
						...(includeDecryptedContent
							? { content: structuredClone(goalContent) }
							: {}),
					}),
					rawObservation(24, 120_030, {
						kind: "authorization.changed",
						source: {
							sensor: "workspace",
							adapterVersion: "observer-authorization.v2",
						},
						subject: {
							appId: "system.authorization",
							appName: "macOS",
							opaqueWindowId: null,
						},
						metadata: structuredClone(authorizationEvent.payload),
					}),
					rawObservation(25, 120_040, {
						kind: "application.processObservedBatch",
						subject: {
							appId: "system.processes",
							appName: "Processes",
						},
						metadata: { started: [], exited: [] },
					}),
				],
				semanticEvents: structuredClone(events),
			}),
		};
		const sourceRange = {
			windows: [],
			facts: [],
			episodes: [],
			summaries: [],
		};
		const sourceSnapshot = structuredClone(sourceRange);
		const auditRepository = {
			readAuditRange: async () => structuredClone(sourceRange),
		} as unknown as TimelineV2Repository;
		const exporter = new TimelineFiveMinuteAuditExporter(
			raw,
			auditRepository,
			clock.nowMs.bind(clock),
		);

		const exported = await exporter.exportFiveMinutes(0, {
			includeDecryptedContent: true,
		});
		const repeated = await exporter.exportFiveMinutes(0, {
			includeDecryptedContent: true,
		});

		expect(sourceRange).toEqual(sourceSnapshot);
		expect(exported.episodes).toHaveLength(0);
		expect(exported.timelineSummaries).toHaveLength(0);
		expect(exported.evidenceFacts).toHaveLength(3);
		expect(
			exported.evidenceFacts.every((fact) =>
				fact.factId.startsWith("audit_only_fact_"),
			),
		).toBeTrue();
		expect(
			new Set(exported.evidenceFacts.map((fact) => fact.factId)).size,
		).toBe(3);
		expect(
			exported.evidenceFacts.flatMap((fact) => fact.eventIds).sort(),
		).toEqual(["event-21", "event-22", "event-23"]);
		expect(repeated.evidenceFacts.map((fact) => fact.factId)).toEqual(
			exported.evidenceFacts.map((fact) => fact.factId),
		);

		expect(exported.episodeSlices).toHaveLength(1);
		expect(exported.timelineSlices).toHaveLength(1);
		const episode = exported.episodeSlices[0]!;
		const timeline = exported.timelineSlices[0]!;
			expect(episode).toMatchObject({
				sourceWindowIds: [],
				inferenceScope: "range_recomputed",
				goalVersion: 7,
			classification: {
				activity: "development",
				goalRelevance: null,
			},
			hypothesis: {
				generator: "deterministic-template.v2",
			},
		});
		expect(episode.episodeSliceId).toStartWith("audit_only_episode_slice_");
		expect(episode.sourceEpisodeId).toStartWith("audit_only_episode_");
			expect(timeline).toMatchObject({
				triggerReason: "audit_range",
				inferenceScope: "range_recomputed",
				goalVersion: 7,
			sourceSegmentCount: 1,
			includedSegmentCount: 1,
		});
		expect(timeline.timelineSliceId).toStartWith(
			"audit_only_timeline_slice_",
		);
		expect(timeline.sourceTimelineId).toStartWith("audit_only_timeline_");
		expect(timeline.sourceWindowId).toStartWith(
			"audit_only_unsealed_range_",
		);
		expect(repeated.timelineSlices[0]?.timelineSliceId).toBe(
			timeline.timelineSliceId,
		);
		expect(timeline.renderedText).toContain(
			"可能在进行软件开发或排查技术问题",
		);
		expect(timeline.renderedText).toContain("前台切换到 Visual Studio Code");
		expect(timeline.renderedText).toContain("最终增加了文本");
		expect(timeline.renderedText).not.toContain("Qwen");
		expect(timeline.segments[0]!.evidenceFactIds).toEqual(
			exported.evidenceFacts
				.filter((fact) => fact.role !== "boundary")
				.map((fact) => fact.factId),
		);
		expect(exported.manifest.exportWarnings).toContain(
			"audit_only_provisional_projection",
		);
		expect(exported.manifest.includedCounts).toMatchObject({
			evidenceFacts: 3,
			sourceEpisodes: 0,
			episodeSlices: 1,
			sourceTimelineSummaries: 0,
			timelineSlices: 1,
		});
		expect(
			exported.lineage.filter((entry) => entry.status === "summarized"),
		).toHaveLength(2);
		const goalLineage = exported.lineage.find(
			(entry) => entry.eventId === "event-23",
		);
		expect(goalLineage).toMatchObject({
			observationId: "observation-23",
			eventId: "event-23",
			sourceEpisodeId: null,
			sourceEpisodeRevisionId: null,
			episodeSliceId: null,
			sourceTimelineId: null,
			timelineSliceId: null,
			timelineSegmentSliceId: null,
			status: "fact_only",
		});
		expect(goalLineage?.factId).toStartWith("audit_only_fact_");
		expect(exported.lineage).toContainEqual({
			observationId: "observation-24",
			eventId: "event-24",
			factId: null,
			sourceEpisodeId: null,
			sourceEpisodeRevisionId: null,
			episodeSliceId: null,
			sourceTimelineId: null,
			timelineSliceId: null,
			timelineSegmentSliceId: null,
			status: "semantic_only",
		});
		expect(exported.lineage).toContainEqual({
			observationId: "observation-25",
			eventId: "event-25",
			factId: null,
			sourceEpisodeId: null,
			sourceEpisodeRevisionId: null,
			episodeSliceId: null,
			sourceTimelineId: null,
			timelineSliceId: null,
			timelineSegmentSliceId: null,
			status: "ignored",
		});
		for (const entry of exported.lineage) {
			if (entry.status !== "summarized") continue;
			expect(entry.factId).toStartWith("audit_only_fact_");
			expect(entry.episodeSliceId).toBe(episode.episodeSliceId);
			expect(entry.timelineSliceId).toBe(timeline.timelineSliceId);
			expect(entry.timelineSegmentSliceId).toBe(
				timeline.segments[0]!.segmentSliceId,
			);
		}
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
