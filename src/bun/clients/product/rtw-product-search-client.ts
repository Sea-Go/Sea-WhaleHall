import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const sessionId = z
	.string()
	.min(1)
	.max(200)
	.refine((value) =>
		Array.from(value).every((character) => {
			const code = character.charCodeAt(0);
			return code >= 32 && code !== 127;
		}),
	);
const searchInput = z
	.object({
		sessionId,
		moduleId: id,
		query: z
			.string()
			.min(1)
			.max(4096)
			.refine((value) => value.trim() !== ""),
		depth: z.enum(["fast", "detailed"]),
		intelligence: z.enum(["low", "medium", "high"]),
		idempotencyKey: z.string().regex(/^[A-Za-z0-9_.-]{8,128}$/u),
	})
	.strict();
const citation = z.object({
	evidence_id: id,
	source_kind: z.enum(["source", "wiki"]),
	content_id: id,
	revision_id: id,
	locator: z.object({
		locator: z.string(),
		original_byte_start: z.number().int().nonnegative(),
		original_byte_end: z.number().int().nonnegative(),
		normalized_rune_start: z.number().int().nonnegative(),
		normalized_rune_end: z.number().int().nonnegative(),
	}),
	original: z.object({ key: z.string(), sha256: hash }),
	quote: z.string().min(1),
	quote_hash: hash,
});
const result = z.object({
	search_id: id,
	answer_id: id,
	status: z.enum([
		"succeeded",
		"insufficient",
		"in_flight",
		"retryable_failure",
	]),
	answer: z.string().optional(),
	citations: z.array(citation),
	citation_receipt_ref: z.string().optional(),
});
const envelope = z.object({
	code: z.number().int(),
	msg: z.string(),
	data: result,
});

export type RTWSearchInput = z.infer<typeof searchInput>;
export type RTWSearchCitation = z.infer<typeof citation>;
export type RTWSearchResult = z.infer<typeof result>;
export type RTWSearchOutcome =
	| { kind: "accepted"; result: RTWSearchResult }
	| { kind: "in_flight"; searchId: string; answerId: string }
	| { kind: "retryable_failure"; searchId: string; answerId: string };

/** The future RTW identity bridge owns these credentials, never a WebView. */
export interface RTWProductSession {
	accessToken: string;
	sessionId: string;
	generation: number;
}

export interface RTWProductSessionProvider {
	current(): Promise<RTWProductSession | null>;
	isCurrent(session: RTWProductSession): boolean;
}

export class RTWProductSearchError extends Error {
	constructor(
		readonly code:
			| "INVALID_INPUT"
			| "NOT_AUTHENTICATED"
			| "SESSION_CHANGED"
			| "CONFLICT"
			| "NOT_FOUND"
			| "UNAVAILABLE"
			| "BAD_RESPONSE"
			| "CANCELLED",
	) {
		super(code);
		this.name = "RTWProductSearchError";
	}
}

export interface RTWProductSearchClientOptions {
	baseUrl: string;
	sessions: RTWProductSessionProvider;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	requestTimeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 1 << 20;

/** Bun-only RTW summary product transport. It never creates a SubjectRef. */
export class RTWProductSearchClient {
	private readonly baseUrl: URL;
	private readonly fetchImpl: (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>;
	private readonly requestTimeoutMs: number;

	constructor(private readonly options: RTWProductSearchClientOptions) {
		this.baseUrl = parseBaseUrl(options.baseUrl);
		this.fetchImpl = options.fetch ?? fetch;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
		if (
			!Number.isSafeInteger(this.requestTimeoutMs) ||
			this.requestTimeoutMs < 1_000 ||
			this.requestTimeoutMs > 180_000
		) {
			throw new RTWProductSearchError("INVALID_INPUT");
		}
	}

	async createSearch(
		input: RTWSearchInput,
		signal?: AbortSignal,
	): Promise<RTWSearchOutcome> {
		const parsed = searchInput.safeParse(input);
		if (
			!parsed.success ||
			new TextEncoder().encode(parsed.data.query).length > 4096
		) {
			throw new RTWProductSearchError("INVALID_INPUT");
		}
		const {
			sessionId: logicalSessionId,
			idempotencyKey,
			...search
		} = parsed.data;
		return this.request(
			`/v1/knowledge/answer-sessions/${encodeURIComponent(logicalSessionId)}/searches`,
			"POST",
			{
				module_id: search.moduleId,
				query: search.query,
				depth: search.depth,
				intelligence: search.intelligence,
				idempotency_key: idempotencyKey,
			},
			signal,
		);
	}

	async getSearch(
		logicalSessionId: string,
		searchId: string,
		signal?: AbortSignal,
	): Promise<RTWSearchOutcome> {
		if (
			!sessionId.safeParse(logicalSessionId).success ||
			!id.safeParse(searchId).success
		) {
			throw new RTWProductSearchError("INVALID_INPUT");
		}
		return this.request(
			`/v1/knowledge/answer-sessions/${encodeURIComponent(logicalSessionId)}/searches/${encodeURIComponent(searchId)}`,
			"GET",
			undefined,
			signal,
		);
	}

	private async request(
		path: string,
		method: "GET" | "POST",
		body: object | undefined,
		signal: AbortSignal | undefined,
	): Promise<RTWSearchOutcome> {
		const current = await this.options.sessions.current();
		if (!current?.accessToken || !Number.isSafeInteger(current.generation)) {
			throw new RTWProductSearchError("NOT_AUTHENTICATED");
		}
		// A provider may reuse and mutate its current object on account cutover.
		// Keep this request's identity and credential immutable across the await.
		const session: RTWProductSession = {
			accessToken: current.accessToken,
			sessionId: current.sessionId,
			generation: current.generation,
		};
		if (!this.options.sessions.isCurrent(session)) {
			throw new RTWProductSearchError("NOT_AUTHENTICATED");
		}
		const url = new URL(path, this.baseUrl);
		const timeout = AbortSignal.timeout(this.requestTimeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				redirect: "error",
				signal: requestSignal,
				headers: {
					authorization: `Bearer ${session.accessToken}`,
					accept: "application/json",
					...(body ? { "content-type": "application/json" } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		} catch {
			throw new RTWProductSearchError(
				requestSignal.aborted && signal?.aborted ? "CANCELLED" : "UNAVAILABLE",
			);
		}
		if (!this.options.sessions.isCurrent(session)) {
			await response.body?.cancel().catch(() => undefined);
			throw new RTWProductSearchError("SESSION_CHANGED");
		}
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => undefined);
			throw new RTWProductSearchError("NOT_AUTHENTICATED");
		}
		if (response.status === 409 || response.status === 404) {
			await response.body?.cancel().catch(() => undefined);
			throw new RTWProductSearchError(
				response.status === 409 ? "CONFLICT" : "NOT_FOUND",
			);
		}
		if (![200, 202, 503].includes(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			throw new RTWProductSearchError("UNAVAILABLE");
		}
		if (
			!response.headers
				.get("content-type")
				?.toLowerCase()
				.startsWith("application/json")
		) {
			await response.body?.cancel().catch(() => undefined);
			throw new RTWProductSearchError("BAD_RESPONSE");
		}
		let payload: unknown;
		try {
			payload = await readLimitedJSON(response);
		} catch (error) {
			if (signal?.aborted) throw new RTWProductSearchError("CANCELLED");
			throw error;
		}
		if (signal?.aborted) throw new RTWProductSearchError("CANCELLED");
		if (!this.options.sessions.isCurrent(session)) {
			throw new RTWProductSearchError("SESSION_CHANGED");
		}
		const parsed = envelope.safeParse(payload);
		if (!parsed.success || parsed.data.code !== response.status) {
			throw new RTWProductSearchError("BAD_RESPONSE");
		}
		const data = parsed.data.data;
		if (
			response.status === 200 &&
			(data.status === "succeeded" || data.status === "insufficient")
		) {
			if (
				(data.status === "succeeded" &&
					(!data.answer ||
						!data.citation_receipt_ref ||
						data.citations.length === 0)) ||
				(data.status === "insufficient" &&
					(data.answer ||
						data.citations.length > 0 ||
						data.citation_receipt_ref)) ||
				data.citations.some(
					(item) =>
						createHash("sha256").update(item.quote, "utf8").digest("hex") !==
						item.quote_hash,
				)
			) {
				throw new RTWProductSearchError("BAD_RESPONSE");
			}
			return { kind: "accepted", result: data };
		}
		if (response.status === 202 && data.status === "in_flight") {
			return {
				kind: "in_flight",
				searchId: data.search_id,
				answerId: data.answer_id,
			};
		}
		if (
			(response.status === 503 || response.status === 200) &&
			data.status === "retryable_failure"
		) {
			return {
				kind: "retryable_failure",
				searchId: data.search_id,
				answerId: data.answer_id,
			};
		}
		throw new RTWProductSearchError("BAD_RESPONSE");
	}
}

function parseBaseUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new RTWProductSearchError("INVALID_INPUT");
	}
	const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "" && url.pathname !== "/")
	) {
		throw new RTWProductSearchError("INVALID_INPUT");
	}
	url.pathname = "/";
	return url;
}

async function readLimitedJSON(response: Response): Promise<unknown> {
	if (!response.body) throw new RTWProductSearchError("BAD_RESPONSE");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES)
				throw new RTWProductSearchError("BAD_RESPONSE");
			parts.push(value);
		}
	} catch (error) {
		if (error instanceof RTWProductSearchError) throw error;
		throw new RTWProductSearchError("UNAVAILABLE");
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new RTWProductSearchError("BAD_RESPONSE");
	}
}
