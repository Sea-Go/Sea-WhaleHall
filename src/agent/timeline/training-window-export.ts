import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalJson } from "../reflection/hash";
import type { RawFiveMinuteAuditSource } from "./audit";
import type {
	PersistTimelineResult,
	TimelineV2Repository,
} from "./repository";
import {
	AGENT_INPUT_SCHEMA_VERSION,
	type ActivityEpisodeV2,
	type AgentInputV1,
	type CoverageLevel,
	type EvidenceFactV2,
	type JsonValue,
	type SemanticEventV2,
	type TimelineJobV2,
	type TimelineSegmentV2,
	type TimelineSummaryV2,
	type TimelineWindowV2,
} from "./types";

export const PRIVATE_TRAINING_EXPORT_SCHEMA_VERSION =
	"private-training-window-export.v1" as const;
export const PRIVATE_TRAINING_MANIFEST_SCHEMA_VERSION =
	"private-training-window-manifest.v1" as const;
export const PRIVATE_TRAINING_RECORDS_FILENAME =
	"committed-timeline-windows.v1.jsonl" as const;
export const PRIVATE_TRAINING_MANIFEST_FILENAME = "manifest.json" as const;

const RAW_QUERY_DURATION_MS = 5 * 60 * 1000;
const MAX_EXPORT_WINDOWS = 10_000;
const MAX_EXPORT_RECORD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EXPORT_RECORD_LINE_BYTES = 64 * 1024 * 1024;
const STALE_STAGING_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRIVATE_TRAINING_STAGING_PATTERN =
	/^\.whalehall-private-training-export-([0-9]{1,16})-([A-Za-z0-9_-]{8,128})\.tmp$/u;

export type TrainingWindowLineageV1 = {
	observationId: string;
	eventId: string;
	factIds: string[];
	episodeRevisionIds: string[];
	timelineId: string | null;
	scope: "window" | "context";
};

export type PrivateTrainingWindowAuthorityV1 = {
	windowId: string;
	job: TimelineJobV2 & { state: "COMMITTED" };
	inputHash: string;
	recomputedInputHash: string;
	goalSnapshotHash: string;
	eventSetHash: string;
	factSetHash: string;
	episodeSetHash: string;
	summaryHash: string;
	rawObservationSetHash: string;
	lineageHash: string;
	modelVersions: string[];
	taxonomyVersion: string;
	projectorVersion: string;
};

/**
 * Legacy v1 records contain plain ActivityEpisodeV2 revisions. A continued
 * Episode cannot be exported as that immutable revision without also leaking
 * facts from earlier windows, so only that case is represented as an explicit
 * current-window slice. The optional field keeps existing v1 packages and the
 * current importer backward compatible.
 */
export type PrivateTrainingEpisodeV1 = ActivityEpisodeV2 & {
	exportSlice?: {
		schemaVersion: "private-training-episode-slice.v1";
		scope: "current_window";
		sourceEpisodeRevisionId: string;
		sourceEpisodeHash: string;
		continuesFromEpisodeRevisionId: string | null;
		sourcePeriod: { startedAtMs: number; endedAtMs: number };
	};
};

export type PrivateTrainingTimelineSegmentV1 = TimelineSegmentV2 & {
	exportSlice?: {
		schemaVersion: "private-training-timeline-segment-slice.v1";
		sourceEpisodeRevisionId: string;
		sourceEpisodeHash: string;
	};
};

export type PrivateTrainingTimelineSummaryV1 = Omit<
	TimelineSummaryV2,
	"segments"
> & {
	segments: PrivateTrainingTimelineSegmentV1[];
	exportSlice?: {
		schemaVersion: "private-training-timeline-slice.v1";
		scope: "current_window";
		sourceTimelineId: string;
		sourceTimelineHash: string;
		sourcePeriod: { startedAtMs: number; endedAtMs: number };
	};
};

export type PrivateTrainingWindowRecordV1 = {
	schemaVersion: typeof PRIVATE_TRAINING_EXPORT_SCHEMA_VERSION;
	contentMode: "decrypted" | "redacted";
	window: TimelineWindowV2;
	goalSnapshot: TimelineWindowV2["goal"];
	rawObservations: Array<Record<string, JsonValue>>;
	semanticEvents: SemanticEventV2[];
	contextOnly: SemanticEventV2[];
	evidenceFacts: EvidenceFactV2[];
	episodes: PrivateTrainingEpisodeV1[];
	timelineSummary: PrivateTrainingTimelineSummaryV1;
	lineage: TrainingWindowLineageV1[];
	authority: PrivateTrainingWindowAuthorityV1;
};

export type PrivateTrainingWindowManifestV1 = {
	schemaVersion: typeof PRIVATE_TRAINING_MANIFEST_SCHEMA_VERSION;
	exportId: string;
	exportedAtMs: number;
	localOnly: true;
	explicitUserOperation: true;
	contentMode: "decrypted" | "redacted";
	trainingEligible: boolean;
	ineligibilityReasons: string[];
	windowCount: number;
	participantId: string;
	sessionTimezone: string;
	files: {
		records: {
			relativePath: typeof PRIVATE_TRAINING_RECORDS_FILENAME;
			sha256: string;
			byteLength: number;
			rowCount: number;
		};
	};
	sourceWindows: Array<{
		windowId: string;
		inputHash: string;
		recordSha256: string;
		goalSnapshotHash: string;
		eventSetHash: string;
		factSetHash: string;
		episodeSetHash: string;
		summaryHash: string;
		rawObservationSetHash: string;
		lineageHash: string;
		jobUpdatedAtMs: number;
	}>;
	overlapGroups: Array<{
		groupId: string;
		windowIds: string[];
		sharedIdentityHash: string;
	}>;
};

export type PrivateTrainingWindowExportResult = {
	directory: string;
	manifestPath: string;
	recordsPath: string;
	manifest: PrivateTrainingWindowManifestV1;
};

export class PrivateTrainingWindowExporter {
	constructor(
		private readonly raw: RawFiveMinuteAuditSource,
		private readonly repository: Pick<
			TimelineV2Repository,
			"getWindow" | "getJob" | "getTimelineResult"
		>,
		private readonly nowMs: () => number = Date.now,
		private readonly createId: () => string = randomUUID,
	) {}

	async exportToNewDirectory(options: {
		directory: string;
		windowIds: readonly string[];
		participantId: string;
		sessionTimezone: string;
		includeDecryptedContent?: boolean;
		onProgress?: (progress: {
			completedWindows: number;
			totalWindows: number;
		}) => void;
	}): Promise<PrivateTrainingWindowExportResult> {
		assertExportOptions(options);
		if (existsSync(options.directory)) {
			throw new Error("Private training export directory must not already exist.");
		}
		const parent = dirname(options.directory);
		if (!statSync(parent).isDirectory()) {
			throw new Error("Private training export parent must be a directory.");
		}

		const includeDecryptedContent = options.includeDecryptedContent ?? false;
		const sortedWindowIds = [...options.windowIds].sort(compareText);
		const exportId = safeExportId(this.createId());
		const exportedAtMs = this.nowMs();
		if (!Number.isSafeInteger(exportedAtMs) || exportedAtMs < 0) {
			throw new Error("Private training export time is invalid.");
		}
		const temporaryDirectory = join(
			parent,
			`.whalehall-private-training-export-${exportedAtMs}-${exportId}.tmp`,
		);
		if (existsSync(temporaryDirectory)) {
			throw new Error("Private training export staging directory already exists.");
		}
		cleanupStaleStagingDirectories(
			parent,
			exportedAtMs,
			new Set([temporaryDirectory]),
		);
		let manifest: PrivateTrainingWindowManifestV1;
		let stagingCreated = false;
		let published = false;
		try {
			mkdirSync(temporaryDirectory, { mode: 0o700 });
			stagingCreated = true;
			const recordsPath = join(
				temporaryDirectory,
				PRIVATE_TRAINING_RECORDS_FILENAME,
			);
			const recordsHash = createHash("sha256");
			let recordsByteLength = 0;
			const sourceWindows: PrivateTrainingWindowManifestV1["sourceWindows"] = [];
			const overlapInputs: OverlapInput[] = [];
			const recordsDescriptor = openSync(recordsPath, "wx", 0o600);
			try {
				for (let index = 0; index < sortedWindowIds.length; index += 1) {
					const record = await this.buildRecord(
						sortedWindowIds[index]!,
						includeDecryptedContent,
					);
					const encodedLine = canonicalJson(record);
					const encodedBytes = Buffer.from(`${encodedLine}\n`, "utf8");
					if (encodedBytes.byteLength - 1 > MAX_EXPORT_RECORD_LINE_BYTES) {
						throw new Error(
							"Private training export record exceeds the per-window size limit.",
						);
					}
					if (
						recordsByteLength + encodedBytes.byteLength >
						MAX_EXPORT_RECORD_BYTES
					) {
						throw new Error("Private training export exceeds the size limit.");
					}
					writeAll(recordsDescriptor, encodedBytes);
					recordsHash.update(encodedBytes);
					recordsByteLength += encodedBytes.byteLength;
					sourceWindows.push(sourceWindowEntry(record, encodedLine));
					overlapInputs.push(overlapInput(record));
					options.onProgress?.({
						completedWindows: index + 1,
						totalWindows: sortedWindowIds.length,
					});
				}
				fsyncSync(recordsDescriptor);
			} finally {
				closeSync(recordsDescriptor);
			}
			manifest = {
				schemaVersion: PRIVATE_TRAINING_MANIFEST_SCHEMA_VERSION,
				exportId,
				exportedAtMs,
				localOnly: true,
				explicitUserOperation: true,
				contentMode: includeDecryptedContent ? "decrypted" : "redacted",
				trainingEligible: includeDecryptedContent,
				ineligibilityReasons: includeDecryptedContent
					? []
					: ["decrypted_content_not_included"],
				windowCount: sortedWindowIds.length,
				participantId: options.participantId,
				sessionTimezone: options.sessionTimezone,
				files: {
					records: {
						relativePath: PRIVATE_TRAINING_RECORDS_FILENAME,
						sha256: recordsHash.digest("hex"),
						byteLength: recordsByteLength,
						rowCount: sortedWindowIds.length,
					},
				},
				sourceWindows,
				overlapGroups: buildOverlapGroups(overlapInputs),
			};
			const manifestPath = join(
				temporaryDirectory,
				PRIVATE_TRAINING_MANIFEST_FILENAME,
			);
			writePrivateFile(
				manifestPath,
				Buffer.from(
					`${JSON.stringify(manifest, null, 2)}\n`,
					"utf8",
				),
			);
			fsyncDirectory(temporaryDirectory);
			renameSync(temporaryDirectory, options.directory);
			published = true;
			fsyncDirectory(parent);
		} catch (error) {
			if (stagingCreated && !published) {
				tryRemoveStagingDirectory(temporaryDirectory, currentEffectiveUserId());
				try {
					fsyncDirectory(parent);
				} catch {
					// Preserve the original export failure. A strictly named residue can
					// be reclaimed by a later export after the stale-age boundary.
				}
			}
			throw error;
		}
		return {
			directory: options.directory,
			manifestPath: join(
				options.directory,
				PRIVATE_TRAINING_MANIFEST_FILENAME,
			),
			recordsPath: join(
				options.directory,
				PRIVATE_TRAINING_RECORDS_FILENAME,
			),
			manifest,
		};
	}

	private async buildRecord(
		windowId: string,
		includeDecryptedContent: boolean,
	): Promise<PrivateTrainingWindowRecordV1> {
		const [window, job, result] = await Promise.all([
			this.repository.getWindow(windowId),
			this.repository.getJob(windowId),
			this.repository.getTimelineResult(windowId),
		]);
		if (window === null) {
			throw new Error(`Unknown or expired Timeline window: ${windowId}.`);
		}
		if (job?.state !== "COMMITTED") {
			throw new Error(`Timeline window ${windowId} is not COMMITTED.`);
		}
		if (result === null) {
			throw new Error(
				`COMMITTED Timeline window ${windowId} has no persisted result.`,
			);
		}
		const exportResult = await this.prepareResultForExport(window, result);
		const recomputedInputHash = sha256(
			canonicalJson({
				goal: window.goal,
				events: window.events,
				contextOnly: window.contextOnly,
			}),
		);
		if (recomputedInputHash !== window.inputHash) {
			throw new Error(`Timeline window ${windowId} inputHash is invalid.`);
		}

		const allEvents = [...window.events, ...window.contextOnly];
		const linkedObservationIds = new Set(
			allEvents.flatMap((event) => event.sourceObservationIds),
		);
		const raw = await this.readRawLineage(
			allEvents,
			linkedObservationIds,
			includeDecryptedContent,
		);
		const rawById = new Map(
			raw.map((observation) => [
				String(observation.observationId),
				observation,
			]),
		);
		const missingObservations = [...linkedObservationIds].filter(
			(observationId) => !rawById.has(observationId),
		);
		if (missingObservations.length > 0) {
			throw new Error(
				`Timeline window ${windowId} is missing raw lineage for ${missingObservations.length} observation(s).`,
			);
		}

		const lineage = buildLineage(window, exportResult, linkedObservationIds);
		const modelVersions = [...new Set(exportResult.summary.modelVersions)].sort(
			compareText,
		);
		if (modelVersions.length === 0) {
			throw new Error(`Timeline window ${windowId} has no model version.`);
		}
		const authority: PrivateTrainingWindowAuthorityV1 = {
			windowId,
			job: structuredClone(job) as TimelineJobV2 & {
				state: "COMMITTED";
			},
			inputHash: window.inputHash,
			recomputedInputHash,
			goalSnapshotHash: sha256(canonicalJson(window.goal)),
			eventSetHash: hashOrdered(window.events),
			factSetHash: hashOrdered(exportResult.facts),
			episodeSetHash: hashOrdered(exportResult.episodes),
			summaryHash: sha256(canonicalJson(exportResult.summary)),
			rawObservationSetHash: hashOrdered(
				[...rawById.values()].sort(compareObservation),
			),
			lineageHash: hashOrdered(lineage),
			modelVersions,
			taxonomyVersion: exportResult.summary.taxonomyVersion,
			projectorVersion: exportResult.summary.projectorVersion,
		};
		const record: PrivateTrainingWindowRecordV1 = {
			schemaVersion: PRIVATE_TRAINING_EXPORT_SCHEMA_VERSION,
			contentMode: includeDecryptedContent ? "decrypted" : "redacted",
			window: structuredClone(window),
			goalSnapshot: structuredClone(window.goal),
			rawObservations: [...rawById.values()].sort(compareObservation),
			semanticEvents: structuredClone(window.events),
			contextOnly: structuredClone(window.contextOnly),
			evidenceFacts: structuredClone(exportResult.facts),
			episodes: structuredClone(exportResult.episodes),
			timelineSummary: structuredClone(exportResult.summary),
			lineage,
			authority,
		};
		return includeDecryptedContent ? record : redactRecord(record);
	}

	private async prepareResultForExport(
		window: TimelineWindowV2,
		result: PersistTimelineResult,
	): Promise<PersistTimelineResult> {
		const currentFactIds = new Set(result.facts.map((fact) => fact.factId));
		const isWindowLocal = result.episodes.every(
			(episode) =>
				episode.sourceWindowIds.length === 1 &&
				episode.sourceWindowIds[0] === window.windowId &&
				episode.supersedesRevisionId === null &&
				[
					...episode.evidenceFactIds,
					...episode.supportingFactIds,
				].every((factId) => currentFactIds.has(factId)),
		);
		if (isWindowLocal) {
			// Preserve byte-for-byte v1 behavior for ordinary single-window
			// Episodes. Only cross-window continuation revisions need a slice.
			assertPersistedResult(window, result);
			return result;
		}

		const completeFacts = await this.loadCompleteFactClosure(window, result);
		assertPersistedResult(window, result, completeFacts);
		const projected = projectResultToCurrentWindow(window, result);
		assertPersistedResult(window, projected);
		return projected;
	}

	private async loadCompleteFactClosure(
		window: TimelineWindowV2,
		result: PersistTimelineResult,
	): Promise<EvidenceFactV2[]> {
		const sourceWindowIds = new Set(
			result.episodes.flatMap((episode) => episode.sourceWindowIds),
		);
		if (!sourceWindowIds.has(window.windowId)) {
			throw new Error(
				`Timeline result ${window.windowId} has no current-window Episode source.`,
			);
		}
		const facts = new Map<string, EvidenceFactV2>();
		const factOwners = new Map<string, string>();
		const sourceResults = new Map<string, PersistTimelineResult>();
		for (const sourceWindowId of [...sourceWindowIds].sort(compareText)) {
			const [sourceWindow, sourceJob, sourceResult] =
				sourceWindowId === window.windowId
					? [window, await this.repository.getJob(sourceWindowId), result]
					: await Promise.all([
							this.repository.getWindow(sourceWindowId),
							this.repository.getJob(sourceWindowId),
							this.repository.getTimelineResult(sourceWindowId),
						]);
			if (
				sourceWindow === null ||
				sourceJob?.state !== "COMMITTED" ||
				sourceResult === null
			) {
				throw new Error(
					`Episode history for ${window.windowId} is not fully COMMITTED and available.`,
				);
			}
			if (
				sourceWindow.windowId !== sourceWindowId ||
				sourceJob.windowId !== sourceWindowId ||
				sourceResult.windowId !== sourceWindowId ||
				sourceWindow.deviceId !== window.deviceId ||
				sourceWindow.sessionId !== window.sessionId ||
				sourceWindow.goalVersion !== window.goalVersion
			) {
				throw new Error(
					`Episode history for ${window.windowId} crosses a window, device, session, or goal authority boundary.`,
				);
			}
			assertWindowFacts(sourceWindow, sourceResult);
			assertAgentInputMatchesResult(sourceWindow, sourceResult);
			sourceResults.set(sourceWindowId, sourceResult);
			for (const fact of sourceResult.facts) {
				const owner = factOwners.get(fact.factId);
				if (owner !== undefined && owner !== sourceWindowId) {
					throw new Error(
						`Fact ${fact.factId} belongs to more than one Timeline window.`,
					);
				}
				factOwners.set(fact.factId, sourceWindowId);
				facts.set(fact.factId, fact);
			}
		}
		assertEpisodeRevisionClosure(window, result, sourceResults);
		return [...facts.values()].sort(compareFacts);
	}

	private async readRawLineage(
		events: readonly SemanticEventV2[],
		linkedObservationIds: ReadonlySet<string>,
		includeDecryptedContent: boolean,
	): Promise<Array<Record<string, JsonValue>>> {
		if (events.length === 0) return [];
		const earliestMs = events.reduce(
			(value, event) => Math.min(value, event.occurredAtMs),
			events[0]!.occurredAtMs,
		);
		const latestMs = events.reduce(
			(value, event) =>
				Math.max(value, event.occurredAtMs, event.observedAtMs),
			earliestMs,
		);
		const observations = new Map<string, Record<string, JsonValue>>();
		for (
			let fromMs = earliestMs;
			fromMs <= latestMs;
			fromMs += RAW_QUERY_DURATION_MS
		) {
			const queried = await this.raw.queryAuditRange({
				fromMs,
				toMs: fromMs + RAW_QUERY_DURATION_MS,
				includeDecryptedContent,
			});
			for (const candidate of queried.rawObservations) {
				const observation = asRawObservation(candidate);
				if (observation === null) continue;
				const observationId = String(observation.observationId);
				if (!linkedObservationIds.has(observationId)) continue;
				assertNoPersistedPixels(observation);
				const existing = observations.get(observationId);
				if (
					existing !== undefined &&
					canonicalJson(existing) !== canonicalJson(observation)
				) {
					throw new Error(
						`Raw observation ${observationId} changed during export.`,
					);
				}
				observations.set(observationId, observation);
			}
		}
		return [...observations.values()];
	}
}

function projectResultToCurrentWindow(
	window: TimelineWindowV2,
	result: PersistTimelineResult,
): PersistTimelineResult {
	const factById = new Map(
		result.facts.map((fact) => [fact.factId, fact] as const),
	);
	const sourceRevisionByExportRevision = new Map<string, string>();
	const sourceHashByExportRevision = new Map<string, string>();
	const episodes: PrivateTrainingEpisodeV1[] = result.episodes.map(
		(sourceEpisode) => {
			const evidenceFactIds = sourceEpisode.evidenceFactIds.filter((factId) =>
				factById.has(factId),
			);
			const supportingFactIds = sourceEpisode.supportingFactIds.filter(
				(factId) => factById.has(factId),
			);
			const allFactIds = [...evidenceFactIds, ...supportingFactIds];
			if (evidenceFactIds.length === 0) {
				throw new Error(
					`Episode revision ${sourceEpisode.revisionId} has no current-window evidence to slice.`,
				);
			}
			const facts = allFactIds.map((factId) => factById.get(factId)!);
			const period = factPeriod(facts);
			const revisionId = `private_training_episode_slice_${sha256(
				canonicalJson({
					schemaVersion: "private-training-episode-slice.v1",
					windowId: window.windowId,
					sourceEpisodeRevisionId: sourceEpisode.revisionId,
					evidenceFactIds,
					supportingFactIds,
				}),
			)}`;
			sourceRevisionByExportRevision.set(
				revisionId,
				sourceEpisode.revisionId,
			);
			const sourceEpisodeHash = sha256(canonicalJson(sourceEpisode));
			sourceHashByExportRevision.set(revisionId, sourceEpisodeHash);
			return {
				...structuredClone(sourceEpisode),
				revisionId,
				revision: 1,
				supersedesRevisionId: null,
				sourceWindowIds: [window.windowId],
				startedAtMs: period.startedAtMs,
				endedAtMs: period.endedAtMs,
				hypothesis: currentWindowHypothesis(sourceEpisode, evidenceFactIds[0]!),
				evidenceFactIds,
				supportingFactIds,
				coverage: mergeFactCoverage(facts),
				exportSlice: {
					schemaVersion: "private-training-episode-slice.v1",
					scope: "current_window",
					sourceEpisodeRevisionId: sourceEpisode.revisionId,
					sourceEpisodeHash,
					continuesFromEpisodeRevisionId:
						sourceEpisode.supersedesRevisionId,
					sourcePeriod: {
						startedAtMs: sourceEpisode.startedAtMs,
						endedAtMs: sourceEpisode.endedAtMs,
					},
				},
			};
		},
	);
	const segments: PrivateTrainingTimelineSegmentV1[] = episodes.map(
		(episode) => {
			const evidence = [
				...episode.evidenceFactIds,
				...episode.supportingFactIds,
			].map((factId) => factById.get(factId)!);
			const sourceEpisodeRevisionId =
				sourceRevisionByExportRevision.get(episode.revisionId) ??
				episode.revisionId;
			const sourceEpisodeHash =
				sourceHashByExportRevision.get(episode.revisionId) ??
				sha256(canonicalJson(episode));
			return {
				episodeId: episode.episodeId,
				episodeRevisionId: episode.revisionId,
				startedAtMs: episode.startedAtMs,
				endedAtMs: episode.endedAtMs,
				activity: episode.classification.abstain
					? "other_unknown"
					: episode.classification.activity,
				goalRelevance:
					window.goal === null
						? null
						: episode.classification.abstain
							? "uncertain"
							: episode.classification.goalRelevance,
				classification: structuredClone(episode.classification),
				hypothesis: structuredClone(episode.hypothesis),
				evidence: structuredClone(evidence),
				exportSlice: {
					schemaVersion:
						"private-training-timeline-segment-slice.v1",
					sourceEpisodeRevisionId,
					sourceEpisodeHash,
				},
			};
		},
	);
	if (segments.length === 0) {
		throw new Error(
			`Timeline result ${window.windowId} has no current-window Episode slice.`,
		);
	}
	const period = {
		startedAtMs: Math.min(...segments.map((segment) => segment.startedAtMs)),
		endedAtMs: Math.max(...segments.map((segment) => segment.endedAtMs)),
	};
	const coverage = mergeFactCoverage(result.facts);
	const timelineId = `private_training_timeline_slice_${sha256(
		canonicalJson({
			schemaVersion: "private-training-timeline-slice.v1",
			windowId: window.windowId,
			sourceTimelineId: result.summary.timelineId,
			episodeRevisionIds: episodes.map((episode) => episode.revisionId),
		}),
	)}`;
	const summary: PrivateTrainingTimelineSummaryV1 = {
		...structuredClone(result.summary),
		timelineId,
		period,
		segments,
		coverage,
		coverageWarnings: currentWindowCoverageWarnings(coverage),
		renderedText: renderCurrentWindowTimeline(segments),
		modelVersions: [
			...new Set([
				...result.summary.modelVersions.filter(
					(version) => !version.startsWith("hypothesis:"),
				),
				"hypothesis:deterministic-template.v2",
			]),
		],
		revision: 1,
		correctsTimelineId: null,
		exportSlice: {
			schemaVersion: "private-training-timeline-slice.v1",
			scope: "current_window",
			sourceTimelineId: result.summary.timelineId,
			sourceTimelineHash: sha256(canonicalJson(result.summary)),
			sourcePeriod: structuredClone(result.summary.period),
		},
	};
	const agentInput = projectAgentInput(window, summary);
	return {
		windowId: window.windowId,
		facts: structuredClone(result.facts),
		episodes,
		summary,
		agentInput,
	};
}

function currentWindowHypothesis(
	episode: ActivityEpisodeV2,
	citedFactId: string,
): ActivityEpisodeV2["hypothesis"] {
	return {
		text: episode.classification.abstain
			? "可能在进行当前可见操作（活动类型暂不确定）"
			: "可能在进行当前可见操作",
		citedFactIds: [citedFactId],
		generator: "deterministic-template.v2",
	};
}

function projectAgentInput(
	window: TimelineWindowV2,
	summary: PrivateTrainingTimelineSummaryV1,
): AgentInputV1 {
	const payload = {
		schemaVersion: AGENT_INPUT_SCHEMA_VERSION,
		timelineId: summary.timelineId,
		windowId: window.windowId,
		triggerReason: window.triggerReason,
		triggeredAtMs: summary.triggeredAtMs,
		deadlineAtMs: summary.deadlineAtMs,
		period: summary.period,
		goal: window.goal,
		segments: summary.segments,
		renderedText: summary.renderedText,
		coverage: summary.coverage,
		modelVersions: summary.modelVersions,
		inferenceDiagnostics: summary.inferenceDiagnostics,
		taxonomyVersion: summary.taxonomyVersion,
		projectorVersion: summary.projectorVersion,
		createdAtMs: summary.createdAtMs,
	};
	const agentInputId = `private_training_agent_input_${sha256(
		canonicalJson(payload),
	)}`;
	return {
		...payload,
		agentInputId,
		idempotencyKey: agentInputId,
		payloadHash: sha256(canonicalJson(payload)),
	};
}

function factPeriod(facts: readonly EvidenceFactV2[]): {
	startedAtMs: number;
	endedAtMs: number;
} {
	return {
		startedAtMs: Math.min(...facts.map((fact) => fact.startedAtMs)),
		endedAtMs: Math.max(...facts.map((fact) => fact.endedAtMs)),
	};
}

function compareFacts(left: EvidenceFactV2, right: EvidenceFactV2): number {
	return (
		left.startedAtMs - right.startedAtMs ||
		left.endedAtMs - right.endedAtMs ||
		compareText(left.factId, right.factId)
	);
}

function mergeFactCoverage(
	facts: readonly EvidenceFactV2[],
): CoverageLevel[] {
	return [...new Set(facts.flatMap((fact) => fact.coverage))].sort(compareText);
}

function currentWindowCoverageWarnings(
	coverage: readonly CoverageLevel[],
): string[] {
	const warnings: string[] = [];
	if (coverage.includes("redacted")) warnings.push("部分敏感内容已主动遮蔽");
	if (coverage.includes("denied")) {
		warnings.push("部分应用或内容因授权策略未采集");
	}
	if (coverage.includes("unavailable")) {
		warnings.push("部分可见内容在采集或解密时不可用");
	}
	if (!coverage.includes("content")) {
		warnings.push("本时间段只有元数据，活动判断应视为低置信");
	}
	return warnings;
}

function renderCurrentWindowTimeline(
	segments: readonly PrivateTrainingTimelineSegmentV1[],
): string {
	const lines: string[] = [];
	for (const segment of segments) {
		lines.push(
			`- ${segment.startedAtMs}–${segment.endedAtMs}，${segment.hypothesis.text}`,
		);
		for (const fact of segment.evidence) {
			lines.push(`  - ${fact.startedAtMs} ${fact.renderedText}`);
		}
	}
	return lines.join("\n");
}

function assertEpisodeRevisionClosure(
	window: TimelineWindowV2,
	result: PersistTimelineResult,
	sourceResults: ReadonlyMap<string, PersistTimelineResult>,
): void {
	const revisions = new Map<
		string,
		{ ownerWindowId: string; episode: ActivityEpisodeV2 }
	>();
	for (const [ownerWindowId, sourceResult] of sourceResults) {
		for (const episode of sourceResult.episodes) {
			const existing = revisions.get(episode.revisionId);
			if (
				existing !== undefined &&
				(existing.ownerWindowId !== ownerWindowId ||
					canonicalJson(existing.episode) !== canonicalJson(episode))
			) {
				throw new Error(
					`Episode revision ${episode.revisionId} has conflicting owners or payloads.`,
				);
			}
			revisions.set(episode.revisionId, { ownerWindowId, episode });
		}
	}

	for (const sourceEpisode of result.episodes) {
		let episode = sourceEpisode;
		let sourceIndex = sourceEpisode.sourceWindowIds.length - 1;
		const visited = new Set<string>();
		for (;;) {
			if (visited.has(episode.revisionId)) {
				throw new Error(
					`Episode revision ${sourceEpisode.revisionId} has a cyclic supersedes chain.`,
				);
			}
			visited.add(episode.revisionId);
			const indexed = revisions.get(episode.revisionId);
			const expectedOwner = sourceEpisode.sourceWindowIds[sourceIndex];
			if (
				indexed === undefined ||
				indexed.ownerWindowId !== expectedOwner ||
				episode.sourceWindowIds.at(-1) !== expectedOwner
			) {
				throw new Error(
					`Episode revision ${sourceEpisode.revisionId} has an incomplete source-window closure.`,
				);
			}
			if (episode.supersedesRevisionId === null) {
				if (
					episode.revision !== 1 ||
					sourceIndex !== 0 ||
					episode.sourceWindowIds.length !== 1
				) {
					throw new Error(
						`Episode revision ${sourceEpisode.revisionId} has an invalid revision root.`,
					);
				}
				break;
			}
			const previous = revisions.get(episode.supersedesRevisionId);
			if (
				previous === undefined ||
				previous.episode.episodeId !== episode.episodeId ||
				previous.episode.revision + 1 !== episode.revision ||
				previous.episode.goalVersion !== episode.goalVersion ||
				previous.episode.endedAtMs > episode.endedAtMs ||
				canonicalJson(previous.episode.sourceWindowIds) !==
					canonicalJson(episode.sourceWindowIds.slice(0, -1))
			) {
				throw new Error(
					`Episode revision ${sourceEpisode.revisionId} has an invalid supersedes chain.`,
				);
			}
			episode = previous.episode;
			sourceIndex -= 1;
			if (sourceIndex < 0) {
				throw new Error(
					`Episode revision ${sourceEpisode.revisionId} exceeds its source-window chain.`,
				);
			}
		}
	}

	if (!sourceResults.has(window.windowId)) {
		throw new Error(
			`Timeline result ${window.windowId} is missing its current source result.`,
		);
	}
}

function assertPersistedResult(
	window: TimelineWindowV2,
	result: PersistTimelineResult,
	availableFacts: readonly EvidenceFactV2[] = result.facts,
): void {
	assertWindowFacts(window, result);
	if (
		new Set(availableFacts.map((fact) => fact.factId)).size !==
		availableFacts.length
	) {
		throw new Error(
			`Timeline result ${window.windowId} fact closure contains duplicate identities.`,
		);
	}
	assertUniqueIdentifiers(
		result.episodes.map((episode) => episode.revisionId),
		`Timeline result ${window.windowId} episode revisions`,
	);
	const factById = new Map(
		availableFacts.map((fact) => [fact.factId, fact] as const),
	);
	const episodeByRevision = new Map(
		result.episodes.map((episode) => [episode.revisionId, episode] as const),
	);
	for (const episode of result.episodes) {
		assertUniqueIdentifiers(
			episode.sourceWindowIds,
			`Episode revision ${episode.revisionId} source windows`,
		);
		assertUniqueIdentifiers(
			episode.evidenceFactIds,
			`Episode revision ${episode.revisionId} evidence facts`,
		);
		assertUniqueIdentifiers(
			episode.supportingFactIds,
			`Episode revision ${episode.revisionId} supporting facts`,
		);
		assertUniqueIdentifiers(
			episode.hypothesis.citedFactIds,
			`Episode revision ${episode.revisionId} cited facts`,
		);
		const episodeFactIds = [
			...episode.evidenceFactIds,
			...episode.supportingFactIds,
		];
		if (
			episode.sourceWindowIds.at(-1) !== window.windowId ||
			episode.evidenceFactIds.length === 0 ||
			new Set(episodeFactIds).size !== episodeFactIds.length ||
			episodeFactIds.some((factId) => !factById.has(factId)) ||
			episode.hypothesis.citedFactIds.some(
				(factId) => !episodeFactIds.includes(factId),
			)
		) {
			throw new Error(
				`Episode revision ${episode.revisionId} has invalid lineage.`,
			);
		}
	}
	assertSummaryMatchesResult(window, result, factById, episodeByRevision);
	assertAgentInputMatchesResult(window, result);
}

function assertWindowFacts(
	window: TimelineWindowV2,
	result: PersistTimelineResult,
): void {
	if (
		result.windowId !== window.windowId ||
		result.summary.windowId !== window.windowId
	) {
		throw new Error(`Timeline result does not belong to ${window.windowId}.`);
	}
	const recomputedInputHash = sha256(
		canonicalJson({
			goal: window.goal,
			events: window.events,
			contextOnly: window.contextOnly,
		}),
	);
	if (recomputedInputHash !== window.inputHash) {
		throw new Error(`Timeline window ${window.windowId} inputHash is invalid.`);
	}
	const windowEventById = new Map(
		window.events.map((event) => [event.eventId, event] as const),
	);
	const contextEventIds = new Set(
		window.contextOnly.map((event) => event.eventId),
	);
	assertUniqueIdentifiers(
		window.events.map((event) => event.eventId),
		`Timeline window ${window.windowId} events`,
	);
	assertUniqueIdentifiers(
		window.contextOnly.map((event) => event.eventId),
		`Timeline window ${window.windowId} context events`,
	);
	if (window.events.some((event) => contextEventIds.has(event.eventId))) {
		throw new Error(
			`Timeline window ${window.windowId} repeats an event across window and context.`,
		);
	}
	for (const event of [...window.events, ...window.contextOnly]) {
		assertUniqueIdentifiers(
			event.sourceObservationIds,
			`Semantic event ${event.eventId} source observations`,
		);
		if (event.sourceObservationIds.length === 0) {
			throw new Error(
				`Semantic event ${event.eventId} has no raw observation lineage.`,
			);
		}
	}
	assertUniqueIdentifiers(
		result.facts.map((fact) => fact.factId),
		`Timeline result ${window.windowId} facts`,
	);
	for (const fact of result.facts) {
		assertUniqueIdentifiers(
			fact.eventIds,
			`Fact ${fact.factId} source events`,
		);
		assertUniqueIdentifiers(
			fact.sourceObservationIds,
			`Fact ${fact.factId} source observations`,
		);
		if (fact.eventIds.length === 0) {
			throw new Error(`Fact ${fact.factId} has invalid window lineage.`);
		}
		const sourceEvents = fact.eventIds.map((eventId) =>
			windowEventById.get(eventId),
		);
		if (sourceEvents.some((event) => event === undefined)) {
			throw new Error(`Fact ${fact.factId} has invalid window lineage.`);
		}
		const presentSourceEvents = sourceEvents.filter(
			(event): event is SemanticEventV2 => event !== undefined,
		);
		const expectedObservationIds = new Set(
			presentSourceEvents.flatMap((event) => event.sourceObservationIds),
		);
		if (!sameStringSet(fact.sourceObservationIds, expectedObservationIds)) {
			throw new Error(
				`Fact ${fact.factId} source observations are not the exact event union.`,
			);
		}
	}
}

function assertSummaryMatchesResult(
	window: TimelineWindowV2,
	result: PersistTimelineResult,
	factById: ReadonlyMap<string, EvidenceFactV2>,
	episodeByRevision: ReadonlyMap<string, ActivityEpisodeV2>,
): void {
	if (
		result.summary.triggerReason !== window.triggerReason ||
		result.summary.triggeredAtMs !== window.endedAtMs ||
		result.summary.deadlineAtMs !== window.deadlineAtMs ||
		result.summary.goalVersion !== window.goalVersion ||
		result.summary.segments.length !== result.episodes.length
	) {
		throw new Error(
			`Timeline summary does not match sealed window ${window.windowId}.`,
		);
	}
	assertUniqueIdentifiers(
		result.summary.segments.map((segment) => segment.episodeRevisionId),
		`Timeline summary ${result.summary.timelineId} episode revisions`,
	);
	for (let index = 0; index < result.summary.segments.length; index += 1) {
		const segment = result.summary.segments[index]!;
		const episode = episodeByRevision.get(segment.episodeRevisionId);
		const orderedFactIds =
			episode === undefined
				? []
				: [
						...new Set([
							...episode.evidenceFactIds,
							...episode.supportingFactIds,
						]),
					];
		const expectedEvidence = orderedFactIds.map((factId) =>
			factById.get(factId),
		);
		const expectedActivity =
			episode?.classification.abstain === true
				? "other_unknown"
				: episode?.classification.activity;
		const expectedRelevance =
			window.goal === null
				? null
				: episode?.classification.abstain === true
					? "uncertain"
					: episode?.classification.goalRelevance;
		if (
			episode === undefined ||
			result.episodes[index]?.revisionId !== episode.revisionId ||
			expectedEvidence.some(
				(fact): fact is undefined => fact === undefined,
			) ||
			segment.episodeId !== episode.episodeId ||
			segment.startedAtMs !== episode.startedAtMs ||
			segment.endedAtMs !== episode.endedAtMs ||
			segment.activity !== expectedActivity ||
			segment.goalRelevance !== expectedRelevance ||
			canonicalJson(segment.classification) !==
				canonicalJson(episode.classification) ||
			canonicalJson(segment.hypothesis) !==
				canonicalJson(episode.hypothesis) ||
			canonicalJson(segment.evidence) !==
				canonicalJson(expectedEvidence)
		) {
			throw new Error(
				`Timeline segment ${segment.episodeRevisionId} has invalid lineage.`,
			);
		}
	}
}

function assertAgentInputMatchesResult(
	window: TimelineWindowV2,
	result: PersistTimelineResult,
): void {
	const input = result.agentInput;
	const expectedPayload = {
		schemaVersion: AGENT_INPUT_SCHEMA_VERSION,
		timelineId: result.summary.timelineId,
		windowId: window.windowId,
		triggerReason: window.triggerReason,
		triggeredAtMs: result.summary.triggeredAtMs,
		deadlineAtMs: result.summary.deadlineAtMs,
		period: result.summary.period,
		goal: window.goal,
		segments: result.summary.segments,
		renderedText: result.summary.renderedText,
		coverage: result.summary.coverage,
		modelVersions: result.summary.modelVersions,
		inferenceDiagnostics: result.summary.inferenceDiagnostics,
		taxonomyVersion: result.summary.taxonomyVersion,
		projectorVersion: result.summary.projectorVersion,
		createdAtMs: result.summary.createdAtMs,
	};
	if (
		input.schemaVersion !== AGENT_INPUT_SCHEMA_VERSION ||
		input.agentInputId !== input.idempotencyKey ||
		input.timelineId !== result.summary.timelineId ||
		input.windowId !== window.windowId ||
		input.triggerReason !== window.triggerReason ||
		input.triggeredAtMs !== result.summary.triggeredAtMs ||
		input.deadlineAtMs !== result.summary.deadlineAtMs ||
		canonicalJson(input.period) !== canonicalJson(result.summary.period) ||
		canonicalJson(input.goal) !== canonicalJson(window.goal) ||
		canonicalJson(input.segments) !==
			canonicalJson(result.summary.segments) ||
		input.renderedText !== result.summary.renderedText ||
		canonicalJson(input.coverage) !==
			canonicalJson(result.summary.coverage) ||
		canonicalJson(input.modelVersions) !==
			canonicalJson(result.summary.modelVersions) ||
		canonicalJson(input.inferenceDiagnostics) !==
			canonicalJson(result.summary.inferenceDiagnostics) ||
		input.taxonomyVersion !== result.summary.taxonomyVersion ||
		input.projectorVersion !== result.summary.projectorVersion ||
		input.createdAtMs !== result.summary.createdAtMs ||
		input.payloadHash !== sha256(canonicalJson(expectedPayload))
	) {
		throw new Error(
			`Agent input for ${window.windowId} does not match its persisted summary or payload hash.`,
		);
	}
}

function assertUniqueIdentifiers(
	values: readonly string[],
	label: string,
): void {
	if (
		values.some((value) => typeof value !== "string" || value.length === 0) ||
		new Set(values).size !== values.length
	) {
		throw new Error(`${label} must be non-empty and unique.`);
	}
}

function sameStringSet(
	values: readonly string[],
	expected: ReadonlySet<string>,
): boolean {
	return (
		values.length === expected.size &&
		values.every((value) => expected.has(value))
	);
}

function buildLineage(
	window: TimelineWindowV2,
	result: PersistTimelineResult,
	linkedObservationIds: ReadonlySet<string>,
): TrainingWindowLineageV1[] {
	const factsByEvent = new Map<string, string[]>();
	for (const fact of result.facts) {
		for (const eventId of fact.eventIds) {
			const values = factsByEvent.get(eventId) ?? [];
			values.push(fact.factId);
			factsByEvent.set(eventId, values);
		}
	}
	const episodesByFact = new Map<string, string[]>();
	for (const episode of result.episodes) {
		for (const factId of [
			...episode.evidenceFactIds,
			...episode.supportingFactIds,
		]) {
			const values = episodesByFact.get(factId) ?? [];
			values.push(episode.revisionId);
			episodesByFact.set(factId, values);
		}
	}
	const summarizedRevisions = new Set(
		result.summary.segments.map((segment) => segment.episodeRevisionId),
	);
	const entries: TrainingWindowLineageV1[] = [];
	for (const [scope, events] of [
		["window", window.events],
		["context", window.contextOnly],
	] as const) {
		for (const event of events) {
			const factIds = [...new Set(factsByEvent.get(event.eventId) ?? [])].sort(
				compareText,
			);
			const episodeRevisionIds = [
				...new Set(
					factIds.flatMap((factId) => episodesByFact.get(factId) ?? []),
				),
			].sort(compareText);
			for (const observationId of event.sourceObservationIds) {
				if (!linkedObservationIds.has(observationId)) {
					throw new Error(
						`Semantic event ${event.eventId} has invalid raw lineage.`,
					);
				}
				entries.push({
					observationId,
					eventId: event.eventId,
					factIds,
					episodeRevisionIds,
					timelineId: episodeRevisionIds.some((revisionId) =>
						summarizedRevisions.has(revisionId),
					)
						? result.summary.timelineId
						: null,
					scope,
				});
			}
		}
	}
	return entries.sort(
		(left, right) =>
			compareText(left.scope, right.scope) ||
			compareText(left.eventId, right.eventId) ||
			compareText(left.observationId, right.observationId),
	);
}

function redactRecord(
	record: PrivateTrainingWindowRecordV1,
): PrivateTrainingWindowRecordV1 {
	const redactCoverage = (
		coverage: readonly CoverageLevel[],
	): CoverageLevel[] => [
		...new Set([
			...coverage.filter((value) => value !== "content"),
			"redacted" as const,
		]),
	];
	const redactEvent = (event: SemanticEventV2): SemanticEventV2 => {
		return {
			...structuredClone(event),
			contentState:
				event.contentState === "expired" ? "expired" : "redacted",
			coverage: redactCoverage(event.coverage),
			payload: {},
		};
	};
	const facts = record.evidenceFacts.map((fact) => ({
		...structuredClone(fact),
		templateArgs: {},
		renderedText: "[redacted]",
		coverage: redactCoverage(fact.coverage),
	}));
	const factById = new Map(facts.map((fact) => [fact.factId, fact]));
	const episodes = record.episodes.map((episode) => ({
		...structuredClone(episode),
		hypothesis: { ...episode.hypothesis, text: "[redacted]" },
		coverage: redactCoverage(episode.coverage),
	}));
	const episodeByRevision = new Map(
		episodes.map((episode) => [episode.revisionId, episode]),
	);
	const windowEvents = record.window.events.map(redactEvent);
	const contextOnly = record.window.contextOnly.map(redactEvent);
	const goalSnapshot =
		record.goalSnapshot === null
			? null
			: { ...record.goalSnapshot, text: "[redacted]" };
	const recomputedInputHash = sha256(
		canonicalJson({
			goal: goalSnapshot,
			events: windowEvents,
			contextOnly,
		}),
	);
	const window: TimelineWindowV2 = {
		...structuredClone(record.window),
		inputHash: recomputedInputHash,
		goal: goalSnapshot,
		events: windowEvents,
		contextOnly,
	};
	const rawObservations = record.rawObservations.map((observation) => {
		const redacted = structuredClone(observation);
		delete redacted.content;
		if (redacted.contentState !== "expired") {
			redacted.contentState = "redacted";
		}
		const coverage = Array.isArray(redacted.coverage)
			? redacted.coverage.filter((value) => value !== "content")
			: [];
		redacted.coverage = [
			...new Set([...coverage, "redacted"]),
		] as JsonValue;
		return redacted;
	});
	const timelineSummary: PrivateTrainingTimelineSummaryV1 = {
		...structuredClone(record.timelineSummary),
		renderedText: "[redacted]",
		coverage: redactCoverage(record.timelineSummary.coverage),
		coverageWarnings: ["训练正文未解密；此导出不可用于训练"],
		segments: record.timelineSummary.segments.map((segment) => ({
			...segment,
			hypothesis: { ...segment.hypothesis, text: "[redacted]" },
			evidence: segment.evidence
				.map((fact) => factById.get(fact.factId))
				.filter((fact): fact is EvidenceFactV2 => fact !== undefined),
			classification:
				episodeByRevision.get(segment.episodeRevisionId)
					?.classification ?? segment.classification,
		})),
	};
	const redactedRecord: PrivateTrainingWindowRecordV1 = {
		...structuredClone(record),
		contentMode: "redacted",
		window,
		goalSnapshot,
		rawObservations,
		semanticEvents: windowEvents,
		contextOnly,
		evidenceFacts: facts,
		episodes,
		timelineSummary,
		authority: structuredClone(record.authority),
	};
	redactedRecord.authority = {
		...redactedRecord.authority,
		inputHash: recomputedInputHash,
		recomputedInputHash,
		goalSnapshotHash: sha256(canonicalJson(goalSnapshot)),
		eventSetHash: hashOrdered(windowEvents),
		factSetHash: hashOrdered(facts),
		episodeSetHash: hashOrdered(episodes),
		summaryHash: sha256(canonicalJson(timelineSummary)),
		rawObservationSetHash: hashOrdered(
			[...rawObservations].sort(compareObservation),
		),
		lineageHash: hashOrdered(redactedRecord.lineage),
	};
	return redactedRecord;
}

type OverlapInput = {
	windowId: string;
	identities: string[];
};

function sourceWindowEntry(
	record: PrivateTrainingWindowRecordV1,
	encodedLine: string,
): PrivateTrainingWindowManifestV1["sourceWindows"][number] {
	return {
		windowId: record.window.windowId,
		inputHash: record.authority.inputHash,
		// Bind the exact UTF-8 JSONL line. Python verifies this raw slice
		// without reserializing numbers whose spelling differs by runtime.
		recordSha256: sha256(encodedLine),
		goalSnapshotHash: record.authority.goalSnapshotHash,
		eventSetHash: record.authority.eventSetHash,
		factSetHash: record.authority.factSetHash,
		episodeSetHash: record.authority.episodeSetHash,
		summaryHash: record.authority.summaryHash,
		rawObservationSetHash: record.authority.rawObservationSetHash,
		lineageHash: record.authority.lineageHash,
		jobUpdatedAtMs: record.authority.job.updatedAtMs,
	};
}

function overlapInput(record: PrivateTrainingWindowRecordV1): OverlapInput {
	return {
		windowId: record.window.windowId,
		identities: [
			...record.rawObservations.map(
				(observation) =>
					`observation:${String(observation.observationId)}`,
			),
			...record.semanticEvents.map((event) => `event:${event.eventId}`),
			...record.contextOnly.map((event) => `event:${event.eventId}`),
			...record.episodes.map((episode) => `episode:${episode.episodeId}`),
		],
	};
}

function buildOverlapGroups(
	records: readonly OverlapInput[],
): PrivateTrainingWindowManifestV1["overlapGroups"] {
	const parents = new Map(
		records.map((record) => [record.windowId, record.windowId]),
	);
	const ranks = new Map(records.map((record) => [record.windowId, 0]));
	const ownerByIdentity = new Map<string, string>();
	const find = (value: string): string => {
		const parent = parents.get(value);
		if (parent === undefined || parent === value) return value;
		const root = find(parent);
		parents.set(value, root);
		return root;
	};
	const union = (left: string, right: string): void => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot === rightRoot) return;
		const leftRank = ranks.get(leftRoot) ?? 0;
		const rightRank = ranks.get(rightRoot) ?? 0;
		if (leftRank < rightRank) {
			parents.set(leftRoot, rightRoot);
			return;
		}
		if (leftRank > rightRank) {
			parents.set(rightRoot, leftRoot);
			return;
		}
		const [first, second] = [leftRoot, rightRoot].sort(compareText);
		parents.set(second!, first!);
		ranks.set(first!, leftRank + 1);
	};
	for (const record of records) {
		const windowId = record.windowId;
		const identities = new Set(record.identities);
		for (const identity of identities) {
			const owner = ownerByIdentity.get(identity);
			if (owner === undefined) ownerByIdentity.set(identity, windowId);
			else union(windowId, owner);
		}
	}
	const groupsByRoot = new Map<
		string,
		{ windowIds: string[]; records: OverlapInput[] }
	>();
	for (const record of records) {
		const root = find(record.windowId);
		const group = groupsByRoot.get(root) ?? {
			windowIds: [],
			records: [],
		};
		group.windowIds.push(record.windowId);
		group.records.push(record);
		groupsByRoot.set(root, group);
	}
	return [...groupsByRoot.values()]
		.map((group) => ({
			windowIds: group.windowIds.sort(compareText),
			records: group.records,
		}))
		.sort((left, right) =>
			compareText(left.windowIds[0]!, right.windowIds[0]!),
		)
		.map(({ windowIds, records: groupRecords }) => {
			const identities = groupRecords
				.flatMap((record) => record.identities)
				.sort(compareText);
			const sharedIdentityHash = sha256(
				canonicalJson(identities),
			);
			return {
				groupId: `overlap_${sha256(canonicalJson(windowIds))}`,
				windowIds,
				sharedIdentityHash,
			};
		});
}

function assertExportOptions(options: {
	directory: string;
	windowIds: readonly string[];
	participantId: string;
	sessionTimezone: string;
}): void {
	if (
		typeof options.directory !== "string" ||
		options.directory.length === 0 ||
		!isAbsolute(options.directory)
	) {
		throw new Error("Private training export directory must be absolute.");
	}
	if (
		options.windowIds.length < 1 ||
		options.windowIds.length > MAX_EXPORT_WINDOWS ||
		new Set(options.windowIds).size !== options.windowIds.length ||
		options.windowIds.some((windowId) => !safeIdentifier(windowId, 256))
	) {
		throw new Error("Private training export windowIds are invalid.");
	}
	if (!safeIdentifier(options.participantId, 160)) {
		throw new Error("Private training export participantId is invalid.");
	}
	if (
		typeof options.sessionTimezone !== "string" ||
		options.sessionTimezone.length < 1 ||
		options.sessionTimezone.length > 160
	) {
		throw new Error("Private training export sessionTimezone is invalid.");
	}
}

function asRawObservation(
	value: unknown,
): Record<string, JsonValue> | null {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("observationId" in value) ||
		typeof value.observationId !== "string"
	) {
		return null;
	}
	return structuredClone(value) as Record<string, JsonValue>;
}

function assertNoPersistedPixels(value: unknown, path = "$"): void {
	if (Array.isArray(value)) {
		value.forEach((entry, index) =>
			assertNoPersistedPixels(entry, `${path}[${index}]`),
		);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, child] of Object.entries(value)) {
		const normalized = key.replaceAll("_", "").toLowerCase();
		if (
			normalized === "screenshot" ||
			normalized === "screenshotpath" ||
			normalized === "pixelbuffer" ||
			normalized === "imagebytes" ||
			normalized === "temporaryimagepath"
		) {
			throw new Error(`Raw observation contains forbidden pixels at ${path}.${key}.`);
		}
		assertNoPersistedPixels(child, `${path}.${key}`);
	}
}

function cleanupStaleStagingDirectories(
	parent: string,
	nowMs: number,
	activeDirectories: ReadonlySet<string>,
): void {
	const effectiveUserId = currentEffectiveUserId();
	if (effectiveUserId === null) return;
	const staleBeforeMs = nowMs - STALE_STAGING_AGE_MS;
	if (staleBeforeMs < 0) return;
	let removedAny = false;
	for (const name of readdirSync(parent)) {
		const matched = PRIVATE_TRAINING_STAGING_PATTERN.exec(name);
		if (matched === null) continue;
		const createdAtMs = Number(matched[1]);
		if (!Number.isSafeInteger(createdAtMs) || createdAtMs > staleBeforeMs) {
			continue;
		}
		const candidate = join(parent, name);
		if (activeDirectories.has(candidate)) continue;
		try {
			const metadata = lstatSync(candidate);
			if (
				!metadata.isDirectory() ||
				metadata.isSymbolicLink() ||
				metadata.uid !== effectiveUserId ||
				!hasPrivateMode(metadata.mode, 0o700) ||
				!Number.isFinite(metadata.mtimeMs) ||
				metadata.mtimeMs > staleBeforeMs
			) {
				continue;
			}
			removedAny =
				tryRemoveStagingDirectory(candidate, effectiveUserId) || removedAny;
		} catch {
			// A candidate that changes or becomes unreadable during inspection is
			// not safe to remove. It can be reconsidered by a later export.
		}
	}
	if (removedAny) fsyncDirectory(parent);
}

function tryRemoveStagingDirectory(
	directory: string,
	effectiveUserId: number | null,
): boolean {
	try {
		const directoryBefore = lstatSync(directory);
		if (
			!directoryBefore.isDirectory() ||
			directoryBefore.isSymbolicLink() ||
			(effectiveUserId !== null &&
				directoryBefore.uid !== effectiveUserId) ||
			!hasPrivateMode(directoryBefore.mode, 0o700)
		) {
			return false;
		}
		const entries = readdirSync(directory).sort(compareText);
		if (
			entries.some(
				(name) =>
					name !== PRIVATE_TRAINING_RECORDS_FILENAME &&
					name !== PRIVATE_TRAINING_MANIFEST_FILENAME,
			)
		) {
			return false;
		}
		const files = entries.map((name) => {
			const path = join(directory, name);
			const metadata = lstatSync(path);
			if (
				!metadata.isFile() ||
				metadata.isSymbolicLink() ||
				(effectiveUserId !== null && metadata.uid !== effectiveUserId) ||
				!hasPrivateMode(metadata.mode, 0o600)
			) {
				throw new Error("Private training staging file is not owned data.");
			}
			return { path, device: metadata.dev, inode: metadata.ino };
		});
		const directoryAfter = lstatSync(directory);
		if (
			directoryAfter.dev !== directoryBefore.dev ||
			directoryAfter.ino !== directoryBefore.ino ||
			directoryAfter.isSymbolicLink()
		) {
			return false;
		}
		for (const file of files) {
			const metadata = lstatSync(file.path);
			if (
				metadata.dev !== file.device ||
				metadata.ino !== file.inode ||
				!metadata.isFile() ||
				metadata.isSymbolicLink() ||
				(effectiveUserId !== null && metadata.uid !== effectiveUserId) ||
				!hasPrivateMode(metadata.mode, 0o600)
			) {
				return false;
			}
		}
		for (const file of files) unlinkSync(file.path);
		rmdirSync(directory);
		return true;
	} catch {
		return false;
	}
}

function currentEffectiveUserId(): number | null {
	if (typeof process.geteuid !== "function") return null;
	const value = process.geteuid();
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hasPrivateMode(mode: number, expected: 0o600 | 0o700): boolean {
	// Windows' stat mode reports synthesized DOS permission bits rather than
	// an ACL equivalent of POSIX owner-only modes. File type, symlink, exact
	// staging names, ownership where available, and inode/device stability
	// remain mandatory on every platform.
	return process.platform === "win32" || (mode & 0o777) === expected;
}

function fsyncDirectory(path: string): void {
	// Node/Bun cannot open directory handles for FlushFileBuffers on Windows.
	// POSIX requires syncing both the populated staging directory and the
	// parent entry after rename for crash-durable publication.
	if (process.platform === "win32") return;
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function writePrivateFile(path: string, bytes: Uint8Array): void {
	const descriptor = openSync(path, "wx", 0o600);
	try {
		writeAll(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = writeSync(
			descriptor,
			bytes,
			offset,
			bytes.byteLength - offset,
		);
		if (written < 1) {
			throw new Error("Private training export write did not make progress.");
		}
		offset += written;
	}
}

function hashOrdered(values: readonly unknown[]): string {
	return sha256(canonicalJson(values));
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeExportId(value: string): string {
	const normalized = value.replaceAll(/[^A-Za-z0-9_-]/gu, "");
	if (normalized.length < 1 || normalized.length > 128) {
		throw new Error("Private training export id is invalid.");
	}
	return normalized;
}

function safeIdentifier(value: string, maximum: number): boolean {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maximum &&
		/^[A-Za-z0-9._:-]+$/u.test(value)
	);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareObservation(
	left: Record<string, JsonValue>,
	right: Record<string, JsonValue>,
): number {
	return compareText(
		String(left.observationId),
		String(right.observationId),
	);
}
