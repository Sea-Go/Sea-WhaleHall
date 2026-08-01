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
};

export type OllamaJsonClientOptions = {
	baseUrl?: string;
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

export class OllamaJsonClient {
	private readonly baseUrl: string;
	private readonly model: string;
	private readonly contextLength: number;
	private readonly keepAlive: string;
	private readonly fetchImpl: FetchLike;
	private readonly realtime: QueueItem<unknown>[] = [];
	private readonly batch: QueueItem<unknown>[] = [];
	private draining = false;

	constructor(options: OllamaJsonClientOptions = {}) {
		this.baseUrl = normalizeLoopbackUrl(
			options.baseUrl ?? "http://127.0.0.1:11434",
		);
		this.model = options.model ?? "qwen3:4b";
		this.contextLength = options.contextLength ?? 4096;
		this.keepAlive = options.keepAlive ?? "30m";
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
					item.reject(errorMessage(error));
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private async executeWithSchemaRetry<T>(
		request: OllamaJsonRequest<T>,
	): Promise<T> {
		let lastError: Error | null = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await this.execute(request, attempt);
			} catch (error) {
				lastError = errorMessage(error);
				if (!(lastError instanceof OllamaSchemaError)) throw lastError;
			}
		}
		throw lastError ?? new OllamaSchemaError("Ollama returned invalid structured output.");
	}

	private async execute<T>(
		request: OllamaJsonRequest<T>,
		attempt: number,
	): Promise<T> {
		const timeoutMs = request.timeoutMs ?? 90_000;
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
			const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					messages,
					stream: false,
					think: request.think ?? false,
					format: request.schema,
					keep_alive: this.keepAlive,
					options: {
						num_ctx: this.contextLength,
						temperature: request.temperature ?? 0,
					},
				}),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new OllamaClientError(
					`Ollama returned HTTP ${response.status}.`,
					response.status >= 500 || response.status === 429,
				);
			}
			const envelope: unknown = await response.json();
			if (
				!isRecord(envelope) ||
				!isRecord(envelope.message) ||
				typeof envelope.message.content !== "string"
			) {
				throw new OllamaSchemaError("Ollama response envelope is invalid.");
			}
			const parsed = parseJsonObject(envelope as OllamaChatResponse);
			if (!request.validate(parsed)) {
				throw new OllamaSchemaError("Ollama JSON did not match the requested schema.");
			}
			return parsed;
		} catch (error) {
			if (controller.signal.aborted) {
				throw new OllamaClientError(
					`Ollama request timed out after ${timeoutMs} ms.`,
					true,
				);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}

export class OllamaClientError extends Error {
	constructor(
		message: string,
		public readonly retryable: boolean,
	) {
		super(message);
		this.name = "OllamaClientError";
	}
}

export class OllamaSchemaError extends OllamaClientError {
	constructor(message: string) {
		super(message, true);
		this.name = "OllamaSchemaError";
	}
}

function parseJsonObject(envelope: OllamaChatResponse): unknown {
	try {
		const value: unknown = JSON.parse(envelope.message.content);
		if (!isRecord(value)) throw new Error("root must be an object");
		return value;
	} catch (error) {
		throw new OllamaSchemaError(
			`Ollama content was not a JSON object: ${errorMessage(error).message}`,
		);
	}
}

function normalizeLoopbackUrl(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
	) {
		throw new Error("The local Ollama client only accepts an HTTP loopback URL.");
	}
	url.pathname = url.pathname.replace(/\/+$/u, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/u, "");
}

function errorMessage(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
