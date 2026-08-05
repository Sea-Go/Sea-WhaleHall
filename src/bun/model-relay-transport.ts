import { createHash } from "node:crypto";

export interface ModelRelayAuthorization {
	authorizedFetch(path: string, init?: RequestInit): Promise<Response>;
}

const MAX_RELAY_BODY_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_CHUNK_BYTES = 64 * 1024;
const RELAY_COMPLETION_PATHS = new Set([
	"/v1/chat/completions",
	"/v1/activity/completions",
]);

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
	/** A code-owned relay endpoint; never a model-configurable URL. */
	endpointPath?: "/v1/chat/completions" | "/v1/activity/completions";
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
	private readonly endpointPath: "/v1/chat/completions" | "/v1/activity/completions";

	constructor(
		private readonly auth: ModelRelayAuthorization,
		options: ModelRelayTransportOptions = {},
	) {
		const endpointPath = options.endpointPath ?? "/v1/chat/completions";
		if (!RELAY_COMPLETION_PATHS.has(endpointPath)) {
			throw new Error("Model relay endpoint path is not approved.");
		}
		this.endpointPath = endpointPath;
	}

	async open(request: ModelRelayRequest, sink: ModelRelaySink): Promise<void> {
		assertRelayRequest(request);
		if (this.active.has(request.runId)) {
			throw new ModelRelayError("duplicate-run", "该运行已有模型请求正在进行。");
		}
		const body = JSON.stringify(request.body);
		if (new TextEncoder().encode(body).byteLength > MAX_RELAY_BODY_BYTES) {
			throw new ModelRelayError("request-too-large", "模型请求超过 16 MiB 上限。");
		}
		const controller = new AbortController();
		this.active.set(request.runId, controller);
		try {
			const response = await this.auth.authorizedFetch(this.endpointPath, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: request.body.stream === true ? "text/event-stream" : "application/json",
					"idempotency-key": request.idempotencyKey ?? relayIdempotencyKey(request),
				},
				body,
				signal: controller.signal,
			});
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
					for (let offset = 0; offset < item.value.byteLength; offset += MAX_STREAM_CHUNK_BYTES) {
						await sink.onChunk(item.value.slice(offset, offset + MAX_STREAM_CHUNK_BYTES));
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
					error instanceof Error ? error.message : "当前账号没有可用的模型转发能力。",
				);
			}
			throw new ModelRelayError(
				"remote-failure",
				error instanceof Error ? error.message : "模型转发失败。",
			);
		} finally {
			if (this.active.get(request.runId) === controller) this.active.delete(request.runId);
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
		throw new ModelRelayError("invalid-request", "模型请求缺少有效的 runId 或 body。");
	}
	if ("userId" in request.body || "accessToken" in request.body || "apiKey" in request.body) {
		throw new ModelRelayError("invalid-request", "模型请求不得携带自报身份或供应商凭据。");
	}
	if (typeof request.body.model !== "string" || request.body.model.length < 1 || request.body.model.length > 256) {
		throw new ModelRelayError("invalid-request", "模型请求缺少有效 model。");
	}
	if (!Array.isArray(request.body.messages) || request.body.messages.length < 1 || request.body.messages.length > 512) {
		throw new ModelRelayError("invalid-request", "模型请求 messages 数量无效。");
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
	for (const name of ["content-type", "cache-control", "x-request-id", "openai-processing-ms"]) {
		const value = headers.get(name);
		if (value) output[name] = value.slice(0, 4096);
	}
	return output;
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
