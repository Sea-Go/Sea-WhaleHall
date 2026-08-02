import type { FetchLike } from "./model/ollama-json-client";

export const ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION =
	"activity-event-analysis-request.v1" as const;
export const ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION =
	"activity-event-analysis-response.v1" as const;

const MAXIMUM_REQUEST_ID_LENGTH = 128;
const MAXIMUM_RAW_EVENT_BYTES = 768 * 1024;
const MAXIMUM_REQUEST_BYTES = 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 190_000;

export type ActivityEventWorkerEvent = {
	source_event_ids: string[];
	activity: string;
	goal_relevance: string;
	confidence: number;
	reason_codes: string[];
	evidence: string[];
	started_at_ms: number | null;
	ended_at_ms: number | null;
};

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

export type ActivityEventWorkerClientOptions = {
	endpoint: string;
	authorizationToken: string;
	fetch?: FetchLike;
	timeoutMs?: number;
};

export interface ActivityEventAnalyzer {
	analyze(request: ActivityEventWorkerRequest): Promise<ActivityEventWorkerResponse>;
}

/**
 * Narrow HTTPS client for the reviewed cloud activity analyzer. The durable
 * sealed-window delivery service owns ordering, retry, receipts, and scores.
 */
export class ActivityEventWorkerClient implements ActivityEventAnalyzer {
	private readonly endpoint: string;
	private readonly authorizationToken: string;
	private readonly fetchImpl: FetchLike;
	private readonly timeoutMs: number;

	constructor(options: ActivityEventWorkerClientOptions) {
		this.endpoint = normalizeWorkerEndpoint(options.endpoint);
		this.authorizationToken = requireToken(options.authorizationToken);
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = positiveSafeInteger(
			options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			"timeoutMs",
		);
	}

	async analyze(
		request: ActivityEventWorkerRequest,
	): Promise<ActivityEventWorkerResponse> {
		const body = serializeRequest(request);
		const requestBytes = new TextEncoder().encode(body).byteLength;
		const controller = new AbortController();
		const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			let response: Response;
			try {
				response = await this.fetchImpl(this.endpoint, {
					method: "POST",
					headers: {
						accept: "application/json",
						authorization: `Bearer ${this.authorizationToken}`,
						"content-type": "application/json",
					},
					body,
					signal: controller.signal,
				});
			} catch {
				throw new ActivityEventWorkerClientError(
					controller.signal.aborted ? "request_timeout" : "transport_error",
					true,
					null,
					requestBytes,
				);
			}
			if (!response.ok) {
				throw new ActivityEventWorkerClientError(
					"http_error",
					isRetryableHttpStatus(response.status),
					response.status,
					requestBytes,
					response.headers.get("server"),
				);
			}
			let source: string;
			try {
				source = await response.text();
			} catch {
				throw new ActivityEventWorkerClientError(
					"transport_error",
					true,
					null,
					requestBytes,
				);
			}
			if (new TextEncoder().encode(source).byteLength > MAXIMUM_RESPONSE_BYTES) {
				throw new ActivityEventWorkerClientError("invalid_response", true);
			}
			let value: unknown;
			try {
				value = JSON.parse(source);
			} catch {
				throw new ActivityEventWorkerClientError("invalid_response", true);
			}
			return validateWorkerResponse(value, request.request_id);
		} finally {
			globalThis.clearTimeout(timeout);
		}
	}
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

function serializeRequest(request: ActivityEventWorkerRequest): string {
	if (
		request.schema_version !== ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION ||
		!isRawEventValue(request.raw_event) ||
		!isRecord(request.context)
	) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	const requestId = boundedString(
		request.request_id,
		"request_id",
		MAXIMUM_REQUEST_ID_LENGTH,
	);
	let rawEvent: string;
	try {
		rawEvent = JSON.stringify(request.raw_event);
	} catch {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	if (new TextEncoder().encode(rawEvent).byteLength > MAXIMUM_RAW_EVENT_BYTES) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	let body: string;
	try {
		body = JSON.stringify({
			schema_version: ACTIVITY_EVENT_WORKER_REQUEST_SCHEMA_VERSION,
			request_id: requestId,
			raw_event: request.raw_event,
			context: request.context,
		});
	} catch {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	if (new TextEncoder().encode(body).byteLength > MAXIMUM_REQUEST_BYTES) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	return body;
}

function validateWorkerResponse(
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
		value.request_id !== requestId ||
		!Array.isArray(value.events) ||
		value.events.length > 64 ||
		!isScore(value.score) ||
		typeof value.score_reason !== "string"
	) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	const events = value.events.map((event) => validateWorkerEvent(event));
	if (events.length === 0 && value.score !== 0) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	return {
		schema_version: ACTIVITY_EVENT_WORKER_RESPONSE_SCHEMA_VERSION,
		request_id: requestId,
		events,
		score: value.score,
		score_reason: boundedResponseString(value.score_reason, 400),
	};
}

function validateWorkerEvent(value: unknown): ActivityEventWorkerEvent {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"source_event_ids",
			"activity",
			"goal_relevance",
			"confidence",
			"reason_codes",
			"evidence",
			"started_at_ms",
			"ended_at_ms",
		]) ||
		!Array.isArray(value.source_event_ids) ||
		value.source_event_ids.length < 1 ||
		value.source_event_ids.length > 32 ||
		!value.source_event_ids.every(
			(candidate) =>
				typeof candidate === "string" &&
				candidate.length > 0 &&
				candidate.length <= 160,
		) ||
		typeof value.activity !== "string" ||
		value.activity.length < 1 ||
		value.activity.length > 80 ||
		typeof value.goal_relevance !== "string" ||
		value.goal_relevance.length < 1 ||
		value.goal_relevance.length > 80 ||
		!isScore(value.confidence) ||
		!Array.isArray(value.reason_codes) ||
		value.reason_codes.length < 1 ||
		value.reason_codes.length > 4 ||
		!value.reason_codes.every(
			(candidate) =>
				typeof candidate === "string" &&
				candidate.length > 0 &&
				candidate.length <= 80,
		) ||
		!Array.isArray(value.evidence) ||
		value.evidence.length > 8 ||
		!value.evidence.every(
			(candidate) => typeof candidate === "string" && candidate.length <= 240,
		) ||
		!isNullableTimestamp(value.started_at_ms) ||
		!isNullableTimestamp(value.ended_at_ms)
	) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	return {
		source_event_ids: [...value.source_event_ids],
		activity: value.activity,
		goal_relevance: value.goal_relevance,
		confidence: value.confidence,
		reason_codes: [...value.reason_codes],
		evidence: [...value.evidence],
		started_at_ms: value.started_at_ms,
		ended_at_ms: value.ended_at_ms,
	};
}

function normalizeWorkerEndpoint(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	return url.toString();
}

function requireToken(value: string): string {
	const token = value.trim();
	if (token.length === 0 || Array.from(token).some((character) => /\s/u.test(character))) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	return token;
}

function isRawEventValue(value: unknown): value is object | unknown[] {
	return Array.isArray(value) || isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function isScore(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNullableTimestamp(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
	);
}

function boundedString(value: unknown, _name: string, maximum: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	return value;
}

function boundedResponseString(value: unknown, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum) {
		throw new ActivityEventWorkerClientError("invalid_response", true);
	}
	return value;
}

function positiveSafeInteger(value: number, _name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	return value;
}

function isRetryableHttpStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}
