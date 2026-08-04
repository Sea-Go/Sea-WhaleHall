import {
	type ActivityAnalysisWorkerEvent,
	isActivityAnalysisWorkerResult,
	MAXIMUM_ACTIVITY_ANALYSIS_RESULT_CHARACTERS,
	serializedActivityAnalysisLength,
} from "../shared/activity-analysis-contract";
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
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

export type ActivityEventWorkerClientOptions = {
	endpoint: string;
	authorizationToken: string;
	fetch?: FetchLike;
	timeoutMs?: number;
};

export interface ActivityEventAnalyzer {
	analyze(
		request: ActivityEventWorkerRequest,
	): Promise<ActivityEventWorkerResponse>;
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
		);
	}

	async analyze(
		request: ActivityEventWorkerRequest,
	): Promise<ActivityEventWorkerResponse> {
		const body = serializeRequest(request);
		const requestBytes = textEncoder.encode(body).byteLength;
		const controller = new AbortController();
		const timeout = globalThis.setTimeout(
			() => controller.abort(),
			this.timeoutMs,
		);
		try {
			let response: Response;
			try {
				response = await this.fetchImpl(this.endpoint, {
					method: "POST",
					redirect: "error",
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
				await cancelResponseBody(response);
				throw new ActivityEventWorkerClientError(
					"http_error",
					isRetryableHttpStatus(response.status),
					response.status,
					requestBytes,
					response.headers.get("server"),
				);
			}
			const source = await readBoundedResponse(response, requestBytes);
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
		MAXIMUM_REQUEST_ID_LENGTH,
	);
	let rawEvent: string;
	try {
		rawEvent = JSON.stringify(request.raw_event);
	} catch {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	if (textEncoder.encode(rawEvent).byteLength > MAXIMUM_RAW_EVENT_BYTES) {
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
	if (textEncoder.encode(body).byteLength > MAXIMUM_REQUEST_BYTES) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	return body;
}

async function readBoundedResponse(
	response: Response,
	requestBytes: number,
): Promise<string> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const length = Number(declaredLength);
		if (
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > MAXIMUM_RESPONSE_BYTES
		) {
			await cancelResponseBody(response);
			throw new ActivityEventWorkerClientError(
				"invalid_response",
				true,
				null,
				requestBytes,
			);
		}
	}
	if (!response.body) {
		throw new ActivityEventWorkerClientError(
			"invalid_response",
			true,
			null,
			requestBytes,
		);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			total += item.value.byteLength;
			if (total > MAXIMUM_RESPONSE_BYTES) {
				await reader.cancel().catch(() => {});
				throw new ActivityEventWorkerClientError(
					"invalid_response",
					true,
					null,
					requestBytes,
				);
			}
			chunks.push(item.value);
		}
	} catch (error) {
		if (error instanceof ActivityEventWorkerClientError) throw error;
		throw new ActivityEventWorkerClientError(
			"transport_error",
			true,
			null,
			requestBytes,
		);
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return textDecoder.decode(bytes);
}

async function cancelResponseBody(response: Response): Promise<void> {
	if (!response.body) return;
	await response.body.cancel().catch(() => {});
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
	if (token.length === 0 || /\s/u.test(token)) {
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

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function boundedString(value: unknown, maximum: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	return value;
}

function positiveSafeInteger(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new ActivityEventWorkerClientError("invalid_request", false);
	}
	return value;
}

function isRetryableHttpStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}
