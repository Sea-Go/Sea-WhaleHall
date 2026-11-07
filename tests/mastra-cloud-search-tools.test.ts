import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import {
	type CloudSearchParent,
	type CloudSearchProductPort,
	CloudSearchToolError,
	CloudSearchToolSession,
} from "../src/agent/mastra-host/cloud-tools/cloud-search-tools";

const quote = "同版原文";
const quoteHash = createHash("sha256").update(quote).digest("hex");
const packHash = "a".repeat(64);
const evidence = {
	evidence_id: "ev-1",
	revision_id: "rev-1",
	locator: "paragraph:1",
	quote,
	quote_hash: quoteHash,
	source_kind: "source" as const,
};
const receipt = {
	search_id: "search-1",
	pack_hash: packHash,
	durable_ref: `search-citations/sha256/${createHash("sha256").update("search-1", "utf8").digest("hex")}`,
};

function parent(overrides: Partial<CloudSearchParent> = {}): CloudSearchParent {
	return {
		runId: "parent-run",
		accountId: "account-1",
		operationId: "operation-1",
		scopeRef: "published-books",
		snapshotRef: "snapshot-1",
		budgetRef: "budget-1",
		allowLowerIntelligence: false,
		deadlineAtMs: Date.now() + 60_000,
		signal: new AbortController().signal,
		budget: {
			searchCalls: 2,
			readCalls: 3,
			quoteRunes: 100,
			maxReadsPerSearch: 1,
			maxQuoteRunesPerSearch: 20,
		},
		...overrides,
	};
}

function searchResult(overrides: Record<string, unknown> = {}) {
	return {
		search_id: "search-1",
		status: "complete",
		stop_reason: "batch_complete",
		snapshot_ref: "snapshot-1",
		requested_intelligence: "low",
		effective_intelligence: "low",
		evidence: [evidence],
		gaps: [],
		conflicts: [],
		pack_hash: packHash,
		citation_receipt: receipt,
		usage: { read_calls: 1, quote_runes: [...quote].length },
		...overrides,
	};
}

function port(
	overrides: Partial<CloudSearchProductPort> = {},
): CloudSearchProductPort {
	return {
		search: async () => searchResult(),
		readEvidence: async () => ({
			search_id: "search-1",
			snapshot_ref: "snapshot-1",
			evidence,
			citation_receipt: receipt,
		}),
		...overrides,
	};
}

describe("Mastra cloud search tools", () => {
	test("two successful searches share one parent budget and a third never reaches H02", async () => {
		let calls = 0;
		const session = new CloudSearchToolSession(
			parent(),
			port({
				search: async () => {
					calls++;
					const searchId = `search-${calls}`;
					return searchResult({
						search_id: searchId,
						citation_receipt: { ...receipt, search_id: searchId },
					});
				},
			}),
		);
		await session.search("fast", { query: "第一问", intelligence: "medium" });
		await session.search("detailed", {
			query: "第二问",
			intelligence: "medium",
		});
		expect(session.remainingBudget().searchCalls).toBe(0);
		await expect(
			session.search("fast", { query: "第三问", intelligence: "medium" }),
		).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
		expect(calls).toBe(2);
	});

	test("the same parent run owns scope and cumulative budget across Mastra Tool calls", async () => {
		const calls: unknown[] = [];
		const session = new CloudSearchToolSession(
			parent(),
			port({
				search: async (input) => {
					calls.push(input);
					return searchResult();
				},
			}),
		);
		const tools = session.tools();
		expect(Object.keys(tools)).toEqual([
			"search_fast",
			"search_detailed",
			"read_evidence",
		]);
		const first = await session.search("fast", {
			query: "鲸落",
			intelligence: "medium",
		});
		expect(first.search.search_id).toBe("search-1");
		expect(first.remaining).toEqual({
			searchCalls: 1,
			readCalls: 2,
			quoteRunes: 100 - [...quote].length,
		});
		const publicEvidence = first.search.evidence.at(0);
		if (!publicEvidence) throw new Error("Missing fixture evidence.");
		publicEvidence.quote = "调用方改写";
		const read = await session.readEvidence({
			search_id: "search-1",
			evidence_id: "ev-1",
		});
		expect(read.evidence).toEqual(evidence);
		expect(read.remaining).toEqual({
			searchCalls: 1,
			readCalls: 1,
			quoteRunes: 100 - 2 * [...quote].length,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			parent: {
				accountId: "account-1",
				scopeRef: "published-books",
				snapshotRef: "snapshot-1",
				budgetRef: "budget-1",
			},
			depth: "fast",
			limits: { readCalls: 1, quoteRunes: 20 },
		});
		await expect(
			session.readEvidence({ search_id: "other", evidence_id: "ev-1" }),
		).rejects.toMatchObject({ code: "BAD_EVIDENCE" });
		await expect(
			session.search("detailed", { query: "鲸落", intelligence: "medium" }),
		).rejects.toMatchObject({ code: "BAD_EVIDENCE" });
		expect(session.remainingBudget().searchCalls).toBe(0);
	});





});
