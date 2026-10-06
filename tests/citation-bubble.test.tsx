import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({
	url: "http://whalehall-pet-citation.test/",
	width: 360,
	height: 300,
});
const reactActEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const [{ cleanup, fireEvent, render }, { CitationBubble, citationBreadcrumb }] =
	await Promise.all([
		import("@testing-library/react"),
		import("../src/views/pet/CitationBubble"),
	]);

afterEach(() => cleanup());
afterAll(async () => {
	delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
	await GlobalRegistrator.unregister();
});

const locator = {
	revision_id: "rev-1",
	section_path: ["第一章 深海环境", "1.2 海流"],
	para_index: 3,
	quote: "风推动海表水运动。",
};

describe("citation breadcrumb", () => {
	test("joins section_path with separators and appends the paragraph anchor", () => {
		expect(citationBreadcrumb(locator)).toBe(
			"§ 第一章 深海环境 › 1.2 海流 · ¶ 3",
		);
	});

	test("falls back to the paragraph anchor alone without headings", () => {
		expect(citationBreadcrumb({ ...locator, section_path: [] })).toBe("¶ 3");
	});
});

describe("CitationBubble", () => {
	test("renders kind, breadcrumb, and a short quote in full", () => {
		const view = render(
			<CitationBubble
				citation={{ id: "ev-1", sourceKind: "source", locator }}
			/>,
		);
		expect(view.getByText("原始资料")).toBeTruthy();
		expect(view.getByText("§ 第一章 深海环境 › 1.2 海流 · ¶ 3")).toBeTruthy();
		expect(view.getByText("风推动海表水运动。")).toBeTruthy();
		expect(view.queryByRole("button", { name: "展开" })).toBeNull();
		expect(view.container.querySelector("a")).toBeNull();
	});

	test("truncates a quote beyond 200 runes with an expand control", () => {
		const long = {
			...locator,
			quote: "海".repeat(203),
		};
		const view = render(
			<CitationBubble
				citation={{ id: "ev-2", sourceKind: "wiki", locator: long }}
			/>,
		);
		expect(view.getByText("Wiki")).toBeTruthy();
		const quote = view.container.querySelector(".pet-citation__quote");
		expect(quote?.textContent).toBe(`${"海".repeat(200)}…`);
		const toggle = view.getByRole("button", { name: "展开" });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});

	test("expand reveals the full quote and collapse truncates again", () => {
		const long = {
			...locator,
			quote: "🌊".repeat(210),
		};
		const view = render(
			<CitationBubble
				citation={{ id: "ev-3", sourceKind: "source", locator: long }}
			/>,
		);
		const quote = view.container.querySelector(".pet-citation__quote");
		// Rune-safe truncation: the astral emoji must not be split in half.
		expect(quote?.textContent).toBe(`${"🌊".repeat(200)}…`);
		fireEvent.click(view.getByRole("button", { name: "展开" }));
		expect(quote?.textContent).toBe("🌊".repeat(210));
		expect(
			view.getByRole("button", { name: "收起" }).getAttribute("aria-expanded"),
		).toBe("true");
		fireEvent.click(view.getByRole("button", { name: "收起" }));
		expect(quote?.textContent).toBe(`${"🌊".repeat(200)}…`);
	});
});
