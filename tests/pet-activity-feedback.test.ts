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
import type { paginateSafePetMarkdown } from "../src/views/pet/pet-markdown";

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

describe("pet activity feedback segmentation", () => {});

describe("pet activity feedback in-memory FIFO", () => {});
