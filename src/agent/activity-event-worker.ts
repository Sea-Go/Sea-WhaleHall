import {
	type ActivityAnalysisWorkerEvent,
	isActivityAnalysisWorkerResult,
	MAXIMUM_ACTIVITY_ANALYSIS_RESULT_CHARACTERS,
	serializedActivityAnalysisLength,
} from "../shared/activity-analysis-contract";

export const ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION =
	"activity-event-analysis-request.v1" as const;
export const ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION =
	"activity-event-analysis-response.v1" as const;

export type ActivityEventWorkerEvent = ActivityAnalysisWorkerEvent;

export type ActivityEventWorkerResponse = {
	schema_version: typeof ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION;
	request_id: string;
	events: ActivityEventWorkerEvent[];
	score: number;
	score_reason: string;
};

export type ActivityEventWorkerRequest = {
	schema_version: typeof ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION;
	request_id: string;
	raw_event: object | unknown[];
	context: Record<string, unknown>;
};

export type ActivityEventWorkerClientErrorCode =
	| "invalid_request"
	| "request_timeout"
	| "transport_error"
	| "http_error"
	| "invalid_response";

/**
 * Safe diagnostic error. It deliberately excludes raw events, response text,
 * endpoint credentials, and authorization values.
 */
export class ActivityEventWorkerClientError extends Error {
	constructor(
		readonly code: ActivityEventWorkerClientErrorCode,
		readonly retryable: boolean,
		readonly httpStatus: number | null = null,
		/** Safe aggregate only; it never includes any raw event content. */
		readonly requestBytes: number | null = null,
		/** A response header, useful for separating gateway and Worker failures. */
		readonly responseServer: string | null = null,
	) {
		super(`Activity event worker request failed: ${code}.`);
		this.name = "ActivityEventWorkerClientError";
	}
}

export interface ActivityEventAnalyzer {
	analyze(
		request: ActivityEventWorkerRequest,
		options?: { signal?: AbortSignal },
	): Promise<ActivityEventWorkerResponse>;
}

export type ActivityScoreStatus = {
	accumulatedScore: number;
	scoreThreshold: number;
	agentTriggerPending: boolean;
	acceptedAnalysisCount: number;
};

export type ActivityAgentTriggerClaim = {
	claimed: boolean;
	status: ActivityScoreStatus;
};

/**
 * Validates the exact Worker response contract at every trust boundary. The
 * Mastra bridge converts its structured workflow output through
 * `activityReflectionOutputToWorkerResponse`, which enforces the same result
 * contract before a malformed Sidecar response can enter the durable ledger.
 */
export function validateActivityEventWorkerResponse(
	value: unknown,
	requestId: string,
): ActivityEventWorkerResponse {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schema_version",
			"request_id",
			"events",
			"score",
			"score_reason",
		]) ||
		value.schema_version !== ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION ||
		value.request_id !== requestId
	) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	const result = {
		request_id: value.request_id,
		events: value.events,
		score: value.score,
		score_reason: value.score_reason,
	};
	if (
		!isActivityAnalysisWorkerResult(result) ||
		serializedActivityAnalysisLength([result]) >
			MAXIMUM_ACTIVITY_ANALYSIS_RESULT_CHARACTERS
	) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	return {
		schema_version: ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION,
		...structuredClone(result),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}
