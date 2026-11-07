import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	RTWCloudHistoryClient,
	RTWCloudHistoryError,
} from "../src/bun/clients/product/rtw-cloud-history-client";
import type { RTWProductSession } from "../src/bun/clients/product/rtw-product-search-client";

const quote = "仅在冻结包中的旧摘录";
const quoteHash = createHash("sha256").update(quote, "utf8").digest("hex");
const objectHash = createHash("sha256")
	.update("fixed-original", "utf8")
	.digest("hex");
const original = { key: `sha256/${objectHash}`, sha256: objectHash };
const locator = {
	locator: "paragraph:1",
	original_byte_start: 0,
	original_byte_end: 30,
	normalized_rune_start: 0,
	normalized_rune_end: 14,
};
const snapshot = {
	module_id: "module-1",
	release_id: "release-1",
	generation: 1,
	publication_revision: "publication-1",
	indexes: {
		dense: original,
		sparse: original,
		multivector: original,
	},
	valid_revision_ids: ["r-1"],
};
const liveSnapshot = {
	module_id: snapshot.module_id,
	release_id: snapshot.release_id,
	publication_revision: snapshot.publication_revision,
};
const reference = {
	evidence_id: "e-1",
	source_kind: "wiki",
	content_id: "c-1",
	revision_id: "r-1",
	chunk_id: "k-1",
	original,
	locator,
	quote_hash: quoteHash,
	state: "available",
};
const subject = {
	authority_id: "rtw.identity",
	tenant_id: "platform",
	subject_id: "42",
};
const turn = JSON.stringify({
	Request: {
		SearchID: "s-1",
		AnswerID: "a-1",
		Subject: subject,
		SessionID: "history-1",
		Search: { Query: "如何使用？", Snapshot: snapshot },
	},
	result: {
		answer_id: "a-1",
		answer: "请先阅读指南。",
		summary_status: "succeeded",
		citations: ["e-1"],
		search: {
			evidence_pack: {
				search_id: "s-1",
				snapshot,
				status: "complete",
				evidence: [
					{
						evidence_id: "e-1",
						key: {
							source_kind: "wiki",
							content_id: "c-1",
							revision_id: "r-1",
							chunk_id: "k-1",
						},
						original,
						locator,
						quote_hash: quoteHash,
						quote,
					},
				],
			},
		},
	},
});
const row = {
	answer_id: "a-1",
	search_id: "s-1",
	subject,
	session_id: "history-1",
	status: "succeeded",
	accepted_ordinal: 1,
	accepted_at: "2026-09-15T00:00:00Z",
	turn_json: turn,
};

function fixture(
	fetchImpl: (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>,
	readVersion?: "v1" | "v2",
) {
	let current: RTWProductSession = {
		accessToken: "jwt-1",
		sessionId: "product-1",
		generation: 1,
	};
	return {
		client: new RTWCloudHistoryClient({
			baseUrl: "http://127.0.0.1:8080",
			readVersion,
			sessions: {
				current: async () => current,
				isCurrent: (s) =>
					current.accessToken === s.accessToken &&
					current.sessionId === s.sessionId &&
					current.generation === s.generation,
			},
			fetch: fetchImpl,
		}),
		switchAccount: () => {
			current = { accessToken: "jwt-2", sessionId: "product-2", generation: 2 };
		},
	};
}

function json(data: unknown, status = 200): Response {
	return Response.json({ code: status, msg: "success", data }, { status });
}

test("真实分页游标按接纳序号递增，当前可用引用才交付已校验摘录", async () => {
	const paths: string[] = [];
	const { client } = fixture(async (request) => {
		const url = new URL(String(request));
		paths.push(`${url.pathname}${url.search}`);
		if (url.pathname.endsWith("/citations"))
			return json({
				answer_id: "a-1",
				search_id: "s-1",
				status: "succeeded",
				...liveSnapshot,
				citations: [reference],
			});
		return json({ items: [row], next_ordinal: 1 });
	});
	const result = await client.list({ logicalSessionId: "history-1", limit: 1 });
	expect(result.nextOrdinal).toBe(1);
	expect(result.items[0]?.question).toBe("如何使用？");
	expect(result.items[0]?.citations[0]?.revisionId).toBe("r-1");
	expect(result.items[0]?.citations[0]?.excerpt).toBe(quote);
	expect(JSON.stringify(result)).not.toContain("turn_json");
	expect(JSON.stringify(result)).not.toContain("jwt-1");
	expect(paths[0]).toContain("after_ordinal=0&limit=1");
	expect(paths.every((path) => path.startsWith("/v1/knowledge/"))).toBe(true);
});

test("显式 v2 的 list、detail、citations 同路由，旧 turn 仅交付安全投影", async () => {
	const paths: string[] = [];
	const methods: string[] = [];
	const v2Row = {
		...row,
		subject: { issuer: "rtw.identity", subject_id: "42" },
	};
	const { client } = fixture(async (request, init) => {
		const url = new URL(String(request));
		paths.push(`${url.pathname}${url.search}`);
		methods.push(init?.method ?? "");
		expect(init?.body).toBeUndefined();
		expect(url.searchParams.has("subject_id")).toBe(false);
		expect(url.searchParams.has("authority_id")).toBe(false);
		expect(url.searchParams.has("tenant_id")).toBe(false);
		if (url.pathname.endsWith("/citations"))
			return json({
				answer_id: "a-1",
				search_id: "s-1",
				status: "succeeded",
				...liveSnapshot,
				citations: [reference],
			});
		if (url.pathname.endsWith("/a-1")) return json(v2Row);
		return json({ items: [v2Row], next_ordinal: 0 });
	}, "v2");
	const listed = await client.list({
		logicalSessionId: "history-1",
		limit: 1,
		// A caller's forged subject remains outside the read request.
		subject_id: "999",
	} as Parameters<typeof client.list>[0]);
	const listedAnswer = listed.items[0];
	if (!listedAnswer) throw new Error("v2 list fixture returned no answer");
	const detail = await client.detail("history-1", "a-1");
	expect(detail).toEqual(listedAnswer);
	expect(paths).toEqual([
		"/v2/knowledge/answer-sessions/history-1/accepted-answers?after_ordinal=0&limit=1",
		"/v2/knowledge/answer-sessions/history-1/accepted-answers/a-1/citations",
		"/v2/knowledge/answer-sessions/history-1/accepted-answers/a-1",
		"/v2/knowledge/answer-sessions/history-1/accepted-answers/a-1/citations",
	]);
	expect(methods).toEqual(["GET", "GET", "GET", "GET"]);
	expect(JSON.stringify(detail)).not.toContain("turn_json");
	expect(JSON.stringify(detail)).not.toContain("subject_id");
	expect(JSON.stringify(detail)).not.toContain("jwt-1");
	expect("quote" in (detail.citations[0] ?? {})).toBe(false);
});

function turnWithSubject(owner: object): string {
	const original = JSON.parse(turn);
	original.Request.Subject = owner;
	return JSON.stringify(original);
}

function historyClientFor(record: object) {
	return fixture(async (request) =>
		String(request).endsWith("/citations")
			? json({
					answer_id: "a-1",
					search_id: "s-1",
					status: "succeeded",
					...liveSnapshot,
					citations: [reference],
				})
			: json({ items: [record], next_ordinal: 0 }),
	).client;
}
