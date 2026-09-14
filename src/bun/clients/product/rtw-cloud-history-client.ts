import { z } from "zod";
import type {
	CloudAcceptedAnswer,
	CloudAnswersPage,
	CloudHistoryResult,
	ListCloudAnswersRequest,
} from "../../../shared/cloud-history";
import type {
	RTWProductSession,
	RTWProductSessionProvider,
} from "./rtw-product-search-client";

const id = z.string().min(1).max(512);
const citation = z.object({
	evidence_id: id,
	source_kind: id,
	content_id: id,
	revision_id: id,
	chunk_id: id,
	quote_hash: id,
	state: z.enum(["available", "unavailable"]),
});
const answer = z.object({
	answer_id: id,
	search_id: id,
	session_id: id,
	status: z.enum(["succeeded", "insufficient"]),
	accepted_ordinal: z.number().int().positive().safe(),
	accepted_at: z.string().datetime({ offset: true }),
	turn_json: z.string().max(4 * 1024 * 1024),
});
const page = z.object({
	items: z.array(answer).max(20),
	next_ordinal: z.number().int().nonnegative().safe().optional().default(0),
});
const citationState = z.object({
	answer_id: id,
	search_id: id,
	status: z.string(),
	citations: z.array(citation).max(100),
});
const turn = z.object({
	Request: z.object({
		SearchID: id,
		AnswerID: id,
		SessionID: id,
		Search: z.object({ Query: z.string().min(1).max(4096) }),
	}),
	result: z.object({
		search: z.object({
			evidence_pack: z.object({
				evidence: z.array(
					z.object({
						evidence_id: id,
						key: z.object({
							source_kind: id,
							content_id: id,
							revision_id: id,
							chunk_id: id,
						}),
						quote_hash: id,
					}),
				),
			}),
		}),
		answer_id: id,
		answer: z.string().optional(),
		summary_status: z.enum(["succeeded", "insufficient"]),
		citations: z.array(id),
	}),
});

export interface RTWCloudHistoryClientOptions {
	baseUrl: string;
	sessions: RTWProductSessionProvider;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	requestTimeoutMs?: number;
}

export class RTWCloudHistoryError extends Error {
	constructor(
		readonly code:
			| "INVALID_INPUT"
			| "NOT_AUTHENTICATED"
			| "SESSION_CHANGED"
			| "UNAVAILABLE"
			| "BAD_RESPONSE"
			| "NOT_FOUND",
	) {
		super(code);
		this.name = "RTWCloudHistoryError";
	}
}

/** Bun-only transport. The renderer receives neither the bearer nor historical evidence/quote. */
export class RTWCloudHistoryClient {
	private readonly baseUrl: URL;
	private readonly fetchImpl: (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>;
	private readonly timeoutMs: number;

	constructor(private readonly options: RTWCloudHistoryClientOptions) {
		let baseUrl: URL;
		try {
			baseUrl = new URL(options.baseUrl);
		} catch {
			throw new RTWCloudHistoryError("INVALID_INPUT");
		}
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
			baseUrl.hostname,
		);
		if (
			(baseUrl.protocol !== "https:" &&
				!(baseUrl.protocol === "http:" && loopback)) ||
			baseUrl.username ||
			baseUrl.password ||
			baseUrl.search ||
			baseUrl.hash ||
			baseUrl.pathname !== "/"
		) {
			throw new RTWCloudHistoryError("INVALID_INPUT");
		}
		this.baseUrl = baseUrl;
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = options.requestTimeoutMs ?? 15000;
		if (
			!Number.isSafeInteger(this.timeoutMs) ||
			this.timeoutMs < 1000 ||
			this.timeoutMs > 60000
		) {
			throw new RTWCloudHistoryError("INVALID_INPUT");
		}
	}

	async list(input: ListCloudAnswersRequest): Promise<CloudAnswersPage> {
		if (
			!id.safeParse(input.logicalSessionId).success ||
			!Number.isSafeInteger(input.afterOrdinal ?? 0) ||
			(input.afterOrdinal ?? 0) < 0 ||
			!Number.isSafeInteger(input.limit ?? 5) ||
			(input.limit ?? 5) < 1 ||
			(input.limit ?? 5) > 20
		) {
			throw new RTWCloudHistoryError("INVALID_INPUT");
		}
		const current = await this.options.sessions.current();
		if (
			!current?.accessToken ||
			!current.sessionId ||
			!Number.isSafeInteger(current.generation)
		) {
			throw new RTWCloudHistoryError("NOT_AUTHENTICATED");
		}
		const session = { ...current };
		this.assertCurrent(session);
		const root = `/v1/knowledge/answer-sessions/${encodeURIComponent(input.logicalSessionId)}/accepted-answers`;
		const query = new URLSearchParams({
			after_ordinal: String(input.afterOrdinal ?? 0),
			limit: String(input.limit ?? 5),
		});
		const raw = await this.get(`${root}?${query}`, session, page);
		const result: CloudAcceptedAnswer[] = [];
		let previous = input.afterOrdinal ?? 0;
		const seen = new Set<string>();
		for (const item of raw.items) {
			if (
				item.session_id !== input.logicalSessionId ||
				item.accepted_ordinal <= previous ||
				seen.has(item.answer_id)
			) {
				throw new RTWCloudHistoryError("BAD_RESPONSE");
			}
			previous = item.accepted_ordinal;
			seen.add(item.answer_id);
			result.push(await this.project(item, root, session));
		}
		this.assertCurrent(session);
		if (
			raw.next_ordinal !== 0 &&
			(result.length === 0 || raw.next_ordinal !== previous)
		) {
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		}
		return { items: result, nextOrdinal: raw.next_ordinal || null };
	}

	private async project(
		item: z.infer<typeof answer>,
		root: string,
		session: RTWProductSession,
	): Promise<CloudAcceptedAnswer> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(item.turn_json);
		} catch {
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		}
		const accepted = turn.safeParse(parsed);
		if (
			!accepted.success ||
			accepted.data.Request.SearchID !== item.search_id ||
			accepted.data.Request.AnswerID !== item.answer_id ||
			accepted.data.Request.SessionID !== item.session_id ||
			accepted.data.result.answer_id !== item.answer_id ||
			accepted.data.result.summary_status !== item.status ||
			(item.status === "succeeded" && !accepted.data.result.answer) ||
			(item.status === "insufficient" &&
				(accepted.data.result.answer ||
					accepted.data.result.citations.length > 0))
		) {
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		}
		let citations: CloudAcceptedAnswer["citations"] = [];
		let state: CloudAcceptedAnswer["citationState"] = "unavailable";
		try {
			const live = await this.get(
				`${root}/${encodeURIComponent(item.answer_id)}/citations`,
				session,
				citationState,
			);
			if (
				live.answer_id !== item.answer_id ||
				live.search_id !== item.search_id ||
				live.status !== item.status
			) {
				throw new RTWCloudHistoryError("BAD_RESPONSE");
			}
			const frozen = accepted.data.result.citations;
			const frozenEvidence = new Map(
				accepted.data.result.search.evidence_pack.evidence.map((entry) => [
					entry.evidence_id,
					entry,
				]),
			);
			if (
				new Set(frozen).size !== frozen.length ||
				live.citations.length !== frozen.length ||
				live.citations.some((entry, index) => {
					const original = frozenEvidence.get(entry.evidence_id);
					return (
						entry.evidence_id !== frozen[index] ||
						!original ||
						entry.source_kind !== original.key.source_kind ||
						entry.content_id !== original.key.content_id ||
						entry.revision_id !== original.key.revision_id ||
						entry.chunk_id !== original.key.chunk_id ||
						entry.quote_hash !== original.quote_hash
					);
				})
			) {
				throw new RTWCloudHistoryError("BAD_RESPONSE");
			}
			citations = live.citations.map((entry) => ({
				evidenceId: entry.evidence_id,
				sourceKind: entry.source_kind,
				contentId: entry.content_id,
				revisionId: entry.revision_id,
				chunkId: entry.chunk_id,
				state: entry.state,
			}));
			state = "verified";
		} catch (error) {
			if (
				error instanceof RTWCloudHistoryError &&
				(error.code === "NOT_AUTHENTICATED" || error.code === "SESSION_CHANGED")
			)
				throw error;
			// Citation status is unavailable or mismatched: never fall back to the frozen quote.
		}
		this.assertCurrent(session);
		return {
			answerId: item.answer_id,
			searchId: item.search_id,
			sessionId: item.session_id,
			acceptedOrdinal: item.accepted_ordinal,
			acceptedAt: item.accepted_at,
			status: item.status,
			question: accepted.data.Request.Search.Query,
			answer: accepted.data.result.answer || null,
			citations,
			citationState: state,
		};
	}

	private assertCurrent(session: RTWProductSession): void {
		if (!this.options.sessions.isCurrent(session))
			throw new RTWCloudHistoryError("SESSION_CHANGED");
	}

	private async get<T>(
		path: string,
		session: RTWProductSession,
		schema: z.ZodType<T>,
	): Promise<T> {
		const url = new URL(path, this.baseUrl);
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "GET",
				redirect: "error",
				signal: AbortSignal.timeout(this.timeoutMs),
				headers: {
					authorization: `Bearer ${session.accessToken}`,
					accept: "application/json",
				},
			});
		} catch {
			this.assertCurrent(session);
			throw new RTWCloudHistoryError("UNAVAILABLE");
		}
		this.assertCurrent(session);
		if (response.status === 401 || response.status === 403)
			throw new RTWCloudHistoryError("NOT_AUTHENTICATED");
		if (response.status === 404) throw new RTWCloudHistoryError("NOT_FOUND");
		if (
			response.status !== 200 ||
			!response.headers
				.get("content-type")
				?.toLowerCase()
				.startsWith("application/json")
		) {
			throw new RTWCloudHistoryError("UNAVAILABLE");
		}
		const length = Number(response.headers.get("content-length") ?? 0);
		if (length > 16 * 1024 * 1024)
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		const bytes = await readLimitedBody(response, 16 * 1024 * 1024);
		this.assertCurrent(session);
		let payload: unknown;
		try {
			payload = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
		} catch {
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		}
		const parsed = z
			.object({ code: z.number().int(), data: schema })
			.safeParse(payload);
		if (!parsed.success || parsed.data.code !== 200)
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		return parsed.data.data;
	}
}

async function readLimitedBody(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	if (!response.body) throw new RTWCloudHistoryError("BAD_RESPONSE");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw new RTWCloudHistoryError("BAD_RESPONSE");
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof RTWCloudHistoryError) throw error;
		throw new RTWCloudHistoryError("UNAVAILABLE");
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export function cloudHistoryResult<T>(
	work: () => Promise<T>,
): Promise<CloudHistoryResult<T>> {
	return work().then(
		(data) => ({ kind: "ok" as const, data }),
		(error): CloudHistoryResult<T> => {
			if (error instanceof RTWCloudHistoryError) {
				switch (error.code) {
					case "NOT_AUTHENTICATED":
						return { kind: "signed_out" };
					case "SESSION_CHANGED":
						return { kind: "session_changed" };
					case "BAD_RESPONSE":
					case "INVALID_INPUT":
						return { kind: "bad_response" };
					case "UNAVAILABLE":
						return { kind: "offline" };
					default:
						return { kind: "unavailable" };
				}
			}
			return { kind: "unavailable" };
		},
	);
}
