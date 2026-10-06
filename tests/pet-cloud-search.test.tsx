import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
	url: "http://whalehall-pet-search.test/",
	width: 360,
	height: 300,
});
const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [
	{ act, cleanup, render },
	{ default: userEvent },
	{ PetCloudSearchPanel },
	{ PetCloudSearchController },
] = await Promise.all([
	import("@testing-library/react"),
	import("@testing-library/user-event"),
	import("../src/views/pet/PetCloudSearchPanel"),
	import("../src/views/pet/cloud-search"),
]);

afterEach(() => cleanup());
afterAll(async () => {
	delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	await GlobalRegistrator.unregister();
});

const accepted = {
	kind: "accepted",
	result: {
		search_id: "search-1",
		answer_id: "answer-1",
		status: "succeeded",
		answer: "海流受风与密度差共同影响。",
		citation_receipt_ref: "receipt-1",
		citations: [
			{
				evidence_id: "evidence-1",
				revision_id: "revision-1",
				source_kind: "source",
				quote: "风推动海表水运动。",
			},
		],
	},
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Accepted outcome whose first citation carries full StructureLocator
 * fields and whose second one does not (legacy excerpt fallback). */
const acceptedWithLocator = {
	kind: "accepted",
	result: {
		search_id: "search-9",
		answer_id: "answer-9",
		status: "succeeded",
		answer: "海水的密度差驱动深层环流。",
		citation_receipt_ref: "receipt-9",
		citations: [
			{
				evidence_id: "evidence-9",
				revision_id: "revision-9",
				source_kind: "wiki",
				quote: "密度差驱动深层环流。",
				doc_key: "wiki/ocean-currents",
				section_path: ["第一章 深海环境", "1.2 海流"],
				para_index: 3,
			},
			{
				evidence_id: "evidence-10",
				revision_id: "revision-10",
				source_kind: "source",
				quote: "风推动海表水运动。",
			},
		],
	},
};

describe("pet cloud search product projection", () => {
	test("requires an injected RTW session port before any search", async () => {
		const states: string[] = [];
		const controller = new PetCloudSearchController(null, (state) =>
			states.push(state.kind),
		);
		expect(controller.state.kind).toBe("unavailable");
		await controller.start("海流是什么？");
		expect(states).toEqual([]);
	});

	test("shows only a durable accepted answer with bound citations", async () => {
		const controller = new PetCloudSearchController(
			{ search: async () => accepted },
			() => {},
		);
		await controller.start("海流是什么？");
		expect(controller.state).toEqual({
			kind: "answered",
			answer: "海流受风与密度差共同影响。",
			citations: [
				{ id: "evidence-1", kind: "source", excerpt: "风推动海表水运动。" },
			],
		});
	});

	test("no evidence remains distinct from a failed or unaccepted Tool pack", async () => {
		const controller = new PetCloudSearchController(
			{
				search: async () => ({
					kind: "accepted",
					result: {
						search_id: "search-2",
						answer_id: "answer-2",
						status: "insufficient",
						citations: [],
					},
				}),
			},
			() => {},
		);
		await controller.start("没有资料的问题");
		expect(controller.state).toEqual({ kind: "insufficient" });

		const toolOnly = new PetCloudSearchController(
			{
				search: async () => ({
					status: "complete",
					evidence: ["模型未接纳的片段"],
				}),
			},
			() => {},
		);
		await toolOnly.start("另一个问题");
		expect(toolOnly.state.kind).toBe("failed");
		expect(JSON.stringify(toolOnly.state)).not.toContain("模型未接纳的片段");
	});

	test("rejects a claimed answer without a citation receipt", async () => {
		const controller = new PetCloudSearchController(
			{
				search: async () => ({
					...accepted,
					result: { ...accepted.result, citation_receipt_ref: undefined },
				}),
			},
			() => {},
		);
		await controller.start("海流是什么？");
		expect(controller.state.kind).toBe("failed");
	});

	test("maps full StructureLocator fields onto answered citations", async () => {
		const controller = new PetCloudSearchController(
			{ search: async () => acceptedWithLocator },
			() => {},
		);
		await controller.start("海流是什么？");
		expect(controller.state).toEqual({
			kind: "answered",
			answer: "海水的密度差驱动深层环流。",
			citations: [
				{
					id: "evidence-9",
					kind: "wiki",
					excerpt: "密度差驱动深层环流。",
					locator: {
						doc_key: "wiki/ocean-currents",
						revision_id: "revision-9",
						section_path: ["第一章 深海环境", "1.2 海流"],
						para_index: 3,
						quote: "密度差驱动深层环流。",
					},
				},
				{ id: "evidence-10", kind: "source", excerpt: "风推动海表水运动。" },
			],
		});
	});

	test("partial locator fields degrade to the excerpt-only projection", async () => {
		const base = accepted.result.citations[0];
		const controller = new PetCloudSearchController(
			{
				search: async () => ({
					kind: "accepted",
					result: {
						...accepted.result,
						citations: [
							// No section_path at all.
							{ ...base, doc_key: "docs/ocean", para_index: 3 },
							// Non-integer para_index.
							{
								...base,
								evidence_id: "evidence-p2",
								doc_key: "docs/ocean",
								section_path: ["第一章"],
								para_index: 1.5,
							},
							// section_path with a non-string crumb.
							{
								...base,
								evidence_id: "evidence-p3",
								doc_key: "docs/ocean",
								section_path: ["第一章", 7],
								para_index: 2,
							},
							// Blank doc_key.
							{
								...base,
								evidence_id: "evidence-p4",
								doc_key: "  ",
								section_path: ["第一章"],
								para_index: 2,
							},
						],
					},
				}),
			},
			() => {},
		);
		await controller.start("海流是什么？");
		const state = controller.state;
		expect(state.kind).toBe("answered");
		if (state.kind !== "answered") return;
		expect(state.citations.length).toBe(4);
		for (const citation of state.citations) {
			expect(citation.locator).toBeUndefined();
		}
	});

	test("explicit cancel aborts and ignores a late accepted result", async () => {
		const response = deferred<unknown>();
		let aborted = false;
		const controller = new PetCloudSearchController(
			{
				search: ({ signal }) => {
					signal.addEventListener("abort", () => {
						aborted = true;
					});
					return response.promise;
				},
			},
			() => {},
		);
		const operation = controller.start("海流是什么？");
		expect(controller.state.kind).toBe("searching");
		controller.cancel();
		expect(aborted).toBeTrue();
		response.resolve(accepted);
		await operation;
		expect(controller.state.kind).toBe("cancelled");
	});

	test("session loss clears a previous answer without exposing transport details", async () => {
		let calls = 0;
		const controller = new PetCloudSearchController(
			{
				search: async () => {
					calls += 1;
					if (calls === 1) return accepted;
					throw { code: "SESSION_CHANGED", accessToken: "must-not-render" };
				},
			},
			() => {},
		);
		await controller.start("海流是什么？");
		expect(controller.state.kind).toBe("answered");
		await controller.start("第二个问题");
		expect(controller.state.kind).toBe("unavailable");
		expect(JSON.stringify(controller.state)).not.toContain("must-not-render");
	});
});

describe("pet cloud search panel", () => {
	test("production default visibly disables search while the RTW session is missing", () => {
		const view = render(<PetCloudSearchPanel port={null} />);
		expect(view.getByText(/知识会话尚未连接/u)).toBeTruthy();
		expect(
			view.getByRole("button", { name: "搜索" }).hasAttribute("disabled"),
		).toBeTrue();
		expect(view.queryByRole("textbox", { name: "搜索问题" })).toBeNull();
	});

	test("explicit search and cancel remain inside the pet card", async () => {
		const response = deferred<unknown>();
		let aborted = false;
		let parentClicks = 0;
		const port = {
			search: ({ signal }: { query: string; signal: AbortSignal }) => {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				return response.promise;
			},
		};
		const view = render(<PetCloudSearchPanel port={port} />);
		const user = userEvent.setup({ document });
		const onParentClick = () => {
			parentClicks += 1;
		};
		document.body.addEventListener("click", onParentClick);
		try {
			await user.type(
				view.getByRole("textbox", { name: "搜索问题" }),
				"海流是什么？",
			);
			await user.click(view.getByRole("button", { name: "搜索" }));
			expect(view.getByText(/尚无可展示的答案/u)).toBeTruthy();
			await user.click(view.getByRole("button", { name: "取消" }));
			expect(view.getByText("搜索已取消。")).toBeTruthy();
			response.resolve(accepted);
			await Promise.resolve();
			expect(view.queryByText(accepted.result.answer)).toBeNull();
			expect(aborted).toBeTrue();
			expect(parentClicks).toBe(0);
		} finally {
			document.body.removeEventListener("click", onParentClick);
		}
	});

	test("accepted answer and citation appear as plain text without links", async () => {
		const response = deferred<unknown>();
		const port = { search: async () => response.promise };
		const view = render(<PetCloudSearchPanel port={port} />);
		const user = userEvent.setup({ document });
		await user.type(
			view.getByRole("textbox", { name: "搜索问题" }),
			"海流是什么？",
		);
		await user.click(view.getByRole("button", { name: "搜索" }));
		expect(view.getByText(/尚无可展示的答案/u)).toBeTruthy();
		await act(async () => {
			response.resolve(accepted);
			await response.promise;
		});
		expect(view.getByText(accepted.result.answer)).toBeTruthy();
		expect(view.getByText("已绑定 1 条引用")).toBeTruthy();
		// The legacy fixture carries no StructureLocator fields, so the
		// fallback excerpt line stays.
		expect(view.getByText(/原始资料 1：/u)).toBeTruthy();
		expect(view.container.querySelector(".pet-citation")).toBeNull();
		expect(view.container.querySelector("a")).toBeNull();
	});

	test("answered citations with locators render as citation bubbles", async () => {
		const response = deferred<unknown>();
		const port = { search: async () => response.promise };
		const view = render(<PetCloudSearchPanel port={port} />);
		const user = userEvent.setup({ document });
		await user.type(
			view.getByRole("textbox", { name: "搜索问题" }),
			"海流是什么？",
		);
		await user.click(view.getByRole("button", { name: "搜索" }));
		await act(async () => {
			response.resolve(acceptedWithLocator);
			await response.promise;
		});
		expect(view.getByText("已绑定 2 条引用")).toBeTruthy();
		const bubbles = view.container.querySelectorAll(".pet-citation");
		expect(bubbles.length).toBe(1);
		expect(bubbles[0]?.getAttribute("data-citation-id")).toBe("evidence-9");
		// section_path breadcrumb with paragraph anchor, rendered by the bubble.
		expect(view.getByText("Wiki")).toBeTruthy();
		expect(view.getByText("§ 第一章 深海环境 › 1.2 海流 · ¶ 3")).toBeTruthy();
		expect(view.getByText("密度差驱动深层环流。")).toBeTruthy();
		// The field-less citation keeps the legacy line beside the bubble.
		expect(view.getByText(/原始资料 2：风推动海表水运动。/u)).toBeTruthy();
		expect(view.container.querySelector("a")).toBeNull();
	});
});
