import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	CloudAnswersPage,
	CloudHistoryResult,
} from "../src/shared/cloud-history";
import { CloudHistoryController } from "../src/views/client/features/cloud-history/CloudHistoryController";
import { CloudHistoryPage } from "../src/views/client/features/cloud-history/CloudHistoryPage";

const first = {
	answerId: "a-1",
	searchId: "s-1",
	sessionId: "logical-1",
	acceptedOrdinal: 1,
	acceptedAt: "2026-09-15T00:00:00Z",
	status: "succeeded" as const,
	question: "什么是资料？",
	answer: "这是已接纳的答案。",
	citationState: "verified" as const,
	citations: [
		{
			evidenceId: "e-1",
			sourceKind: "wiki",
			contentId: "c-1",
			revisionId: "r-1",
			chunkId: "k-1",
			state: "unavailable" as const,
		},
	],
};

test("默认禁用，不拿本地会话猜 RTW 会话", () => {
	let calls = 0;
	const controller = new CloudHistoryController({
		list: async () => {
			calls++;
			return { kind: "disabled" };
		},
	});
	controller.setVisible(true);
	expect(calls).toBe(0);
	expect(controller.getSnapshot()).toEqual({ status: "disabled" });
	expect(
		renderToStaticMarkup(<CloudHistoryPage controller={controller} />),
	).toContain("云端历史暂不可用");
});

test("后续分页按接纳序号递增，撤回引用只展示状态", async () => {
	const calls: number[] = [];
	const controller = new CloudHistoryController({
		list: async (input): Promise<CloudHistoryResult<CloudAnswersPage>> => {
			calls.push(input.afterOrdinal ?? 0);
			return {
				kind: "ok",
				data: input.afterOrdinal
					? {
							items: [{ ...first, answerId: "a-2", acceptedOrdinal: 2 }],
							nextOrdinal: null,
						}
					: { items: [first], nextOrdinal: 1 },
			};
		},
	});
	controller.setScope({
		logicalSessionId: "logical-1",
		productSessionId: "rtw-1",
		generation: 1,
	});
	await controller.load();
	await controller.loadMore();
	expect(calls).toEqual([0, 1]);
	const html = renderToStaticMarkup(
		<CloudHistoryPage controller={controller} />,
	);
	expect(html).toContain("已撤回或不可用");
	expect(html).toContain("第 2 条");
	expect(html).not.toContain("仅在冻结包中的旧摘录");
	expect(html).not.toContain("更早记录");
});

test("可用引用展示摘录，加载后续页断网立即清除旧摘录", async () => {
	const citation = first.citations[0];
	if (!citation) throw new Error("fixture citation missing");
	const available = {
		...first,
		citations: [
			{
				...citation,
				state: "available" as const,
				excerpt: "仅当前可用的摘录",
			},
		],
	};
	let release!: (value: CloudHistoryResult<CloudAnswersPage>) => void;
	const delayed = new Promise<CloudHistoryResult<CloudAnswersPage>>(
		(resolve) => {
			release = resolve;
		},
	);
	let calls = 0;
	const controller = new CloudHistoryController({
		list: async () =>
			++calls === 1
				? { kind: "ok", data: { items: [available], nextOrdinal: 1 } }
				: delayed,
	});
	controller.setScope({
		logicalSessionId: "logical-1",
		productSessionId: "rtw-1",
		generation: 1,
	});
	await controller.load();
	expect(
		renderToStaticMarkup(<CloudHistoryPage controller={controller} />),
	).toContain("仅当前可用的摘录");
	const pending = controller.loadMore();
	expect(
		renderToStaticMarkup(<CloudHistoryPage controller={controller} />),
	).not.toContain("仅当前可用的摘录");
	release({ kind: "offline" });
	await pending;
	const html = renderToStaticMarkup(
		<CloudHistoryPage controller={controller} />,
	);
	expect(html).not.toContain("仅当前可用的摘录");
	expect(html).toContain("当前引用状态无法核验");
});

test("离开云端页同步清摘录，撤回后返回首帧不复用旧引用", async () => {
	const citation = first.citations[0];
	if (!citation) throw new Error("fixture citation missing");
	const available = {
		...first,
		citations: [
			{ ...citation, state: "available" as const, excerpt: "先前可用摘录" },
		],
	};
	let release!: (value: CloudHistoryResult<CloudAnswersPage>) => void;
	const withdrawnPage = new Promise<CloudHistoryResult<CloudAnswersPage>>(
		(resolve) => {
			release = resolve;
		},
	);
	let withdrawn = false;
	const controller = new CloudHistoryController({
		list: async () =>
			withdrawn
				? withdrawnPage
				: { kind: "ok", data: { items: [available], nextOrdinal: null } },
	});
	controller.setScope({
		logicalSessionId: "logical-1",
		productSessionId: "rtw-1",
		generation: 1,
	});
	await controller.load();
	expect(
		renderToStaticMarkup(<CloudHistoryPage controller={controller} />),
	).toContain("先前可用摘录");
	controller.setVisible(false);
	expect(
		renderToStaticMarkup(<CloudHistoryPage controller={controller} />),
	).not.toContain("先前可用摘录");
	withdrawn = true;
	controller.setVisible(true);
	expect(
		renderToStaticMarkup(<CloudHistoryPage controller={controller} />),
	).not.toContain("先前可用摘录");
	release({
		kind: "ok",
		data: {
			items: [{ ...first, citations: [{ ...citation, state: "unavailable" }] }],
			nextOrdinal: null,
		},
	});
	await withdrawnPage;
	await new Promise((resolve) => setTimeout(resolve, 0));
	const html = renderToStaticMarkup(
		<CloudHistoryPage controller={controller} />,
	);
	expect(html).toContain("已撤回或不可用");
	expect(html).not.toContain("先前可用摘录");
});

test("切换主体清空旧页并丢弃晚到回执，登录失效清空现页", async () => {
	let release!: (value: CloudHistoryResult<CloudAnswersPage>) => void;
	const pending = new Promise<CloudHistoryResult<CloudAnswersPage>>(
		(resolve) => {
			release = resolve;
		},
	);
	const controller = new CloudHistoryController({ list: () => pending });
	controller.setScope({
		logicalSessionId: "logical-1",
		productSessionId: "rtw-1",
		generation: 1,
	});
	const old = controller.load();
	controller.setScope(null);
	release({ kind: "ok", data: { items: [first], nextOrdinal: null } });
	await old;
	expect(controller.getSnapshot()).toEqual({ status: "disabled" });
	const scope = {
		logicalSessionId: "logical-1",
		productSessionId: "rtw-1",
		generation: 1,
	};
	controller.setScope(scope);
	await controller.load();
	expect(controller.getSnapshot()).toMatchObject({ status: "ready" });
	controller.setScope({ ...scope, generation: 2 });
	expect(controller.getSnapshot()).toEqual({ status: "disabled" });

	const cited = first.citations[0];
	if (!cited) throw new Error("fixture citation missing");
	const availableFirst = {
		...first,
		citations: [
			{ ...cited, state: "available" as const, excerpt: "旧账号摘录" },
		],
	};
	let calls = 0;
	const changed = new CloudHistoryController({
		list: async () =>
			++calls === 1
				? { kind: "ok", data: { items: [availableFirst], nextOrdinal: 1 } }
				: { kind: "session_changed" },
	});
	changed.setScope({
		logicalSessionId: "logical-1",
		productSessionId: "rtw-1",
		generation: 1,
	});
	await changed.load();
	expect(
		renderToStaticMarkup(<CloudHistoryPage controller={changed} />),
	).toContain("旧账号摘录");
	await changed.loadMore();
	expect(
		renderToStaticMarkup(<CloudHistoryPage controller={changed} />),
	).not.toContain("旧账号摘录");
	expect(changed.getSnapshot()).toEqual({
		status: "error",
		reason: "session_changed",
		items: [],
		nextOrdinal: null,
	});
});
