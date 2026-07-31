import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/agent/reflection/hash";
import {
	PrivateTrainingWindowExporter,
	type ActivityEpisodeV2,
	type EvidenceFactV2,
	type PersistTimelineResult,
	type RawFiveMinuteAuditSource,
	type SemanticEventV2,
	type TimelineJobV2,
	type TimelineSummaryV2,
	type TimelineWindowV2,
} from "../src/agent/timeline-v2";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
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
		const exported = await exporter.exportToNewDirectory({
			directory: target,
			windowIds: [value.window.windowId],
			participantId: "participant-1",
			sessionTimezone: "Asia/Shanghai",
			includeDecryptedContent: true,
		});

		expect(statSync(target).mode & 0o777).toBe(0o700);
		expect(statSync(exported.manifestPath).mode & 0o777).toBe(0o600);
		expect(statSync(exported.recordsPath).mode & 0o777).toBe(0o600);
		expect(exported.manifest.trainingEligible).toBeTrue();
		expect(exported.manifest.sourceWindows[0]?.inputHash).toBe(
			value.window.inputHash,
		);
		expect(exported.manifest.overlapGroups).toHaveLength(1);
		const line = readFileSync(exported.recordsPath, "utf8").trim();
		const record = JSON.parse(line);
		expect(record.authority.job.state).toBe("COMMITTED");
		expect(record.goalSnapshot).toEqual(value.window.goal);
		expect(record.rawObservations).toHaveLength(1);
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
		expect(readFileSync(exported.recordsPath, "utf8")).not.toContain(
			"PRIVATE EDITOR TEXT",
		);
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
