import { mergeCoverage } from "./evidence";
import { HeuristicTimelineEpisodeClassifier } from "./episodes";
import type { TimelineV2Repository } from "./repository";
import {
	EPISODE_SLICE_SCHEMA_VERSION,
	TIMELINE_AUDIT_SCHEMA_VERSION,
	TIMELINE_SLICE_SCHEMA_VERSION,
	type ActivityEpisodeV2,
	type CoverageLevel,
	type EpisodeSliceV3,
	type EvidenceFactV2,
	type JsonValue,
	type SemanticEventV2,
	type TimelineAuditBundleV3,
	type TimelineAuditCountsV3,
	type TimelineSegmentSliceV3,
	type TimelineSliceV3,
	type TimelineSummaryV2,
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
	): Promise<TimelineAuditBundleV3> {
		if (!Number.isSafeInteger(fromMs) || fromMs < 0) {
			throw new Error("fromMs must be a non-negative safe integer.");
		}
		const toMs = fromMs + FIVE_MINUTE_AUDIT_DURATION_MS;
		if (!Number.isSafeInteger(toMs)) {
			throw new Error("Five-minute audit range exceeds safe integer time.");
		}
		const includeDecryptedContent = options.includeDecryptedContent ?? false;
		const [raw, derived] = await Promise.all([
			this.raw.queryAuditRange({
				fromMs,
				toMs,
				includeDecryptedContent,
			}),
			this.repository.readAuditRange(fromMs, toMs),
		]);
		const validatedRawObservations = raw.rawObservations
			.map((observation) =>
				projectRawObservationForAudit(observation, includeDecryptedContent),
			)
			.filter(
				(observation): observation is Record<string, JsonValue> =>
					observation !== null,
			);
		const scopedRawObservations = validatedRawObservations.filter(
			(observation) => rawObservationIsInsideRange(observation, fromMs, toMs),
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
				fact.eventIds.every((identifier) => scopedEventIds.has(identifier)) &&
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
						segment.evidence.every((fact) => scopedFactIds.has(fact.factId)),
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
							templateArgs: redactTemplateArgs(fact.templateArgs),
						})),
					})),
				}));
		const episodeSlices = await buildEpisodeSlices({
			episodes: derived.episodes,
			facts: scopedFacts,
			fromMs,
			toMs,
			includeDecryptedContent,
		});
		const timelineSlices = buildTimelineSlices({
			summaries: derived.summaries,
			episodeSlices,
			facts: scopedFacts,
			fromMs,
			toMs,
			includeDecryptedContent,
		});
		const lineage: TimelineAuditBundleV3["lineage"] = [];
		const seenLineage = new Set<string>();
		const factsByEvent = new Map<string, typeof facts>();
		for (const fact of facts) {
			for (const eventId of fact.eventIds) {
				const existing = factsByEvent.get(eventId) ?? [];
				existing.push(fact);
				factsByEvent.set(eventId, existing);
			}
		}
		const episodeSlicesByFact = new Map<string, EpisodeSliceV3[]>();
		for (const episodeSlice of episodeSlices) {
			for (const factId of [
				...episodeSlice.evidenceFactIds,
				...episodeSlice.supportingFactIds,
			]) {
				const existing = episodeSlicesByFact.get(factId) ?? [];
				existing.push(episodeSlice);
				episodeSlicesByFact.set(factId, existing);
			}
		}
		const timelineSegmentsByEpisodeSliceFact = new Map<
			string,
			Array<{
				sourceTimelineId: string;
				timelineSliceId: string;
				timelineSegmentSliceId: string;
			}>
		>();
		for (const slice of timelineSlices) {
			for (const segment of slice.segments) {
				for (const factId of segment.evidenceFactIds) {
					const key = episodeSliceFactKey(segment.episodeSliceId, factId);
					const existing = timelineSegmentsByEpisodeSliceFact.get(key) ?? [];
					existing.push({
						sourceTimelineId: slice.sourceTimelineId,
						timelineSliceId: slice.timelineSliceId,
						timelineSegmentSliceId: segment.segmentSliceId,
					});
					timelineSegmentsByEpisodeSliceFact.set(key, existing);
				}
			}
		}
		const pushLineage = (entry: TimelineAuditBundleV3["lineage"][number]) => {
			const key = [
				entry.observationId,
				entry.eventId ?? "",
				entry.factId ?? "",
				entry.sourceEpisodeId ?? "",
				entry.sourceEpisodeRevisionId ?? "",
				entry.episodeSliceId ?? "",
				entry.sourceTimelineId ?? "",
				entry.timelineSliceId ?? "",
				entry.timelineSegmentSliceId ?? "",
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
						sourceEpisodeId: null,
						sourceEpisodeRevisionId: null,
						episodeSliceId: null,
						sourceTimelineId: null,
						timelineSliceId: null,
						timelineSegmentSliceId: null,
						status:
							event.countClass === "ignored" ? "ignored" : "semantic_only",
					});
					continue;
				}
				for (const fact of eventFacts) {
					const factEpisodeSlices = episodeSlicesByFact.get(fact.factId) ?? [];
					if (factEpisodeSlices.length === 0) {
						pushLineage({
							observationId,
							eventId: event.eventId,
							factId: fact.factId,
							sourceEpisodeId: null,
							sourceEpisodeRevisionId: null,
							episodeSliceId: null,
							sourceTimelineId: null,
							timelineSliceId: null,
							timelineSegmentSliceId: null,
							status: "fact_only",
						});
						continue;
					}
					for (const episodeSlice of factEpisodeSlices) {
						const timelineSegments =
							timelineSegmentsByEpisodeSliceFact.get(
								episodeSliceFactKey(episodeSlice.episodeSliceId, fact.factId),
							) ?? [];
						if (timelineSegments.length === 0) {
							pushLineage({
								observationId,
								eventId: event.eventId,
								factId: fact.factId,
								sourceEpisodeId: episodeSlice.sourceEpisodeId,
								sourceEpisodeRevisionId: episodeSlice.sourceEpisodeRevisionId,
								episodeSliceId: episodeSlice.episodeSliceId,
								sourceTimelineId: null,
								timelineSliceId: null,
								timelineSegmentSliceId: null,
								status: "episode_only",
							});
							continue;
						}
						for (const timelineSegment of timelineSegments) {
							pushLineage({
								observationId,
								eventId: event.eventId,
								factId: fact.factId,
								sourceEpisodeId: episodeSlice.sourceEpisodeId,
								sourceEpisodeRevisionId: episodeSlice.sourceEpisodeRevisionId,
								episodeSliceId: episodeSlice.episodeSliceId,
								sourceTimelineId: timelineSegment.sourceTimelineId,
								timelineSliceId: timelineSegment.timelineSliceId,
								timelineSegmentSliceId: timelineSegment.timelineSegmentSliceId,
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
		const rawObservations = scopedRawObservations;
		for (const rawObservation of rawObservations) {
			const observationId = observationIdentifier(rawObservation);
			if (observationId && !referencedRawObservationIds.has(observationId)) {
				pushLineage({
					observationId,
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
			}
		}
		const candidateCounts: TimelineAuditCountsV3 = {
			rawObservations: raw.rawObservations.length,
			semanticEvents: raw.semanticEvents.length,
			evidenceFacts: derived.facts.length,
			sourceEpisodes: derived.episodes.length,
			episodeSlices: derived.episodes.length,
			sourceTimelineSummaries: derived.summaries.length,
			timelineSlices: derived.summaries.length,
		};
		const includedCounts: TimelineAuditCountsV3 = {
			rawObservations: rawObservations.length,
			semanticEvents: semanticEvents.length,
			evidenceFacts: facts.length,
			sourceEpisodes: episodes.length,
			episodeSlices: episodeSlices.length,
			sourceTimelineSummaries: summaries.length,
			timelineSlices: timelineSlices.length,
		};
		const omittedCounts = subtractAuditCounts(candidateCounts, includedCounts);
		const rangeWasClipped = Object.values(omittedCounts).some(
			(count) => count > 0,
		);
		const invalidRawObservationCount =
			raw.rawObservations.length - validatedRawObservations.length;
		const exportWarnings = [
			...(rangeWasClipped ? ["candidate_records_omitted"] : []),
			...(invalidRawObservationCount > 0
				? ["invalid_raw_observation_omitted"]
				: []),
			...(episodeSlices.some(
				(slice) =>
					slice.clippedAtStart || slice.clippedAtEnd || slice.evidencePruned,
			)
				? ["derived_episode_recomputed_for_exact_range"]
				: []),
			...(timelineSlices.some(
				(slice) =>
					slice.clippedAtStart || slice.clippedAtEnd || slice.evidencePruned,
			)
				? ["derived_timeline_clipped_to_exact_range"]
				: []),
		];
		const coverage = mergeCoverage([
			raw.coverage,
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
				rawObservationCount: rawObservations.length,
				semanticEventCount: semanticEvents.length,
				evidenceFactCount: facts.length,
				sourceEpisodeCount: episodes.length,
				episodeSliceCount: episodeSlices.length,
				sourceTimelineSummaryCount: summaries.length,
				timelineSliceCount: timelineSlices.length,
				lineageEntryCount: lineage.length,
				candidateCounts,
				includedCounts,
				omittedCounts,
				exportWarnings,
				rangeBoundaryOmissions: omittedCounts,
			},
			permissions: structuredClone(raw.permissions),
			coverage,
			rawObservations,
			semanticEvents,
			evidenceFacts: facts,
			episodes,
			episodeSlices,
			timelineSummaries: summaries,
			timelineSlices,
			lineage,
		};
	}
}

async function buildEpisodeSlices(options: {
	episodes: readonly ActivityEpisodeV2[];
	facts: readonly EvidenceFactV2[];
	fromMs: number;
	toMs: number;
	includeDecryptedContent: boolean;
}): Promise<EpisodeSliceV3[]> {
	const classifier = new HeuristicTimelineEpisodeClassifier();
	const factById = new Map(
		options.facts.map((fact) => [fact.factId, fact] as const),
	);
	const slices: EpisodeSliceV3[] = [];
	for (const sourceEpisode of options.episodes) {
		const sourceEvidenceFactIds = unique([
			...sourceEpisode.evidenceFactIds,
			...sourceEpisode.supportingFactIds,
		]);
		const evidence = sourceEvidenceFactIds
			.map((factId) => factById.get(factId))
			.filter((fact): fact is EvidenceFactV2 => fact !== undefined)
			.sort(compareFacts);
		if (evidence.length === 0) continue;
		const classificationEvidence = sourceEpisode.evidenceFactIds
			.map((factId) => factById.get(factId))
			.filter((fact): fact is EvidenceFactV2 => fact !== undefined);
		const classification = await classifier.classify(
			classificationEvidence.length > 0 ? classificationEvidence : evidence,
			null,
		);
		// The audit repository retains only goalVersion, not the goal text.
		// Relevance therefore cannot be truthfully recomputed for this slice.
		classification.goalRelevance = null;
		const evidenceFactIds = sourceEpisode.evidenceFactIds.filter((factId) =>
			factById.has(factId),
		);
		const supportingFactIds = sourceEpisode.supportingFactIds.filter((factId) =>
			factById.has(factId),
		);
		const citedFactId =
			evidenceFactIds[0] ?? supportingFactIds[0] ?? evidence[0]!.factId;
		const period = factPeriod(evidence);
		slices.push({
			schemaVersion: EPISODE_SLICE_SCHEMA_VERSION,
			episodeSliceId: [
				"episode_slice",
				sourceEpisode.revisionId,
				options.fromMs,
				options.toMs,
			].join("_"),
			sourceEpisodeId: sourceEpisode.episodeId,
			sourceEpisodeRevisionId: sourceEpisode.revisionId,
			sourceWindowIds: [...sourceEpisode.sourceWindowIds],
			sourcePeriod: {
				startedAtMs: sourceEpisode.startedAtMs,
				endedAtMs: sourceEpisode.endedAtMs,
			},
			period,
			clippedAtStart: sourceEpisode.startedAtMs < options.fromMs,
			clippedAtEnd: sourceEpisode.endedAtMs > options.toMs,
			evidencePruned: evidence.length !== sourceEvidenceFactIds.length,
			goalVersion: sourceEpisode.goalVersion,
			inferenceScope: "range_recomputed",
			classification,
			hypothesis: {
				text: options.includeDecryptedContent
					? auditHypothesisTemplate(classification.activity)
					: "[redacted]",
				citedFactIds: [citedFactId],
				generator: "deterministic-template.v2",
			},
			evidenceFactIds,
			supportingFactIds,
			coverage: mergeCoverage(evidence.map((fact) => fact.coverage)),
		});
	}
	return slices.sort(
		(left, right) =>
			left.period.startedAtMs - right.period.startedAtMs ||
			left.episodeSliceId.localeCompare(right.episodeSliceId),
	);
}

function buildTimelineSlices(options: {
	summaries: readonly TimelineSummaryV2[];
	episodeSlices: readonly EpisodeSliceV3[];
	facts: readonly EvidenceFactV2[];
	fromMs: number;
	toMs: number;
	includeDecryptedContent: boolean;
}): TimelineSliceV3[] {
	const factById = new Map(
		options.facts.map((fact) => [fact.factId, fact] as const),
	);
	const episodeSliceBySourceRevisionId = new Map(
		options.episodeSlices.map(
			(slice) => [slice.sourceEpisodeRevisionId, slice] as const,
		),
	);
	const slices: TimelineSliceV3[] = [];
	for (const summary of options.summaries) {
		const segments: TimelineSegmentSliceV3[] = [];
		for (
			let sourceSegmentIndex = 0;
			sourceSegmentIndex < summary.segments.length;
			sourceSegmentIndex += 1
		) {
			const sourceSegment = summary.segments[sourceSegmentIndex];
			if (!sourceSegment) continue;
			const episodeSlice = episodeSliceBySourceRevisionId.get(
				sourceSegment.episodeRevisionId,
			);
			if (
				!episodeSlice ||
				episodeSlice.sourceEpisodeId !== sourceSegment.episodeId
			) {
				continue;
			}
			const episodeSliceFactIds = new Set([
				...episodeSlice.evidenceFactIds,
				...episodeSlice.supportingFactIds,
			]);
			const sourceEvidenceFactIds = unique(
				sourceSegment.evidence.map((fact) => fact.factId),
			);
			const evidence = sourceEvidenceFactIds
				.filter((factId) => episodeSliceFactIds.has(factId))
				.map((factId) => factById.get(factId))
				.filter((fact): fact is EvidenceFactV2 => fact !== undefined)
				.sort(compareFacts);
			if (evidence.length === 0) continue;
			const period = factPeriod(evidence);
			segments.push({
				segmentSliceId: [
					"timeline_segment_slice",
					summary.timelineId,
					sourceSegmentIndex,
					options.fromMs,
					options.toMs,
				].join("_"),
				episodeSliceId: episodeSlice.episodeSliceId,
				sourceEpisodeId: sourceSegment.episodeId,
				sourceEpisodeRevisionId: sourceSegment.episodeRevisionId,
				sourcePeriod: {
					startedAtMs: sourceSegment.startedAtMs,
					endedAtMs: sourceSegment.endedAtMs,
				},
				period,
				clippedAtStart: sourceSegment.startedAtMs < options.fromMs,
				clippedAtEnd: sourceSegment.endedAtMs > options.toMs,
				evidencePruned: evidence.length !== sourceEvidenceFactIds.length,
				evidenceFactIds: evidence.map((fact) => fact.factId),
			});
		}
		if (segments.length === 0) continue;
		segments.sort(
			(left, right) =>
				left.period.startedAtMs - right.period.startedAtMs ||
				left.segmentSliceId.localeCompare(right.segmentSliceId),
		);
		const period = {
			startedAtMs: Math.min(
				...segments.map((segment) => segment.period.startedAtMs),
			),
			endedAtMs: Math.max(
				...segments.map((segment) => segment.period.endedAtMs),
			),
		};
		const includedFacts = segments
			.flatMap((segment) => segment.evidenceFactIds)
			.map((factId) => factById.get(factId))
			.filter((fact): fact is EvidenceFactV2 => fact !== undefined);
		const includedEpisodeSlices = segments
			.map((segment) =>
				options.episodeSlices.find(
					(slice) => slice.episodeSliceId === segment.episodeSliceId,
				),
			)
			.filter((slice): slice is EpisodeSliceV3 => slice !== undefined);
		const modelVersions = unique(
			includedEpisodeSlices.flatMap((slice) => [
				slice.classification.modelVersion,
				slice.hypothesis.generator,
			]),
		);
		const evidencePruned =
			segments.length !== summary.segments.length ||
			segments.some((segment) => segment.evidencePruned);
		slices.push({
			schemaVersion: TIMELINE_SLICE_SCHEMA_VERSION,
			timelineSliceId: [
				"timeline_slice",
				summary.timelineId,
				options.fromMs,
				options.toMs,
			].join("_"),
			sourceTimelineId: summary.timelineId,
			sourceWindowId: summary.windowId,
			triggerReason: summary.triggerReason,
			triggeredAtMs: summary.triggeredAtMs ?? summary.period.endedAtMs,
			deadlineAtMs: summary.deadlineAtMs ?? summary.period.endedAtMs,
			sourcePeriod: structuredClone(summary.period),
			period,
			clippedAtStart:
				summary.period.startedAtMs < options.fromMs ||
				segments.some((segment) => segment.clippedAtStart),
			clippedAtEnd:
				summary.period.endedAtMs > options.toMs ||
				segments.some((segment) => segment.clippedAtEnd),
			evidencePruned,
			goalVersion: summary.goalVersion,
			inferenceScope: "range_recomputed",
			sourceSegmentCount: summary.segments.length,
			includedSegmentCount: segments.length,
			segments,
			coverage: mergeCoverage(includedFacts.map((fact) => fact.coverage)),
			renderedText: options.includeDecryptedContent
				? renderSliceText(segments, episodeSliceBySourceRevisionId, factById)
				: "[redacted]",
			modelVersions,
			inferenceDiagnostics: [],
			taxonomyVersion: summary.taxonomyVersion,
			projectorVersion: summary.projectorVersion,
		});
	}
	return slices.sort(
		(left, right) =>
			left.period.startedAtMs - right.period.startedAtMs ||
			left.timelineSliceId.localeCompare(right.timelineSliceId),
	);
}

function auditHypothesisTemplate(
	activity: EpisodeSliceV3["classification"]["activity"],
): string {
	switch (activity) {
		case "development":
			return "可能在进行软件开发或排查技术问题";
		case "writing":
			return "可能在编辑或整理文字内容";
		case "research":
			return "可能在查阅和研究资料";
		case "communication":
			return "可能在处理沟通消息";
		case "planning":
			return "可能在规划或安排接下来的工作";
		case "data_work":
			return "可能在查看或处理数据";
		case "media":
			return "可能在查看或播放媒体内容";
		case "gaming":
			return "可能在进行游戏活动";
		case "system_file_ops":
			return "可能在管理系统或文件";
		case "commerce":
			return "可能在浏览商品或处理交易相关页面";
		case "idle_transition":
			return "可能在暂离、锁屏或恢复电脑活动";
		case "other_unknown":
			return "可能在进行当前可见操作";
	}
}

function renderSliceText(
	segments: readonly TimelineSegmentSliceV3[],
	episodeSliceBySourceRevisionId: ReadonlyMap<string, EpisodeSliceV3>,
	factById: ReadonlyMap<string, EvidenceFactV2>,
): string {
	const lines: string[] = [];
	for (const segment of segments) {
		const episodeSlice = episodeSliceBySourceRevisionId.get(
			segment.sourceEpisodeRevisionId,
		);
		if (!episodeSlice) continue;
		lines.push(
			`- ${auditTime(segment.period.startedAtMs)}–${auditTime(segment.period.endedAtMs)}，${episodeSlice.hypothesis.text}`,
		);
		for (const factId of segment.evidenceFactIds) {
			const fact = factById.get(factId);
			if (!fact) continue;
			lines.push(`  - ${auditTime(fact.startedAtMs)} ${fact.renderedText}`);
		}
	}
	return lines.join("\n");
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
		left.factId.localeCompare(right.factId)
	);
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function episodeSliceFactKey(episodeSliceId: string, factId: string): string {
	return `${episodeSliceId}\u001f${factId}`;
}

function subtractAuditCounts(
	candidate: TimelineAuditCountsV3,
	included: TimelineAuditCountsV3,
): TimelineAuditCountsV3 {
	return {
		rawObservations: Math.max(
			0,
			candidate.rawObservations - included.rawObservations,
		),
		semanticEvents: Math.max(
			0,
			candidate.semanticEvents - included.semanticEvents,
		),
		evidenceFacts: Math.max(
			0,
			candidate.evidenceFacts - included.evidenceFacts,
		),
		sourceEpisodes: Math.max(
			0,
			candidate.sourceEpisodes - included.sourceEpisodes,
		),
		episodeSlices: Math.max(
			0,
			candidate.episodeSlices - included.episodeSlices,
		),
		sourceTimelineSummaries: Math.max(
			0,
			candidate.sourceTimelineSummaries - included.sourceTimelineSummaries,
		),
		timelineSlices: Math.max(
			0,
			candidate.timelineSlices - included.timelineSlices,
		),
	};
}

function auditTime(timestampMs: number): string {
	return new Date(timestampMs).toLocaleTimeString("zh-CN", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function observationIdentifier(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
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
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
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

const RAW_OBSERVATION_TOP_LEVEL_KEYS = new Set([
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
	"metadata",
	"contentState",
	"content",
	"dedupHash",
]);

function projectRawObservationForAudit(
	value: unknown,
	includeDecryptedContent: boolean,
): Record<string, JsonValue> | null {
	if (!isRecord(value) || !hasOnlyKeys(value, RAW_OBSERVATION_TOP_LEVEL_KEYS)) {
		return null;
	}
	const {
		schemaVersion,
		observationId,
		cursor,
		deviceId,
		sessionId,
		kind,
		interval,
		source,
		subject,
		reliability,
		coverage,
		redactions,
		metadata,
		contentState,
		content,
		dedupHash,
	} = value;
	if (
		schemaVersion !== "raw-observation.v2" ||
		!isNonEmptyString(observationId) ||
		!isNonEmptyString(cursor) ||
		!isNonEmptyString(deviceId) ||
		!isNonEmptyString(sessionId) ||
		!isNonEmptyString(kind) ||
		!validRawInterval(interval) ||
		!validRawSource(source) ||
		!validRawSubject(subject) ||
		!["high", "medium", "low"].includes(String(reliability)) ||
		!validCoverage(coverage) ||
		!Array.isArray(redactions) ||
		!redactions.every(isString) ||
		!isRecord(metadata) ||
		!["available", "redacted", "expired", "unavailable"].includes(
			String(contentState),
		) ||
		(content !== undefined && !isRecord(content)) ||
		!isNonEmptyString(dedupHash)
	) {
		return null;
	}
	if (
		kind === "authorization.changed" &&
		!validRawAuthorizationEnvelope({
			interval,
			source,
			subject,
			reliability,
			coverage,
			redactions,
			contentState,
			content,
		})
	) {
		return null;
	}
	const payload = projectRawKindPayload(
		kind,
		source.sensor as string,
		metadata,
		content,
	);
	if (!payload) return null;
	const result: Record<string, JsonValue> = {
		schemaVersion,
		observationId,
		cursor,
		deviceId,
		sessionId,
		kind,
		interval: structuredClone(interval) as JsonValue,
		source: structuredClone(source) as JsonValue,
		subject: structuredClone(subject) as JsonValue,
		reliability: reliability as JsonValue,
		coverage: structuredClone(coverage),
		redactions: structuredClone(redactions) as JsonValue,
		metadata: payload.metadata,
		contentState: contentState as JsonValue,
		dedupHash,
	};
	if (includeDecryptedContent && payload.content !== undefined) {
		result.content = payload.content;
	}
	return result;
}

function projectRawKindPayload(
	kind: string,
	sensor: string,
	metadata: Record<string, unknown>,
	content: Record<string, unknown> | undefined,
): {
	metadata: Record<string, JsonValue>;
	content?: Record<string, JsonValue>;
} | null {
	switch (kind) {
		case "workspace.foregroundChanged":
			if (
				sensor !== "workspace" ||
				!exactKeys(metadata, ["processId"]) ||
				!isNonNegativeSafeInteger(metadata.processId) ||
				content !== undefined
			) {
				return null;
			}
			break;
		case "ax.focusChanged":
		case "ax.valueChanged":
		case "ax.visibleContentChanged":
			if (
				sensor !== "ax" ||
				!exactKeys(
					metadata,
					["processId", "protectedInput"],
					[
						"focusedRole",
						"focusedSubrole",
						"opaqueControlId",
						"finalValueAvailable",
					],
				) ||
				!isNonNegativeSafeInteger(metadata.processId) ||
				typeof metadata.protectedInput !== "boolean" ||
				!optionalString(metadata.focusedRole) ||
				!optionalString(metadata.focusedSubrole) ||
				!optionalString(metadata.opaqueControlId) ||
				!optionalBoolean(metadata.finalValueAvailable) ||
				!optionalExactStringRecord(
					content,
					[],
					[
						"windowTitle",
						"focusedLabel",
						"finalValue",
						"inputOrigin",
						"selectedText",
						"visibleText",
					],
				)
			) {
				return null;
			}
			break;
		case "screen.visibleTextChanged":
			if (
				sensor !== "ocr" ||
				!exactKeys(metadata, ["languageHints"]) ||
				!Array.isArray(metadata.languageHints) ||
				!metadata.languageHints.every(isString) ||
				!optionalExactStringRecord(content, ["visibleText"], [], true)
			) {
				return null;
			}
			break;
		case "browser.visiblePageChanged":
			if (
				!["apple_events", "ax", "ocr"].includes(sensor) ||
				!exactKeys(metadata, []) ||
				!optionalExactStringRecord(content, ["title", "url"], ["visibleText"])
			) {
				return null;
			}
			break;
		case "input.activityBucket":
			if (
				sensor !== "cg_activity" ||
				!exactKeys(
					metadata,
					["keyCount", "clickCount", "scrollDelta", "mouseDistance"],
					["coalescedBucketCount"],
				) ||
				!isNonNegativeSafeInteger(metadata.keyCount) ||
				!isNonNegativeSafeInteger(metadata.clickCount) ||
				!isFiniteNumber(metadata.scrollDelta) ||
				!isFiniteNumber(metadata.mouseDistance) ||
				(metadata.coalescedBucketCount !== undefined &&
					(!isNonNegativeSafeInteger(metadata.coalescedBucketCount) ||
						metadata.coalescedBucketCount < 2 ||
						metadata.coalescedBucketCount > 256)) ||
				content !== undefined
			) {
				return null;
			}
			break;
		case "coverage.gap":
			if (
				!["workspace", "ax", "ocr"].includes(sensor) ||
				!exactKeys(metadata, []) ||
				content !== undefined
			) {
				return null;
			}
			break;
		case "ui.controlActivated":
			if (
				sensor !== "ax" ||
				!exactKeys(metadata, [], ["role"]) ||
				!optionalString(metadata.role) ||
				!optionalExactStringRecord(content, [], ["label"])
			) {
				return null;
			}
			break;
		case "presence.changed":
			if (
				sensor !== "workspace" ||
				!exactKeys(metadata, ["state"], ["idleForMs"]) ||
				!isNonEmptyString(metadata.state) ||
				(metadata.idleForMs !== undefined &&
					!isNonNegativeSafeInteger(metadata.idleForMs)) ||
				content !== undefined
			) {
				return null;
			}
			break;
		case "goal.changed":
			if (
				sensor !== "workspace" ||
				!exactKeys(metadata, []) ||
				(content !== undefined && !validGoalChangeContent(content))
			) {
				return null;
			}
			break;
		case "authorization.changed":
			if (
				sensor !== "workspace" ||
				!exactKeys(metadata, [
					"permissions",
					"changedPermissions",
					"transition",
					"reason",
				]) ||
				!validAuthorizationPermissions(metadata.permissions) ||
				!validChangedPermissionList(metadata.changedPermissions) ||
				![
					"baseline",
					"changed",
					"granted",
					"revoked",
					"mixed",
				].includes(String(metadata.transition)) ||
				![
					"startup_snapshot",
					"runtime_change",
					"manual_refresh",
					"status_request",
					"heartbeat_check",
					"legacy_status",
				].includes(String(metadata.reason)) ||
				content !== undefined
			) {
				return null;
			}
			break;
		case "application.processObservedBatch":
			if (
				sensor !== "workspace" ||
				!exactKeys(metadata, ["started", "exited"]) ||
				!validProcessEntries(metadata.started) ||
				!validProcessEntries(metadata.exited) ||
				content !== undefined
			) {
				return null;
			}
			break;
		default:
			return null;
	}
	return {
		metadata: structuredClone(metadata) as Record<string, JsonValue>,
		...(content === undefined
			? {}
			: {
					content: structuredClone(content) as Record<string, JsonValue>,
				}),
	};
}

function validRawAuthorizationEnvelope(value: {
	interval: Record<string, JsonValue>;
	source: Record<string, JsonValue>;
	subject: Record<string, JsonValue>;
	reliability: unknown;
	coverage: CoverageLevel[];
	redactions: unknown[];
	contentState: unknown;
	content: Record<string, unknown> | undefined;
}): boolean {
	return (
		value.interval.startedAtMs === value.interval.endedAtMs &&
		value.source.sensor === "workspace" &&
		value.source.adapterVersion === "observer-authorization.v2" &&
		value.subject.appId === "system.authorization" &&
		value.subject.appName === "macOS" &&
		(value.subject.opaqueWindowId === undefined ||
			value.subject.opaqueWindowId === null) &&
		value.reliability === "high" &&
		value.coverage.length === 1 &&
		value.coverage[0] === "metadata" &&
		value.redactions.length === 0 &&
		value.contentState === "available" &&
		value.content === undefined
	);
}

const AUTHORIZATION_PERMISSION_NAMES = [
	"accessibility",
	"screenRecording",
	"inputMonitoring",
	"automation",
] as const;

function validAuthorizationPermissions(value: unknown): boolean {
	return (
		isRecord(value) &&
		exactKeys(value, [...AUTHORIZATION_PERMISSION_NAMES]) &&
		AUTHORIZATION_PERMISSION_NAMES.every((permission) =>
			[
				"unknown",
				"granted",
				"denied",
				"not_determined",
				"unsupported",
			].includes(String(value[permission])),
		)
	);
}

function validChangedPermissionList(value: unknown): boolean {
	if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
		return false;
	}
	const uniquePermissions = new Set(value);
	return (
		uniquePermissions.size === value.length &&
		value.every(
			(permission) =>
				typeof permission === "string" &&
				AUTHORIZATION_PERMISSION_NAMES.includes(
					permission as (typeof AUTHORIZATION_PERMISSION_NAMES)[number],
				),
		)
	);
}

function validRawInterval(value: unknown): value is Record<string, JsonValue> {
	return (
		isRecord(value) &&
		exactKeys(value, ["startedAtMs", "endedAtMs"]) &&
		isNonNegativeSafeInteger(value.startedAtMs) &&
		isNonNegativeSafeInteger(value.endedAtMs) &&
		value.endedAtMs >= value.startedAtMs
	);
}

function validRawSource(value: unknown): value is Record<string, JsonValue> {
	return (
		isRecord(value) &&
		exactKeys(value, ["sensor", "adapterVersion"]) &&
		typeof value.sensor === "string" &&
		["workspace", "ax", "ocr", "apple_events", "cg_activity"].includes(
			value.sensor,
		) &&
		isNonEmptyString(value.adapterVersion)
	);
}

function validRawSubject(value: unknown): value is Record<string, JsonValue> {
	return (
		isRecord(value) &&
		exactKeys(value, ["appId", "appName"], ["opaqueWindowId"]) &&
		isNonEmptyString(value.appId) &&
		isNonEmptyString(value.appName) &&
		(value.opaqueWindowId === undefined ||
			value.opaqueWindowId === null ||
			isNonEmptyString(value.opaqueWindowId))
	);
}

function validCoverage(value: unknown): value is CoverageLevel[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(item) =>
				typeof item === "string" &&
				["content", "metadata", "redacted", "denied", "unavailable"].includes(
					item,
				),
		)
	);
}

function optionalExactStringRecord(
	value: Record<string, unknown> | undefined,
	required: readonly string[],
	optional: readonly string[] = [],
	requireWhenPresent = false,
): boolean {
	if (value === undefined) return true;
	if (!exactKeys(value, required, optional)) return false;
	if (
		!required.every((key) => isString(value[key])) ||
		!optional.every((key) => value[key] === undefined || isString(value[key]))
	) {
		return false;
	}
	return !requireWhenPresent || required.length > 0;
}

function validGoalChangeContent(value: Record<string, unknown>): boolean {
	return (
		exactKeys(value, ["previous", "next"]) &&
		validGoalContext(value.previous) &&
		validGoalContext(value.next)
	);
}

function validGoalContext(value: unknown): boolean {
	if (value === null) return true;
	return (
		isRecord(value) &&
		exactKeys(value, [
			"goalId",
			"planId",
			"version",
			"text",
			"activatedAtMs",
		]) &&
		isNonEmptyString(value.goalId) &&
		(value.planId === null || isNonEmptyString(value.planId)) &&
		isNonNegativeSafeInteger(value.version) &&
		isString(value.text) &&
		isNonNegativeSafeInteger(value.activatedAtMs)
	);
}

function validProcessEntries(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				isRecord(entry) &&
				exactKeys(entry, ["processId", "appId", "appName"]) &&
				isNonNegativeSafeInteger(entry.processId) &&
				isNonEmptyString(entry.appId) &&
				isNonEmptyString(entry.appName),
		)
	);
}

function exactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return (
		required.every((key) => key in value) &&
		Object.keys(value).every((key) => allowed.has(key))
	);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
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
			event.contentState === "available" ? "redacted" : event.contentState,
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
		} else if (typeof child === "object" && child !== null) {
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
			typeof value === "string" && CONTENT_KEYS.has(key) ? "[redacted]" : value;
	}
	return result;
}
