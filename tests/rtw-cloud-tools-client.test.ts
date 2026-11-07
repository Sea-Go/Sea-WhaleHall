import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CloudSearchToolSession } from "../src/agent/mastra-host/cloud-tools/cloud-search-tools";
import {
	RTWCloudToolsClient,
	RTWCloudToolsError,
} from "../src/bun/clients/product/rtw-cloud-tools-client";
import type {
	RTWProductSession,
	RTWProductSessionProvider,
} from "../src/bun/clients/product/rtw-product-search-client";
import {
	cloudToolRereadView,
	cloudToolSearchView,
	cloudToolUnavailableView,
} from "../src/shared/cloud-tools-view";
import type { AuthSessionIdentity } from "../src/shared/session-identity";

const quote = "RTW已核的同版证据";
const quoteHash = createHash("sha256").update(quote, "utf8").digest("hex");
const packHash = "a".repeat(64);
const parentData = () => ({
	operation_id: "toolop-1",
	scope_ref: "scope-1",
	snapshot_ref: "snapshot-1",
	budget_ref: "budget-1",
	module_id: "module-1",
	deadline_at_ms: Date.now() + 60_000,
	allow_lower_intelligence: false,
	budget: {
		search_calls: 4,
		read_calls: 24,
		quote_runes: 32768,
		max_reads_per_search: 8,
		max_quote_runes_per_search: 8192,
	},
});
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
const searchData = () => ({
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
});
const parentInput = (signal = new AbortController().signal) => ({
	logicalSessionId: "lesson-1",
	moduleId: "module-1",
	idempotencyKey: "tool-parent-key-1",
	runId: "run-1",
	accountId: "dc-account-1",
	signal,
});

function productSession() {
	let current: RTWProductSession | null = {
		accessToken: "rtw.jwt.owner",
		sessionId: "product-session-1",
		generation: 1,
	};
	const provider: RTWProductSessionProvider = {
		current: async () => current,
		// The transport also compares all three frozen fields, including bearer.
		isCurrent: (session) => current?.generation === session.generation,
	};
	return {
		provider,
		switchAccount: () => {
			current = {
				accessToken: "rtw.jwt.other",
				sessionId: "product-session-2",
				generation: 2,
			};
		},
		mutateTokenInPlace: () => {
			if (current) current.accessToken = "rtw.jwt.other";
		},
	};
}

function accountSession() {
	let current: AuthSessionIdentity | null = {
		accountId: "dc-account-1",
		sessionId: "dc-login-1",
		generation: 1,
	};
	return {
		provider: {
			current: () => current,
			isCurrent: (identity: AuthSessionIdentity) =>
				current?.accountId === identity.accountId &&
				current?.sessionId === identity.sessionId &&
				current?.generation === identity.generation,
		},
		switchAccount: () => {
			current = {
				accountId: "dc-account-2",
				sessionId: "dc-login-2",
				generation: 2,
			};
		},
	};
}

let servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => {
	for (const server of servers) server.stop(true);
	servers = [];
});

test("Bun pins RTW Tool parent and Mastra consumes only structured evidence", async () => {
	const requests: Array<{
		path: string;
		method: string;
		bearer: string | null;
		body: unknown;
	}> = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const path = new URL(request.url).pathname;
			requests.push({
				path,
				method: request.method,
				bearer: request.headers.get("authorization"),
				body: await request.json(),
			});
			if (path.endsWith("/evidence-reads"))
				return Response.json({
					code: 200,
					msg: "success",
					data: {
						search_id: "search-1",
						snapshot_ref: "snapshot-1",
						evidence,
						citation_receipt: receipt,
					},
				});
			if (path.endsWith("/searches"))
				return Response.json({
					code: 200,
					msg: "success",
					data: {
						...searchData(),
						future_subject_ref: "must-not-pass-through",
					},
				});
			return Response.json({ code: 200, msg: "success", data: parentData() });
		},
	});
	servers.push(server);
	const client = new RTWCloudToolsClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
	});
	const run = await client.startParent(parentInput());
	const tools = new CloudSearchToolSession(run.parent, run.port);
	const searched = await tools.search("fast", {
		query: "鲸落",
		intelligence: "low",
	});
	expect(searched.search.evidence[0]?.quote).toBe(quote);
	expect(searched.search.citation_receipt?.durable_ref).toBe(
		receipt.durable_ref,
	);
	expect("future_subject_ref" in searched.search).toBe(false);
	expect(searched.search).not.toHaveProperty("answer");
	const reread = await tools.readEvidence(
		{
			search_id: "search-1",
			evidence_id: "ev-1",
		},
		undefined,
		"read-call-1",
	);
	expect(reread.evidence).toMatchObject({ quote, quote_hash: quoteHash });
	expect(reread.citation_receipt.durable_ref).toBe(receipt.durable_ref);
	const unverified = cloudToolSearchView(searched.search);
	const available = cloudToolRereadView(unverified, {
		search_id: "search-1",
		snapshot_ref: "snapshot-1",
		evidence,
		citation_receipt: receipt,
	});
	expect(available.evidence[0]?.availability).toBe("available");
	expect(
		cloudToolUnavailableView(available, "ev-1").evidence[0]?.availability,
	).toBe("unavailable");
	expect(JSON.stringify(available)).not.toContain(quote);
	expect(JSON.stringify(available)).not.toContain("rtw.jwt.owner");
	expect(JSON.stringify(available)).not.toContain("subject_ref");
	expect(requests).toHaveLength(3);
	expect(requests.map((request) => request.path)).toEqual([
		"/v1/knowledge/answer-sessions/lesson-1/tool-runs",
		"/v1/knowledge/answer-sessions/lesson-1/tool-runs/toolop-1/searches",
		"/v1/knowledge/answer-sessions/lesson-1/tool-runs/toolop-1/evidence-reads",
	]);
	expect(requests.map((request) => request.bearer)).toEqual([
		"Bearer rtw.jwt.owner",
		"Bearer rtw.jwt.owner",
		"Bearer rtw.jwt.owner",
	]);
	expect(requests[0]?.body).toEqual({
		module_id: "module-1",
		idempotency_key: "tool-parent-key-1",
	});
	expect(requests[1]?.body).toMatchObject({
		query: "鲸落",
		depth: "fast",
		intelligence: "low",
		read_calls: 8,
		quote_runes: 8192,
	});
	expect(Object.keys(requests[1]?.body as object).sort()).toEqual(
		[
			"depth",
			"idempotency_key",
			"intelligence",
			"query",
			"quote_runes",
			"read_calls",
		].sort(),
	);
	expect(requests[2]?.body).toMatchObject({
		search_id: "search-1",
		evidence_id: "ev-1",
		idempotency_key: `whale_${createHash("sha256")
			.update("run-1:toolop-1:read_evidence:read-call-1")
			.digest("hex")}`,
	});
	expect(tools.remainingBudget()).toMatchObject({
		searchCalls: 3,
		readCalls: 22,
	});
});

test("RTW durable citation ref accepts only its fixed path and search-ID digest", async () => {
	for (const wrong of [
		`search-citations/sha256/${"0".repeat(64)}`,
		`other/sha256/${createHash("sha256").update("search-1").digest("hex")}`,
	]) {
		const client = new RTWCloudToolsClient({
			baseUrl: "https://rtw.example.invalid",
			sessions: productSession().provider,
			accountSessions: accountSession().provider,
			fetch: async (_url, init) =>
				String(init?.body).includes("module_id")
					? Response.json({ code: 200, msg: "success", data: parentData() })
					: Response.json({
							code: 200,
							msg: "success",
							data: {
								...searchData(),
								citation_receipt: { ...receipt, durable_ref: wrong },
							},
						}),
		});
		const run = await client.startParent(parentInput());
		await expect(
			run.port.search({
				parent: run.parent,
				requestKey: "whale_ref_test_1",
				depth: "fast",
				query: "鲸落",
				intelligence: "low",
				limits: { readCalls: 8, quoteRunes: 8192 },
				signal: run.parent.signal,
			}),
		).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	}
});
