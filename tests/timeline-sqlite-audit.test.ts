import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReflectionClock } from "../src/agent/reflection/collector";
import { WebCryptoReflectionHasher } from "../src/agent/reflection/hash";
import {
	DeterministicEpisodeAssembler,
	DeterministicEvidenceRenderer,
	DeterministicTimelineHypothesisGenerator,
	type RawFiveMinuteAuditSource,
	type SemanticEventV2,
	SqliteTimelineV2Repository,
	TIMELINE_RAW_RETENTION_MS,
	type TimelineCollectorSnapshotV2,
	TimelineFiveMinuteAuditExporter,
	TimelineV2Collector,
	TimelineV2JobRunner,
	TimelineV2Processor,
	type TimelineV2Repository,
	type TimelineVault,
	type TimelineVaultDeleteRequest,
	type TimelineVaultOpenRequest,
	type TimelineVaultSealRequest,
} from "../src/agent/timeline";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	if (process.platform === "win32") Bun.gc(true);
	for (const directory of temporaryDirectories.splice(0)) {
		await removeTemporaryDirectory(directory);
	}
});

async function removeTemporaryDirectory(directory: string): Promise<void> {
	const maxRetries = process.platform === "win32" ? 20 : 0;
	for (let attempt = 0; ; attempt += 1) {
		try {
			rmSync(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!isWindowsBusyError(error) || attempt >= maxRetries) throw error;
			Bun.gc(true);
			await Bun.sleep(25);
		}
	}
}

function isWindowsBusyError(error: unknown): error is NodeJS.ErrnoException {
	return (
		process.platform === "win32" &&
		error instanceof Error &&
		(error as NodeJS.ErrnoException).code === "EBUSY"
	);
}

class MemoryVault implements TimelineVault {
	readonly seals: TimelineVaultSealRequest[] = [];
	readonly deletes: TimelineVaultDeleteRequest[] = [];
	private nextRef = 1;
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
			if (
				existing.request.plaintext !== request.plaintext ||
				existing.request.schemaVersion !== request.schemaVersion ||
				existing.request.expiresAtMs !== request.expiresAtMs ||
				JSON.stringify(existing.request.aad) !== JSON.stringify(request.aad)
			) {
				throw new Error("vault record id reused with different content");
			}
			return existing.ref;
		}
		const ref = `vaultref_${this.nextRef}`;
		this.nextRef += 1;
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

	async deleteRecords(request: TimelineVaultDeleteRequest): Promise<void> {
		this.deletes.push(structuredClone(request));
		for (const recordId of request.recordIds) {
			const key = `${request.purpose}:${recordId}`;
			const existing = this.byId.get(key);
			if (!existing) continue;
			this.byId.delete(key);
			this.byRef.delete(existing.ref);
		}
	}

	retainedRecordCount(purpose: TimelineVaultDeleteRequest["purpose"]): number {
		return [...this.byId.values()].filter(
			(entry) => entry.request.purpose === purpose,
		).length;
	}

	retainedPlaintextBytes(
		purpose: TimelineVaultDeleteRequest["purpose"],
	): number {
		return [...this.byId.values()]
			.filter((entry) => entry.request.purpose === purpose)
			.reduce(
				(total, entry) =>
					total + new TextEncoder().encode(entry.request.plaintext).length,
				0,
			);
	}
}

class Clock implements ReflectionClock {
	constructor(private value = 400_000) {}
	set(value: number): void {
		this.value = value;
	}
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
	expect(await repository.readCursorAuthority(events[1]!.cursor)).toMatchObject(
		{
			state: "pending",
			windowId: window!.windowId,
		},
	);
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
	expect(await repository.readCursorAuthority(events[1]!.cursor)).toEqual({
		state: "committed",
		windowId: window!.windowId,
	});
	return { windowId: window!.windowId, events };
}

describe("Timeline v2 encrypted SQLite and audit", () => {
	test("durably abandons an aged shutdown claim without spending its retry history", async () => {
		const directory = mkdtempSync(
			join(tmpdir(), "whalehall-timeline-v2-abandon-"),
		);
		temporaryDirectories.push(directory);
		const path = join(directory, "timeline-v2.sqlite3");
		const vault = new MemoryVault();
		const clock = new Clock();
		let repository = new SqliteTimelineV2Repository(
			path,
			vault,
			clock.nowMs.bind(clock),
		);
		const collector = new TimelineV2Collector({
			collectorId: "collector.timeline-v2.abandon",
			deviceId: "device-1",
			sessionId: "session-1",
			repository,
			hasher: new WebCryptoReflectionHasher(),
			clock,
			effectiveEventThreshold: 2,
		});
		await collector.recover();
		await collector.ingest(
			semantic(1, 100_000, "application.foregroundChanged"),
		);
		const window = await collector.ingest(
			semantic(2, 100_010, "application.textValueChanged"),
		);
		const firstAttemptAtMs = clock.nowMs();
		await repository.claimNextWindow(firstAttemptAtMs, 1_000);
		await repository.recordWindowFailure(window!.windowId, {
			nowMs: firstAttemptAtMs,
			code: "PRIOR_TRANSIENT",
			message: "historical failure",
			nextAttemptAtMs: firstAttemptAtMs,
			terminal: false,
		});
		clock.set(firstAttemptAtMs + 24 * 60 * 60 * 1_000 + 1);
		expect(
			await repository.claimNextWindow(clock.nowMs(), 1_000),
		).toMatchObject({ state: "RUNNING", attempt: 2 });
		await repository.abandonWindowClaim(window!.windowId, clock.nowMs());
		repository.close();

		repository = new SqliteTimelineV2Repository(
			path,
			vault,
			clock.nowMs.bind(clock),
		);
		expect(await repository.getJob(window!.windowId)).toMatchObject({
			state: "READY",
			attempt: 1,
			firstAttemptAtMs,
			failureCode: "PRIOR_TRANSIENT",
			failureMessage: "historical failure",
			leaseExpiresAtMs: null,
		});
		expect(
			await repository.claimNextWindow(clock.nowMs(), 1_000),
		).toMatchObject({
			state: "RUNNING",
			attempt: 2,
			firstAttemptAtMs,
			failureCode: "PRIOR_TRANSIENT",
			failureMessage: "historical failure",
		});
		repository.close();
	});

	test("keeps redacted raw lineage exportable when production-derived vault data is unavailable", async () => {
		const event = semantic(1, 1_000, "application.foregroundChanged");
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
});
