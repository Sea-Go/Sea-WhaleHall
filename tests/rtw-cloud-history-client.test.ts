import { expect, test } from "bun:test";
import {
	RTWCloudHistoryClient,
	RTWCloudHistoryError,
} from "../src/bun/clients/product/rtw-cloud-history-client";
import type { RTWProductSession } from "../src/bun/clients/product/rtw-product-search-client";

const reference = {
	evidence_id: "e-1",
	source_kind: "wiki",
	content_id: "c-1",
	revision_id: "r-1",
	chunk_id: "k-1",
	quote_hash: "hash-1",
	state: "available",
};
const turn = JSON.stringify({
	Request: {
		SearchID: "s-1",
		AnswerID: "a-1",
		SessionID: "history-1",
		Search: { Query: "如何使用？" },
	},
	result: {
		answer_id: "a-1",
		answer: "请先阅读指南。",
		summary_status: "succeeded",
		citations: ["e-1"],
		search: {
			evidence_pack: {
				evidence: [
					{
						evidence_id: "e-1",
						key: {
							source_kind: "wiki",
							content_id: "c-1",
							revision_id: "r-1",
							chunk_id: "k-1",
						},
						quote_hash: "hash-1",
						quote: "仅在冻结包中的旧摘录",
					},
				],
			},
		},
	},
});
const row = {
	answer_id: "a-1",
	search_id: "s-1",
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
) {
	let current: RTWProductSession = {
		accessToken: "jwt-1",
		sessionId: "product-1",
		generation: 1,
	};
	return {
		client: new RTWCloudHistoryClient({
			baseUrl: "http://127.0.0.1:8080",
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

test("真实分页游标按接纳序号递增，引用只交付实时元数据", async () => {
	const paths: string[] = [];
	const { client } = fixture(async (request) => {
		const url = new URL(String(request));
		paths.push(`${url.pathname}${url.search}`);
		if (url.pathname.endsWith("/citations"))
			return json({
				answer_id: "a-1",
				search_id: "s-1",
				status: "succeeded",
				citations: [reference],
			});
		return json({ items: [row], next_ordinal: 1 });
	});
	const result = await client.list({ logicalSessionId: "history-1", limit: 1 });
	expect(result.nextOrdinal).toBe(1);
	expect(result.items[0]?.question).toBe("如何使用？");
	expect(result.items[0]?.citations[0]?.revisionId).toBe("r-1");
	expect(JSON.stringify(result)).not.toContain("仅在冻结包中的旧摘录");
	expect(JSON.stringify(result)).not.toContain("jwt-1");
	expect(paths[0]).toContain("after_ordinal=0&limit=1");
});

test("撤回状态与冻结引用修订不符时不回放旧摘录", async () => {
	let live = { ...reference, state: "unavailable" };
	const { client } = fixture(async (request) =>
		String(request).endsWith("/citations")
			? json({
					answer_id: "a-1",
					search_id: "s-1",
					status: "succeeded",
					citations: [live],
				})
			: json({ items: [row], next_ordinal: 0 }),
	);
	let result = await client.list({ logicalSessionId: "history-1" });
	expect(result.items[0]?.citations[0]?.state).toBe("unavailable");
	expect(result.items[0]?.citationState).toBe("verified");
	live = { ...reference, revision_id: "r-2", state: "available" };
	result = await client.list({ logicalSessionId: "history-1" });
	expect(result.items[0]?.citationState).toBe("unavailable");
	expect(result.items[0]?.citations).toEqual([]);
});

test("网络回执期间换号拒收，错误主体和逆序页拒收", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const account = fixture(async () => {
		await gate;
		return json({ items: [row], next_ordinal: 0 });
	});
	const pending = account.client.list({ logicalSessionId: "history-1" });
	await Promise.resolve();
	account.switchAccount();
	release();
	expect(pending).rejects.toMatchObject({ code: "SESSION_CHANGED" });
	const wrong = fixture(async () =>
		json({ items: [{ ...row, session_id: "other-history" }], next_ordinal: 0 }),
	);
	expect(
		wrong.client.list({ logicalSessionId: "history-1" }),
	).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	const reverse = fixture(async () => json({ items: [row], next_ordinal: 0 }));
	expect(
		reverse.client.list({ logicalSessionId: "history-1", afterOrdinal: 1 }),
	).rejects.toBeInstanceOf(RTWCloudHistoryError);
});

test("越权和离线不可回退缓存", async () => {
	const unauthorized = fixture(async () => json({}, 403));
	expect(
		unauthorized.client.list({ logicalSessionId: "history-1" }),
	).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
	const offline = fixture(async () => {
		throw new Error("network");
	});
	expect(
		offline.client.list({ logicalSessionId: "history-1" }),
	).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
