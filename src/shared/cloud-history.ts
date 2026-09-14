/** Renderer-safe RTW accepted-answer projection. Historical evidence and bearer never cross this RPC. */
export interface CloudAnswerCitation {
	evidenceId: string;
	sourceKind: string;
	contentId: string;
	revisionId: string;
	chunkId: string;
	state: "available" | "unavailable";
}

export interface CloudAcceptedAnswer {
	answerId: string;
	searchId: string;
	sessionId: string;
	acceptedOrdinal: number;
	acceptedAt: string;
	status: "succeeded" | "insufficient";
	question: string;
	answer: string | null;
	/** Citation metadata is current RTW state, never a historical quote. */
	citations: CloudAnswerCitation[];
	citationState: "verified" | "unavailable";
}

export interface CloudAnswersPage {
	items: CloudAcceptedAnswer[];
	/** RTW ascending after_ordinal; null means the end of this known page. */
	nextOrdinal: number | null;
}

export interface ListCloudAnswersRequest {
	/** RTW logical answer session, supplied only by a future approved product bridge. */
	logicalSessionId: string;
	afterOrdinal?: number;
	limit?: number;
}

export type CloudHistoryResult<T> =
	| { kind: "ok"; data: T }
	| {
			kind:
				| "disabled"
				| "signed_out"
				| "session_changed"
				| "offline"
				| "unavailable"
				| "bad_response";
	  };
