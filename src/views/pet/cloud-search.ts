import type { Locator } from "../../shared/locator-types";

export interface PetCloudSearchPort {
	/** Bun must bind this port to the current RTW product session and module. */
	search(input: { query: string; signal: AbortSignal }): Promise<unknown>;
}

/**
 * StructureLocator-shaped citation anchor for CitationBubble rendering:
 * the Locator contract mirror (locator-types.ts) plus the doc identity
 * (`doc_key`). The current RTW accepted-search wire only guarantees
 * evidence_id/revision_id/quote per citation, so the locator is mapped
 * opportunistically from any extra wire fields; `undefined` keeps the
 * panel on the legacy excerpt line until the wire carries the full shape.
 */
export interface PetCitationLocator extends Locator {
	doc_key: string;
}

export type PetCloudSearchState =
	| { kind: "unavailable"; message: string }
	| { kind: "idle" }
	| { kind: "searching" }
	| {
			kind: "answered";
			answer: string;
			citations: readonly {
				id: string;
				kind: "source" | "wiki";
				excerpt: string;
				/** Absent while the wire citation lacks StructureLocator fields. */
				locator?: PetCitationLocator;
			}[];
	  }
	| { kind: "insufficient" }
	| { kind: "failed"; message: string }
	| { kind: "cancelled" };

const NO_SESSION_MESSAGE = "知识会话尚未连接，云搜索暂不可用。";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function acceptedSearchState(value: unknown): PetCloudSearchState {
	const outcome = asRecord(value);
	if (outcome?.kind !== "accepted") {
		return {
			kind: "failed",
			message: "尚未取得已接纳的搜索结果，请稍后重试。",
		};
	}
	const result = asRecord(outcome.result);
	if (
		!result ||
		typeof result.search_id !== "string" ||
		typeof result.answer_id !== "string"
	) {
		return { kind: "failed", message: "搜索结果无法确认，请稍后重试。" };
	}
	const citations = result.citations;
	if (result.status === "insufficient") {
		if (
			result.answer !== undefined ||
			!Array.isArray(citations) ||
			citations.length !== 0 ||
			result.citation_receipt_ref !== undefined
		) {
			return { kind: "failed", message: "搜索结果无法确认，请稍后重试。" };
		}
		return { kind: "insufficient" };
	}
	if (
		result.status !== "succeeded" ||
		typeof result.answer !== "string" ||
		result.answer.trim().length === 0 ||
		typeof result.citation_receipt_ref !== "string" ||
		result.citation_receipt_ref.trim().length === 0 ||
		!Array.isArray(citations) ||
		citations.length === 0
	) {
		return { kind: "failed", message: "搜索结果无法确认，请稍后重试。" };
	}
	const visibleCitations: {
		id: string;
		kind: "source" | "wiki";
		excerpt: string;
		locator?: PetCitationLocator;
	}[] = [];
	for (const citation of citations) {
		const item = asRecord(citation);
		if (
			!item ||
			(item.source_kind !== "source" && item.source_kind !== "wiki") ||
			typeof item.evidence_id !== "string" ||
			typeof item.revision_id !== "string" ||
			typeof item.quote !== "string" ||
			item.quote.trim().length === 0
		) {
			return { kind: "failed", message: "引用状态无法确认，请稍后重试。" };
		}
		// revision_id/quote are already validated above; doc_key/section_path/
		// para_index are checked inside citationLocator and degrade to the
		// excerpt-only projection when the wire has not grown them yet.
		const locator = citationLocator(item, item.revision_id, item.quote);
		visibleCitations.push({
			id: item.evidence_id,
			kind: item.source_kind,
			excerpt: Array.from(item.quote).slice(0, 120).join(""),
			...(locator ? { locator } : {}),
		});
	}
	return {
		kind: "answered",
		answer: result.answer,
		citations: visibleCitations,
	};
}

/**
 * Map one accepted wire citation onto the StructureLocator shape
 * (doc_key/revision_id/section_path/para_index/quote) when every locator
 * field is present and well-formed; otherwise return undefined so the
 * panel falls back to the legacy excerpt line.
 */
function citationLocator(
	item: Record<string, unknown>,
	revisionId: string,
	quote: string,
): PetCitationLocator | undefined {
	const docKey = typeof item.doc_key === "string" ? item.doc_key.trim() : "";
	const sectionPath =
		Array.isArray(item.section_path) &&
		item.section_path.every((part) => typeof part === "string")
			? (item.section_path as string[])
			: undefined;
	const paraIndex =
		typeof item.para_index === "number" &&
		Number.isInteger(item.para_index) &&
		item.para_index >= 0
			? item.para_index
			: undefined;
	if (
		docKey.length === 0 ||
		sectionPath === undefined ||
		paraIndex === undefined
	)
		return undefined;
	return {
		doc_key: docKey,
		revision_id: revisionId,
		section_path: sectionPath,
		para_index: paraIndex,
		quote,
	};
}

function failureMessage(error: unknown): string {
	const code = asRecord(error)?.code;
	if (code === "NOT_AUTHENTICATED" || code === "SESSION_CHANGED") {
		return NO_SESSION_MESSAGE;
	}
	if (code === "CONFLICT") return "当前搜索状态已变化，请重新发起。";
	if (code === "CANCELLED") return "搜索已取消。";
	return "云搜索暂时失败，请稍后重试。";
}

export class PetCloudSearchController {
	private stateValue: PetCloudSearchState;
	private run: AbortController | null = null;
	private generation = 0;
	private disposed = false;

	constructor(
		private readonly port: PetCloudSearchPort | null,
		private readonly onState: (state: PetCloudSearchState) => void,
	) {
		this.stateValue = port
			? { kind: "idle" }
			: { kind: "unavailable", message: NO_SESSION_MESSAGE };
	}

	get state(): PetCloudSearchState {
		return this.stateValue;
	}

	async start(rawQuery: string): Promise<void> {
		if (this.disposed || !this.port || this.run) return;
		const query = rawQuery.trim();
		if (query.length === 0 || new TextEncoder().encode(query).length > 4096) {
			this.publish({
				kind: "failed",
				message: "请输入不超过 4096 字节的问题。",
			});
			return;
		}
		const run = new AbortController();
		const generation = ++this.generation;
		this.run = run;
		this.publish({ kind: "searching" });
		try {
			const outcome = await this.port.search({ query, signal: run.signal });
			if (!this.isCurrent(run, generation)) return;
			this.publish(acceptedSearchState(outcome));
		} catch (error) {
			if (!this.isCurrent(run, generation)) return;
			const message = failureMessage(error);
			this.publish(
				message === "搜索已取消。"
					? { kind: "cancelled" }
					: message === NO_SESSION_MESSAGE
						? { kind: "unavailable", message }
						: { kind: "failed", message },
			);
		} finally {
			if (this.run === run) this.run = null;
		}
	}

	cancel(): void {
		if (!this.run) return;
		this.generation += 1;
		this.run.abort();
		this.run = null;
		this.publish({ kind: "cancelled" });
	}

	dispose(): void {
		this.disposed = true;
		this.generation += 1;
		this.run?.abort();
		this.run = null;
	}

	private isCurrent(run: AbortController, generation: number): boolean {
		return (
			!this.disposed &&
			this.run === run &&
			this.generation === generation &&
			!run.signal.aborted
		);
	}

	private publish(state: PetCloudSearchState): void {
		if (this.disposed) return;
		this.stateValue = state;
		this.onState(state);
	}
}
