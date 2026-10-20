/**
 * Mirror of the LLM Wiki platform citation contract snapshot.
 *
 * Source of truth: Sea-Docs 文档/技术/LLM-Wiki平台落地工程方案.md §1
 * "核心数据结构（v2.0 修订处加粗）" —— the `Locator`, `EvidencePack`, and
 * `WholeDocIndexManifest.DocEntry` proto messages. Field-level alignment:
 * names keep the proto's snake_case so wire payloads from the B-side
 * (btw-evidence-rpc) can be validated without renaming, and each field
 * carries its proto field number in the JSDoc. When the platform contract
 * snapshot is revised, update this mirror in the same change.
 *
 * Unlike `CloudToolEvidenceView` in cloud-tools-view.ts these are wire-level
 * mirror types, not renderer projections; views must project them into
 * pet-safe shapes before rendering.
 */

/** Proto: `message Locator` —— replaces chunk_id as the citation anchor. */
export interface Locator {
	/** proto 1 */
	revision_id: string;
	/** proto 2 — heading titles from the doc root down to the anchor's node. */
	section_path: string[];
	/** proto 3 */
	para_index: number;
	/**
	 * proto 4 — contract limit: ≤200 characters and must byte-hit the
	 * paragraph addressed by section_path + para_index (C-4 acceptance).
	 */
	quote: string;
}

/**
 * Proto: referenced opaquely inside `EvidencePack.Candidate` as
 * `LaneScores lanes`. The snapshot does not inline its fields; the three
 * lanes follow the platform's three-lane whole-doc retrieval design
 * (dense / sparse / multi, 工程方案 §4). Revisit if the platform contract
 * ever defines this message explicitly.
 */
export interface LaneScores {
	dense: number;
	sparse: number;
	multi: number;
}

/** Proto: `message EvidencePack.Candidate`. */
export interface EvidencePackCandidate {
	doc_key: string;
	rrf_score: number;
	lanes: LaneScores;
	evidence: Locator[];
}

/** Proto: `message EvidencePack`. */
export interface EvidencePack {
	query_id: string;
	candidates: EvidencePackCandidate[];
}

/** Contract limit for Locator.quote (≤200 字，必须命中段落). */
export const LOCATOR_QUOTE_MAX_RUNES = 200;
