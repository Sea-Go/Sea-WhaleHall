import { describe, expect, test } from "bun:test";
import {
	isPetActivityFeedbackPresentation,
	MAX_PET_ACTIVITY_FEEDBACK_BYTES,
	MAX_PET_ACTIVITY_FEEDBACK_CHARACTERS,
	type PetActivityFeedbackPresentation,
} from "../src/shared/pet-activity-feedback";
import {
	PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
	type PetActivityFeedbackPage,
	PetActivityFeedbackQueue,
	petActivityFeedbackDwellMs,
	petActivityFeedbackGraphemeCount,
	segmentPetActivityFeedback,
} from "../src/views/pet/activity-feedback";
import { paginateSafePetMarkdown } from "../src/views/pet/pet-markdown";

function pageText(pages: ReturnType<typeof paginateSafePetMarkdown>): string {
	return pages
		.flatMap((page) =>
			page.blocks.flatMap((block) => block.runs.map((run) => run.text)),
		)
		.join("");
}

function presentation(
	presentationId: string,
	text: string,
): PetActivityFeedbackPresentation {
	return { presentationId, generatedAtMs: 1_786_464_000_000, text };
}

describe("pet activity feedback contract", () => {
	test("accepts only the dedicated exact payload and the complete 64 KiB text", () => {
		const maximum = presentation(
			"feedback-maximum",
			"a".repeat(MAX_PET_ACTIVITY_FEEDBACK_CHARACTERS),
		);
		expect(isPetActivityFeedbackPresentation(maximum)).toBe(true);
		expect(
			isPetActivityFeedbackPresentation({
				...maximum,
				accountId: "must-not-cross",
			}),
		).toBe(false);
		expect(
			isPetActivityFeedbackPresentation({
				...maximum,
				text: `${maximum.text}超`,
			}),
		).toBe(false);
		expect(
			isPetActivityFeedbackPresentation(
				presentation("feedback-control", "safe\u0000unsafe"),
			),
		).toBe(false);
		expect(
			isPetActivityFeedbackPresentation(
				presentation("feedback-c1-control", "safe\u0085unsafe"),
			),
		).toBe(false);
	});

	test("enforces the UTF-8 byte boundary for Chinese feedback", () => {
		const exactBytes = `${"观".repeat(21_845)}a`;
		expect(new TextEncoder().encode(exactBytes).byteLength).toBe(
			MAX_PET_ACTIVITY_FEEDBACK_BYTES,
		);
		expect(
			isPetActivityFeedbackPresentation(
				presentation("feedback-chinese-boundary", exactBytes),
			),
		).toBe(true);
		expect(
			isPetActivityFeedbackPresentation(
				presentation("feedback-chinese-overflow", `${exactBytes}观`),
			),
		).toBe(false);
	});
});

describe("pet activity feedback segmentation", () => {
	test("prefers sentence endings and preserves the exact source", () => {
		const first = `${"甲".repeat(80)}。`;
		const second = `${"乙".repeat(30)}。`;
		const pages = segmentPetActivityFeedback(first + second);
		expect(pages).toEqual([first, second]);
		expect(pages.join("")).toBe(first + second);
	});

	test("never splits emoji, surrogate pairs, or combining graphemes", () => {
		const grapheme = "👩🏽‍💻e\u0301";
		const text = grapheme.repeat(151);
		const pages = segmentPetActivityFeedback(text);
		expect(pages.join("")).toBe(text);
		expect(pages.map(petActivityFeedbackGraphemeCount)).toEqual([
			100, 100, 100, 2,
		]);
		for (const page of pages) {
			expect(petActivityFeedbackGraphemeCount(page)).toBeLessThanOrEqual(
				PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
			);
		}
	});

	test("segments and restores the full maximum-size output", () => {
		const text = "a".repeat(MAX_PET_ACTIVITY_FEEDBACK_CHARACTERS);
		const pages = segmentPetActivityFeedback(text);
		expect(pages).toHaveLength(656);
		expect(pages.join("")).toBe(text);
		expect(pages.at(-1)).toHaveLength(36);
	});

	test("paginates rendered Markdown by visible graphemes without losing styles", () => {
		const strongText = "甲".repeat(130);
		const listText = "乙".repeat(80);
		const pages = paginateSafePetMarkdown(
			`**${strongText}**\n\n- ${listText}`,
			PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
		);
		expect(pages.map((page) => page.visibleGraphemeCount)).toEqual([
			100, 30, 82,
		]);
		expect(pageText(pages)).toBe(`${strongText}• ${listText}`);
		expect(pages[0]?.blocks[0]?.runs[0]).toMatchObject({ strong: true });
		expect(pages[1]?.blocks[0]?.runs[0]).toMatchObject({ strong: true });
		expect(
			pages.at(-1)?.blocks.some((block) => block.kind === "list-item"),
		).toBeTrue();
	});

	test("paginates the complete maximum-size Markdown input", () => {
		const source = `**${"a".repeat(
			MAX_PET_ACTIVITY_FEEDBACK_CHARACTERS - 4,
		)}**`;
		const pages = paginateSafePetMarkdown(
			source,
			PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
		);
		expect(pages).toHaveLength(656);
		expect(pageText(pages)).toBe(
			"a".repeat(MAX_PET_ACTIVITY_FEEDBACK_CHARACTERS - 4),
		);
		expect(pages.every((page) => page.visibleGraphemeCount <= 100)).toBeTrue();
		expect(
			pages.every((page) =>
				page.blocks.every((block) => block.runs.every((run) => run.strong)),
			),
		).toBeTrue();
	});

	test("counts explicit list markers and never repeats them on continuation pages", () => {
		const pages = paginateSafePetMarkdown(
			`- ${"甲".repeat(99)}`,
			PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
		);
		expect(pages.map((page) => page.visibleGraphemeCount)).toEqual([100, 1]);
		expect(pages[0]?.visibleText.startsWith("• ")).toBeTrue();
		expect(pages[1]?.visibleText).toBe("甲");
		expect(pageText(pages)).toBe(`• ${"甲".repeat(99)}`);
	});

	test("prefers sentence endings inside list items after their visible marker", () => {
		const firstSentence = `${"甲".repeat(60)}。`;
		const secondSentence = `${"乙".repeat(60)}。`;
		const pages = paginateSafePetMarkdown(
			`- ${firstSentence}${secondSentence}`,
			PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
		);
		expect(pages.map((page) => page.visibleGraphemeCount)).toEqual([63, 61]);
		expect(pageText(pages)).toBe(`• ${firstSentence}${secondSentence}`);
	});

	test("preserves nested-list source order", () => {
		const pages = paginateSafePetMarkdown(
			"- parent before\n  - nested\n\n  parent after",
			PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
		);
		const rendered = pageText(pages);
		expect(rendered.indexOf("parent before")).toBeLessThan(
			rendered.indexOf("nested"),
		);
		expect(rendered.indexOf("nested")).toBeLessThan(
			rendered.indexOf("parent after"),
		);
	});

	test("keeps Unicode graphemes whole across Markdown style boundaries", () => {
		for (const suffix of ["e**\u0301**", "👩**🏽**‍💻"]) {
			const source = `${"甲".repeat(99)}${suffix}`;
			const pages = paginateSafePetMarkdown(
				source,
				PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
			);
			expect(pages).toHaveLength(1);
			expect(pages[0]?.visibleGraphemeCount).toBe(100);
			expect(pageText(pages)).toBe(source.replaceAll("**", ""));
		}
	});

	test("preserves paths, regular expressions, and identifier underscores", () => {
		const source = String.raw`路径 C:\Users\edy，正则 \d+，标识符 foo_bar_baz，转义 \*文字\*`;
		const pages = paginateSafePetMarkdown(
			source,
			PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
		);
		expect(pageText(pages)).toBe(
			String.raw`路径 C:\Users\edy，正则 \d+，标识符 foo_bar_baz，转义 *文字*`,
		);
		expect(
			pages
				.flatMap((page) => page.blocks)
				.flatMap((block) => block.runs)
				.every((run) => !run.strong && !run.emphasis && !run.code),
		).toBeTrue();
	});

	test("handles maximum-size adversarial Markdown in bounded time", () => {
		for (const source of [
			`${"[".repeat(32_768)}${"]".repeat(32_768)}`,
			`${"> ".repeat(32_768)}x`.slice(0, MAX_PET_ACTIVITY_FEEDBACK_CHARACTERS),
		]) {
			const startedAt = performance.now();
			const pages = paginateSafePetMarkdown(
				source,
				PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
			);
			expect(performance.now() - startedAt).toBeLessThan(2_000);
			expect(pages.length).toBeGreaterThan(0);
			expect(
				pages.every((page) => page.visibleGraphemeCount <= 100),
			).toBeTrue();
		}
	});

	test("uses the fixed clamped dwell formula", () => {
		expect(petActivityFeedbackDwellMs(1)).toBe(8_000);
		expect(petActivityFeedbackDwellMs(100)).toBe(16_000);
		expect(petActivityFeedbackDwellMs(200)).toBe(20_000);
	});
});

describe("pet activity feedback in-memory FIFO", () => {
	test("auto-advances pages and presentations in arrival order", () => {
		const pages: Array<PetActivityFeedbackPage | null> = [];
		const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
		const queue = new PetActivityFeedbackQueue({
			onPage: (page) => pages.push(page),
			schedule(callback, delayMs) {
				scheduled.push({ callback, delayMs });
				return scheduled.length as unknown as ReturnType<
					typeof globalThis.setTimeout
				>;
			},
			cancel: () => {},
		});
		expect(queue.enqueue(presentation("feedback-a", "甲".repeat(101)))).toBe(
			true,
		);
		expect(queue.enqueue(presentation("feedback-b", "第二条"))).toBe(true);
		expect(pages[0]).toMatchObject({
			presentationId: "feedback-a",
			pageNumber: 1,
			pageCount: 2,
		});
		expect(scheduled[0]?.delayMs).toBe(16_000);

		scheduled[0]?.callback();
		expect(pages.at(-1)).toMatchObject({
			presentationId: "feedback-a",
			pageNumber: 2,
		});
		scheduled[1]?.callback();
		expect(pages.at(-1)).toMatchObject({
			presentationId: "feedback-b",
			pageNumber: 1,
			pageCount: 1,
		});
	});

	test("manual next, dismiss, clear, and duplicate protection are deterministic", () => {
		const pages: Array<PetActivityFeedbackPage | null> = [];
		const queue = new PetActivityFeedbackQueue({
			onPage: (page) => pages.push(page),
			schedule: () => 1 as unknown as ReturnType<typeof globalThis.setTimeout>,
			cancel: () => {},
		});
		const first = presentation("feedback-a", "甲".repeat(101));
		expect(queue.enqueue(first)).toBe(true);
		expect(queue.enqueue(first)).toBe(false);
		expect(queue.enqueue(presentation("feedback-b", "乙"))).toBe(true);

		queue.next();
		expect(pages.at(-1)).toMatchObject({ pageNumber: 2 });
		queue.dismissCurrent();
		expect(pages.at(-1)).toMatchObject({ presentationId: "feedback-b" });
		queue.clear();
		expect(pages.at(-1)).toBeNull();
		expect(queue.enqueue(first)).toBe(false);
	});

	test("hidden feedback is dropped and never replayed when presence returns", () => {
		const pages: Array<PetActivityFeedbackPage | null> = [];
		const queue = new PetActivityFeedbackQueue({
			onPage: (page) => pages.push(page),
			initiallyPresent: false,
			schedule: () => 1 as unknown as ReturnType<typeof globalThis.setTimeout>,
			cancel: () => {},
		});
		const hidden = presentation("feedback-hidden", "这条只进入历史记录");
		expect(queue.enqueue(hidden)).toBe(false);
		queue.setPresent(true);
		expect(pages).toEqual([]);
		expect(queue.enqueue(hidden)).toBe(false);

		expect(queue.enqueue(presentation("feedback-visible", "当前可见"))).toBe(
			true,
		);
		queue.setPresent(false);
		expect(pages.at(-1)).toBeNull();
	});
});
