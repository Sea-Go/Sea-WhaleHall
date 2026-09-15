import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	CloudAcceptedAnswer,
	CloudAnswersPage,
	CloudHistoryResult,
	ListCloudAnswersRequest,
} from "../../../shared/cloud-history";
import { parseRTWHistoryJSON } from "./rtw-history-json";
import {
	canonicalRTWSubject,
	rtwHistorySubject,
	rtwSubjectVersion,
} from "./rtw-history-subject";
import type {
	RTWProductSession,
	RTWProductSessionProvider,
} from "./rtw-product-search-client";

const id = z.string().min(1).max(512);
const MAX_EXCERPT_RUNES = 240;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const citationObject = z.object({ key: id, sha256 }).strict();
const lanes = ["dense", "sparse", "multivector"] as const;
const snapshot = z
	.object({
		module_id: id,
		release_id: id,
		generation: z.number().int().positive().safe(),
		publication_revision: id,
		indexes: z
			.object({
				dense: citationObject,
				sparse: citationObject,
				multivector: citationObject,
			})
			.strict(),
		valid_revision_ids: z.array(id),
	})
	.passthrough();
const sameSnapshot = (
	a: z.infer<typeof snapshot>,
	b: z.infer<typeof snapshot>,
) =>
	a.module_id === b.module_id &&
	a.release_id === b.release_id &&
	a.generation === b.generation &&
	a.publication_revision === b.publication_revision &&
	lanes.every(
		(lane) =>
			a.indexes[lane].key === b.indexes[lane].key &&
			a.indexes[lane].sha256 === b.indexes[lane].sha256,
	) &&
	a.valid_revision_ids.length === b.valid_revision_ids.length &&
	a.valid_revision_ids.every(
		(revision, index) => revision === b.valid_revision_ids[index],
	);
const locator = z
	.object({
		locator: id,
		original_byte_start: z.number().int().nonnegative().safe(),
		original_byte_end: z.number().int().nonnegative().safe(),
		normalized_rune_start: z.number().int().nonnegative().safe(),
		normalized_rune_end: z.number().int().nonnegative().safe(),
	})
	.strict();
const citation = z
	.object({
		evidence_id: id,
		source_kind: id,
		content_id: id,
		revision_id: id,
		chunk_id: id,
		original: citationObject,
		locator,
		quote_hash: sha256,
		state: z.enum(["available", "unavailable"]),
	})
	.strict();
const answer = z
	.object({
		answer_id: id,
		search_id: id,
		subject: rtwHistorySubject,
		session_id: id,
		status: z.enum(["succeeded", "insufficient"]),
		accepted_ordinal: z.number().int().positive().safe(),
		accepted_at: z.string().datetime({ offset: true }),
		turn_json: z.string().max(4 * 1024 * 1024),
	})
	.strict();
const page = z
	.object({
		items: z.array(answer).max(20),
		next_ordinal: z.number().int().nonnegative().safe().optional().default(0),
	})
	.strict();
const citationState = z
	.object({
		answer_id: id,
		search_id: id,
		status: z.string(),
		module_id: z.string(),
		release_id: z.string(),
		publication_revision: z.string(),
		citations: z.array(citation).max(100),
	})
	.strict();
const turn = z
	.object({
		Request: z
			.object({
				SearchID: id,
				AnswerID: id,
				Subject: rtwHistorySubject,
				SessionID: id,
				Search: z
					.object({
						Query: z.string().min(1).max(4096),
						Snapshot: snapshot,
					})
					.passthrough(),
			})
			.strict(),
		result: z
			.object({
				search: z
					.object({
						evidence_pack: z
							.object({
								search_id: id,
								snapshot,
								status: z.enum(["complete", "partial", "empty"]),
								evidence: z.array(
									z
										.object({
											evidence_id: id,
											key: z
												.object({
													source_kind: id,
													content_id: id,
													revision_id: id,
													chunk_id: id,
												})
												.strict(),
											original: citationObject,
											locator,
											quote_hash: sha256,
											quote: z
												.string()
												.min(1)
												.max(1 << 20),
										})
										.passthrough(),
								),
							})
							.passthrough(),
					})
					.passthrough(),
				answer_id: id,
				answer: z.string().optional(),
				summary_status: z.enum(["succeeded", "insufficient"]),
				citations: z.array(id),
			})
			.strict(),
	})
	.strict();

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

class CitationMismatchError extends Error {}

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
		let previous = input.afterOrdinal ?? 0;
		const seen = new Set<string>();
		const firstSubject = raw.items[0]
			? canonicalRTWSubject(raw.items[0].subject)
			: null;
		for (const item of raw.items) {
			const owner = canonicalRTWSubject(item.subject);
			if (
				(firstSubject &&
					(owner.issuer !== firstSubject.issuer ||
						owner.subjectId !== firstSubject.subjectId)) ||
				item.session_id !== input.logicalSessionId ||
				item.accepted_ordinal <= previous ||
				seen.has(item.answer_id)
			) {
				throw new RTWCloudHistoryError("BAD_RESPONSE");
			}
			previous = item.accepted_ordinal;
			seen.add(item.answer_id);
		}
		if (
			raw.next_ordinal !== 0 &&
			(raw.items.length === 0 || raw.next_ordinal !== previous)
		) {
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		}
		const result: CloudAcceptedAnswer[] = [];
		for (const item of raw.items) {
			result.push(await this.project(item, root, session));
		}
		this.assertCurrent(session);
		return { items: result, nextOrdinal: raw.next_ordinal || null };
	}

	private async project(
		item: z.infer<typeof answer>,
		root: string,
		session: RTWProductSession,
	): Promise<CloudAcceptedAnswer> {
		let parsed: unknown;
		try {
			parsed = parseRTWHistoryJSON(item.turn_json);
		} catch {
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		}
		const accepted = turn.safeParse(parsed);
		const outerSubject = canonicalRTWSubject(item.subject);
		const turnSubject = accepted.success
			? canonicalRTWSubject(accepted.data.Request.Subject)
			: null;
		if (
			!accepted.success ||
			(rtwSubjectVersion(item.subject) === 1 &&
				rtwSubjectVersion(accepted.data.Request.Subject) === 2) ||
			accepted.data.Request.SearchID !== item.search_id ||
			accepted.data.Request.AnswerID !== item.answer_id ||
			accepted.data.Request.SessionID !== item.session_id ||
			turnSubject?.issuer !== outerSubject.issuer ||
			turnSubject.subjectId !== outerSubject.subjectId ||
			accepted.data.result.answer_id !== item.answer_id ||
			accepted.data.result.search.evidence_pack.search_id !== item.search_id ||
			accepted.data.result.summary_status !== item.status ||
			(item.status === "succeeded" &&
				accepted.data.result.search.evidence_pack.status === "empty") ||
			(item.status === "succeeded" && !accepted.data.result.answer) ||
			(item.status === "succeeded" &&
				accepted.data.result.citations.length === 0) ||
			(item.status === "insufficient" &&
				(accepted.data.result.answer ||
					accepted.data.result.citations.length > 0 ||
					accepted.data.result.search.evidence_pack.status !== "empty" ||
					accepted.data.result.search.evidence_pack.evidence.length > 0))
		) {
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		}
		const frozen = accepted.data.result.citations;
		const evidence = accepted.data.result.search.evidence_pack.evidence;
		const fixedSnapshot = accepted.data.Request.Search.Snapshot;
		const packSnapshot = accepted.data.result.search.evidence_pack.snapshot;
		const frozenEvidence = new Map(
			evidence.map((entry) => [entry.evidence_id, entry]),
		);
		if (
			!sameSnapshot(packSnapshot, fixedSnapshot) ||
			new Set(frozen).size !== frozen.length ||
			frozenEvidence.size !== evidence.length ||
			frozen.some((key) => !frozenEvidence.has(key)) ||
			evidence.some(
				(entry) =>
					createHash("sha256").update(entry.quote, "utf8").digest("hex") !==
					entry.quote_hash,
			)
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
			if (
				(item.status === "succeeded" &&
					(live.module_id !== fixedSnapshot.module_id ||
						live.release_id !== fixedSnapshot.release_id ||
						live.publication_revision !==
							fixedSnapshot.publication_revision)) ||
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
						entry.original.key !== original.original.key ||
						entry.original.sha256 !== original.original.sha256 ||
						entry.locator.locator !== original.locator.locator ||
						entry.locator.original_byte_start !==
							original.locator.original_byte_start ||
						entry.locator.original_byte_end !==
							original.locator.original_byte_end ||
						entry.locator.normalized_rune_start !==
							original.locator.normalized_rune_start ||
						entry.locator.normalized_rune_end !==
							original.locator.normalized_rune_end ||
						entry.quote_hash !== original.quote_hash
					);
				})
			) {
				throw new CitationMismatchError();
			}
			citations = live.citations.map((entry) => {
				const original = frozenEvidence.get(entry.evidence_id);
				if (!original) throw new CitationMismatchError();
				const runes = Array.from(original.quote);
				return {
					evidenceId: entry.evidence_id,
					sourceKind: entry.source_kind,
					contentId: entry.content_id,
					revisionId: entry.revision_id,
					chunkId: entry.chunk_id,
					state: entry.state,
					...(entry.state === "available"
						? {
								excerpt:
									runes.length > MAX_EXCERPT_RUNES
										? `${runes.slice(0, MAX_EXCERPT_RUNES - 1).join("")}…`
										: original.quote,
							}
						: {}),
				};
			});
			state = "verified";
		} catch (error) {
			if (
				error instanceof RTWCloudHistoryError &&
				(error.code === "NOT_AUTHENTICATED" ||
					error.code === "SESSION_CHANGED" ||
					error.code === "BAD_RESPONSE")
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
			payload = parseRTWHistoryJSON(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
		} catch {
			throw new RTWCloudHistoryError("BAD_RESPONSE");
		}
		const parsed = z
			.object({ code: z.number().int(), msg: z.string(), data: schema })
			.strict()
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
