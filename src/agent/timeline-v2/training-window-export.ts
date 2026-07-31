import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalJson } from "../reflection/hash";
import type { RawFiveMinuteAuditSource } from "./audit";
import type {
	PersistTimelineResult,
	TimelineV2Repository,
} from "./repository";
import {
	AGENT_INPUT_SCHEMA_VERSION,
	type ActivityEpisodeV2,
	type CoverageLevel,
	type EvidenceFactV2,
	type JsonValue,
	type SemanticEventV2,
	type TimelineJobV2,
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

export type PrivateTrainingWindowRecordV1 = {
	schemaVersion: typeof PRIVATE_TRAINING_EXPORT_SCHEMA_VERSION;
	contentMode: "decrypted" | "redacted";
	window: TimelineWindowV2;
	goalSnapshot: TimelineWindowV2["goal"];
	rawObservations: Array<Record<string, JsonValue>>;
	semanticEvents: SemanticEventV2[];
	contextOnly: SemanticEventV2[];
	evidenceFacts: EvidenceFactV2[];
	episodes: ActivityEpisodeV2[];
	timelineSummary: TimelineSummaryV2;
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
	}): Promise<PrivateTrainingWindowExportResult> {
		assertExportOptions(options);
		if (existsSync(options.directory)) {
			throw new Error("Private training export directory must not already exist.");
		}
		const parent = dirname(options.directory);
		if (!statSync(parent).isDirectory()) {
			throw new Error("Private training export parent must be a directory.");
		}

		const includeDecryptedContent =
			options.includeDecryptedContent ?? false;
		const records = await Promise.all(
			[...options.windowIds]
				.sort(compareText)
				.map((windowId) =>
					this.buildRecord(windowId, includeDecryptedContent),
				),
		);
		const encodedRecordLines = records.map((record) =>
			canonicalJson(record),
		);
		const encodedRecords = encodedRecordLines
			.map((line) => `${line}\n`)
			.join("");
		const encodedRecordsBytes = Buffer.from(encodedRecords, "utf8");
		const sourceWindows = records.map((record, index) => ({
			windowId: record.window.windowId,
			inputHash: record.authority.inputHash,
			// Bind the exact UTF-8 JSONL line. Python verifies this raw slice
			// without reserializing numbers whose spelling differs by runtime.
			recordSha256: sha256(encodedRecordLines[index]!),
			goalSnapshotHash: record.authority.goalSnapshotHash,
			eventSetHash: record.authority.eventSetHash,
			factSetHash: record.authority.factSetHash,
			episodeSetHash: record.authority.episodeSetHash,
			summaryHash: record.authority.summaryHash,
			rawObservationSetHash: record.authority.rawObservationSetHash,
			lineageHash: record.authority.lineageHash,
			jobUpdatedAtMs: record.authority.job.updatedAtMs,
		}));
		const manifest: PrivateTrainingWindowManifestV1 = {
			schemaVersion: PRIVATE_TRAINING_MANIFEST_SCHEMA_VERSION,
			exportId: safeExportId(this.createId()),
			exportedAtMs: this.nowMs(),
			localOnly: true,
			explicitUserOperation: true,
			contentMode: includeDecryptedContent ? "decrypted" : "redacted",
			trainingEligible: includeDecryptedContent,
			ineligibilityReasons: includeDecryptedContent
				? []
				: ["decrypted_content_not_included"],
			windowCount: records.length,
			participantId: options.participantId,
			sessionTimezone: options.sessionTimezone,
			files: {
				records: {
					relativePath: PRIVATE_TRAINING_RECORDS_FILENAME,
					sha256: sha256(encodedRecordsBytes),
					byteLength: encodedRecordsBytes.byteLength,
					rowCount: records.length,
				},
			},
			sourceWindows,
			overlapGroups: buildOverlapGroups(records),
		};

		const temporaryDirectory = join(
			parent,
			`.${basename(options.directory)}.${manifest.exportId}.tmp`,
		);
		if (existsSync(temporaryDirectory)) {
			throw new Error("Private training export staging directory already exists.");
		}
		try {
			mkdirSync(temporaryDirectory, { mode: 0o700 });
			const recordsPath = join(
				temporaryDirectory,
				PRIVATE_TRAINING_RECORDS_FILENAME,
			);
			const manifestPath = join(
				temporaryDirectory,
				PRIVATE_TRAINING_MANIFEST_FILENAME,
			);
			writePrivateFile(recordsPath, encodedRecordsBytes);
			writePrivateFile(
				manifestPath,
				Buffer.from(
					`${JSON.stringify(manifest, null, 2)}\n`,
					"utf8",
				),
			);
			renameSync(temporaryDirectory, options.directory);
		} catch (error) {
			rmSync(temporaryDirectory, { recursive: true, force: true });
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
		assertPersistedResult(window, result);
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

		const lineage = buildLineage(window, result, linkedObservationIds);
		const modelVersions = [...new Set(result.summary.modelVersions)].sort(
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
			factSetHash: hashOrdered(result.facts),
			episodeSetHash: hashOrdered(result.episodes),
			summaryHash: sha256(canonicalJson(result.summary)),
			rawObservationSetHash: hashOrdered(
				[...rawById.values()].sort(compareObservation),
			),
			lineageHash: hashOrdered(lineage),
			modelVersions,
			taxonomyVersion: result.summary.taxonomyVersion,
			projectorVersion: result.summary.projectorVersion,
		};
		const record: PrivateTrainingWindowRecordV1 = {
			schemaVersion: PRIVATE_TRAINING_EXPORT_SCHEMA_VERSION,
			contentMode: includeDecryptedContent ? "decrypted" : "redacted",
			window: structuredClone(window),
			goalSnapshot: structuredClone(window.goal),
			rawObservations: [...rawById.values()].sort(compareObservation),
			semanticEvents: structuredClone(window.events),
			contextOnly: structuredClone(window.contextOnly),
			evidenceFacts: structuredClone(result.facts),
			episodes: structuredClone(result.episodes),
			timelineSummary: structuredClone(result.summary),
			lineage,
			authority,
		};
		return includeDecryptedContent ? record : redactRecord(record);
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

function assertPersistedResult(
	window: TimelineWindowV2,
	result: PersistTimelineResult,
): void {
	if (
		result.windowId !== window.windowId ||
		result.summary.windowId !== window.windowId
	) {
		throw new Error(`Timeline result does not belong to ${window.windowId}.`);
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
	assertUniqueIdentifiers(
		result.episodes.map((episode) => episode.revisionId),
		`Timeline result ${window.windowId} episode revisions`,
	);
	const factById = new Map(
		result.facts.map((fact) => [fact.factId, fact] as const),
	);
	const episodeByRevision = new Map(
		result.episodes.map((episode) => [episode.revisionId, episode] as const),
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
		if (
			!sameStringSet(
				fact.sourceObservationIds,
				expectedObservationIds,
			)
		) {
			throw new Error(
				`Fact ${fact.factId} source observations are not the exact event union.`,
			);
		}
	}
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
			!episode.sourceWindowIds.includes(window.windowId) ||
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
	const redactEvent = (event: SemanticEventV2): SemanticEventV2 => {
		const coverage: CoverageLevel[] = [
			...new Set(
				event.coverage.includes("metadata")
					? [
							...event.coverage.filter((value) => value !== "content"),
							"redacted" as const,
						]
					: (["redacted"] as const),
			),
		];
		return {
			...structuredClone(event),
			contentState:
				event.contentState === "expired" ? "expired" : "redacted",
			coverage,
			payload: {},
		};
	};
	const facts = record.evidenceFacts.map((fact) => ({
		...structuredClone(fact),
		templateArgs: {},
		renderedText: "[redacted]",
	}));
	const factById = new Map(facts.map((fact) => [fact.factId, fact]));
	const episodes = record.episodes.map((episode) => ({
		...structuredClone(episode),
		hypothesis: { ...episode.hypothesis, text: "[redacted]" },
	}));
	const episodeByRevision = new Map(
		episodes.map((episode) => [episode.revisionId, episode]),
	);
	return {
		...structuredClone(record),
		contentMode: "redacted",
		window: {
			...structuredClone(record.window),
			goal:
				record.window.goal === null
					? null
					: { ...record.window.goal, text: "[redacted]" },
			events: record.window.events.map(redactEvent),
			contextOnly: record.window.contextOnly.map(redactEvent),
		},
		goalSnapshot:
			record.goalSnapshot === null
				? null
				: { ...record.goalSnapshot, text: "[redacted]" },
		rawObservations: record.rawObservations.map((observation) => {
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
		}),
		semanticEvents: record.semanticEvents.map(redactEvent),
		contextOnly: record.contextOnly.map(redactEvent),
		evidenceFacts: facts,
		episodes,
		timelineSummary: {
			...structuredClone(record.timelineSummary),
			renderedText: "[redacted]",
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
		},
	};
}

function buildOverlapGroups(
	records: readonly PrivateTrainingWindowRecordV1[],
): PrivateTrainingWindowManifestV1["overlapGroups"] {
	const parents = new Map(records.map((record) => [
		record.window.windowId,
		record.window.windowId,
	]));
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
		const [first, second] = [leftRoot, rightRoot].sort(compareText);
		parents.set(second!, first!);
	};
	for (const record of records) {
		const windowId = record.window.windowId;
		const identities = new Set([
			...record.rawObservations.map(
				(observation) => `observation:${String(observation.observationId)}`,
			),
			...record.semanticEvents.map((event) => `event:${event.eventId}`),
			...record.contextOnly.map((event) => `event:${event.eventId}`),
			...record.episodes.map(
				(episode) => `episode:${episode.episodeId}`,
			),
		]);
		for (const identity of identities) {
			const owner = ownerByIdentity.get(identity);
			if (owner === undefined) ownerByIdentity.set(identity, windowId);
			else union(windowId, owner);
		}
	}
	const windowsByRoot = new Map<string, string[]>();
	for (const windowId of parents.keys()) {
		const root = find(windowId);
		const values = windowsByRoot.get(root) ?? [];
		values.push(windowId);
		windowsByRoot.set(root, values);
	}
	return [...windowsByRoot.values()]
		.map((windowIds) => windowIds.sort(compareText))
		.sort((left, right) => compareText(left[0]!, right[0]!))
		.map((windowIds) => {
			const sharedIdentityHash = sha256(
				canonicalJson(
					records
						.filter((record) =>
							windowIds.includes(record.window.windowId),
						)
						.flatMap((record) => [
							...record.rawObservations.map(
								(observation) =>
									`observation:${String(observation.observationId)}`,
							),
							...record.semanticEvents.map(
								(event) => `event:${event.eventId}`,
							),
							...record.contextOnly.map(
								(event) => `event:${event.eventId}`,
							),
							...record.episodes.map(
								(episode) => `episode:${episode.episodeId}`,
							),
						])
						.sort(compareText),
				),
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
		!options.directory.startsWith("/")
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

function writePrivateFile(path: string, bytes: Uint8Array): void {
	writeFileSync(path, bytes, {
		flag: "wx",
		mode: 0o600,
	});
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
