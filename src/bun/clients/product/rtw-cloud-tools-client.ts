import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	CloudSearchParent,
	CloudSearchProductPort,
} from "../../../agent/mastra-host/cloud-tools/cloud-search-tools";
import type { AuthSessionIdentity } from "../../../shared/session-identity";
import { parseRTWHistoryJSON } from "./rtw-history-json";
import type {
	RTWProductSession,
	RTWProductSessionProvider,
} from "./rtw-product-search-client";

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,256}$/u);
const boundedText = z.string().trim().min(1).max(256);
const key = z.string().regex(/^[A-Za-z0-9_.-]{8,128}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const durableRef = z
	.string()
	.regex(/^search-citations\/sha256\/[a-f0-9]{64}$/u);
const sessionId = z
	.string()
	.min(1)
	.max(200)
	.refine((value) =>
		[...value].every((character) => {
			const code = character.charCodeAt(0);
			return code >= 32 && code !== 127;
		}),
	);
const receipt = z.object({
	search_id: id,
	pack_hash: hash,
	durable_ref: durableRef,
});
const evidence = z.object({
	evidence_id: id,
	revision_id: id,
	locator: boundedText,
	quote: z.string().min(1).max(32768),
	quote_hash: hash,
	source_kind: z.enum(["source", "wiki"]),
});
const budget = z.object({
	search_calls: z.number().int().nonnegative(),
	read_calls: z.number().int().nonnegative(),
	quote_runes: z.number().int().nonnegative(),
	max_reads_per_search: z.number().int().positive(),
	max_quote_runes_per_search: z.number().int().positive(),
});
const parentResult = z.object({
	operation_id: id,
	scope_ref: id,
	snapshot_ref: id,
	budget_ref: id,
	module_id: id,
	deadline_at_ms: z.number().int().positive(),
	allow_lower_intelligence: z.boolean(),
	budget,
});
const searchResult = z.object({
	search_id: id,
	status: z.enum(["complete", "partial", "empty"]),
	stop_reason: boundedText,
	snapshot_ref: id,
	requested_intelligence: z.enum(["low", "medium", "high"]),
	effective_intelligence: z.enum(["low", "medium", "high"]),
	evidence: z.array(evidence).max(100),
	gaps: z.array(boundedText).max(100),
	conflicts: z.array(boundedText).max(100),
	pack_hash: hash.optional(),
	citation_receipt: receipt.optional(),
	usage: z.object({
		read_calls: z.number().int().nonnegative(),
		quote_runes: z.number().int().nonnegative(),
	}),
});
const readResult = z.object({
	search_id: id,
	snapshot_ref: id,
	evidence,
	citation_receipt: receipt,
});
const pendingResult = z.object({
	search_id: id,
	status: z.enum(["in_flight", "retryable_failure"]),
	evidence: z.array(z.unknown()).length(0),
});
const envelope = z.object({
	code: z.number().int(),
	msg: z.string(),
	data: z.unknown(),
});

export class RTWCloudToolsError extends Error {
	constructor(
		readonly code:
			| "INVALID_INPUT"
			| "NOT_AUTHENTICATED"
			| "SESSION_CHANGED"
			| "CANCELLED"
			| "CONFLICT"
			| "BUDGET_EXHAUSTED"
			| "NOT_FOUND"
			| "UNAVAILABLE"
			| "BAD_RESPONSE"
			| "IN_FLIGHT"
			| "RETRYABLE_FAILURE"
			| "UNSUPPORTED",
		readonly searchId?: string,
	) {
		super(code);
		this.name = "RTWCloudToolsError";
	}
}

export interface RTWCloudToolsClientOptions {
	baseUrl: string;
	sessions: RTWProductSessionProvider;
	/** Bun's exact current desktop login, independent of RTW's numeric UID. */
	accountSessions: {
		current(): AuthSessionIdentity | null;
		isCurrent(identity: AuthSessionIdentity): boolean;
	};
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	requestTimeoutMs?: number;
}

export interface RTWCloudToolsParentInput {
	/** RTW's logical knowledge session, never the DC login UUID. */
	logicalSessionId: string;
	moduleId: string;
	idempotencyKey: string;
	/** These two values must originate from the Bun-owned current Agent run. */
	runId: string;
	accountId: string;
	signal: AbortSignal;
}

const MAX_RESPONSE_BYTES = 1 << 20;

/** Bun transport for RTW's authenticated Tool parent and its two child routes. */
export class RTWCloudToolsClient {
	private readonly baseUrl: URL;
	private readonly fetchImpl: NonNullable<RTWCloudToolsClientOptions["fetch"]>;
	private readonly requestTimeoutMs: number;

	constructor(private readonly options: RTWCloudToolsClientOptions) {
		if (
			typeof options.accountSessions?.current !== "function" ||
			typeof options.accountSessions?.isCurrent !== "function"
		)
			throw new RTWCloudToolsError("INVALID_INPUT");
		try {
			this.baseUrl = new URL(options.baseUrl);
		} catch {
			throw new RTWCloudToolsError("INVALID_INPUT");
		}
		const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
			this.baseUrl.hostname,
		);
		if (
			(this.baseUrl.protocol !== "https:" &&
				!(this.baseUrl.protocol === "http:" && loopback)) ||
			this.baseUrl.username ||
			this.baseUrl.password ||
			this.baseUrl.search ||
			this.baseUrl.hash ||
			!["", "/"].includes(this.baseUrl.pathname)
		)
			throw new RTWCloudToolsError("INVALID_INPUT");
		this.baseUrl.pathname = "/";
		this.fetchImpl = options.fetch ?? fetch;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		if (
			!Number.isSafeInteger(this.requestTimeoutMs) ||
			this.requestTimeoutMs < 1_000 ||
			this.requestTimeoutMs > 180_000
		)
			throw new RTWCloudToolsError("INVALID_INPUT");
	}

	async startParent(
		input: RTWCloudToolsParentInput,
	): Promise<RTWCloudToolsRun> {
		if (
			!sessionId.safeParse(input.logicalSessionId).success ||
			new TextEncoder().encode(input.logicalSessionId).length > 200 ||
			!id.safeParse(input.moduleId).success ||
			!key.safeParse(input.idempotencyKey).success ||
			!id.safeParse(input.runId).success ||
			!id.safeParse(input.accountId).success ||
			!input.signal
		)
			throw new RTWCloudToolsError("INVALID_INPUT");
		const current = await this.options.sessions.current();
		const currentAccount = this.options.accountSessions.current();
		if (!current || !this.validSession(current))
			throw new RTWCloudToolsError("NOT_AUTHENTICATED");
		if (
			!currentAccount ||
			currentAccount.accountId !== input.accountId ||
			!this.options.accountSessions.isCurrent(currentAccount)
		)
			throw new RTWCloudToolsError("SESSION_CHANGED");
		const session = { ...current };
		const account = { ...currentAccount };
		if (!this.options.sessions.isCurrent(session))
			throw new RTWCloudToolsError("SESSION_CHANGED");
		const abort = new AbortController();
		const signal = AbortSignal.any([input.signal, abort.signal]);
		const path = `/v1/knowledge/answer-sessions/${encodeURIComponent(input.logicalSessionId)}/tool-runs`;
		const raw = await this.request(
			session,
			account,
			path,
			"POST",
			{
				module_id: input.moduleId,
				idempotency_key: input.idempotencyKey,
			},
			signal,
		);
		if (raw.status === 503) throw new RTWCloudToolsError("UNAVAILABLE");
		const parsed = parentResult.safeParse(raw.data);
		if (
			raw.status !== 200 ||
			!parsed.success ||
			parsed.data.module_id !== input.moduleId ||
			parsed.data.deadline_at_ms <= Date.now() ||
			parsed.data.deadline_at_ms > Date.now() + 630_000 ||
			parsed.data.budget.search_calls > 4 ||
			parsed.data.budget.read_calls > 24 ||
			parsed.data.budget.quote_runes > 32768 ||
			parsed.data.budget.max_reads_per_search > 8 ||
			parsed.data.budget.max_quote_runes_per_search > 8192
		)
			throw new RTWCloudToolsError("BAD_RESPONSE");
		if (
			parsed.data.budget.search_calls === 0 ||
			parsed.data.budget.read_calls === 0 ||
			parsed.data.budget.quote_runes === 0
		)
			throw new RTWCloudToolsError("BUDGET_EXHAUSTED");
		return new RTWCloudToolsRun(
			this,
			session,
			account,
			input,
			parsed.data,
			abort,
			signal,
		);
	}

	private validSession(value: RTWProductSession): boolean {
		return (
			/^[A-Za-z0-9._~-]{1,8192}$/u.test(value.accessToken) &&
			sessionId.safeParse(value.sessionId).success &&
			Number.isSafeInteger(value.generation) &&
			value.generation >= 0
		);
	}

	private async assertCurrent(
		session: RTWProductSession,
		account: AuthSessionIdentity,
	): Promise<void> {
		const now = await this.options.sessions.current();
		const nowAccount = this.options.accountSessions.current();
		if (
			!now ||
			!this.options.sessions.isCurrent(session) ||
			now.generation !== session.generation ||
			now.sessionId !== session.sessionId ||
			now.accessToken !== session.accessToken ||
			!nowAccount ||
			!this.options.accountSessions.isCurrent(account) ||
			nowAccount.accountId !== account.accountId ||
			nowAccount.sessionId !== account.sessionId ||
			nowAccount.generation !== account.generation
		)
			throw new RTWCloudToolsError("SESSION_CHANGED");
	}

	async request(
		session: RTWProductSession,
		account: AuthSessionIdentity,
		path: string,
		method: "GET" | "POST",
		body: object | undefined,
		signal: AbortSignal,
	): Promise<{ status: number; data: unknown }> {
		if (signal.aborted) throw new RTWCloudToolsError("CANCELLED");
		await this.assertCurrent(session, account);
		const requestSignal = AbortSignal.any([
			signal,
			AbortSignal.timeout(this.requestTimeoutMs),
		]);
		let response: Response;
		try {
			response = await this.fetchImpl(new URL(path, this.baseUrl), {
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
			throw new RTWCloudToolsError(
				signal.aborted ? "CANCELLED" : "UNAVAILABLE",
			);
		}
		if (signal.aborted) {
			await response.body?.cancel().catch(() => undefined);
			throw new RTWCloudToolsError("CANCELLED");
		}
		try {
			await this.assertCurrent(session, account);
		} catch (error) {
			await response.body?.cancel().catch(() => undefined);
			throw error;
		}
		if (
			response.status === 401 ||
			response.status === 403 ||
			response.status === 404 ||
			response.status === 409
		) {
			await response.body?.cancel().catch(() => undefined);
			throw new RTWCloudToolsError(
				response.status === 404
					? "NOT_FOUND"
					: response.status === 409
						? "CONFLICT"
						: "NOT_AUTHENTICATED",
			);
		}
		if (![200, 202, 503].includes(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			throw new RTWCloudToolsError("UNAVAILABLE");
		}
		if (
			!response.headers
				.get("content-type")
				?.toLowerCase()
				.startsWith("application/json")
		) {
			await response.body?.cancel().catch(() => undefined);
			throw new RTWCloudToolsError("BAD_RESPONSE");
		}
		const payload = await readLimitedJSON(response, signal);
		if (signal.aborted) throw new RTWCloudToolsError("CANCELLED");
		await this.assertCurrent(session, account);
		const parsed = envelope.safeParse(payload);
		if (!parsed.success || parsed.data.code !== response.status)
			throw new RTWCloudToolsError("BAD_RESPONSE");
		return { status: response.status, data: parsed.data.data };
	}
}

type ParentResult = z.infer<typeof parentResult>;

/** One RTW parent operation, pinned to one immutable product session and run. */
export class RTWCloudToolsRun {
	readonly parent: CloudSearchParent;
	readonly port: CloudSearchProductPort;
	private readonly parentPath: string;

	constructor(
		private readonly client: RTWCloudToolsClient,
		private readonly session: RTWProductSession,
		private readonly account: AuthSessionIdentity,
		input: RTWCloudToolsParentInput,
		parent: ParentResult,
		private readonly abort: AbortController,
		private readonly signal: AbortSignal,
	) {
		this.parentPath = `/v1/knowledge/answer-sessions/${encodeURIComponent(input.logicalSessionId)}/tool-runs/${encodeURIComponent(parent.operation_id)}`;
		this.parent = {
			runId: input.runId,
			accountId: input.accountId,
			operationId: parent.operation_id,
			scopeRef: parent.scope_ref,
			snapshotRef: parent.snapshot_ref,
			budgetRef: parent.budget_ref,
			allowLowerIntelligence: parent.allow_lower_intelligence,
			deadlineAtMs: parent.deadline_at_ms,
			signal,
			budget: {
				searchCalls: parent.budget.search_calls,
				readCalls: parent.budget.read_calls,
				quoteRunes: parent.budget.quote_runes,
				maxReadsPerSearch: parent.budget.max_reads_per_search,
				maxQuoteRunesPerSearch: parent.budget.max_quote_runes_per_search,
			},
		};
		this.port = {
			search: (request) => this.search(request),
			readEvidence: (request) => this.readEvidence(request),
		};
	}

	/** Bun's account-cutover and Agent-run cancellation owner must call this. */
	cancel(): void {
		this.abort.abort();
	}

	private assertParent(
		value: Readonly<Omit<CloudSearchParent, "signal" | "budget">>,
	): void {
		for (const field of [
			"runId",
			"accountId",
			"operationId",
			"scopeRef",
			"snapshotRef",
			"budgetRef",
			"allowLowerIntelligence",
			"deadlineAtMs",
		] as const) {
			if (value[field] !== this.parent[field])
				throw new RTWCloudToolsError("INVALID_INPUT");
		}
	}

	private callSignal(signal: AbortSignal): AbortSignal {
		if (
			this.signal.aborted ||
			signal.aborted ||
			Date.now() >= this.parent.deadlineAtMs
		)
			throw new RTWCloudToolsError("CANCELLED");
		return AbortSignal.any([
			this.signal,
			signal,
			AbortSignal.timeout(this.parent.deadlineAtMs - Date.now()),
		]);
	}

	private async search(
		request: Parameters<CloudSearchProductPort["search"]>[0],
	) {
		this.assertParent(request.parent);
		if (!key.safeParse(request.requestKey).success)
			throw new RTWCloudToolsError("INVALID_INPUT");
		if (request.continueSearchId) throw new RTWCloudToolsError("UNSUPPORTED");
		if (
			!z.string().trim().min(1).max(4096).safeParse(request.query).success ||
			new TextEncoder().encode(request.query).length > 4096 ||
			!(["fast", "detailed"] as const).includes(request.depth) ||
			!(["low", "medium", "high"] as const).includes(request.intelligence) ||
			!Number.isSafeInteger(request.limits.readCalls) ||
			request.limits.readCalls < 1 ||
			request.limits.readCalls > this.parent.budget.maxReadsPerSearch ||
			!Number.isSafeInteger(request.limits.quoteRunes) ||
			request.limits.quoteRunes < 1 ||
			request.limits.quoteRunes > this.parent.budget.maxQuoteRunesPerSearch
		)
			throw new RTWCloudToolsError("INVALID_INPUT");
		const raw = await this.client.request(
			this.session,
			this.account,
			`${this.parentPath}/searches`,
			"POST",
			{
				query: request.query,
				depth: request.depth,
				intelligence: request.intelligence,
				read_calls: request.limits.readCalls,
				quote_runes: request.limits.quoteRunes,
				idempotency_key: request.requestKey,
			},
			this.callSignal(request.signal),
		);
		if (raw.status !== 200) {
			const pending = pendingResult.safeParse(raw.data);
			if (
				pending.success &&
				((raw.status === 202 && pending.data.status === "in_flight") ||
					(raw.status === 503 && pending.data.status === "retryable_failure"))
			)
				throw new RTWCloudToolsError(
					raw.status === 202 ? "IN_FLIGHT" : "RETRYABLE_FAILURE",
					pending.data.search_id,
				);
			throw new RTWCloudToolsError(
				raw.status === 503 ? "UNAVAILABLE" : "BAD_RESPONSE",
			);
		}
		const parsed = searchResult.safeParse(raw.data);
		if (
			!parsed.success ||
			parsed.data.snapshot_ref !== this.parent.snapshotRef ||
			parsed.data.requested_intelligence !== request.intelligence ||
			parsed.data.usage.read_calls > request.limits.readCalls ||
			parsed.data.usage.quote_runes > request.limits.quoteRunes ||
			parsed.data.evidence.some(
				(item) => digest(item.quote) !== item.quote_hash,
			) ||
			(parsed.data.citation_receipt &&
				parsed.data.citation_receipt.durable_ref !==
					`search-citations/sha256/${digest(parsed.data.search_id)}`)
		)
			throw new RTWCloudToolsError("BAD_RESPONSE");
		return parsed.data;
	}

	private async readEvidence(
		request: Parameters<CloudSearchProductPort["readEvidence"]>[0],
	) {
		this.assertParent(request.parent);
		if (!key.safeParse(request.requestKey).success)
			throw new RTWCloudToolsError("INVALID_INPUT");
		if (
			!id.safeParse(request.searchId).success ||
			!id.safeParse(request.evidenceId).success
		)
			throw new RTWCloudToolsError("INVALID_INPUT");
		const raw = await this.client.request(
			this.session,
			this.account,
			`${this.parentPath}/evidence-reads`,
			"POST",
			{
				search_id: request.searchId,
				evidence_id: request.evidenceId,
				idempotency_key: request.requestKey,
			},
			this.callSignal(request.signal),
		);
		if (raw.status !== 200) throw new RTWCloudToolsError("UNAVAILABLE");
		const parsed = readResult.safeParse(raw.data);
		if (
			!parsed.success ||
			parsed.data.search_id !== request.searchId ||
			parsed.data.snapshot_ref !== this.parent.snapshotRef ||
			parsed.data.evidence.evidence_id !== request.evidenceId ||
			parsed.data.citation_receipt.search_id !== request.searchId ||
			digest(parsed.data.evidence.quote) !== parsed.data.evidence.quote_hash ||
			parsed.data.citation_receipt.durable_ref !==
				`search-citations/sha256/${digest(request.searchId)}`
		)
			throw new RTWCloudToolsError("BAD_RESPONSE");
		return parsed.data;
	}
}

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readLimitedJSON(
	response: Response,
	signal: AbortSignal,
): Promise<unknown> {
	if (!response.body) throw new RTWCloudToolsError("BAD_RESPONSE");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES)
				throw new RTWCloudToolsError("BAD_RESPONSE");
			parts.push(value);
		}
	} catch (error) {
		if (signal.aborted) throw new RTWCloudToolsError("CANCELLED");
		if (error instanceof RTWCloudToolsError) throw error;
		throw new RTWCloudToolsError("UNAVAILABLE");
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
		return parseRTWHistoryJSON(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
	} catch {
		throw new RTWCloudToolsError("BAD_RESPONSE");
	}
}
