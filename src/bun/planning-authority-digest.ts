import { createHash } from "node:crypto";
import type {
	PlanningAuthorityDraft,
	PlanningAuthorityInput,
} from "../shared/planning-authority";

export interface PlanningCommitCoordinationInput {
	commitId: string;
	expectedAuthorityRevision: number;
	expectedCalendarRevision: number;
	draftRevision: number;
	draftDigest: string;
}

/** Stable across retries, processes, object key order, and generated timestamps. */
export function planningDraftDigest(
	input: PlanningAuthorityInput,
	draft: PlanningAuthorityDraft,
): string {
	return sha256(canonicalJson({ input, draft }));
}

/**
 * Digest for the plaintext SQLite coordination columns. Deliberately excludes
 * timestamps, generated mutation IDs, encrypted event bytes, and outbox attempts.
 */
export function planningCommitCoordinationDigest(
	input: PlanningCommitCoordinationInput,
): string {
	return sha256(canonicalJson(input));
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}
