import { mergeCoverage } from "./evidence";
import type { TimelineV2Repository } from "./repository";
import {
	TIMELINE_AUDIT_SCHEMA_VERSION,
	type CoverageLevel,
	type JsonValue,
	type SemanticEventV2,
	type TimelineAuditBundleV2,
} from "./types";

export const FIVE_MINUTE_AUDIT_DURATION_MS = 5 * 60 * 1000;

export type RawFiveMinuteAuditResult = {
	permissions: Record<string, JsonValue>;
	coverage: CoverageLevel[];
	rawObservations: unknown[];
	semanticEvents: SemanticEventV2[];
};

/**
 * Implemented by the Rust observation journal. It must never return screenshot
 * bytes or paths; includeDecryptedContent controls only explicitly authorized
 * text fields.
 */
export interface RawFiveMinuteAuditSource {
	queryAuditRange(options: {
		fromMs: number;
		toMs: number;
		includeDecryptedContent: boolean;
	}): Promise<RawFiveMinuteAuditResult>;
}

export class TimelineFiveMinuteAuditExporter {
	constructor(
		private readonly raw: RawFiveMinuteAuditSource,
		private readonly repository: TimelineV2Repository,
		private readonly nowMs: () => number = Date.now,
	) {}

	async exportFiveMinutes(
		fromMs: number,
		options: { includeDecryptedContent?: boolean } = {},
	): Promise<TimelineAuditBundleV2> {
		if (!Number.isSafeInteger(fromMs) || fromMs < 0) {
			throw new Error("fromMs must be a non-negative safe integer.");
		}
		const toMs = fromMs + FIVE_MINUTE_AUDIT_DURATION_MS;
		if (!Number.isSafeInteger(toMs)) {
			throw new Error("Five-minute audit range exceeds safe integer time.");
		}
		const includeDecryptedContent =
			options.includeDecryptedContent ?? false;
		const [raw, derived] = await Promise.all([
			this.raw.queryAuditRange({
				fromMs,
				toMs,
				includeDecryptedContent,
			}),
			this.repository.readAuditRange(fromMs, toMs),
		]);
		const scopedRawObservations = raw.rawObservations.filter((observation) =>
			rawObservationIsInsideRange(observation, fromMs, toMs),
		);
		const scopedObservationIds = new Set(
			scopedRawObservations
				.map(observationIdentifier)
				.filter((identifier): identifier is string => identifier !== null),
		);
		const scopedSemanticEvents = raw.semanticEvents.filter(
			(event) =>
				event.occurredAtMs >= fromMs &&
				event.occurredAtMs < toMs &&
				event.observedAtMs <= toMs &&
				event.sourceObservationIds.length > 0 &&
				event.sourceObservationIds.every((identifier) =>
					scopedObservationIds.has(identifier),
				),
		);
		const semanticEvents = includeDecryptedContent
			? structuredClone(scopedSemanticEvents)
			: scopedSemanticEvents.map(redactSemanticEvent);
		const scopedEventIds = new Set(
			scopedSemanticEvents.map((event) => event.eventId),
		);
		const scopedFacts = derived.facts.filter(
			(fact) =>
				fact.startedAtMs >= fromMs &&
				fact.endedAtMs <= toMs &&
				fact.eventIds.length > 0 &&
				fact.eventIds.every((identifier) =>
					scopedEventIds.has(identifier),
				) &&
				fact.sourceObservationIds.every((identifier) =>
					scopedObservationIds.has(identifier),
				),
		);
		const facts = includeDecryptedContent
			? structuredClone(scopedFacts)
			: scopedFacts.map((fact) => ({
					...structuredClone(fact),
					renderedText: "[redacted]",
					templateArgs: redactTemplateArgs(fact.templateArgs),
				}));
		const scopedFactIds = new Set(scopedFacts.map((fact) => fact.factId));
		const scopedEpisodes = derived.episodes.filter(
			(episode) =>
				episode.startedAtMs >= fromMs &&
				episode.endedAtMs <= toMs &&
				episode.evidenceFactIds.length > 0 &&
				[...episode.evidenceFactIds, ...episode.supportingFactIds].every(
					(identifier) => scopedFactIds.has(identifier),
				),
		);
		const episodes = includeDecryptedContent
			? structuredClone(scopedEpisodes)
			: scopedEpisodes.map((episode) => ({
					...structuredClone(episode),
					hypothesis: {
						...episode.hypothesis,
						text: "[redacted]",
					},
				}));
		const scopedEpisodeRevisionIds = new Set(
			scopedEpisodes.map((episode) => episode.revisionId),
		);
		const scopedSummaries = derived.summaries.filter(
			(summary) =>
				summary.period.startedAtMs >= fromMs &&
				summary.period.endedAtMs <= toMs &&
				summary.segments.length > 0 &&
				summary.segments.every(
					(segment) =>
						segment.startedAtMs >= fromMs &&
						segment.endedAtMs <= toMs &&
						scopedEpisodeRevisionIds.has(segment.episodeRevisionId) &&
						segment.evidence.every((fact) =>
							scopedFactIds.has(fact.factId),
						),
				),
		);
		const summaries = includeDecryptedContent
			? structuredClone(scopedSummaries)
			: scopedSummaries.map((summary) => ({
					...structuredClone(summary),
					renderedText: "[redacted]",
					segments: summary.segments.map((segment) => ({
						...segment,
						hypothesis: {
							...segment.hypothesis,
							text: "[redacted]",
						},
						evidence: segment.evidence.map((fact) => ({
							...fact,
							renderedText: "[redacted]",
							templateArgs: redactTemplateArgs(
								fact.templateArgs,
							),
						})),
					})),
				}));
		const lineage: TimelineAuditBundleV2["lineage"] = [];
		const seenLineage = new Set<string>();
		const factsByEvent = new Map<string, typeof facts>();
		for (const fact of facts) {
			for (const eventId of fact.eventIds) {
				const existing = factsByEvent.get(eventId) ?? [];
				existing.push(fact);
				factsByEvent.set(eventId, existing);
			}
		}
		const episodesByFact = new Map<string, typeof episodes>();
		for (const episode of episodes) {
			for (const factId of [
				...episode.evidenceFactIds,
				...episode.supportingFactIds,
			]) {
				const existing = episodesByFact.get(factId) ?? [];
				existing.push(episode);
				episodesByFact.set(factId, existing);
			}
		}
		const summariesByEpisode = new Map<string, typeof summaries>();
		for (const summary of summaries) {
			for (const segment of summary.segments) {
				const existing =
					summariesByEpisode.get(segment.episodeRevisionId) ?? [];
				existing.push(summary);
				summariesByEpisode.set(segment.episodeRevisionId, existing);
			}
		}
		const pushLineage = (
			entry: TimelineAuditBundleV2["lineage"][number],
		) => {
			const key = [
				entry.observationId,
				entry.eventId ?? "",
				entry.factId ?? "",
				entry.episodeRevisionId ?? "",
				entry.timelineId ?? "",
				entry.status,
			].join("\u001f");
			if (seenLineage.has(key)) return;
			seenLineage.add(key);
			lineage.push(entry);
		};
		for (const event of semanticEvents) {
			const eventFacts = factsByEvent.get(event.eventId) ?? [];
			for (const observationId of event.sourceObservationIds) {
				if (eventFacts.length === 0) {
					pushLineage({
						observationId,
						eventId: event.eventId,
						factId: null,
						episodeRevisionId: null,
						timelineId: null,
						status:
							event.countClass === "ignored"
								? "ignored"
								: "semantic_only",
					});
					continue;
				}
				for (const fact of eventFacts) {
					const factEpisodes =
						episodesByFact.get(fact.factId) ?? [];
					if (factEpisodes.length === 0) {
						pushLineage({
							observationId,
							eventId: event.eventId,
							factId: fact.factId,
							episodeRevisionId: null,
							timelineId: null,
							status: "fact_only",
						});
						continue;
					}
					for (const episode of factEpisodes) {
						const episodeSummaries =
							summariesByEpisode.get(episode.revisionId) ?? [];
						if (episodeSummaries.length === 0) {
							pushLineage({
								observationId,
								eventId: event.eventId,
								factId: fact.factId,
								episodeRevisionId: episode.revisionId,
								timelineId: null,
								status: "unepisoded",
							});
							continue;
						}
						for (const summary of episodeSummaries) {
							pushLineage({
								observationId,
								eventId: event.eventId,
								factId: fact.factId,
								episodeRevisionId: episode.revisionId,
								timelineId: summary.timelineId,
								status: "summarized",
							});
						}
					}
				}
			}
		}
		const referencedRawObservationIds = new Set(
			semanticEvents.flatMap((event) => event.sourceObservationIds),
		);
		const rawObservations = includeDecryptedContent
			? scopedRawObservations.map((observation) =>
					sanitizeDecryptedRawObservation(observation),
				)
			: scopedRawObservations.map(redactRawObservation);
		for (const rawObservation of rawObservations) {
			const observationId = observationIdentifier(rawObservation);
			if (
				observationId &&
				!referencedRawObservationIds.has(observationId)
			) {
				pushLineage({
					observationId,
					eventId: null,
					factId: null,
					episodeRevisionId: null,
					timelineId: null,
					status: "unreferenced_raw",
				});
			}
		}
		const rangeBoundaryOmissions = {
			rawObservations:
				raw.rawObservations.length - scopedRawObservations.length,
			semanticEvents:
				raw.semanticEvents.length - scopedSemanticEvents.length,
			evidenceFacts: derived.facts.length - scopedFacts.length,
			episodes: derived.episodes.length - scopedEpisodes.length,
			timelines: derived.summaries.length - scopedSummaries.length,
		};
		const rangeWasClipped = Object.values(rangeBoundaryOmissions).some(
			(count) => count > 0,
		);
		const coverage = mergeCoverage([
			raw.coverage,
			rangeWasClipped ? ["unavailable"] : [],
			...semanticEvents.map((event) => event.coverage),
			...facts.map((fact) => fact.coverage),
		]);
		return {
			manifest: {
				schemaVersion: TIMELINE_AUDIT_SCHEMA_VERSION,
				exportedAtMs: this.nowMs(),
				fromMs,
				toMs,
				decryptedContentIncluded: includeDecryptedContent,
				rawObservationCount: raw.rawObservations.length,
				semanticEventCount: semanticEvents.length,
				evidenceFactCount: facts.length,
				episodeCount: episodes.length,
				timelineCount: summaries.length,
				rangeBoundaryOmissions,
			},
			permissions: structuredClone(raw.permissions),
			coverage,
			rawObservations,
			semanticEvents,
			evidenceFacts: facts,
			episodes,
			timelineSummaries: summaries,
			lineage,
		};
	}
}

function observationIdentifier(value: unknown): string | null {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value)
	) {
		return null;
	}
	const identifier = (value as Record<string, unknown>).observationId;
	return typeof identifier === "string" && identifier.length > 0
		? identifier
		: null;
}

function rawObservationIsInsideRange(
	value: unknown,
	fromMs: number,
	toMs: number,
): boolean {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value)
	) {
		return false;
	}
	const interval = (value as Record<string, unknown>).interval;
	if (
		typeof interval !== "object" ||
		interval === null ||
		Array.isArray(interval)
	) {
		return false;
	}
	const { startedAtMs, endedAtMs } = interval as Record<string, unknown>;
	return (
		Number.isSafeInteger(startedAtMs) &&
		Number.isSafeInteger(endedAtMs) &&
		(startedAtMs as number) >= fromMs &&
		(startedAtMs as number) < toMs &&
		(endedAtMs as number) <= toMs
	);
}

function redactRawObservation(value: unknown): unknown {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value)
	) {
		return {};
	}
	const raw = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of [
		"schemaVersion",
		"observationId",
		"cursor",
		"deviceId",
		"sessionId",
		"kind",
		"interval",
		"source",
		"subject",
		"reliability",
		"coverage",
		"redactions",
		"contentState",
		"dedupHash",
	]) {
		if (key in raw) result[key] = structuredClone(raw[key]);
	}
	if (
		typeof raw.metadata === "object" &&
		raw.metadata !== null &&
		!Array.isArray(raw.metadata)
	) {
		result.metadata = redactRawMetadata(
			raw.metadata as Record<string, unknown>,
		);
	}
	return result;
}

function sanitizeDecryptedRawObservation(value: unknown): unknown {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value)
	) {
		return {};
	}
	const raw = value as Record<string, unknown>;
	const result = redactRawObservation(raw) as Record<string, unknown>;
	if (
		typeof raw.metadata === "object" &&
		raw.metadata !== null &&
		!Array.isArray(raw.metadata)
	) {
		result.metadata = stripPersistedImageArtifacts(raw.metadata);
	}
	if ("content" in raw) {
		result.content = stripPersistedImageArtifacts(raw.content);
	}
	return result;
}

const FORBIDDEN_AUDIT_ARTIFACT_KEYS = new Set([
	"bitmap",
	"buffer",
	"bytes",
	"cgimage",
	"dataurl",
	"file",
	"filepath",
	"image",
	"imagedata",
	"path",
	"pixelbuffer",
	"screencapture",
	"screenshot",
	"screenshotbytes",
	"temppath",
	"temporaryfile",
]);

function stripPersistedImageArtifacts(value: unknown): unknown {
	if (Array.isArray(value)) {
		if (value.length > 0 && value.every((item) => typeof item === "number")) {
			return [];
		}
		return value.map(stripPersistedImageArtifacts);
	}
	if (
		typeof value !== "object" ||
		value === null
	) {
		return structuredClone(value);
	}
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (FORBIDDEN_AUDIT_ARTIFACT_KEYS.has(key.toLowerCase())) continue;
		result[key] = stripPersistedImageArtifacts(child);
	}
	return result;
}

function redactRawMetadata(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key)) continue;
		if (
			CONTENT_KEYS.has(key) ||
			key === "content" ||
			key === "contentRef" ||
			key === "plaintext"
		) {
			continue;
		}
		if (typeof child === "string") {
			result[key] = "[redacted]";
		} else if (
			typeof child === "number" ||
			typeof child === "boolean" ||
			child === null
		) {
			result[key] = child;
		} else if (Array.isArray(child)) {
			result[key] = child.map((item) =>
				typeof item === "string" ? "[redacted]" : item,
			);
		} else if (typeof child === "object") {
			result[key] = redactRawMetadata(
				child as Record<string, unknown>,
			);
		}
	}
	return result;
}

const CONTENT_KEYS = new Set([
	"windowTitle",
	"visibleText",
	"label",
	"addedText",
	"finalValue",
	"url",
	"domain",
	"title",
	"text",
	"goalText",
]);

function redactSemanticEvent(event: SemanticEventV2): SemanticEventV2 {
	const payload = redactRecord(event.payload);
	return {
		...structuredClone(event),
		contentState:
			event.contentState === "available"
				? "redacted"
				: event.contentState,
		coverage: event.coverage.includes("redacted")
			? [...event.coverage]
			: [...event.coverage, "redacted"],
		payload,
	};
}

function redactRecord(
	value: Record<string, JsonValue>,
): Record<string, JsonValue> {
	const result: Record<string, JsonValue> = {};
	for (const [key, child] of Object.entries(value)) {
		if (CONTENT_KEYS.has(key)) continue;
		if (Array.isArray(child)) {
			result[key] = child.map(redactValue);
		} else if (
			typeof child === "object" &&
			child !== null
		) {
			result[key] = redactRecord(child);
		} else {
			result[key] = child;
		}
	}
	return result;
}

function redactValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(redactValue);
	if (typeof value === "object" && value !== null) {
		return redactRecord(value);
	}
	return value;
}

function redactTemplateArgs(
	args: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
	const result: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(args)) {
		result[key] =
			typeof value === "string" && CONTENT_KEYS.has(key)
				? "[redacted]"
				: value;
	}
	return result;
}
