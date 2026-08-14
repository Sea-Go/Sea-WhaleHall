import { Fragment, type ReactNode } from "react";
import {
	type PetMarkdownBlock,
	type PetMarkdownPageContent,
	type PetMarkdownRun,
	paginateSafePetMarkdown,
} from "./pet-markdown";

export interface SafePetMarkdownProps {
	content?: PetMarkdownPageContent;
	fallbackText: string;
}

const blockKeys = new WeakMap<PetMarkdownBlock, string>();
const runKeys = new WeakMap<PetMarkdownRun, string>();
let nextMarkdownNodeKey = 1;

export function SafePetMarkdown({
	content,
	fallbackText,
}: SafePetMarkdownProps) {
	const page =
		content ??
		paginateSafePetMarkdown(
			fallbackText,
			Math.max(1, Array.from(fallbackText).length),
		).at(0);
	if (!page) return null;
	return <>{renderBlocks(page.blocks)}</>;
}

function renderBlocks(blocks: readonly PetMarkdownBlock[]): ReactNode[] {
	const rendered: ReactNode[] = [];
	let index = 0;
	while (index < blocks.length) {
		const block = blocks[index];
		if (!block) break;
		if (block.kind === "list-item" && block.list) {
			const items: PetMarkdownBlock[] = [block];
			let next = index + 1;
			while (next < blocks.length) {
				const candidate = blocks[next];
				if (
					candidate?.kind !== "list-item" ||
					candidate.list?.ordered !== block.list.ordered ||
					candidate.list?.depth !== block.list.depth ||
					candidate.quoteDepth !== block.quoteDepth
				) {
					break;
				}
				items.push(candidate);
				next += 1;
			}
			const List = block.list.ordered ? "ol" : "ul";
			rendered.push(
				<List
					key={markdownNodeKey(blockKeys, block, "list")}
					start={block.list.ordered ? block.list.index : undefined}
					className="pet-safe-markdown__list"
					data-depth={block.list.depth}
				>
					{items.map((item) => (
						<li key={markdownNodeKey(blockKeys, item, "item")}>
							{renderRuns(item.runs)}
						</li>
					))}
				</List>,
			);
			index = next;
			continue;
		}
		rendered.push(renderBlock(block));
		index += 1;
	}
	return rendered;
}

function renderBlock(block: PetMarkdownBlock): ReactNode {
	const children = renderRuns(block.runs);
	const className = block.quoteDepth ? "pet-safe-markdown__quoted" : undefined;
	switch (block.kind) {
		case "heading": {
			const Heading = `h${Math.min(6, Math.max(1, block.headingLevel ?? 3))}` as
				| "h1"
				| "h2"
				| "h3"
				| "h4"
				| "h5"
				| "h6";
			return (
				<Heading
					key={markdownNodeKey(blockKeys, block, "heading")}
					className={className}
				>
					{children}
				</Heading>
			);
		}
		default:
			return (
				<p
					key={markdownNodeKey(blockKeys, block, "paragraph")}
					className={className}
				>
					{children}
				</p>
			);
	}
}

function renderRuns(runs: readonly PetMarkdownRun[]): ReactNode[] {
	return runs.map((run) => {
		let node: ReactNode = run.text;
		if (run.code) node = <code>{node}</code>;
		if (run.emphasis) node = <em>{node}</em>;
		if (run.strong) node = <strong>{node}</strong>;
		return (
			<Fragment key={markdownNodeKey(runKeys, run, "run")}>{node}</Fragment>
		);
	});
}

function markdownNodeKey<T extends object>(
	keys: WeakMap<T, string>,
	node: T,
	prefix: string,
): string {
	const existing = keys.get(node);
	if (existing) return existing;
	const key = `${prefix}-${nextMarkdownNodeKey}`;
	nextMarkdownNodeKey += 1;
	keys.set(node, key);
	return key;
}
