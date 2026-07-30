import type {
	ActiveGoalContextV1,
	ActivityLabel,
	GoalRelevanceLabel,
	ReflectionTriggerReason,
} from "../reflection/types";

export const SEMANTIC_EVENT_V2_SCHEMA_VERSION = "semantic-event.v2" as const;
export const TIMELINE_COLLECTOR_SCHEMA_VERSION =
	"timeline-collector-snapshot.v2" as const;
export const TIMELINE_WINDOW_SCHEMA_VERSION = "timeline-window.v2" as const;
export const EVIDENCE_FACT_SCHEMA_VERSION = "evidence-fact.v2" as const;
export const ACTIVITY_EPISODE_SCHEMA_VERSION = "activity-episode.v2" as const;
export const TIMELINE_SUMMARY_SCHEMA_VERSION = "timeline-summary.v2" as const;
export const AGENT_INPUT_SCHEMA_VERSION = "agent-input.v1" as const;
export const TIMELINE_JOB_SCHEMA_VERSION = "timeline-job.v2" as const;
export const TIMELINE_AUDIT_SCHEMA_VERSION = "timeline-audit.v2" as const;
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

export type EpisodeHypothesisV2 = {
	text: string;
	citedFactIds: string[];
	generator:
		| "qwen3:4b-cited.v2"
		| "deterministic-template.v2";
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
	period: { startedAtMs: number; endedAtMs: number };
	goalVersion: number | null;
	segments: TimelineSegmentV2[];
	coverage: CoverageLevel[];
	coverageWarnings: string[];
	renderedText: string;
	modelVersions: string[];
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
	period: { startedAtMs: number; endedAtMs: number };
	goal: ActiveGoalContextV1 | null;
	segments: TimelineSegmentV2[];
	renderedText: string;
	coverage: CoverageLevel[];
	modelVersions: string[];
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

export type TimelineAuditManifestV2 = {
	schemaVersion: typeof TIMELINE_AUDIT_SCHEMA_VERSION;
	exportedAtMs: number;
	fromMs: number;
	toMs: number;
	decryptedContentIncluded: boolean;
	rawObservationCount: number;
	semanticEventCount: number;
	evidenceFactCount: number;
	episodeCount: number;
	timelineCount: number;
	/**
	 * Cross-boundary records are omitted instead of exporting text whose
	 * provenance extends beyond the requested half-open five-minute range.
	 */
	rangeBoundaryOmissions?: {
		rawObservations: number;
		semanticEvents: number;
		evidenceFacts: number;
		episodes: number;
		timelines: number;
	};
};

export type TimelineAuditBundleV2 = {
	manifest: TimelineAuditManifestV2;
	permissions: Record<string, JsonValue>;
	coverage: CoverageLevel[];
	rawObservations: unknown[];
	semanticEvents: SemanticEventV2[];
	evidenceFacts: EvidenceFactV2[];
	episodes: ActivityEpisodeV2[];
	timelineSummaries: TimelineSummaryV2[];
	lineage: Array<{
		observationId: string;
		eventId: string | null;
		factId: string | null;
		episodeRevisionId: string | null;
		timelineId: string | null;
		status:
			| "summarized"
			| "unepisoded"
			| "fact_only"
			| "semantic_only"
			| "ignored"
			| "unreferenced_raw";
	}>;
};
