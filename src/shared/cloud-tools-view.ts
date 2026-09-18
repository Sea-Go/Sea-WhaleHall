import type {
	CloudReadEvidenceResult,
	CloudSearchResult,
} from "../agent/mastra-host/cloud-tools/cloud-search-tools";

export interface CloudToolEvidenceView {
	evidenceId: string;
	sourceKind: "source" | "wiki";
	revisionId: string;
	/** A search hit alone has not reread the current source. */
	availability: "unverified" | "available" | "unavailable";
	/** Time of the last RTW reread, absent for a search-only hit. */
	checkedAtMs?: number;
}

export interface CloudToolSearchView {
	searchId: string;
	status: "complete" | "partial" | "empty";
	stopReason: string;
	snapshotRef: string;
	evidence: CloudToolEvidenceView[];
}

/** Renderer-facing identity and current state; no quote, bearer or subject. */
export function cloudToolSearchView(
	result: CloudSearchResult,
): CloudToolSearchView {
	return {
		searchId: result.search_id,
		status: result.status,
		stopReason: result.stop_reason,
		snapshotRef: result.snapshot_ref,
		evidence: result.evidence.map((item) => ({
			evidenceId: item.evidence_id,
			sourceKind: item.source_kind,
			revisionId: item.revision_id,
			availability: "unverified" as const,
		})),
	};
}

/** Call only after RTW has reread the citation at the current revision. */
export function cloudToolRereadView(
	current: CloudToolSearchView,
	reread: CloudReadEvidenceResult,
): CloudToolSearchView {
	if (
		current.searchId !== reread.search_id ||
		current.snapshotRef !== reread.snapshot_ref ||
		!current.evidence.some(
			(item) =>
				item.evidenceId === reread.evidence.evidence_id &&
				item.revisionId === reread.evidence.revision_id,
		)
	)
		throw new Error("Reread evidence is outside the current search view.");
	return {
		...current,
		evidence: current.evidence.map((item) =>
			item.evidenceId === reread.evidence.evidence_id
				? {
						...item,
						availability: "available" as const,
						checkedAtMs: Date.now(),
					}
				: item,
		),
	};
}

/** A later unavailable response must clear any previously observed state. */
export function cloudToolUnavailableView(
	current: CloudToolSearchView,
	evidenceId: string,
): CloudToolSearchView {
	if (!current.evidence.some((item) => item.evidenceId === evidenceId))
		throw new Error("Unavailable evidence is outside the current search view.");
	return {
		...current,
		evidence: current.evidence.map((item) =>
			item.evidenceId === evidenceId
				? {
						...item,
						availability: "unavailable" as const,
						checkedAtMs: Date.now(),
					}
				: item,
		),
	};
}
