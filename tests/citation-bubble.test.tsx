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

describe("CitationBubble", () => {});
