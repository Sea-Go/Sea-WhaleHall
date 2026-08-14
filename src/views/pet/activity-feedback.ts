import {
	isPetActivityFeedbackPresentation,
	type PetActivityFeedbackPresentation,
} from "../../shared/pet-activity-feedback";
import {
	type PetMarkdownPageContent,
	paginateSafePetMarkdown,
} from "./pet-markdown";

export const PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES = 100;
export const PET_ACTIVITY_FEEDBACK_MIN_DWELL_MS = 8_000;
export const PET_ACTIVITY_FEEDBACK_MAX_DWELL_MS = 20_000;

const graphemeSegmenter = new Intl.Segmenter("zh-CN", {
	granularity: "grapheme",
});
const sentenceSegmenter = new Intl.Segmenter("zh-CN", {
	granularity: "sentence",
});

export type PetActivityFeedbackPage = {
	presentationId: string;
	generatedAtMs: number;
	text: string;
	pageNumber: number;
	pageCount: number;
	dwellMs: number;
	/** Safe, inert Markdown projection. `text` remains its accessible plain text. */
	content?: PetMarkdownPageContent;
};

type QueuedPresentation = {
	presentation: PetActivityFeedbackPresentation;
	pages: readonly PetMarkdownPageContent[];
};

type PetActivityFeedbackTimer = ReturnType<typeof globalThis.setTimeout>;

export interface PetActivityFeedbackQueueOptions {
	onPage: (page: PetActivityFeedbackPage | null) => void;
	initiallyPresent?: boolean;
	schedule?: (
		callback: () => void,
		delayMs: number,
	) => PetActivityFeedbackTimer;
	cancel?: (timer: PetActivityFeedbackTimer) => void;
}

export function petActivityFeedbackGraphemeCount(text: string): number {
	return Array.from(graphemeSegmenter.segment(text)).length;
}

/**
 * Splits without dropping or rewriting text. Sentence ends are preferred when
 * they fit within the hard grapheme limit; oversized sentences are split only
 * at Unicode grapheme boundaries.
 */
export function segmentPetActivityFeedback(
	text: string,
	maximumGraphemes = PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
): readonly string[] {
	if (!Number.isSafeInteger(maximumGraphemes) || maximumGraphemes <= 0) {
		throw new RangeError("Pet feedback page size must be a positive integer.");
	}
	if (text.length === 0) return [];

	const graphemes = Array.from(
		graphemeSegmenter.segment(text),
		({ segment }) => segment,
	);
	const sentenceEnds = new Set<number>();
	let sentenceEnd = 0;
	for (const sentence of sentenceSegmenter.segment(text)) {
		sentenceEnd += petActivityFeedbackGraphemeCount(sentence.segment);
		sentenceEnds.add(sentenceEnd);
	}

	const pages: string[] = [];
	let start = 0;
	while (start < graphemes.length) {
		const hardEnd = Math.min(start + maximumGraphemes, graphemes.length);
		let end = hardEnd;
		if (hardEnd < graphemes.length) {
			for (let candidate = hardEnd; candidate > start; candidate -= 1) {
				if (sentenceEnds.has(candidate)) {
					end = candidate;
					break;
				}
			}
		}
		pages.push(graphemes.slice(start, end).join(""));
		start = end;
	}
	return pages;
}

export function petActivityFeedbackDwellMs(graphemeCount: number): number {
	const dwellMs = 4_000 + Math.max(0, graphemeCount) * 120;
	return Math.min(
		PET_ACTIVITY_FEEDBACK_MAX_DWELL_MS,
		Math.max(PET_ACTIVITY_FEEDBACK_MIN_DWELL_MS, dwellMs),
	);
}

/** Owns only the current renderer's FIFO; dispose/remount intentionally loses it. */
export class PetActivityFeedbackQueue {
	private readonly schedule: NonNullable<
		PetActivityFeedbackQueueOptions["schedule"]
	>;
	private readonly cancel: NonNullable<
		PetActivityFeedbackQueueOptions["cancel"]
	>;
	private readonly queued: QueuedPresentation[] = [];
	private readonly acceptedIds = new Set<string>();
	private current: QueuedPresentation | null = null;
	private pageIndex = 0;
	private timer: PetActivityFeedbackTimer | null = null;
	private disposed = false;
	private present: boolean;

	constructor(private readonly options: PetActivityFeedbackQueueOptions) {
		this.schedule = options.schedule ?? globalThis.setTimeout;
		this.cancel = options.cancel ?? globalThis.clearTimeout;
		this.present = options.initiallyPresent ?? true;
	}

	enqueue(presentation: PetActivityFeedbackPresentation): boolean {
		if (
			this.disposed ||
			!isPetActivityFeedbackPresentation(presentation) ||
			this.acceptedIds.has(presentation.presentationId)
		) {
			return false;
		}
		if (!this.present) {
			this.acceptedIds.add(presentation.presentationId);
			return false;
		}
		const pages = paginateSafePetMarkdown(
			presentation.text,
			PET_ACTIVITY_FEEDBACK_PAGE_GRAPHEMES,
		);
		if (pages.length === 0) return false;
		this.acceptedIds.add(presentation.presentationId);
		this.queued.push({ presentation, pages });
		if (this.current === null) this.startNextPresentation();
		return true;
	}

	setPresent(present: boolean): void {
		if (this.disposed || this.present === present) return;
		this.present = present;
		if (!present) this.clear();
	}

	next(): void {
		if (this.disposed || this.current === null) return;
		this.cancelTimer();
		if (this.pageIndex + 1 < this.current.pages.length) {
			this.pageIndex += 1;
			this.publishCurrentPage();
			return;
		}
		this.finishCurrentPresentation();
	}

	dismissCurrent(): void {
		if (this.disposed || this.current === null) return;
		this.cancelTimer();
		this.finishCurrentPresentation();
	}

	clear(): void {
		if (this.disposed) return;
		this.cancelTimer();
		this.queued.length = 0;
		this.current = null;
		this.pageIndex = 0;
		this.options.onPage(null);
	}

	dispose(): void {
		if (this.disposed) return;
		this.cancelTimer();
		this.queued.length = 0;
		this.acceptedIds.clear();
		this.current = null;
		this.pageIndex = 0;
		this.disposed = true;
	}

	private startNextPresentation(): void {
		this.current = this.queued.shift() ?? null;
		this.pageIndex = 0;
		if (this.current === null) {
			this.options.onPage(null);
			return;
		}
		this.publishCurrentPage();
	}

	private publishCurrentPage(): void {
		const current = this.current;
		const content = current?.pages[this.pageIndex];
		if (!current || content === undefined) {
			this.finishCurrentPresentation();
			return;
		}
		const dwellMs = petActivityFeedbackDwellMs(content.visibleGraphemeCount);
		this.options.onPage({
			presentationId: current.presentation.presentationId,
			generatedAtMs: current.presentation.generatedAtMs,
			text: content.visibleText,
			pageNumber: this.pageIndex + 1,
			pageCount: current.pages.length,
			dwellMs,
			content,
		});
		this.timer = this.schedule(() => {
			this.timer = null;
			this.next();
		}, dwellMs);
	}

	private finishCurrentPresentation(): void {
		this.current = null;
		this.pageIndex = 0;
		this.startNextPresentation();
	}

	private cancelTimer(): void {
		if (this.timer !== null) this.cancel(this.timer);
		this.timer = null;
	}
}
