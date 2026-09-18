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

test("no RTW session or a forged parent never reaches a child product route", async () => {
	let calls = 0;
	const absent = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: { current: async () => null, isCurrent: () => false },
		accountSessions: accountSession().provider,
		fetch: async () => {
			calls++;
			return Response.json({ code: 200, msg: "success", data: parentData() });
		},
	});
	await expect(absent.startParent(parentInput())).rejects.toMatchObject({
		code: "NOT_AUTHENTICATED",
	});
	expect(calls).toBe(0);
	const client = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
		fetch: async () => {
			calls++;
			return Response.json({ code: 200, msg: "success", data: parentData() });
		},
	});
	const run = await client.startParent(parentInput());
	await expect(
		run.port.search({
			parent: { ...run.parent, operationId: "forged" },
			requestKey: "whale_test_search_1",
			depth: "fast",
			query: "鲸落",
			intelligence: "low",
			limits: { readCalls: 8, quoteRunes: 8192 },
			signal: run.parent.signal,
		}),
	).rejects.toMatchObject({ code: "INVALID_INPUT" });
	expect(calls).toBe(1);
});

test("account cutover rejects an old reply and Bun cancellation aborts pending work", async () => {
	const auth = productSession();
	let reply!: (response: Response) => void;
	const pending = new Promise<Response>((resolve) => {
		reply = resolve;
	});
	const client = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: auth.provider,
		accountSessions: accountSession().provider,
		fetch: async (_url, init) => {
			if (init?.body?.toString().includes("module_id"))
				return Response.json({ code: 200, msg: "success", data: parentData() });
			return pending;
		},
	});
	const run = await client.startParent(parentInput());
	const request = run.port.search({
		parent: run.parent,
		requestKey: "whale_test_search_1",
		depth: "fast",
		query: "鲸落",
		intelligence: "low",
		limits: { readCalls: 8, quoteRunes: 8192 },
		signal: run.parent.signal,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	auth.switchAccount();
	reply(Response.json({ code: 200, msg: "success", data: searchData() }));
	await expect(request).rejects.toMatchObject({ code: "SESSION_CHANGED" });
	const second = productSession();
	const cancelled = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: second.provider,
		accountSessions: accountSession().provider,
		fetch: async (_url, init) => {
			if (init?.body?.toString().includes("module_id"))
				return Response.json({ code: 200, msg: "success", data: parentData() });
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{ once: true },
				);
			});
		},
	});
	const secondRun = await cancelled.startParent(parentInput());
	const pendingSearch = secondRun.port.search({
		parent: secondRun.parent,
		requestKey: "whale_test_search_1",
		depth: "fast",
		query: "鲸落",
		intelligence: "low",
		limits: { readCalls: 8, quoteRunes: 8192 },
		signal: secondRun.parent.signal,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	secondRun.cancel();
	await expect(pendingSearch).rejects.toMatchObject({ code: "CANCELLED" });
	expect(secondRun.parent.signal.aborted).toBe(true);
});

test("Bun login generation change rejects an old Tool result even while RTW JWT stays unchanged", async () => {
	const local = accountSession();
	let release!: (response: Response) => void;
	const pending = new Promise<Response>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const client = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: productSession().provider,
		accountSessions: local.provider,
		fetch: async (_url, init) => {
			calls++;
			return init?.body?.toString().includes("module_id")
				? Response.json({ code: 200, msg: "success", data: parentData() })
				: pending;
		},
	});
	const run = await client.startParent(parentInput());
	const input = {
		parent: run.parent,
		requestKey: "whale_test_search_1",
		depth: "fast" as const,
		query: "鲸落",
		intelligence: "low" as const,
		limits: { readCalls: 8, quoteRunes: 8192 },
		signal: run.parent.signal,
	};
	const request = run.port.search(input);
	await new Promise((resolve) => setTimeout(resolve, 0));
	local.switchAccount();
	release(Response.json({ code: 200, msg: "success", data: searchData() }));
	await expect(request).rejects.toMatchObject({ code: "SESSION_CHANGED" });
	await expect(run.port.search(input)).rejects.toMatchObject({
		code: "SESSION_CHANGED",
	});
	expect(calls).toBe(2);
});

test("RTW 202 and 503 retain their child ID instead of fabricating Tool evidence", async () => {
	let status = 202;
	const client = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
		fetch: async (_url, init) => {
			if (init?.body?.toString().includes("module_id"))
				return Response.json({ code: 200, msg: "success", data: parentData() });
			return Response.json(
				{
					code: status,
					msg: "pending",
					data: {
						search_id: "search-1",
						status: status === 202 ? "in_flight" : "retryable_failure",
						evidence: [],
						gaps: [],
						conflicts: [],
					},
				},
				{ status },
			);
		},
	});
	const run = await client.startParent(parentInput());
	const input = {
		parent: run.parent,
		requestKey: "whale_test_search_1",
		depth: "fast" as const,
		query: "鲸落",
		intelligence: "low" as const,
		limits: { readCalls: 8, quoteRunes: 8192 },
		signal: run.parent.signal,
	};
	await expect(run.port.search(input)).rejects.toMatchObject({
		code: "IN_FLIGHT",
		searchId: "search-1",
	});
	status = 503;
	await expect(run.port.search(input)).rejects.toMatchObject({
		code: "RETRYABLE_FAILURE",
		searchId: "search-1",
	});
});

test("changed bearer under the same generation and forged quote both fail closed", async () => {
	const auth = productSession();
	let calls = 0;
	const client = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: auth.provider,
		accountSessions: accountSession().provider,
		fetch: async (_url, init) => {
			calls++;
			if (init?.body?.toString().includes("module_id"))
				return Response.json({ code: 200, msg: "success", data: parentData() });
			return Response.json({
				code: 200,
				msg: "success",
				data: {
					...searchData(),
					evidence: [{ ...evidence, quote: "伪造" }],
				},
			});
		},
	});
	const run = await client.startParent(parentInput());
	const input = {
		parent: run.parent,
		requestKey: "whale_test_search_1",
		depth: "fast" as const,
		query: "鲸落",
		intelligence: "low" as const,
		limits: { readCalls: 8, quoteRunes: 8192 },
		signal: run.parent.signal,
	};
	await expect(run.port.search(input)).rejects.toMatchObject({
		code: "BAD_RESPONSE",
	});
	expect(calls).toBe(2);
	auth.mutateTokenInPlace();
	await expect(run.port.search(input)).rejects.toMatchObject({
		code: "SESSION_CHANGED",
	});
	expect(calls).toBe(2);
});

test("invalid URL, unsupported continuation, and malformed search result remain unavailable", async () => {
	expect(
		() =>
			new RTWCloudToolsClient({
				baseUrl: "http://remote.invalid",
				sessions: productSession().provider,
				accountSessions: accountSession().provider,
			}),
	).toThrow(RTWCloudToolsError);
	const client = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
		fetch: async (_url, init) =>
			init?.body?.toString().includes("module_id")
				? Response.json({ code: 200, msg: "success", data: parentData() })
				: Response.json({
						code: 200,
						msg: "success",
						data: { ...searchData(), snapshot_ref: "forged" },
					}),
	});
	const run = await client.startParent(parentInput());
	await expect(
		run.port.search({
			parent: run.parent,
			requestKey: "whale_test_search_1",
			depth: "fast",
			query: "鲸落",
			intelligence: "low",
			continueSearchId: "search-old",
			limits: { readCalls: 8, quoteRunes: 8192 },
			signal: run.parent.signal,
		}),
	).rejects.toMatchObject({ code: "UNSUPPORTED" });
	await expect(
		run.port.search({
			parent: run.parent,
			requestKey: "whale_test_search_1",
			depth: "fast",
			query: "鲸落",
			intelligence: "low",
			limits: { readCalls: 8, quoteRunes: 8192 },
			signal: run.parent.signal,
		}),
	).rejects.toMatchObject({ code: "BAD_RESPONSE" });
});

test("RTW replayed parent with exhausted or inflated budget cannot create a fresh local Tool budget", async () => {
	for (const replayBudget of [
		{ ...parentData().budget, search_calls: 0 },
		{ ...parentData().budget, search_calls: 5 },
	]) {
		const client = new RTWCloudToolsClient({
			baseUrl: "https://rtw.example.invalid",
			sessions: productSession().provider,
			accountSessions: accountSession().provider,
			fetch: async () =>
				Response.json({
					code: 200,
					msg: "success",
					data: { ...parentData(), budget: replayBudget },
				}),
		});
		await expect(client.startParent(parentInput())).rejects.toMatchObject({
			code:
				replayBudget.search_calls === 0 ? "BUDGET_EXHAUSTED" : "BAD_RESPONSE",
		});
	}
});

test("lost HTTP acknowledgement reuses the same RTW child key for the same Mastra Tool-call ID", async () => {
	const childBodies: string[] = [];
	const committed = new Set<string>();
	const client = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
		fetch: async (_url, init) => {
			const body = String(init?.body);
			if (body.includes("module_id"))
				return Response.json({ code: 200, msg: "success", data: parentData() });
			childBodies.push(body);
			const key = JSON.parse(body).idempotency_key as string;
			if (!committed.has(key)) {
				committed.add(key);
				throw new Error("HTTP reply lost after RTW stored child result");
			}
			return Response.json({ code: 200, msg: "success", data: searchData() });
		},
	});
	const run = await client.startParent(parentInput());
	const mastra = new CloudSearchToolSession(run.parent, run.port);
	await expect(
		mastra.search(
			"fast",
			{ query: "鲸落", intelligence: "low" },
			undefined,
			"call-1",
		),
	).rejects.toMatchObject({ code: "UNAVAILABLE" });
	const replay = await mastra.search(
		"fast",
		{ query: "鲸落", intelligence: "low" },
		undefined,
		"call-1",
	);
	expect(replay.search.search_id).toBe("search-1");
	expect(committed.size).toBe(1);
	expect(childBodies).toHaveLength(2);
	expect(childBodies[0]).toBe(childBodies[1]);
	expect(JSON.parse(childBodies[0] ?? "{}").idempotency_key).toMatch(
		/^whale_[a-f0-9]{64}$/u,
	);
	expect(mastra.remainingBudget().searchCalls).toBe(3);
	await expect(
		mastra.search(
			"fast",
			{ query: "鲸落", intelligence: "low" },
			undefined,
			"",
		),
	).rejects.toMatchObject({ code: "INVALID_SCOPE" });
	expect(mastra.remainingBudget().searchCalls).toBe(3);
});

test("real loopback RTW-shaped HTTP rejects duplicate status, nested quote hash and Unicode-key aliases", async () => {
	const normal = JSON.stringify({
		code: 200,
		msg: "success",
		data: searchData(),
	});
	const malformed = [
		normal.replace(
			'"status":"complete"',
			'"status":"empty","status":"complete"',
		),
		normal.replace(
			'"status":"complete"',
			'"sta\\u0074us":"empty","status":"complete"',
		),
		normal.replace(
			`"quote_hash":"${quoteHash}"`,
			`"quote_hash":"${"0".repeat(64)}","quote_hash":"${quoteHash}"`,
		),
	];
	let next = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/tool-runs"))
				return Response.json({ code: 200, msg: "success", data: parentData() });
			return new Response(malformed[next++], {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	servers.push(server);
	const client = new RTWCloudToolsClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
	});
	const run = await client.startParent(parentInput());
	for (let index = 0; index < malformed.length; index++) {
		await expect(
			run.port.search({
				parent: run.parent,
				requestKey: `whale_duplicate_${index}`,
				depth: "fast",
				query: "鲸落",
				intelligence: "low",
				limits: { readCalls: 8, quoteRunes: 8192 },
				signal: run.parent.signal,
			}),
		).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	}
	expect(next).toBe(3);
});

test("RTW-shaped replay rejects a changed body under the same durable child key", async () => {
	const stored = new Map<string, string>();
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			if (new URL(request.url).pathname.endsWith("/tool-runs"))
				return Response.json({ code: 200, msg: "success", data: parentData() });
			calls++;
			const body = await request.text();
			const key = JSON.parse(body).idempotency_key as string;
			const previous = stored.get(key);
			if (previous && previous !== body)
				return new Response(null, { status: 409 });
			stored.set(key, body);
			return Response.json({ code: 200, msg: "success", data: searchData() });
		},
	});
	servers.push(server);
	const client = new RTWCloudToolsClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
	});
	const run = await client.startParent(parentInput());
	const first = {
		parent: run.parent,
		requestKey: "whale_fixed_call_1",
		depth: "fast" as const,
		query: "鲸落",
		intelligence: "low" as const,
		limits: { readCalls: 8, quoteRunes: 8192 },
		signal: run.parent.signal,
	};
	expect(
		((await run.port.search(first)) as { search_id: string }).search_id,
	).toBe("search-1");
	await expect(
		run.port.search({
			...first,
			query: "改过的正文",
			limits: { readCalls: 7, quoteRunes: 8192 },
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(calls).toBe(2);
	expect(stored.size).toBe(1);
});

test("direct component calls without framework Tool-call ID are one-shot, not a replay identity", async () => {
	const keys: string[] = [];
	const client = new RTWCloudToolsClient({
		baseUrl: "https://rtw.example.invalid",
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
		fetch: async (_url, init) => {
			const body = String(init?.body);
			if (body.includes("module_id"))
				return Response.json({ code: 200, msg: "success", data: parentData() });
			keys.push(JSON.parse(body).idempotency_key);
			return Response.json({
				code: 200,
				msg: "success",
				data: {
					...searchData(),
					search_id: `search-${keys.length}`,
					status: "empty",
					stop_reason: "no_evidence",
					evidence: [],
					pack_hash: undefined,
					citation_receipt: undefined,
					usage: { read_calls: 0, quote_runes: 0 },
				},
			});
		},
	});
	const run = await client.startParent(parentInput());
	const mastra = new CloudSearchToolSession(run.parent, run.port);
	await mastra.search("fast", { query: "鲸落", intelligence: "low" });
	await mastra.search("fast", { query: "鲸落", intelligence: "low" });
	expect(keys).toHaveLength(2);
	expect(keys[0]).not.toBe(keys[1]);
	expect(mastra.remainingBudget().searchCalls).toBe(2);
});

test("one remaining RTW search call survives a lost ACK and same Tool-call replay without new budget", async () => {
	const stored = new Map<string, string>();
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/tool-runs"))
				return Response.json({
					code: 200,
					msg: "success",
					data: {
						...parentData(),
						budget: {
							search_calls: 1,
							read_calls: 1,
							quote_runes: 8192,
							max_reads_per_search: 1,
							max_quote_runes_per_search: 8192,
						},
					},
				});
			const body = await request.text();
			const key = JSON.parse(body).idempotency_key as string;
			const previous = stored.get(key);
			if (previous && previous !== body)
				return new Response(null, { status: 409 });
			stored.set(key, body);
			return Response.json({ code: 200, msg: "success", data: searchData() });
		},
	});
	servers.push(server);
	let dropFirstSearchReply = true;
	const client = new RTWCloudToolsClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
		fetch: async (url, init) => {
			const response = await fetch(url, init);
			if (
				new URL(String(url)).pathname.endsWith("/searches") &&
				dropFirstSearchReply
			) {
				dropFirstSearchReply = false;
				await response.body?.cancel();
				throw new Error("client lost HTTP response after RTW accepted child");
			}
			return response;
		},
	});
	const run = await client.startParent(parentInput());
	const mastra = new CloudSearchToolSession(run.parent, run.port);
	await expect(
		mastra.search(
			"fast",
			{ query: "鲸落", intelligence: "low" },
			undefined,
			"call-once",
		),
	).rejects.toMatchObject({ code: "UNAVAILABLE" });
	expect(mastra.remainingBudget().searchCalls).toBe(0);
	const replay = await mastra.search(
		"fast",
		{ query: "鲸落", intelligence: "low" },
		undefined,
		"call-once",
	);
	expect(replay.search.search_id).toBe("search-1");
	expect(stored.size).toBe(1);
	expect(mastra.remainingBudget().searchCalls).toBe(0);
	const verifiedAgain = await mastra.search(
		"fast",
		{ query: "鲸落", intelligence: "low" },
		undefined,
		"call-once",
	);
	expect(verifiedAgain.search.search_id).toBe("search-1");
	expect(mastra.remainingBudget().searchCalls).toBe(0);
	await expect(
		mastra.search(
			"fast",
			{ query: "异文", intelligence: "low" },
			undefined,
			"call-once",
		),
	).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	await expect(
		mastra.search(
			"fast",
			{ query: "鲸落", intelligence: "low" },
			undefined,
			"another-call",
		),
	).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
	expect(stored.size).toBe(1);
});

test("one remaining reread survives lost ACK, same-key replay, and later withdrawal without stale cache", async () => {
	const quoteRunes = [...quote].length;
	const reads = new Map<string, string>();
	let withdrawn = false;
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/tool-runs"))
				return Response.json({
					code: 200,
					msg: "success",
					data: {
						...parentData(),
						budget: {
							search_calls: 1,
							read_calls: 2,
							quote_runes: 2 * quoteRunes,
							max_reads_per_search: 1,
							max_quote_runes_per_search: quoteRunes,
						},
					},
				});
			if (path.endsWith("/searches"))
				return Response.json({
					code: 200,
					msg: "success",
					data: searchData(),
				});
			if (withdrawn)
				return Response.json(
					{ code: 503, msg: "citation unavailable", data: {} },
					{ status: 503 },
				);
			const body = await request.text();
			const key = JSON.parse(body).idempotency_key as string;
			const previous = reads.get(key);
			if (previous && previous !== body)
				return new Response(null, { status: 409 });
			reads.set(key, body);
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
		},
	});
	servers.push(server);
	let dropFirstReadReply = true;
	const client = new RTWCloudToolsClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		sessions: productSession().provider,
		accountSessions: accountSession().provider,
		fetch: async (url, init) => {
			const response = await fetch(url, init);
			if (
				new URL(String(url)).pathname.endsWith("/evidence-reads") &&
				dropFirstReadReply
			) {
				dropFirstReadReply = false;
				await response.body?.cancel();
				throw new Error("client lost reread response after RTW stored it");
			}
			return response;
		},
	});
	const run = await client.startParent(parentInput());
	const mastra = new CloudSearchToolSession(run.parent, run.port);
	await mastra.search(
		"fast",
		{ query: "鲸落", intelligence: "low" },
		undefined,
		"search-once",
	);
	expect(mastra.remainingBudget().readCalls).toBe(1);
	const rereadInput = { search_id: "search-1", evidence_id: "ev-1" };
	await expect(
		mastra.readEvidence(rereadInput, undefined, "read-once"),
	).rejects.toMatchObject({ code: "UNAVAILABLE" });
	expect(mastra.remainingBudget().readCalls).toBe(0);
	const replay = await mastra.readEvidence(rereadInput, undefined, "read-once");
	expect(replay.evidence.quote).toBe(quote);
	expect(reads.size).toBe(1);
	expect(mastra.remainingBudget().readCalls).toBe(0);
	await expect(
		mastra.readEvidence(
			{ ...rereadInput, evidence_id: "ev-other" },
			undefined,
			"read-once",
		),
	).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	await expect(
		mastra.readEvidence(rereadInput, undefined, "new-read"),
	).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
	withdrawn = true;
	await expect(
		mastra.readEvidence(rereadInput, undefined, "read-once"),
	).rejects.toMatchObject({ code: "UNAVAILABLE" });
	expect(mastra.remainingBudget().readCalls).toBe(0);
});
