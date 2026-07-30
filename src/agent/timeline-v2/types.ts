import type {
	ActiveGoalContextV1,
	ActivityLabel,
	GoalRelevanceLabel,
	ReflectionTriggerReason,
} from "../reflection/types";
import type { OllamaClientErrorCode } from "../model/ollama-json-client";

export const SEMANTIC_EVENT_V2_SCHEMA_VERSION = "semantic-event.v2" as const;
export const TIMELINE_COLLECTOR_SCHEMA_VERSION =
	"timeline-collector-snapshot.v2" as const;
export const TIMELINE_WINDOW_SCHEMA_VERSION = "timeline-window.v2" as const;
export const EVIDENCE_FACT_SCHEMA_VERSION = "evidence-fact.v2" as const;
export const ACTIVITY_EPISODE_SCHEMA_VERSION = "activity-episode.v2" as const;
export const TIMELINE_SUMMARY_SCHEMA_VERSION = "timeline-summary.v2" as const;
export const AGENT_INPUT_SCHEMA_VERSION = "agent-input.v1" as const;
export const TIMELINE_JOB_SCHEMA_VERSION = "timeline-job.v2" as const;
export const TIMELINE_AUDIT_SCHEMA_VERSION = "timeline-audit.v3" as const;
export const EPISODE_SLICE_SCHEMA_VERSION = "episode-slice.v3" as const;
export const TIMELINE_SLICE_SCHEMA_VERSION = "timeline-slice.v3" as const;
export const TIMELINE_TAXONOMY_VERSION = "activity-taxonomy.v2" as const;
export const TIMELINE_PROJECTOR_VERSION = "timeline-projector.v2" as const;

export const SEMANTIC_EVENT_KINDS = [
	"application.foregroundChanged",
	"application.visibleContentChanged",
	"application.textValueChanged",
	"browser.visiblePageChanged",
	"ui.focusChanged",
	"ui.controlActivated",
	"input.activityBucket",
	"presence.changed",
	"goal.changed",
	"authorization.changed",
	"application.processObservedBatch",
	"coverage.gap",
] as const;

export type SemanticEventKind = (typeof SEMANTIC_EVENT_KINDS)[number];
export type SemanticCountClass =
	| "effective"
	| "boundary"
	| "context"
	| "ignored";
export type EvidenceReliability = "high" | "medium" | "low";
export type CoverageLevel =
	| "content"
	| "metadata"
	| "redacted"
	| "denied"
	| "unavailable";
export type SemanticContentState =
	| "available"
	| "redacted"
	| "expired"
	| "unavailable";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| { [key: string]: JsonValue }
	| JsonValue[];

/**
 * Handwritten TypeScript mirror of the Rust semantic journal contract.
 *
 * Content fields can be present only when semantic.query is called with
 * includeContent=true. Callers must seal any returned content through the
 * Rust vault before advancing the semantic consumer cursor.
 */
export type SemanticEventV2 = {
	schemaVersion: typeof SEMANTIC_EVENT_V2_SCHEMA_VERSION;
	eventId: string;
	cursor: string;
	deviceId: string;
	sessionId: string;
	kind: SemanticEventKind;
	source: string;
	occurredAtMs: number;
	observedAtMs: number;
	goalVersion: number | null;
	countClass: SemanticCountClass;
	reliability: EvidenceReliability;
	coverage: CoverageLevel[];
	contentState: SemanticContentState;
	sourceObservationIds: string[];
	taxonomyVersion: string;
	projectorVersion: string;
	payload: Record<string, JsonValue>;
};

export type TimelineCollectorState =
	| "RECOVERING"
	| "ACTIVE_EMPTY"
	| "ACTIVE_COLLECTING"
	| "SEALED";

export type OpenTimelineWindowV2 = {
	goal: ActiveGoalContextV1 | null;
	goalVersion: number | null;
	startedAtMs: number;
	deadlineAtMs: number;
	events: SemanticEventV2[];
	effectiveEventCount: number;
};

export type TimelineCollectorSnapshotV2 = {
	schemaVersion: typeof TIMELINE_COLLECTOR_SCHEMA_VERSION;
	collectorId: string;
	deviceId: string;
	sessionId: string;
	state: "ACTIVE_EMPTY" | "ACTIVE_COLLECTING";
	activeGoal: ActiveGoalContextV1 | null;
	openWindow: OpenTimelineWindowV2 | null;
	contextCandidates: SemanticEventV2[];
	recentEventIds: string[];
	materializedCursor: string | null;
	revision: number;
	updatedAtMs: number;
};

export type TimelineWindowV2 = {
	schemaVersion: typeof TIMELINE_WINDOW_SCHEMA_VERSION;
	windowId: string;
	collectorId: string;
	deviceId: string;
	sessionId: string;
	triggerReason: ReflectionTriggerReason;
	goal: ActiveGoalContextV1 | null;
	goalVersion: number | null;
	startedAtMs: number;
	endedAtMs: number;
	deadlineAtMs: number;
	eventCount: number;
	firstCursor: string;
	lastCursor: string;
	events: SemanticEventV2[];
	contextOnly: SemanticEventV2[];
	inputHash: string;
};

export type FactTemplateCode =
	| "application.foreground"
	| "application.visible_content"
	| "application.text_value"
	| "browser.visible_page"
	| "ui.focus"
	| "ui.control_activated"
	| "input.activity"
	| "presence.changed"
	| "goal.changed"
	| "coverage.unavailable";

export type EvidenceAnchorV2 = {
	appId: string | null;
	windowId: string | null;
	documentId: string | null;
	pageId: string | null;
};

export type EvidenceFactV2 = {
	schemaVersion: typeof EVIDENCE_FACT_SCHEMA_VERSION;
	factId: string;
	eventIds: string[];
	sourceObservationIds: string[];
	startedAtMs: number;
	endedAtMs: number;
	templateCode: FactTemplateCode;
	templateArgs: Record<string, JsonPrimitive>;
	renderedText: string;
	anchor: EvidenceAnchorV2;
	role: "primary" | "supporting" | "boundary";
	reliability: EvidenceReliability;
	coverage: CoverageLevel[];
};

export type TimelineInferenceDiagnosticV2 = {
	source: "qwen3:4b";
	stage: "model_lock" | "readiness_probe" | "pack_selection" | "generation";
	code:
		| "model_verification_disabled"
		| "model_lock_failed"
		| "pack_limit"
		| "input_unavailable"
		| "unexpected_failure"
		| `ollama.${OllamaClientErrorCode}`;
	retryable: boolean;
	httpStatus: number | null;
	/**
	 * Counts are safe to persist; episode/fact identifiers and generated or
	 * prompt content must never be placed in diagnostics.
	 */
	affectedEpisodeCount: number | null;
};

export type EpisodeHypothesisV2 = {
	text: string;
	citedFactIds: string[];
	generator: "qwen3:4b-cited.v2" | "deterministic-template.v2";
	diagnostics?: TimelineInferenceDiagnosticV2[];
};

export type EpisodeClassificationV2 = {
	activity: ActivityLabel;
	goalRelevance: GoalRelevanceLabel | null;
	confidence: number;
	oodScore: number;
	abstain: boolean;
	modelVersion: string;
};

export type ActivityEpisodeV2 = {
	schemaVersion: typeof ACTIVITY_EPISODE_SCHEMA_VERSION;
	episodeId: string;
	revisionId: string;
	revision: number;
	supersedesRevisionId: string | null;
	sourceWindowIds: string[];
	startedAtMs: number;
	endedAtMs: number;
	goalVersion: number | null;
	anchor: EvidenceAnchorV2;
	classification: EpisodeClassificationV2;
	hypothesis: EpisodeHypothesisV2;
	evidenceFactIds: string[];
	supportingFactIds: string[];
	coverage: CoverageLevel[];
};

export type TimelineSegmentV2 = {
	episodeId: string;
	episodeRevisionId: string;
	startedAtMs: number;
	endedAtMs: number;
	activity: ActivityLabel;
	goalRelevance: GoalRelevanceLabel | null;
	hypothesis: EpisodeHypothesisV2;
	evidence: EvidenceFactV2[];
};

export type TimelineSummaryV2 = {
	schemaVersion: typeof TIMELINE_SUMMARY_SCHEMA_VERSION;
	timelineId: string;
	windowId: string;
	triggerReason: ReflectionTriggerReason;
	triggeredAtMs: number;
	deadlineAtMs: number;
	period: { startedAtMs: number; endedAtMs: number };
	goalVersion: number | null;
	segments: TimelineSegmentV2[];
	coverage: CoverageLevel[];
	coverageWarnings: string[];
	renderedText: string;
	modelVersions: string[];
	inferenceDiagnostics: TimelineInferenceDiagnosticV2[];
	taxonomyVersion: string;
	projectorVersion: string;
	createdAtMs: number;
	revision: number;
	correctsTimelineId: string | null;
};

export type AgentInputState = "HELD_LOCAL" | "READY" | "LEASED" | "ACKED";

export type AgentInputV1 = {
	schemaVersion: typeof AGENT_INPUT_SCHEMA_VERSION;
	agentInputId: string;
	idempotencyKey: string;
	timelineId: string;
	windowId: string;
	triggerReason: ReflectionTriggerReason;
	triggeredAtMs: number;
	deadlineAtMs: number;
	period: { startedAtMs: number; endedAtMs: number };
	goal: ActiveGoalContextV1 | null;
	segments: TimelineSegmentV2[];
	renderedText: string;
	coverage: CoverageLevel[];
	modelVersions: string[];
	inferenceDiagnostics: TimelineInferenceDiagnosticV2[];
	taxonomyVersion: string;
	projectorVersion: string;
	payloadHash: string;
	createdAtMs: number;
};

export type AgentInputEnvelopeV1 = {
	input: AgentInputV1;
	state: AgentInputState;
	leaseToken: string | null;
	leaseExpiresAtMs: number | null;
	attempt: number;
	ackedAtMs: number | null;
};

export type TimelineJobState =
	| "READY"
	| "RUNNING"
	| "RESULT_PERSISTED"
	| "COMMITTING"
	| "RETRY_WAIT"
	| "COMMITTED"
	| "TERMINAL_FAILED";

export type TimelineJobV2 = {
	schemaVersion: typeof TIMELINE_JOB_SCHEMA_VERSION;
	windowId: string;
	state: TimelineJobState;
	attempt: number;
	createdAtMs: number;
	updatedAtMs: number;
	nextAttemptAtMs: number | null;
	leaseExpiresAtMs: number | null;
	firstAttemptAtMs: number | null;
	failureCode: string | null;
	failureMessage: string | null;
};

export type TimelineAuditCountsV3 = {
	rawObservations: number;
	semanticEvents: number;
	evidenceFacts: number;
	sourceEpisodes: number;
	episodeSlices: number;
	sourceTimelineSummaries: number;
	timelineSlices: number;
};

export type EpisodeSliceV3 = {
	schemaVersion: typeof EPISODE_SLICE_SCHEMA_VERSION;
	episodeSliceId: string;
	sourceEpisodeId: string;
	sourceEpisodeRevisionId: string;
	sourceWindowIds: string[];
	sourcePeriod: { startedAtMs: number; endedAtMs: number };
	period: { startedAtMs: number; endedAtMs: number };
	clippedAtStart: boolean;
	clippedAtEnd: boolean;
	evidencePruned: boolean;
	goalVersion: number | null;
	inferenceScope: "range_recomputed";
	classification: EpisodeClassificationV2;
	hypothesis: EpisodeHypothesisV2;
	evidenceFactIds: string[];
	supportingFactIds: string[];
	coverage: CoverageLevel[];
};

export type TimelineSegmentSliceV3 = {
	segmentSliceId: string;
	episodeSliceId: string;
	sourceEpisodeId: string;
	sourceEpisodeRevisionId: string;
	sourcePeriod: { startedAtMs: number; endedAtMs: number };
	period: { startedAtMs: number; endedAtMs: number };
	clippedAtStart: boolean;
	clippedAtEnd: boolean;
	evidencePruned: boolean;
	evidenceFactIds: string[];
};

export type TimelineSliceV3 = {
	schemaVersion: typeof TIMELINE_SLICE_SCHEMA_VERSION;
	timelineSliceId: string;
	sourceTimelineId: string;
	sourceWindowId: string;
	triggerReason: ReflectionTriggerReason | "audit_range";
	triggeredAtMs: number;
	deadlineAtMs: number;
	sourcePeriod: { startedAtMs: number; endedAtMs: number };
	period: { startedAtMs: number; endedAtMs: number };
	clippedAtStart: boolean;
	clippedAtEnd: boolean;
	evidencePruned: boolean;
	goalVersion: number | null;
	inferenceScope: "range_recomputed";
	sourceSegmentCount: number;
	includedSegmentCount: number;
	segments: TimelineSegmentSliceV3[];
	coverage: CoverageLevel[];
	renderedText: string;
	modelVersions: string[];
	inferenceDiagnostics: TimelineInferenceDiagnosticV2[];
	taxonomyVersion: string;
	projectorVersion: string;
};

export type TimelineAuditManifestV3 = {
	schemaVersion: typeof TIMELINE_AUDIT_SCHEMA_VERSION;
	exportedAtMs: number;
	fromMs: number;
	toMs: number;
	decryptedContentIncluded: boolean;
	rawObservationCount: number;
	semanticEventCount: number;
	evidenceFactCount: number;
	sourceEpisodeCount: number;
	episodeSliceCount: number;
	sourceTimelineSummaryCount: number;
	timelineSliceCount: number;
	lineageEntryCount: number;
	candidateCounts: TimelineAuditCountsV3;
	includedCounts: TimelineAuditCountsV3;
	omittedCounts: TimelineAuditCountsV3;
	exportWarnings: string[];
	/** @deprecated Use omittedCounts. Retained for one local protocol version. */
	rangeBoundaryOmissions: TimelineAuditCountsV3;
};

export type TimelineAuditBundleV3 = {
	manifest: TimelineAuditManifestV3;
	permissions: Record<string, JsonValue>;
	coverage: CoverageLevel[];
	rawObservations: Array<Record<string, JsonValue>>;
	semanticEvents: SemanticEventV2[];
	evidenceFacts: EvidenceFactV2[];
	/** Immutable source revisions included only when their full provenance is in range. */
	episodes: ActivityEpisodeV2[];
	/** Range-derived excerpts with identities distinct from immutable revisions. */
	episodeSlices: EpisodeSliceV3[];
	/** Immutable source summaries included only when every referenced node is in range. */
	timelineSummaries: TimelineSummaryV2[];
	/** Range-derived timelines composed only from exported episode/fact slices. */
	timelineSlices: TimelineSliceV3[];
	lineage: Array<{
		observationId: string;
		eventId: string | null;
		factId: string | null;
		sourceEpisodeId: string | null;
		sourceEpisodeRevisionId: string | null;
		episodeSliceId: string | null;
		sourceTimelineId: string | null;
		timelineSliceId: string | null;
		timelineSegmentSliceId: string | null;
		status:
			| "summarized"
			| "episode_only"
			| "fact_only"
			| "semantic_only"
			| "ignored"
			| "unreferenced_raw";
	}>;
};

/** @deprecated Use TimelineAuditManifestV3. */
export type TimelineAuditManifestV2 = TimelineAuditManifestV3;
/** @deprecated Use TimelineAuditBundleV3. */
export type TimelineAuditBundleV2 = TimelineAuditBundleV3;
