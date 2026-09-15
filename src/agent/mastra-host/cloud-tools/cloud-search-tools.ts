import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const intelligence = z.enum(["low", "medium", "high"]);
const searchInput = z
	.object({
		query: z.string().trim().min(1).max(4096),
		intelligence,
		continue_search_id: identifier.optional(),
	})
	.strict();
const readInput = z
	.object({
		search_id: identifier,
		evidence_id: identifier,
	})
	.strict();
const receiptSchema = z
	.object({
		search_id: identifier,
		pack_hash: hash,
		durable_ref: identifier,
	})
	.strict();
const evidenceSchema = z
	.object({
		evidence_id: identifier,
		revision_id: identifier,
		locator: identifier,
		quote: z.string().min(1).max(32768),
		quote_hash: hash,
		source_kind: z.enum(["source", "wiki"]),
	})
	.strict();
const searchResultSchema = z
	.object({
		search_id: identifier,
		status: z.enum(["complete", "partial", "empty"]),
		stop_reason: identifier,
		snapshot_ref: identifier,
		requested_intelligence: intelligence,
		effective_intelligence: intelligence,
		evidence: z.array(evidenceSchema).max(100),
		gaps: z.array(identifier).max(100),
		conflicts: z.array(identifier).max(100),
		pack_hash: hash.optional(),
		citation_receipt: receiptSchema.optional(),
		usage: z
			.object({
				read_calls: z.number().int().nonnegative(),
				quote_runes: z.number().int().nonnegative(),
			})
			.strict(),
	})
	.strict();
const readResultSchema = z
	.object({
		search_id: identifier,
		snapshot_ref: identifier,
		evidence: evidenceSchema,
		citation_receipt: receiptSchema,
	})
	.strict();

export type CloudSearchResult = z.infer<typeof searchResultSchema>;
export type CloudReadEvidenceResult = z.infer<typeof readResultSchema>;
export type SearchIntelligence = z.infer<typeof intelligence>;

/** Bun supplies these values from the authenticated parent run, never from model JSON. */
export interface CloudSearchParent {
	runId: string;
	accountId: string;
	operationId: string;
	scopeRef: string;
	snapshotRef: string;
	budgetRef: string;
	allowLowerIntelligence: boolean;
	deadlineAtMs: number;
	signal: AbortSignal;
	budget: {
		searchCalls: number;
		readCalls: number;
		quoteRunes: number;
		maxReadsPerSearch: number;
		maxQuoteRunesPerSearch: number;
	};
}

export interface CloudSearchProductPort {
	search(input: {
		parent: Readonly<Omit<CloudSearchParent, "signal" | "budget">>;
		/** Stable for one actual Mastra Tool-call ID, not supplied by model JSON. */
		requestKey: string;
		depth: "fast" | "detailed";
		query: string;
		intelligence: SearchIntelligence;
		continueSearchId?: string;
		limits: { readCalls: number; quoteRunes: number };
		signal: AbortSignal;
	}): Promise<unknown>;
	readEvidence(input: {
		parent: Readonly<Omit<CloudSearchParent, "signal" | "budget">>;
		requestKey: string;
		searchId: string;
		evidenceId: string;
		signal: AbortSignal;
	}): Promise<unknown>;
}

export class CloudSearchToolError extends Error {
	constructor(
		readonly code:
			| "INVALID_SCOPE"
			| "INVALID_INPUT"
			| "IDEMPOTENCY_CONFLICT"
			| "BUDGET_EXHAUSTED"
			| "CANCELLED"
			| "BAD_EVIDENCE"
			| "BAD_RECEIPT",
		message: string,
	) {
		super(message);
		this.name = "CloudSearchToolError";
	}
}

type Remaining = { searchCalls: number; readCalls: number; quoteRunes: number };
type SearchRecord = {
	snapshotRef: string;
	receipt: NonNullable<CloudSearchResult["citation_receipt"]>;
	evidence: Map<string, CloudSearchResult["evidence"][number]>;
};
type SearchAttempt = {
	depth: "fast" | "detailed";
	query: string;
	intelligence: SearchIntelligence;
	continueSearchId?: string;
	limits: { readCalls: number; quoteRunes: number };
	accepted?: CloudSearchResult;
};
type ReadAttempt = {
	searchId: string;
	evidenceId: string;
	accepted?: CloudReadEvidenceResult;
};

/** One instance belongs to one parent Agent run. Reusing it across accounts is forbidden. */
export class CloudSearchToolSession {
	private readonly parent: Readonly<
		Omit<CloudSearchParent, "signal" | "budget">
	>;
	private readonly signal: AbortSignal;
	private readonly budget: CloudSearchParent["budget"];
	private remaining: Remaining;
	private readonly searches = new Map<string, SearchRecord>();
	/** One reservation and one immutable body per parent/tool-call identity. */
	private readonly searchAttempts = new Map<string, SearchAttempt>();
	private readonly readAttempts = new Map<string, ReadAttempt>();
	private tail: Promise<void> = Promise.resolve();

	constructor(
		parent: CloudSearchParent,
		private readonly port: CloudSearchProductPort,
	) {
		for (const value of [
			parent.runId,
			parent.accountId,
			parent.operationId,
			parent.scopeRef,
			parent.snapshotRef,
			parent.budgetRef,
		]) {
			if (!identifier.safeParse(value).success || value !== value.trim())
				throw new CloudSearchToolError(
					"INVALID_SCOPE",
					"Authenticated parent scope is incomplete.",
				);
		}
		if (
			!Number.isFinite(parent.deadlineAtMs) ||
			parent.deadlineAtMs <= Date.now() ||
			!parent.signal ||
			!parent.budget ||
			Object.values(parent.budget).some(
				(value) => !Number.isSafeInteger(value) || value < 1,
			) ||
			typeof port?.search !== "function" ||
			typeof port.readEvidence !== "function"
		) {
			throw new CloudSearchToolError(
				"INVALID_SCOPE",
				"Parent deadline or budget is invalid.",
			);
		}
		if (typeof parent.allowLowerIntelligence !== "boolean") {
			throw new CloudSearchToolError(
				"INVALID_SCOPE",
				"Parent intelligence policy is missing.",
			);
		}
		this.parent = Object.freeze({
			runId: parent.runId,
			accountId: parent.accountId,
			operationId: parent.operationId,
			scopeRef: parent.scopeRef,
			snapshotRef: parent.snapshotRef,
			budgetRef: parent.budgetRef,
			allowLowerIntelligence: parent.allowLowerIntelligence,
			deadlineAtMs: parent.deadlineAtMs,
		});
		this.signal = parent.signal;
		this.budget = { ...parent.budget };
		this.remaining = {
			searchCalls: parent.budget.searchCalls,
			readCalls: parent.budget.readCalls,
			quoteRunes: parent.budget.quoteRunes,
		};
	}

	remainingBudget(): Readonly<Remaining> {
		return { ...this.remaining };
	}

	private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release = () => {};
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private callSignal(toolSignal?: AbortSignal): AbortSignal {
		const timeout = this.parent.deadlineAtMs - Date.now();
		if (this.signal.aborted || toolSignal?.aborted || timeout <= 0) {
			throw new CloudSearchToolError(
				"CANCELLED",
				"Parent search run was cancelled or expired.",
			);
		}
		return AbortSignal.any([
			this.signal,
			...(toolSignal ? [toolSignal] : []),
			AbortSignal.timeout(timeout),
		]);
	}

	private assertLive(signal: AbortSignal): void {
		if (
			signal.aborted ||
			this.signal.aborted ||
			Date.now() >= this.parent.deadlineAtMs
		) {
			throw new CloudSearchToolError(
				"CANCELLED",
				"Parent search run was cancelled or expired.",
			);
		}
	}

	async search(
		depth: "fast" | "detailed",
		rawInput: unknown,
		toolSignal?: AbortSignal,
		toolCallId?: string,
	) {
		const parsedInput = searchInput.safeParse(rawInput);
		if (!parsedInput.success) {
			throw new CloudSearchToolError(
				"INVALID_INPUT",
				"Cloud search Tool input is invalid.",
			);
		}
		const input = parsedInput.data;
		const requestKey = this.requestKey(`search_${depth}`, toolCallId);
		return this.exclusive(async () => {
			const signal = this.callSignal(toolSignal);
			let attempt = this.searchAttempts.get(requestKey);
			if (
				attempt &&
				(attempt.depth !== depth ||
					attempt.query !== input.query ||
					attempt.intelligence !== input.intelligence ||
					attempt.continueSearchId !== input.continue_search_id)
			)
				throw new CloudSearchToolError(
					"IDEMPOTENCY_CONFLICT",
					"Tool-call ID reused with different search input.",
				);
			if (
				input.continue_search_id &&
				!this.searches.has(input.continue_search_id)
			) {
				throw new CloudSearchToolError(
					"BAD_EVIDENCE",
					"Continuation search ID is outside this parent run.",
				);
			}
			if (!attempt) {
				const reservedReads = Math.min(
					this.remaining.readCalls,
					this.budget.maxReadsPerSearch,
				);
				const reservedRunes = Math.min(
					this.remaining.quoteRunes,
					this.budget.maxQuoteRunesPerSearch,
				);
				if (
					this.remaining.searchCalls < 1 ||
					reservedReads < 1 ||
					reservedRunes < 1
				)
					throw new CloudSearchToolError(
						"BUDGET_EXHAUSTED",
						"Parent search budget is exhausted.",
					);
				// The first logical Tool call atomically pins its body and reservation.
				this.remaining.searchCalls--;
				this.remaining.readCalls -= reservedReads;
				this.remaining.quoteRunes -= reservedRunes;
				attempt = {
					depth,
					query: input.query,
					intelligence: input.intelligence,
					...(input.continue_search_id
						? { continueSearchId: input.continue_search_id }
						: {}),
					limits: { readCalls: reservedReads, quoteRunes: reservedRunes },
				};
				this.searchAttempts.set(requestKey, attempt);
			}
			const raw = await abortable(
				this.port.search({
					parent: this.parent,
					requestKey,
					depth: attempt.depth,
					query: attempt.query,
					intelligence: attempt.intelligence,
					...(attempt.continueSearchId
						? { continueSearchId: attempt.continueSearchId }
						: {}),
					limits: { ...attempt.limits },
					signal,
				}),
				signal,
			);
			this.assertLive(signal);
			const parsedResult = searchResultSchema.safeParse(raw);
			if (!parsedResult.success) {
				throw new CloudSearchToolError(
					"BAD_EVIDENCE",
					"Product search response is invalid.",
				);
			}
			const result = parsedResult.data;
			if (attempt.accepted) {
				if (!isDeepStrictEqual(result, attempt.accepted))
					throw new CloudSearchToolError(
						"BAD_EVIDENCE",
						"RTW changed an already accepted Tool result on same-key replay.",
					);
			} else {
				this.validateSearchResult(
					result,
					attempt.intelligence,
					attempt.limits.readCalls,
					attempt.limits.quoteRunes,
				);
				this.remaining.readCalls +=
					attempt.limits.readCalls - result.usage.read_calls;
				this.remaining.quoteRunes +=
					attempt.limits.quoteRunes - result.usage.quote_runes;
				if (result.evidence.length > 0) {
					const receipt = result.citation_receipt;
					if (!receipt)
						throw new CloudSearchToolError(
							"BAD_RECEIPT",
							"Citation receipt is missing.",
						);
					this.searches.set(result.search_id, {
						snapshotRef: result.snapshot_ref,
						receipt: { ...receipt },
						evidence: new Map(
							result.evidence.map((item) => [item.evidence_id, { ...item }]),
						),
					});
				}
				attempt.accepted = structuredClone(result);
			}
			return {
				search: structuredClone(result),
				remaining: this.remainingBudget(),
			};
		});
	}

	private validateSearchResult(
		result: CloudSearchResult,
		requested: SearchIntelligence,
		reads: number,
		runes: number,
	): void {
		if (
			result.snapshot_ref !== this.parent.snapshotRef ||
			result.requested_intelligence !== requested ||
			result.usage.read_calls > reads ||
			result.usage.quote_runes > runes ||
			result.usage.quote_runes <
				result.evidence.reduce(
					(sum, item) => sum + [...item.quote].length,
					0,
				) ||
			this.searches.has(result.search_id)
		) {
			throw new CloudSearchToolError(
				"BAD_EVIDENCE",
				"Search result escaped its fixed scope or budget.",
			);
		}
		const level = { low: 0, medium: 1, high: 2 } as const;
		if (
			(result.effective_intelligence !== requested &&
				!this.parent.allowLowerIntelligence) ||
			level[result.effective_intelligence] > level[requested] ||
			new Set(result.evidence.map((item) => item.evidence_id)).size !==
				result.evidence.length ||
			result.evidence.some((item) => digest(item.quote) !== item.quote_hash)
		) {
			throw new CloudSearchToolError(
				"BAD_EVIDENCE",
				"Search evidence IDs, quote hashes or actual tier are invalid.",
			);
		}
		if (
			result.usage.read_calls < result.evidence.length ||
			(result.status === "complete" && result.gaps.length > 0)
		) {
			throw new CloudSearchToolError(
				"BAD_EVIDENCE",
				"Search result falsely reports complete evidence or read usage.",
			);
		}
		if (result.evidence.length === 0) {
			if (
				result.status !== "empty" ||
				result.citation_receipt ||
				result.pack_hash
			) {
				throw new CloudSearchToolError(
					"BAD_RECEIPT",
					"Empty result cannot claim a citation receipt.",
				);
			}
		} else if (
			!result.citation_receipt ||
			!result.pack_hash ||
			result.citation_receipt.search_id !== result.search_id ||
			result.citation_receipt.pack_hash !== result.pack_hash ||
			result.status === "empty"
		) {
			throw new CloudSearchToolError(
				"BAD_RECEIPT",
				"Citation receipt does not bind this evidence pack.",
			);
		}
	}

	async readEvidence(
		rawInput: unknown,
		toolSignal?: AbortSignal,
		toolCallId?: string,
	) {
		const parsedInput = readInput.safeParse(rawInput);
		if (!parsedInput.success) {
			throw new CloudSearchToolError(
				"INVALID_INPUT",
				"Evidence Tool input is invalid.",
			);
		}
		const input = parsedInput.data;
		const requestKey = this.requestKey("read_evidence", toolCallId);
		return this.exclusive(async () => {
			const signal = this.callSignal(toolSignal);
			let attempt = this.readAttempts.get(requestKey);
			if (
				attempt &&
				(attempt.searchId !== input.search_id ||
					attempt.evidenceId !== input.evidence_id)
			)
				throw new CloudSearchToolError(
					"IDEMPOTENCY_CONFLICT",
					"Tool-call ID reused with different evidence identity.",
				);
			const stored = this.searches.get(input.search_id);
			const evidence = stored?.evidence.get(input.evidence_id);
			if (!stored || !evidence) {
				throw new CloudSearchToolError(
					"BAD_EVIDENCE",
					"Evidence ID is outside this parent run.",
				);
			}
			if (!attempt) {
				const quoteRunes = [...evidence.quote].length;
				if (
					this.remaining.readCalls < 1 ||
					this.remaining.quoteRunes < quoteRunes
				)
					throw new CloudSearchToolError(
						"BUDGET_EXHAUSTED",
						"Parent evidence-read budget is exhausted.",
					);
				this.remaining.readCalls--;
				this.remaining.quoteRunes -= quoteRunes;
				attempt = { searchId: input.search_id, evidenceId: input.evidence_id };
				this.readAttempts.set(requestKey, attempt);
			}
			const raw = await abortable(
				this.port.readEvidence({
					parent: this.parent,
					requestKey,
					searchId: attempt.searchId,
					evidenceId: attempt.evidenceId,
					signal,
				}),
				signal,
			);
			this.assertLive(signal);
			const parsedResult = readResultSchema.safeParse(raw);
			if (!parsedResult.success) {
				throw new CloudSearchToolError(
					"BAD_EVIDENCE",
					"Product evidence response is invalid.",
				);
			}
			const result = parsedResult.data;
			if (
				result.search_id !== input.search_id ||
				result.snapshot_ref !== stored.snapshotRef ||
				result.evidence.evidence_id !== evidence.evidence_id ||
				result.evidence.revision_id !== evidence.revision_id ||
				result.evidence.locator !== evidence.locator ||
				result.evidence.source_kind !== evidence.source_kind ||
				result.evidence.quote_hash !== evidence.quote_hash ||
				result.evidence.quote !== evidence.quote ||
				result.citation_receipt.search_id !== stored.receipt.search_id ||
				result.citation_receipt.pack_hash !== stored.receipt.pack_hash ||
				result.citation_receipt.durable_ref !== stored.receipt.durable_ref
			) {
				throw new CloudSearchToolError(
					"BAD_EVIDENCE",
					"Reread changed the fixed revision, locator, quote or receipt.",
				);
			}
			if (attempt.accepted) {
				if (!isDeepStrictEqual(result, attempt.accepted))
					throw new CloudSearchToolError(
						"BAD_EVIDENCE",
						"RTW changed an already reread citation on same-key replay.",
					);
			} else attempt.accepted = structuredClone(result);
			return {
				evidence: structuredClone(result.evidence),
				citation_receipt: structuredClone(result.citation_receipt),
				remaining: this.remainingBudget(),
			};
		});
	}

	/** Each real Agent Tool call must carry its stable framework identity. */
	private agentCallId(toolCallId?: string): string {
		if (!toolCallId)
			throw new CloudSearchToolError(
				"INVALID_SCOPE",
				"Mastra Tool-call identity is missing.",
			);
		return toolCallId;
	}

	/** Stable for one framework Tool-call ID; direct component calls may be one-shot. */
	private requestKey(toolName: string, toolCallId?: string): string {
		if (toolCallId === undefined) return `whale_${randomUUID()}`;
		if (
			toolCallId.length < 1 ||
			toolCallId.length > 200 ||
			[...toolCallId].some((character) => {
				const code = character.charCodeAt(0);
				return code < 32 || code === 127;
			})
		)
			throw new CloudSearchToolError(
				"INVALID_SCOPE",
				"Tool-call identity is invalid.",
			);
		return `whale_${digest(`${this.parent.runId}:${this.parent.operationId}:${toolName}:${toolCallId}`)}`;
	}

	/** Attach only to a compatible caller Agent created for this same parent run. */
	tools() {
		return {
			search_fast: createTool({
				id: "search_fast",
				description: "一次有界快搜，返回同版证据和引用收据，不生成最终回答。",
				inputSchema: searchInput,
				strict: true,
				execute: (input, context) =>
					this.search(
						"fast",
						input,
						context.abortSignal,
						this.agentCallId(context.agent?.toolCallId),
					),
			}),
			search_detailed: createTool({
				id: "search_detailed",
				description: "有界详搜，返回结构化证据、缺口和停止原因。",
				inputSchema: searchInput,
				strict: true,
				execute: (input, context) =>
					this.search(
						"detailed",
						input,
						context.abortSignal,
						this.agentCallId(context.agent?.toolCallId),
					),
			}),
			read_evidence: createTool({
				id: "read_evidence",
				description: "按本次搜索 ID 和证据 ID 重读同版原文。",
				inputSchema: readInput,
				strict: true,
				execute: (input, context) =>
					this.readEvidence(
						input,
						context.abortSignal,
						this.agentCallId(context.agent?.toolCallId),
					),
			}),
		};
	}
}

function digest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

async function abortable<T>(
	pending: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted)
		throw new CloudSearchToolError(
			"CANCELLED",
			"Parent search run was cancelled or expired.",
		);
	return new Promise<T>((resolve, reject) => {
		const cancelled = () => {
			signal.removeEventListener("abort", cancelled);
			reject(
				new CloudSearchToolError(
					"CANCELLED",
					"Parent search run was cancelled or expired.",
				),
			);
		};
		signal.addEventListener("abort", cancelled, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", cancelled);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", cancelled);
				reject(error);
			},
		);
	});
}
