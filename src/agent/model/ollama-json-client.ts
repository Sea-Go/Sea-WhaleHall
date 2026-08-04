import { isRecord } from "../local-protocol";

export type OllamaPriority = "realtime" | "batch";

export type OllamaJsonRequest<T> = {
	messages: ReadonlyArray<{
		role: "system" | "user" | "assistant";
		content: string;
	}>;
	schema: Record<string, unknown>;
	validate: (value: unknown) => value is T;
	priority?: OllamaPriority;
	think?: boolean;
	temperature?: number;
	timeoutMs?: number;
	maxOutputTokens?: number;
};

export type OllamaJsonClientOptions = {
	baseUrl?: string;
	/** Exact HTTPS origins allowed for a remote Ollama-compatible server. */
	allowedRemoteOrigins?: readonly string[];
	/** Environment-only Bearer token for an authenticated remote gateway. */
	authorizationToken?: string;
	model?: string;
	contextLength?: number;
	keepAlive?: string;
	fetch?: FetchLike;
};

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

type QueueItem<T> = {
	request: OllamaJsonRequest<T>;
	resolve: (value: T) => void;
	reject: (reason: Error) => void;
};

type OllamaChatResponse = {
	message: { content: string };
};

export type OllamaClientErrorCode =
	| "invalid_request"
	| "http_error"
	| "request_timeout"
	| "transport_error"
	| "invalid_response_envelope"
	| "invalid_json"
	| "schema_mismatch";

/**
 * Safe to persist or emit as telemetry. It intentionally excludes prompts,
 * response content, URLs, and arbitrary exception messages.
 */
export type OllamaFailureDiagnostic = {
	source: "ollama";
	code: OllamaClientErrorCode;
	retryable: boolean;
	httpStatus: number | null;
};

export class OllamaJsonClient {
	private readonly baseUrl: string;
	private readonly model: string;
	private readonly contextLength: number;
	private readonly keepAlive: string;
	private readonly authorizationToken: string | null;
	private readonly fetchImpl: FetchLike;
	private readonly realtime: QueueItem<unknown>[] = [];
	private readonly batch: QueueItem<unknown>[] = [];
	private draining = false;

	constructor(options: OllamaJsonClientOptions = {}) {
		this.baseUrl = normalizeOllamaBaseUrl(
			options.baseUrl ?? "http://127.0.0.1:11434",
			options.allowedRemoteOrigins ?? [],
		);
		this.model = options.model ?? "qwen3:4b";
		this.contextLength = options.contextLength ?? 4096;
		this.keepAlive = options.keepAlive ?? "30m";
		this.authorizationToken = normalizeAuthorizationToken(
			options.authorizationToken,
		);
		this.fetchImpl = options.fetch ?? fetch;
	}

	generateJson<T>(request: OllamaJsonRequest<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const item: QueueItem<T> = { request, resolve, reject };
			const queue = request.priority === "batch" ? this.batch : this.realtime;
			queue.push(item as QueueItem<unknown>);
			void this.drain();
		});
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.realtime.length > 0 || this.batch.length > 0) {
				const item = this.realtime.shift() ?? this.batch.shift();
				if (!item) break;
				try {
					item.resolve(await this.executeWithSchemaRetry(item.request));
				} catch (error) {
					item.reject(safeOllamaError(error));
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private async executeWithSchemaRetry<T>(
		request: OllamaJsonRequest<T>,
	): Promise<T> {
		let lastError: OllamaClientError | null = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await this.execute(request, attempt);
			} catch (error) {
				lastError = safeOllamaError(error);
				if (!(lastError instanceof OllamaSchemaError)) throw lastError;
			}
		}
		throw (
			lastError ??
			new OllamaSchemaError("Ollama returned invalid structured output.")
		);
	}

	private async execute<T>(
		request: OllamaJsonRequest<T>,
		attempt: number,
	): Promise<T> {
		const timeoutMs = request.timeoutMs ?? 90_000;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new OllamaClientError(
				"Ollama request timeout must be positive.",
				false,
				"invalid_request",
			);
		}
		if (
			request.maxOutputTokens !== undefined &&
			(!Number.isSafeInteger(request.maxOutputTokens) ||
				request.maxOutputTokens <= 0)
		) {
			throw new OllamaClientError(
				"Ollama maximum output tokens must be a positive integer.",
				false,
				"invalid_request",
			);
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const messages =
				attempt === 0
					? request.messages
					: [
							...request.messages,
							{
								role: "user" as const,
								content:
									"上一份输出未通过给定 JSON Schema。只返回一份符合 Schema 的 JSON，不要解释。",
							},
						];
			const inferenceOptions: Record<string, number> = {
				num_ctx: this.contextLength,
				temperature: request.temperature ?? 0,
			};
			if (request.maxOutputTokens !== undefined) {
				inferenceOptions.num_predict = request.maxOutputTokens;
			}
			const headers: Record<string, string> = {
				"content-type": "application/json",
			};
			if (this.authorizationToken !== null) {
				headers.authorization = `Bearer ${this.authorizationToken}`;
			}
			const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: this.model,
					messages,
					stream: false,
					think: request.think ?? false,
					format: request.schema,
					keep_alive: this.keepAlive,
					options: inferenceOptions,
				}),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new OllamaClientError(
					`Ollama returned HTTP ${response.status}.`,
					response.status >= 500 || response.status === 429,
					"http_error",
					response.status,
				);
			}
			let envelope: unknown;
			try {
				envelope = await response.json();
			} catch {
				throw new OllamaSchemaError(
					"Ollama response envelope is invalid.",
					"invalid_response_envelope",
				);
			}
			if (
				!isRecord(envelope) ||
				!isRecord(envelope.message) ||
				typeof envelope.message.content !== "string"
			) {
				throw new OllamaSchemaError(
					"Ollama response envelope is invalid.",
					"invalid_response_envelope",
				);
			}
			const parsed = parseJsonObject(envelope as OllamaChatResponse);
			try {
				if (request.validate(parsed)) return parsed;
			} catch {
				// Validators are a trust boundary too. Never propagate an
				// exception that may have embedded generated content.
			}
			throw new OllamaSchemaError(
				"Ollama JSON did not match the requested schema.",
				"schema_mismatch",
			);
		} catch (error) {
			if (controller.signal.aborted) {
				throw new OllamaClientError(
					`Ollama request timed out after ${timeoutMs} ms.`,
					true,
					"request_timeout",
				);
			}
			throw safeOllamaError(error);
		} finally {
			clearTimeout(timeout);
		}
	}
}

export class OllamaClientError extends Error {
	constructor(
		message: string,
		public readonly retryable: boolean,
		public readonly code: OllamaClientErrorCode = "transport_error",
		public readonly httpStatus: number | null = null,
	) {
		super(message);
		this.name = "OllamaClientError";
	}

	toDiagnostic(): OllamaFailureDiagnostic {
		return {
			source: "ollama",
			code: this.code,
			retryable: this.retryable,
			httpStatus: this.httpStatus,
		};
	}
}

export class OllamaSchemaError extends OllamaClientError {
	constructor(
		message: string,
		code:
			| "invalid_response_envelope"
			| "invalid_json"
			| "schema_mismatch" = "schema_mismatch",
	) {
		super(message, true, code);
		this.name = "OllamaSchemaError";
	}
}

function parseJsonObject(envelope: OllamaChatResponse): unknown {
	try {
		const value: unknown = JSON.parse(envelope.message.content);
		if (!isRecord(value)) throw new Error("root must be an object");
		return value;
	} catch {
		throw new OllamaSchemaError(
			"Ollama content was not a JSON object.",
			"invalid_json",
		);
	}
}

function normalizeOllamaBaseUrl(
	value: string,
	allowedRemoteOrigins: readonly string[],
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("The Ollama client URL is invalid.");
	}
	if (
		url.username !== "" ||
		url.password !== "" ||
		(url.pathname !== "" && url.pathname !== "/") ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error(
			"The Ollama client URL contains disallowed URL components.",
		);
	}
	if (isLoopbackHostname(url.hostname)) {
		if (url.protocol !== "http:") {
			throw new Error("The loopback Ollama client URL must use HTTP.");
		}
		return url.origin;
	}
	if (url.protocol !== "https:" || !allowedRemoteOrigins.includes(url.origin)) {
		throw new Error(
			"The remote Ollama client requires an allowlisted HTTPS origin.",
		);
	}
	return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
	return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);
}

function normalizeAuthorizationToken(value: string | undefined): string | null {
	if (value === undefined) return null;
	if (value.length < 1 || value.length > 4_096 || /\p{Cc}/u.test(value)) {
		throw new Error("The Ollama authorization token is invalid.");
	}
	return value;
}

function safeOllamaError(error: unknown): OllamaClientError {
	if (error instanceof OllamaClientError) return error;
	return new OllamaClientError(
		"Ollama request failed.",
		true,
		"transport_error",
	);
}
