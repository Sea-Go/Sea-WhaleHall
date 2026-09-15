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
});

test("撤回状态与冻结引用修订不符时不回放旧摘录", async () => {
	let live = { ...reference, state: "unavailable" };
	const { client } = fixture(async (request) =>
		String(request).endsWith("/citations")
			? json({
					answer_id: "a-1",
					search_id: "s-1",
					status: "succeeded",
					...liveSnapshot,
					citations: [live],
				})
			: json({ items: [row], next_ordinal: 0 }),
	);
	let result = await client.list({ logicalSessionId: "history-1" });
	expect(result.items[0]?.citations[0]?.state).toBe("unavailable");
	expect(result.items[0]?.citations[0]?.excerpt).toBeUndefined();
	expect(result.items[0]?.citationState).toBe("verified");
	live = { ...reference, revision_id: "r-2", state: "available" };
	result = await client.list({ logicalSessionId: "history-1" });
	expect(result.items[0]?.citationState).toBe("unavailable");
	expect(result.items[0]?.citations).toEqual([]);
});

test("冻结引用文本哈希与当前发布版本不一致时不投影摘录", async () => {
	const changed = JSON.stringify(JSON.parse(turn), (_key, value) =>
		value === quote ? "改写后的引用" : value,
	);
	const { client } = fixture(async (request) =>
		String(request).endsWith("/citations")
			? json({
					answer_id: "a-1",
					search_id: "s-1",
					status: "succeeded",
					...liveSnapshot,
					citations: [reference],
				})
			: json({ items: [{ ...row, turn_json: changed }], next_ordinal: 0 }),
	);
	expect(client.list({ logicalSessionId: "history-1" })).rejects.toMatchObject({
		code: "BAD_RESPONSE",
	});

	const { client: wrongRelease } = fixture(async (request) =>
		String(request).endsWith("/citations")
			? json({
					answer_id: "a-1",
					search_id: "s-1",
					status: "succeeded",
					...liveSnapshot,
					release_id: "release-2",
					citations: [reference],
				})
			: json({ items: [row], next_ordinal: 0 }),
	);
	const wrong = await wrongRelease.list({ logicalSessionId: "history-1" });
	expect(wrong.items[0]?.citations).toEqual([]);
});

test("长引用先校验完整文本，再限长投影摘录", async () => {
	const longQuote = "海".repeat(300);
	const longHash = createHash("sha256").update(longQuote, "utf8").digest("hex");
	const frozen = JSON.parse(turn);
	frozen.result.search.evidence_pack.evidence[0].quote = longQuote;
	frozen.result.search.evidence_pack.evidence[0].quote_hash = longHash;
	const { client } = fixture(async (request) =>
		String(request).endsWith("/citations")
			? json({
					answer_id: "a-1",
					search_id: "s-1",
					status: "succeeded",
					...liveSnapshot,
					citations: [{ ...reference, quote_hash: longHash }],
				})
			: json({
					items: [{ ...row, turn_json: JSON.stringify(frozen) }],
					next_ordinal: 0,
				}),
	);
	const result = await client.list({ logicalSessionId: "history-1" });
	const excerpt = result.items[0]?.citations[0]?.excerpt;
	expect(Array.from(excerpt ?? "")).toHaveLength(240);
	expect(excerpt?.endsWith("…")).toBe(true);
	expect(excerpt).not.toBe(longQuote);
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
	const wrongSubject = fixture(async () =>
		json({
			items: [{ ...row, subject: { ...subject, subject_id: "other" } }],
			next_ordinal: 0,
		}),
	);
	expect(
		wrongSubject.client.list({ logicalSessionId: "history-1" }),
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

test("旧外层与旧turn、新外层与新turn、v2投影与不可变旧turn均双读为同一人", async () => {
	const subjectV2 = { issuer: "rtw.identity", subject_id: "42" };
	for (const record of [
		row,
		{ ...row, subject: subjectV2, turn_json: turnWithSubject(subjectV2) },
		{ ...row, subject: subjectV2, turn_json: turn },
	]) {
		const result = await historyClientFor(record).list({
			logicalSessionId: "history-1",
		});
		expect(result.items[0]?.answerId).toBe("a-1");
		expect(result.items[0]?.searchId).toBe("s-1");
		expect(result.items[0]?.citationState).toBe("verified");
		expect(result.items[0]?.citations[0]?.excerpt).toBe(quote);
		expect(JSON.stringify(result)).not.toContain("subject_id");
		expect(JSON.stringify(result)).not.toContain("jwt-1");
	}
	const v1OuterWithV2Turn = {
		...row,
		turn_json: turnWithSubject(subjectV2),
	};
	expect(
		historyClientFor(v1OuterWithV2Turn).list({
			logicalSessionId: "history-1",
		}),
	).rejects.toMatchObject({ code: "BAD_RESPONSE" });
});

test("证据不足历史在两版主体和完整旧快照下不产生摘录", async () => {
	const empty = JSON.parse(turn);
	empty.result.answer = "";
	empty.result.summary_status = "insufficient";
	empty.result.citations = [];
	empty.result.search.evidence_pack.status = "empty";
	empty.result.search.evidence_pack.evidence = [];
	const v2 = { issuer: "rtw.identity", subject_id: "42" };
	for (const accepted of [
		{ ...row, status: "insufficient", turn_json: JSON.stringify(empty) },
		{
			...row,
			status: "insufficient",
			subject: v2,
			turn_json: JSON.stringify(empty),
		},
	]) {
		const client = fixture(async (request) =>
			String(request).endsWith("/citations")
				? json({
						answer_id: "a-1",
						search_id: "s-1",
						status: "insufficient",
						...liveSnapshot,
						citations: [],
					})
				: json({ items: [accepted], next_ordinal: 0 }),
		).client;
		const answer = (await client.list({ logicalSessionId: "history-1" }))
			.items[0];
		expect(answer?.status).toBe("insufficient");
		expect(answer?.answer).toBeNull();
		expect(answer?.citations).toEqual([]);
	}
});

test("UID全程保持十进制高位精度并拒绝越界或非规范值", async () => {
	for (const highUID of ["9007199254740993", "9223372036854775807"]) {
		const owner = { issuer: "rtw.identity", subject_id: highUID };
		const result = await historyClientFor({
			...row,
			subject: owner,
			turn_json: turnWithSubject(owner),
		}).list({ logicalSessionId: "history-1" });
		expect(result.items[0]?.answerId).toBe("a-1");
		const mixed = await historyClientFor({
			...row,
			subject: owner,
			turn_json: turnWithSubject({ ...subject, subject_id: highUID }),
		}).list({ logicalSessionId: "history-1" });
		expect(mixed.items[0]?.citationState).toBe("verified");
	}
	for (const value of [
		"0",
		"-1",
		"01",
		"42.0",
		"9223372036854775808",
		"9007199254740993.0",
	]) {
		const owner = { issuer: "rtw.identity", subject_id: value };
		expect(
			historyClientFor({
				...row,
				subject: owner,
				turn_json: turnWithSubject(owner),
			}).list({ logicalSessionId: "history-1" }),
		).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	}
});

test("v1错误兼容槽、v2额外主体字段和外层turn跨用户均拒收", async () => {
	const v2 = { issuer: "rtw.identity", subject_id: "42" };
	const badOwners: unknown[] = [
		{ ...subject, tenant_id: "other" },
		{ ...subject, authority_id: "other" },
		{ ...v2, tenant_id: "platform" },
		{ ...v2, realm: "platform" },
		{ ...v2, authority_id: "rtw.identity" },
		{ ...v2, issuer: "other" },
		null,
	];
	for (const owner of badOwners) {
		expect(
			historyClientFor({ ...row, subject: owner }).list({
				logicalSessionId: "history-1",
			}),
		).rejects.toMatchObject({ code: "BAD_RESPONSE" });
		expect(
			historyClientFor({
				...row,
				subject: v2,
				turn_json: turnWithSubject(owner ?? { ...v2, subject_id: "43" }),
			}).list({ logicalSessionId: "history-1" }),
		).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	}
	expect(
		historyClientFor({
			...row,
			subject: v2,
			turn_json: turnWithSubject({ ...v2, subject_id: "43" }),
		}).list({ logicalSessionId: "history-1" }),
	).rejects.toMatchObject({ code: "BAD_RESPONSE" });
});

test("同一分页会话不得混入第二个UID，答复和检索引用仍须一致", async () => {
	const otherSubject = { issuer: "rtw.identity", subject_id: "43" };
	const otherTurn = JSON.parse(turn);
	otherTurn.Request.Subject = otherSubject;
	otherTurn.Request.SearchID = "s-2";
	otherTurn.Request.AnswerID = "a-2";
	otherTurn.result.answer_id = "a-2";
	const other = {
		...row,
		answer_id: "a-2",
		search_id: "s-2",
		subject: otherSubject,
		accepted_ordinal: 2,
		turn_json: JSON.stringify(otherTurn),
	};
	let citationReads = 0;
	const mixed = fixture(async (request) => {
		if (String(request).endsWith("/citations")) {
			citationReads++;
			return json({
				answer_id: "a-1",
				search_id: "s-1",
				status: "succeeded",
				...liveSnapshot,
				citations: [reference],
			});
		}
		return json({ items: [row, other], next_ordinal: 0 });
	}).client;
	expect(mixed.list({ logicalSessionId: "history-1" })).rejects.toMatchObject({
		code: "BAD_RESPONSE",
	});
	expect(citationReads).toBe(0);
	const badPack = JSON.parse(turn);
	badPack.result.search.evidence_pack.search_id = "s-other";
	expect(
		historyClientFor({ ...row, turn_json: JSON.stringify(badPack) }).list({
			logicalSessionId: "history-1",
		}),
	).rejects.toMatchObject({ code: "BAD_RESPONSE" });
});

test("未知、null和重复JSON字段在Bun投影前拒绝", async () => {
	const badTurn = JSON.parse(turn);
	badTurn.Request.Subject = {
		issuer: "rtw.identity",
		subject_id: "42",
		realm: "platform",
	};
	for (const record of [
		{ ...row, unknown: "injected" },
		{
			...row,
			subject: { issuer: "rtw.identity", subject_id: "42" },
			turn_json: JSON.stringify(badTurn),
		},
		{ ...row, turn_json: "null" },
		{
			...row,
			turn_json: JSON.stringify({
				...JSON.parse(turn),
				Request: { ...JSON.parse(turn).Request, Subject: null },
			}),
		},
		{
			...row,
			turn_json: turn.replace(
				'"subject_id":"42"',
				'"subject_id":"42","subject_id":"43"',
			),
		},
	]) {
		expect(
			historyClientFor(record).list({ logicalSessionId: "history-1" }),
		).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	}
	const rawDuplicate = JSON.stringify({
		code: 200,
		msg: "success",
		data: { items: [row], next_ordinal: 0 },
	}).replace('"subject_id":"42"', '"subject_id":"42","subject_id":"43"');
	const client = fixture(
		async () =>
			new Response(rawDuplicate, {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	).client;
	expect(client.list({ logicalSessionId: "history-1" })).rejects.toMatchObject({
		code: "BAD_RESPONSE",
	});
	const badLiveCitation = fixture(async (request) =>
		String(request).endsWith("/citations")
			? json({
					answer_id: "a-1",
					search_id: "s-1",
					status: "succeeded",
					...liveSnapshot,
					citations: [reference],
					unknown: "injected",
				})
			: json({ items: [row], next_ordinal: 0 }),
	).client;
	expect(
		badLiveCitation.list({ logicalSessionId: "history-1" }),
	).rejects.toMatchObject({ code: "BAD_RESPONSE" });
});

test("冻结证据包的来源版本与请求版本不一致时拒绝整条历史", async () => {
	const changed = JSON.parse(turn);
	changed.result.search.evidence_pack.snapshot.release_id = "other-release";
	expect(
		historyClientFor({ ...row, turn_json: JSON.stringify(changed) }).list({
			logicalSessionId: "history-1",
		}),
	).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	for (const change of [
		(pack: {
			snapshot: typeof snapshot;
			search_id?: string;
			status?: string;
		}) => {
			pack.snapshot.generation = 2;
		},
		(pack: {
			snapshot: typeof snapshot;
			search_id?: string;
			status?: string;
		}) => {
			pack.snapshot.generation = 0;
		},
		(pack: {
			snapshot: typeof snapshot;
			search_id?: string;
			status?: string;
		}) => {
			pack.snapshot.indexes.dense.sha256 = quoteHash;
		},
		(pack: {
			snapshot: typeof snapshot;
			search_id?: string;
			status?: string;
		}) => {
			pack.snapshot.valid_revision_ids = ["other-revision"];
		},
		(pack: {
			snapshot: typeof snapshot;
			search_id?: string;
			status?: string;
		}) => {
			delete pack.search_id;
		},
		(pack: {
			snapshot: typeof snapshot;
			search_id?: string;
			status?: string;
		}) => {
			pack.status = "empty";
		},
		(pack: {
			snapshot: typeof snapshot;
			search_id?: string;
			status?: string;
		}) => {
			delete pack.status;
		},
	]) {
		const bad = JSON.parse(turn);
		change(bad.result.search.evidence_pack);
		expect(
			historyClientFor({ ...row, turn_json: JSON.stringify(bad) }).list({
				logicalSessionId: "history-1",
			}),
		).rejects.toMatchObject({ code: "BAD_RESPONSE" });
	}
	const zeroGeneration = JSON.parse(turn);
	zeroGeneration.Request.Search.Snapshot.generation = 0;
	zeroGeneration.result.search.evidence_pack.snapshot.generation = 0;
	expect(
		historyClientFor({
			...row,
			turn_json: JSON.stringify(zeroGeneration),
		}).list({
			logicalSessionId: "history-1",
		}),
	).rejects.toMatchObject({ code: "BAD_RESPONSE" });
});

test("RTW引用原对象与定位的已知字段需核同，异文不回放旧摘录", async () => {
	const mismatched = fixture(async (request) =>
		String(request).endsWith("/citations")
			? json({
					answer_id: "a-1",
					search_id: "s-1",
					status: "succeeded",
					...liveSnapshot,
					citations: [
						{ ...reference, locator: { ...locator, locator: "paragraph:2" } },
					],
				})
			: json({ items: [row], next_ordinal: 0 }),
	).client;
	const result = await mismatched.list({ logicalSessionId: "history-1" });
	expect(result.items[0]?.citationState).toBe("unavailable");
	expect(result.items[0]?.citations).toEqual([]);
	const missingOriginal = fixture(async (request) =>
		String(request).endsWith("/citations")
			? json({
					answer_id: "a-1",
					search_id: "s-1",
					status: "succeeded",
					...liveSnapshot,
					citations: [{ ...reference, original: undefined }],
				})
			: json({ items: [row], next_ordinal: 0 }),
	).client;
	expect(
		missingOriginal.list({ logicalSessionId: "history-1" }),
	).rejects.toMatchObject({ code: "BAD_RESPONSE" });
});
