import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	RTWProductSearchClient,
	RTWProductSearchError,
	type RTWProductSession,
	type RTWProductSessionProvider,
	type RTWSearchInput,
} from "../src/bun/clients/product/rtw-product-search-client";

const input: RTWSearchInput = {
	sessionId: "lesson-1",
	moduleId: "module-1",
	query: "这份资料讲什么？",
	depth: "fast",
	intelligence: "low",
	idempotencyKey: "search-key-1",
};
const hash = (value: string) =>
	createHash("sha256").update(value, "utf8").digest("hex");
const citation = {
	evidence_id: "evidence-1",
	source_kind: "source",
	content_id: "source-1",
	revision_id: "revision-1",
	locator: {
		locator: "paragraph:1",
		original_byte_start: 0,
		original_byte_end: 6,
		normalized_rune_start: 0,
		normalized_rune_end: 2,
	},
	original: { key: "source/revision-1", sha256: hash("原文") },
	quote: "原文",
	quote_hash: hash("原文"),
};
const accepted = {
	code: 200,
	msg: "success",
	data: {
		search_id: "search-1",
		answer_id: "answer-1",
		status: "succeeded",
		answer: "这是已引用的回答。",
		citations: [citation],
		citation_receipt_ref: "receipt-1",
	},
};

let servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => {
	for (const server of servers) server.stop(true);
	servers = [];
});

function sessionProvider(): {
	provider: RTWProductSessionProvider;
	switchAccount(): void;
} {
	let current: RTWProductSession | null = {
		accessToken: "rtw-jwt-1",
		sessionId: "rtw-session-1",
		generation: 1,
	};
	return {
		provider: {
			current: async () => current,
			isCurrent: (session) =>
				current?.sessionId === session.sessionId &&
				current.generation === session.generation,
		},
		switchAccount: () => {
			current = {
				accessToken: "rtw-jwt-2",
				sessionId: "rtw-session-2",
				generation: 2,
			};
		},
	};
}

test("posts only five product fields with RTW bearer and accepts durable cited answer", async () => {
	const received: Array<{
		path: string;
		authorization: string | null;
		body: unknown;
	}> = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			received.push({
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				body: await request.json(),
			});
			return Response.json({
				...accepted,
				future_optional: true,
				data: { ...accepted.data, future_optional: true },
			});
		},
	});
	servers.push(server);
	const { provider } = sessionProvider();
	const client = new RTWProductSearchClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		sessions: provider,
	});
	const outcome = await client.createSearch(input);
	expect(outcome.kind).toBe("accepted");
	if (outcome.kind !== "accepted") throw new Error("accepted result required");
	expect(outcome.result.citations[0]?.quote).toBe("原文");
	expect("future_optional" in outcome.result).toBe(false);
	expect(received).toEqual([
		{
			path: "/v1/knowledge/answer-sessions/lesson-1/searches",
			authorization: "Bearer rtw-jwt-1",
			body: {
				module_id: "module-1",
				query: "这份资料讲什么？",
				depth: "fast",
				intelligence: "low",
				idempotency_key: "search-key-1",
			},
		},
	]);
});

test("retains a fixed operation across 503 replay and 202 GET recovery", async () => {
	const bodies: string[] = [];
	const paths: string[] = [];
	let posts = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			paths.push(new URL(request.url).pathname);
			if (request.method === "GET") {
				return Response.json(
					{
						...accepted,
						code: 202,
						data: {
							search_id: "search-1",
							answer_id: "answer-1",
							status: "in_flight",
							citations: [],
						},
					},
					{ status: 202 },
				);
			}
			bodies.push(await request.text());
			posts++;
			if (posts === 1) {
				return Response.json(
					{
						...accepted,
						code: 503,
						data: {
							search_id: "search-1",
							answer_id: "answer-1",
							status: "retryable_failure",
							citations: [],
						},
					},
					{ status: 503 },
				);
			}
			return Response.json(accepted);
		},
	});
	servers.push(server);
	const client = new RTWProductSearchClient({
		baseUrl: `http://127.0.0.1:${server.port}`,
		sessions: sessionProvider().provider,
	});
	expect(await client.createSearch(input)).toEqual({
		kind: "retryable_failure",
		searchId: "search-1",
		answerId: "answer-1",
	});
	expect(await client.getSearch(input.sessionId, "search-1")).toEqual({
		kind: "in_flight",
		searchId: "search-1",
		answerId: "answer-1",
	});
	expect((await client.createSearch(input)).kind).toBe("accepted");
	expect(bodies).toHaveLength(2);
	expect(bodies[0]).toBe(bodies[1]);
	expect(paths[1]).toBe(
		"/v1/knowledge/answer-sessions/lesson-1/searches/search-1",
	);
});





