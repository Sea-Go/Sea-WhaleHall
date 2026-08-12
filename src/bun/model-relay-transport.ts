import { createHash } from "node:crypto";

export interface ModelRelayAuthorization {
	authorizedFetch(
		path: string,
		init: RequestInit,
		purpose: ModelRelayPurpose,
	): Promise<Response>;
}

export type ModelRelayPurpose = "agent" | "activity";

const MAX_RELAY_BODY_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_CHUNK_BYTES = 64 * 1024;
const RELAY_COMPLETIONS_PATH = "/v1/chat/completions";
const DEFAULT_INFLIGHT_RETRY_DELAYS_MS = [
	250, 500, 1_000, 2_000, 4_000, 8_000,
] as const;

export interface ModelRelayRequest {
	runId: string;
	body: Record<string, unknown>;
	idempotencyKey?: string;
}

export interface ModelRelayResponseMetadata {
	status: number;
	headers: Record<string, string>;
}

export interface ModelRelaySink {
	onResponse(metadata: ModelRelayResponseMetadata): Promise<void> | void;
	onChunk(chunk: Uint8Array): Promise<void> | void;
}

export interface ModelRelayTransportOptions {
	/** A code-owned audit classification; never supplied by the sidecar/body. */
	purpose?: ModelRelayPurpose;
	/** Bounded polling for a durable operation that another attempt still owns. */
	inflightRetryDelaysMs?: readonly number[];
	wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export class ModelRelayError extends Error {
	constructor(
		readonly code:
			| "invalid-request"
			| "request-too-large"
			| "duplicate-run"
			| "service-unavailable"
			| "remote-failure"
			| "cancelled",
		message: string,
	) {
		super(message);
		this.name = "ModelRelayError";
	}
}

/** Streams raw OpenAI-compatible bytes between the authenticated relay and
 * the local sidecar. The sidecar never receives the bearer token. */
export class ModelRelayTransport {
	private readonly active = new Map<string, AbortController>();
	private readonly purpose: ModelRelayPurpose;
	private readonly inflightRetryDelaysMs: readonly number[];
	private readonly wait: (
		delayMs: number,
		signal: AbortSignal,
	) => Promise<void>;

	constructor(
		private readonly auth: ModelRelayAuthorization,
		options: ModelRelayTransportOptions = {},
	) {
		this.purpose = options.purpose ?? "agent";
		if (this.purpose !== "agent" && this.purpose !== "activity") {
			throw new Error("Model relay purpose is not approved.");
		}
		this.inflightRetryDelaysMs = validateRetryDelays(
			options.inflightRetryDelaysMs ?? DEFAULT_INFLIGHT_RETRY_DELAYS_MS,
		);
		this.wait = options.wait ?? waitForRetry;
	}

	async open(request: ModelRelayRequest, sink: ModelRelaySink): Promise<void> {
		assertRelayRequest(request);
		if (this.active.has(request.runId)) {
			throw new ModelRelayError(
				"duplicate-run",
				"该运行已有模型请求正在进行。",
			);
		}
		const body = JSON.stringify(request.body);
		if (new TextEncoder().encode(body).byteLength > MAX_RELAY_BODY_BYTES) {
			throw new ModelRelayError(
				"request-too-large",
				"模型请求超过 16 MiB 上限。",
			);
		}
		const controller = new AbortController();
		this.active.set(request.runId, controller);
		try {
			const response = await this.fetchWithInflightRecovery(
				request,
				body,
				controller.signal,
			);
			await sink.onResponse({
				status: response.status,
				headers: safeResponseHeaders(response.headers),
			});
			if (!response.body) return;
			const reader = response.body.getReader();
			try {
				while (true) {
					const item = await reader.read();
					if (item.done) break;
					for (
						let offset = 0;
						offset < item.value.byteLength;
						offset += MAX_STREAM_CHUNK_BYTES
					) {
						await sink.onChunk(
							item.value.slice(offset, offset + MAX_STREAM_CHUNK_BYTES),
						);
					}
				}
			} finally {
				reader.releaseLock();
			}
		} catch (error) {
			if (controller.signal.aborted) {
				throw new ModelRelayError("cancelled", "模型请求已取消。");
			}
			if (error instanceof ModelRelayError) throw error;
			if (isServiceUnavailable(error)) {
				throw new ModelRelayError(
					"service-unavailable",
					error instanceof Error
						? error.message
						: "当前账号没有可用的模型转发能力。",
				);
			}
			throw new ModelRelayError(
				"remote-failure",
				error instanceof Error ? error.message : "模型转发失败。",
			);
		} finally {
			if (this.active.get(request.runId) === controller)
				this.active.delete(request.runId);
		}
	}

	private async fetchWithInflightRecovery(
		request: ModelRelayRequest,
		body: string,
		signal: AbortSignal,
	): Promise<Response> {
		for (let attempt = 0; ; attempt += 1) {
			const response = await this.auth.authorizedFetch(
				RELAY_COMPLETIONS_PATH,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept:
							request.body.stream === true
								? "text/event-stream"
								: "application/json",
						"idempotency-key":
							request.idempotencyKey ?? relayIdempotencyKey(request),
					},
					body,
					signal,
				},
				this.purpose,
			);
			if (!(await isRequestInProgress(response))) return response;
			await response.body?.cancel().catch(() => undefined);
			const delayMs = this.inflightRetryDelaysMs[attempt];
			if (delayMs === undefined) {
				throw new ModelRelayError(
					"remote-failure",
					"模型请求仍在云端处理中，请稍后重试。",
				);
			}
			await this.wait(delayMs, signal);
		}
	}

	abort(runId: string): boolean {
		const controller = this.active.get(runId);
		if (!controller) return false;
		controller.abort();
		return true;
	}

	abortAll(): void {
		for (const controller of this.active.values()) controller.abort();
		this.active.clear();
	}
}

function assertRelayRequest(request: ModelRelayRequest): void {
	if (!isBoundedId(request.runId) || !isRecord(request.body)) {
		throw new ModelRelayError(
			"invalid-request",
			"模型请求缺少有效的 runId 或 body。",
		);
	}
	if (
		"userId" in request.body ||
		"user" in request.body ||
		"user_id" in request.body ||
		"accessToken" in request.body ||
		"apiKey" in request.body ||
		"token" in request.body ||
		"key" in request.body ||
		"api_key" in request.body ||
		"access_token" in request.body
	) {
		throw new ModelRelayError(
			"invalid-request",
			"模型请求不得携带自报身份或供应商凭据。",
		);
	}
	if (
		typeof request.body.model !== "string" ||
		request.body.model.length < 1 ||
		request.body.model.length > 256
	) {
		throw new ModelRelayError("invalid-request", "模型请求缺少有效 model。");
	}
	if (
		!Array.isArray(request.body.messages) ||
		request.body.messages.length < 1 ||
		request.body.messages.length > 512
	) {
		throw new ModelRelayError(
			"invalid-request",
			"模型请求 messages 数量无效。",
		);
	}
}

function relayIdempotencyKey(request: ModelRelayRequest): string {
	const digest = createHash("sha256")
		.update(request.runId)
		.update("\0")
		.update(JSON.stringify(request.body))
		.digest("hex");
	return `relay-${digest}`;
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
	const output: Record<string, string> = {};
	for (const name of [
		"content-type",
		"cache-control",
		"x-request-id",
		"openai-processing-ms",
	]) {
		const value = headers.get(name);
		if (value) output[name] = value.slice(0, 4096);
	}
	return output;
}

async function isRequestInProgress(response: Response): Promise<boolean> {
	if (response.status !== 409) return false;
	try {
		const payload: unknown = await response.clone().json();
		return (
			isRecord(payload) &&
			isRecord(payload.error) &&
			payload.error.code === "request-in-progress"
		);
	} catch {
		return false;
	}
}

function validateRetryDelays(delays: readonly number[]): readonly number[] {
	if (
		delays.length > 10 ||
		delays.some(
			(delay) => !Number.isFinite(delay) || delay < 0 || delay > 30_000,
		)
	) {
		throw new Error("Model relay retry delays are invalid.");
	}
	return [...delays];
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new DOMException("aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new DOMException("aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function isBoundedId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServiceUnavailable(error: unknown): boolean {
	return isRecord(error) && error.kind === "service-unavailable";
}
