export type PetMarkdownRun = {
	text: string;
	strong: boolean;
	emphasis: boolean;
	code: boolean;
};

export type PetMarkdownBlock = {
	kind: "paragraph" | "heading" | "list-item";
	runs: readonly PetMarkdownRun[];
	headingLevel?: number;
	quoteDepth: number;
	list?: {
		ordered: boolean;
		index: number;
		depth: number;
	};
};

export type PetMarkdownPageContent = {
	blocks: readonly PetMarkdownBlock[];
	visibleText: string;
	visibleGraphemeCount: number;
};

type InlineMarks = Pick<PetMarkdownRun, "strong" | "emphasis" | "code">;

type IndexedMarkdownBlock = {
	block: PetMarkdownBlock;
	markerGraphemeCount: number;
	runs: Array<{
		run: PetMarkdownRun;
		graphemes: string[];
		start: number;
		end: number;
	}>;
};

const defaultMarks: InlineMarks = {
	strong: false,
	emphasis: false,
	code: false,
};

const markdownGraphemeSegmenter = new Intl.Segmenter("zh-CN", {
	granularity: "grapheme",
});
const markdownSentenceSegmenter = new Intl.Segmenter("zh-CN", {
	granularity: "sentence",
});

const unorderedListLine = /^(\s{0,24})[-+*][ \t]+(.*)$/u;
const orderedListLine = /^(\s{0,24})([0-9]{1,6})[.)][ \t]+(.*)$/u;
const headingLine = /^(#{1,6})[ \t]+(.*)$/u;

/**
 * A bounded linear Markdown subset for untrusted model output. It supports the
 * formatting the activity Agent is asked to use, never interprets HTML, URLs,
 * images, or code fences, and preserves unsupported syntax as inert text.
 */
export function parseSafePetMarkdown(
	source: string,
): readonly PetMarkdownBlock[] {
	const blocks: PetMarkdownBlock[] = [];
	let orderedListIndex = 1;
	for (const originalLine of source.split(/\r?\n/u)) {
		if (originalLine.trim().length === 0) continue;
		const { line, quoteDepth } = stripQuotePrefix(originalLine);
		const ordered = orderedListLine.exec(line);
		if (ordered) {
			const explicitIndex = Number(ordered[2]);
			orderedListIndex = Number.isSafeInteger(explicitIndex)
				? explicitIndex
				: orderedListIndex;
			const marker = `${orderedListIndex}. `;
			blocks.push({
				kind: "list-item",
				runs: [run(marker, defaultMarks), ...parseInline(ordered[3] ?? "")],
				quoteDepth,
				list: {
					ordered: true,
					index: orderedListIndex,
					depth: indentationDepth(ordered[1] ?? ""),
				},
			});
			orderedListIndex += 1;
			continue;
		}
		const unordered = unorderedListLine.exec(line);
		if (unordered) {
			blocks.push({
				kind: "list-item",
				runs: [run("• ", defaultMarks), ...parseInline(unordered[2] ?? "")],
				quoteDepth,
				list: {
					ordered: false,
					index: 1,
					depth: indentationDepth(unordered[1] ?? ""),
				},
			});
			continue;
		}
		const heading = headingLine.exec(line);
		if (heading) {
			blocks.push({
				kind: "heading",
				runs: parseInline(heading[2] ?? ""),
				headingLevel: heading[1]?.length ?? 3,
				quoteDepth,
			});
			continue;
		}
		blocks.push({
			kind: "paragraph",
			runs: parseInline(line),
			quoteDepth,
		});
	}
	return blocks.length > 0 ? blocks : [plainBlock(source)];
}

/** Splits formatted output by actual visible Unicode graphemes. */
export function paginateSafePetMarkdown(
	source: string,
	maximumGraphemes: number,
): readonly PetMarkdownPageContent[] {
	if (!Number.isSafeInteger(maximumGraphemes) || maximumGraphemes <= 0) {
		throw new RangeError("Pet Markdown page size must be a positive integer.");
	}
	if (source.length === 0) return [];
	const indexedBlocks = indexBlocks(parseSafePetMarkdown(source));
	const sentenceEnds = new Set<number>();
	let totalGraphemes = 0;
	for (const indexed of indexedBlocks) {
		const text = indexed.runs
			.flatMap(({ graphemes: sourceGraphemes }) => sourceGraphemes)
			.join("");
		const markerGraphemes = indexed.markerGraphemeCount;
		let sentenceEnd = totalGraphemes;
		for (const sentence of markdownSentenceSegmenter.segment(text)) {
			sentenceEnd += graphemes(sentence.segment).length;
			if (sentenceEnd > totalGraphemes + markerGraphemes) {
				sentenceEnds.add(sentenceEnd);
			}
		}
		totalGraphemes = indexed.runs.at(-1)?.end ?? totalGraphemes;
		sentenceEnds.add(totalGraphemes);
	}
	if (totalGraphemes === 0) return [];

	const pages: PetMarkdownPageContent[] = [];
	let start = 0;
	while (start < totalGraphemes) {
		const hardEnd = Math.min(start + maximumGraphemes, totalGraphemes);
		let end = hardEnd;
		if (hardEnd < totalGraphemes) {
			for (let candidate = hardEnd; candidate > start; candidate -= 1) {
				if (sentenceEnds.has(candidate)) {
					end = candidate;
					break;
				}
			}
		}
		const pageBlocks = sliceBlocks(indexedBlocks, start, end);
		pages.push({
			blocks: pageBlocks,
			visibleText: pageBlocks
				.map((block) => block.runs.map((sourceRun) => sourceRun.text).join(""))
				.join("\n"),
			visibleGraphemeCount: end - start,
		});
		start = end;
	}
	return pages;
}

function parseInline(source: string): PetMarkdownRun[] {
	const runs: PetMarkdownRun[] = [];
	let plain = "";
	const flush = () => {
		appendRun(runs, plain, defaultMarks);
		plain = "";
	};
	let index = 0;
	while (index < source.length) {
		if (
			source[index] === "\\" &&
			index + 1 < source.length &&
			isSupportedMarkdownEscape(source[index + 1])
		) {
			plain += source[index + 1];
			index += 2;
			continue;
		}
		const marker = inlineMarkerAt(source, index);
		if (marker) {
			const end = source.indexOf(marker.token, index + marker.token.length);
			if (end >= index + marker.token.length + 1) {
				flush();
				appendRun(runs, source.slice(index + marker.token.length, end), {
					...defaultMarks,
					[marker.mark]: true,
				});
				index = end + marker.token.length;
				continue;
			}
		}
		plain += source[index];
		index += 1;
	}
	flush();
	return runs.length > 0 ? runs : [run("", defaultMarks)];
}

function inlineMarkerAt(
	source: string,
	index: number,
): { token: string; mark: keyof InlineMarks } | null {
	if (source.startsWith("**", index)) return { token: "**", mark: "strong" };
	if (source[index] === "`") return { token: "`", mark: "code" };
	if (source[index] === "*") return { token: "*", mark: "emphasis" };
	return null;
}

function isSupportedMarkdownEscape(value: string | undefined): boolean {
	return value === "\\" || value === "*" || value === "`";
}

function stripQuotePrefix(source: string): {
	line: string;
	quoteDepth: number;
} {
	let line = source;
	let quoteDepth = 0;
	while (quoteDepth < 8) {
		const prefix = /^( {0,3})>[ \t]?/u.exec(line);
		if (!prefix) break;
		quoteDepth += 1;
		line = line.slice(prefix[0].length);
	}
	return { line, quoteDepth };
}

function indentationDepth(indentation: string): number {
	return Math.min(
		8,
		Math.floor(indentation.replaceAll("\t", "    ").length / 2) + 1,
	);
}

function appendRun(
	runs: PetMarkdownRun[],
	text: string,
	marks: InlineMarks,
): void {
	if (text.length === 0) return;
	const previous = runs.at(-1);
	if (
		previous &&
		previous.strong === marks.strong &&
		previous.emphasis === marks.emphasis &&
		previous.code === marks.code
	) {
		previous.text += text;
		return;
	}
	runs.push(run(text, marks));
}

function run(text: string, marks: InlineMarks): PetMarkdownRun {
	return {
		text,
		strong: marks.strong,
		emphasis: marks.emphasis,
		code: marks.code,
	};
}

function plainBlock(source: string): PetMarkdownBlock {
	return {
		kind: "paragraph",
		runs: [run(source, defaultMarks)],
		quoteDepth: 0,
	};
}

function indexBlocks(
	blocks: readonly PetMarkdownBlock[],
): IndexedMarkdownBlock[] {
	let cursor = 0;
	return blocks.map((block) => {
		const indexedRuns: IndexedMarkdownBlock["runs"] = [];
		const markerGraphemeCount = block.list
			? graphemes(block.runs[0]?.text ?? "").length
			: 0;
		const text = block.runs.map((sourceRun) => sourceRun.text).join("");
		const boundaries: Array<{
			run: PetMarkdownRun;
			start: number;
			end: number;
		}> = [];
		let codeUnitCursor = 0;
		for (const sourceRun of block.runs) {
			boundaries.push({
				run: sourceRun,
				start: codeUnitCursor,
				end: codeUnitCursor + sourceRun.text.length,
			});
			codeUnitCursor += sourceRun.text.length;
		}
		let boundaryIndex = 0;
		for (const segment of markdownGraphemeSegmenter.segment(text)) {
			while (
				boundaryIndex + 1 < boundaries.length &&
				segment.index >=
					(boundaries[boundaryIndex]?.end ?? Number.POSITIVE_INFINITY)
			) {
				boundaryIndex += 1;
			}
			const owner = boundaries[boundaryIndex] ?? boundaries.at(-1);
			if (!owner) continue;
			const previous = indexedRuns.at(-1);
			if (
				previous &&
				previous.run.strong === owner.run.strong &&
				previous.run.emphasis === owner.run.emphasis &&
				previous.run.code === owner.run.code &&
				previous.end === cursor
			) {
				previous.graphemes.push(segment.segment);
				previous.end += 1;
			} else {
				indexedRuns.push({
					run: owner.run,
					graphemes: [segment.segment],
					start: cursor,
					end: cursor + 1,
				});
			}
			cursor += 1;
		}
		return { block, markerGraphemeCount, runs: indexedRuns };
	});
}

function sliceBlocks(
	blocks: readonly IndexedMarkdownBlock[],
	pageStart: number,
	pageEnd: number,
): PetMarkdownBlock[] {
	const page: PetMarkdownBlock[] = [];
	for (const indexed of blocks) {
		const pageRuns: PetMarkdownRun[] = [];
		for (const source of indexed.runs) {
			const overlapStart = Math.max(pageStart, source.start);
			const overlapEnd = Math.min(pageEnd, source.end);
			if (overlapStart < overlapEnd) {
				appendRun(
					pageRuns,
					source.graphemes
						.slice(overlapStart - source.start, overlapEnd - source.start)
						.join(""),
					source.run,
				);
			}
		}
		if (pageRuns.length > 0) page.push({ ...indexed.block, runs: pageRuns });
	}
	return page;
}

function graphemes(value: string): string[] {
	return Array.from(
		markdownGraphemeSegmenter.segment(value),
		({ segment }) => segment,
	);
}
