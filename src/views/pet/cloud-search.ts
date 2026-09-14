export interface PetCloudSearchPort {
	/** Bun must bind this port to the current RTW product session and module. */
	search(input: { query: string; signal: AbortSignal }): Promise<unknown>;
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
		visibleCitations.push({
			id: item.evidence_id,
			kind: item.source_kind,
			excerpt: Array.from(item.quote).slice(0, 120).join(""),
		});
	}
	return {
		kind: "answered",
		answer: result.answer,
		citations: visibleCitations,
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
