import { useState } from "react";
import {
	LOCATOR_QUOTE_MAX_RUNES,
	type Locator,
} from "../../shared/locator-types";

export interface CitationView {
	id: string;
	sourceKind: "source" | "wiki";
	locator: Locator;
}

export interface CitationBubbleProps {
	citation: CitationView;
}

/** Breadcrumb for a locator: heading path + paragraph anchor, e.g. "§ 第一章 › 1.2 海流 · ¶ 3". */
export function citationBreadcrumb(locator: Locator): string {
	const crumbs = locator.section_path.filter((part) => part.trim().length > 0);
	const path = crumbs.length > 0 ? `§ ${crumbs.join(" › ")}` : "";
	const anchor = `¶ ${locator.para_index}`;
	return path.length > 0 ? `${path} · ${anchor}` : anchor;
}

/**
 * Rune-safe display truncation. The contract caps Locator.quote at 200
 * characters, but untrusted display input may exceed it; anything longer
 * collapses behind the expand control.
 */
export function truncateQuoteForDisplay(
	quote: string,
	maxRunes: number = LOCATOR_QUOTE_MAX_RUNES,
): { text: string; truncated: boolean } {
	const runes = Array.from(quote);
	if (runes.length <= maxRunes) return { text: quote, truncated: false };
	return { text: `${runes.slice(0, maxRunes).join("")}…`, truncated: true };
}

/**
 * Pet citation bubble: renders one evidence locator as a breadcrumb
 * (section_path + paragraph anchor) with the quote highlighted. Follows the
 * pet cloud-search panel's visual language (surface bubble, rounded, muted
 * text, accent highlight) and adds no links or new dependencies.
 */
export function CitationBubble({ citation }: CitationBubbleProps) {
	const [expanded, setExpanded] = useState(false);
	const { locator } = citation;
	const shown = truncateQuoteForDisplay(locator.quote);
	const quote = expanded ? locator.quote : shown.text;
	const kindLabel = citation.sourceKind === "wiki" ? "Wiki" : "原始资料";

	return (
		<figure className="pet-citation" data-citation-id={citation.id}>
			<figcaption className="pet-citation__meta">
				<span className="pet-citation__kind">{kindLabel}</span>
				<span className="pet-citation__breadcrumb">
					{citationBreadcrumb(locator)}
				</span>
			</figcaption>
			<blockquote className="pet-citation__quote">{quote}</blockquote>
			{shown.truncated && (
				<button
					type="button"
					className="pet-citation__toggle"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? "收起" : "展开"}
				</button>
			)}
		</figure>
	);
}
