const headingLine = /^#{1,6}[ \t]+/u;
const unorderedListLine = /^(\s{0,24})[-+*][ \t]+/u;
const orderedListLine = /^(\s{0,24})([0-9]{1,6})[.)][ \t]+/u;
const fenceLine = /^\s{0,3}(?:```|~~~)/u;

/**
 * Projects signed Markdown release notes to inert text. The client never
 * creates links, images or HTML nodes from release metadata; supported visual
 * markers are removed while list structure and line breaks remain readable.
 */
export function releaseNotesToPlainText(source: string): string {
	const lines: string[] = [];
	let insideFence = false;
	for (const originalLine of source.split(/\r?\n/u)) {
		if (fenceLine.test(originalLine)) {
			insideFence = !insideFence;
			continue;
		}
		let line = stripQuotePrefix(originalLine);
		const ordered = orderedListLine.exec(line);
		if (ordered) {
			line = `${ordered[2]}. ${line.slice(ordered[0].length)}`;
		} else {
			const unordered = unorderedListLine.exec(line);
			if (unordered) {
				line = `• ${line.slice(unordered[0].length)}`;
			} else {
				line = line.replace(headingLine, "");
			}
		}
		const projected = projectInlineMarkdown(line).replaceAll("**", "");
		if (insideFence && projected.length > 0) {
			lines.push(`    ${projected}`);
		} else {
			lines.push(projected);
		}
	}
	return trimBlankLines(lines).join("\n");
}

function projectInlineMarkdown(source: string): string {
	let result = "";
	let index = 0;
	while (index < source.length) {
		if (source[index] === "\\" && index + 1 < source.length) {
			result += source[index + 1];
			index += 2;
			continue;
		}

		const image = markdownDestinationAt(source, index, true);
		if (image) {
			result += projectInlineMarkdown(image.label);
			index = image.end;
			continue;
		}
		const link = markdownDestinationAt(source, index, false);
		if (link) {
			result += projectInlineMarkdown(link.label);
			index = link.end;
			continue;
		}

		const marker = inlineMarkerAt(source, index);
		if (marker) {
			const end = source.indexOf(marker, index + marker.length);
			if (end >= index + marker.length + 1) {
				const content = source.slice(index + marker.length, end);
				result += marker === "`" ? content : projectInlineMarkdown(content);
				index = end + marker.length;
				continue;
			}
			if (marker.length > 1 || marker === "`") {
				index += marker.length;
				continue;
			}
		}

		result += source[index];
		index += 1;
	}
	return result;
}

function markdownDestinationAt(
	source: string,
	index: number,
	image: boolean,
): { label: string; end: number } | null {
	const labelStart = image ? index + 2 : index + 1;
	if (image ? !source.startsWith("![", index) : source[index] !== "[") {
		return null;
	}
	const labelEnd = source.indexOf("]", labelStart);
	if (labelEnd < labelStart || source[labelEnd + 1] !== "(") return null;
	const destinationEnd = findClosingParenthesis(source, labelEnd + 1);
	if (destinationEnd < 0) return null;
	return {
		label: source.slice(labelStart, labelEnd),
		end: destinationEnd + 1,
	};
}

function findClosingParenthesis(source: string, openIndex: number): number {
	let depth = 0;
	for (let index = openIndex; index < source.length; index += 1) {
		if (source[index] === "\\") {
			index += 1;
			continue;
		}
		if (source[index] === "(") depth += 1;
		if (source[index] !== ")") continue;
		depth -= 1;
		if (depth === 0) return index;
	}
	return -1;
}

function inlineMarkerAt(source: string, index: number): string | null {
	for (const marker of ["**", "__", "~~", "`", "*", "_"] as const) {
		if (source.startsWith(marker, index)) return marker;
	}
	return null;
}

function stripQuotePrefix(source: string): string {
	let line = source;
	for (let depth = 0; depth < 8; depth += 1) {
		const prefix = /^( {0,3})>[ \t]?/u.exec(line);
		if (!prefix) break;
		line = line.slice(prefix[0].length);
	}
	return line;
}

function trimBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim().length === 0) start += 1;
	while (end > start && lines[end - 1]?.trim().length === 0) end -= 1;
	return lines.slice(start, end);
}
