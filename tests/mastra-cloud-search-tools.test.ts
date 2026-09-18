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
		requested_intelligence: "medium",
		effective_intelligence: "medium",
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

	test("empty and cancelled child calls do not create citations or a fresh budget", async () => {
		const controller = new AbortController();
		const session = new CloudSearchToolSession(
			parent({ signal: controller.signal }),
			port({
				search: async () => ({
					...searchResult(),
					status: "empty",
					stop_reason: "no_evidence",
					evidence: [],
					pack_hash: undefined,
					citation_receipt: undefined,
					usage: { read_calls: 0, quote_runes: 0 },
				}),
			}),
		);
		const first = await session.search("fast", {
			query: "未收录",
			intelligence: "medium",
		});
		expect(first.search.evidence).toEqual([]);
		expect(session.remainingBudget()).toEqual({
			searchCalls: 1,
			readCalls: 3,
			quoteRunes: 100,
		});
		controller.abort();
		await expect(
			session.search("fast", { query: "再搜", intelligence: "medium" }),
		).rejects.toMatchObject({ code: "CANCELLED" });
		expect(session.remainingBudget().searchCalls).toBe(1);
	});

	test("cancels an in-flight product call even if the port ignores its signal", async () => {
		const controller = new AbortController();
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const session = new CloudSearchToolSession(
			parent({ signal: controller.signal }),
			port({
				search: async () => {
					entered();
					return new Promise<never>(() => {});
				},
			}),
		);
		const pending = session.search("detailed", {
			query: "鲸落",
			intelligence: "medium",
		});
		await started;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
		expect(session.remainingBudget()).toEqual({
			searchCalls: 1,
			readCalls: 2,
			quoteRunes: 80,
		});
	});

	test("rejects forged receipt, changed quote, unauthorised tier and out-of-scope reread", async () => {
		for (const wrong of [
			{ citation_receipt: { ...receipt, search_id: "elsewhere" } },
			{ evidence: [{ ...evidence, quote: "伪造原文" }] },
			{ effective_intelligence: "high" },
			{ snapshot_ref: "snapshot-other" },
			{ summary_text: "伪造的最终答案" },
		]) {
			const session = new CloudSearchToolSession(
				parent(),
				port({ search: async () => searchResult(wrong) }),
			);
			await expect(
				session.search("fast", { query: "鲸落", intelligence: "medium" }),
			).rejects.toBeInstanceOf(CloudSearchToolError);
			expect(session.remainingBudget()).toEqual({
				searchCalls: 1,
				readCalls: 2,
				quoteRunes: 80,
			});
		}
		const session = new CloudSearchToolSession(
			parent(),
			port({
				readEvidence: async () => ({
					search_id: "search-1",
					snapshot_ref: "snapshot-1",
					evidence: { ...evidence, revision_id: "rev-2" },
					citation_receipt: receipt,
				}),
			}),
		);
		await session.search("fast", { query: "鲸落", intelligence: "medium" });
		await expect(
			session.readEvidence({ search_id: "search-1", evidence_id: "ev-1" }),
		).rejects.toMatchObject({ code: "BAD_EVIDENCE" });
	});

	test("a compatible Mastra parent receives Tool evidence and continues to its own answer", async () => {
		let modelCalls = 0;
		let productCalls = 0;
		let productKey = "";
		const session = new CloudSearchToolSession(
			parent(),
			port({
				search: async (input) => {
					productCalls++;
					productKey = input.requestKey;
					return searchResult();
				},
			}),
		);
		const provider = createOpenAICompatible({
			name: "fixture",
			baseURL: "https://fixture.invalid/v1",
			fetch: Object.assign(
				async (_url: URL | RequestInfo, init?: RequestInit) => {
					modelCalls++;
					const body = JSON.parse(String(init?.body));
					if (modelCalls === 1) {
						expect(body.tools).toBeDefined();
						return new Response(
							JSON.stringify({
								id: "fixture-1",
								object: "chat.completion",
								created: 1,
								model: "fixture",
								choices: [
									{
										index: 0,
										finish_reason: "tool_calls",
										message: {
											role: "assistant",
											content: null,
											tool_calls: [
												{
													id: "call-1",
													type: "function",
													function: {
														name: "search_fast",
														arguments: JSON.stringify({
															query: "鲸落",
															intelligence: "medium",
														}),
													},
												},
											],
										},
									},
								],
								usage: {
									prompt_tokens: 10,
									completion_tokens: 10,
									total_tokens: 20,
								},
							}),
							{ headers: { "content-type": "application/json" } },
						);
					}
					const toolMessage = body.messages.find(
						(message: { role: string }) => message.role === "tool",
					);
					expect(toolMessage).toBeDefined();
					expect(JSON.stringify(toolMessage)).toContain("ev-1");
					expect(JSON.stringify(toolMessage)).toContain(
						"search-citations/sha256/",
					);
					return new Response(
						JSON.stringify({
							id: "fixture-2",
							object: "chat.completion",
							created: 2,
							model: "fixture",
							choices: [
								{
									index: 0,
									finish_reason: "stop",
									message: {
										role: "assistant",
										content: "根据同版证据，鲸落……",
									},
								},
							],
							usage: {
								prompt_tokens: 10,
								completion_tokens: 10,
								total_tokens: 20,
							},
						}),
						{ headers: { "content-type": "application/json" } },
					);
				},
				{ preconnect: fetch.preconnect },
			),
		});
		const agent = new Agent({
			id: "fixture-cloud-search-parent",
			name: "Fixture parent",
			instructions: "Use the tool then answer.",
			model: provider.chatModel("fixture"),
			tools: session.tools(),
			maxRetries: 0,
		});
		const answer = await agent.generate("查询鲸落", {
			maxSteps: 3,
			requestContext: new RequestContext(),
		});
		expect(answer.text).toContain("根据同版证据");
		expect(productCalls).toBe(1);
		expect(productKey).toBe(
			`whale_${createHash("sha256")
				.update("parent-run:operation-1:search_fast:call-1")
				.digest("hex")}`,
		);
		expect(modelCalls).toBe(2);
	});
});
