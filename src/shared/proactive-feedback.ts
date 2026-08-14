export const PROACTIVE_FEEDBACK_RETENTION_OPTIONS = [
	7,
	30,
	90,
	"forever",
] as const;

export type ProactiveFeedbackRetention =
	(typeof PROACTIVE_FEEDBACK_RETENTION_OPTIONS)[number];

export const DEFAULT_PROACTIVE_FEEDBACK_POLICY = {
	enabled: true,
	retention: 30,
} as const satisfies ProactiveFeedbackPolicy;

export const PROACTIVE_FEEDBACK_HISTORY_DEFAULT_LIMIT = 20;
export const PROACTIVE_FEEDBACK_HISTORY_MAX_LIMIT = 50;
export const PROACTIVE_FEEDBACK_MESSAGE_MAX_BYTES = 64 * 1024;
/** Defensive renderer cap; the authoritative wire limit is UTF-8 bytes. */
export const PROACTIVE_FEEDBACK_MESSAGE_MAX_CHARACTERS = 64 * 1024;

/**
 * Account identity is deliberately absent. Bun resolves the current account
 * from the authenticated session before reading or mutating this policy.
 */
export interface ProactiveFeedbackPolicy {
	enabled: boolean;
	retention: ProactiveFeedbackRetention;
}

export interface ProactiveFeedbackPolicySnapshot {
	policy: ProactiveFeedbackPolicy;
	revision: number;
	updatedAtMs: number | null;
}

export interface SetProactiveFeedbackPolicyRequest {
	policy: ProactiveFeedbackPolicy;
	expectedRevision: number;
}

export interface ProactiveFeedbackHistoryCursor {
	generatedAtMs: number;
	id: string;
}

export interface ProactiveFeedbackItem {
	id: string;
	generatedAtMs: number;
	message: string;
}

export interface ListProactiveFeedbackRequest {
	cursor?: ProactiveFeedbackHistoryCursor;
	limit?: number;
}

export interface ProactiveFeedbackPage {
	items: readonly ProactiveFeedbackItem[];
	nextCursor: ProactiveFeedbackHistoryCursor | null;
}

export interface ProactiveFeedbackAvailable {
	id: string;
	generatedAtMs: number;
}

export interface ClearProactiveFeedbackResult {
	clearedAtMs: number;
}

export type ProactiveFeedbackFailureKind =
	| "signed-out"
	| "offline"
	| "service-unavailable"
	| "version-conflict"
	| "invalid-request"
	| "unexpected";

export type ProactiveFeedbackRpcResult<T> =
	| { kind: "success"; data: T }
	| {
			kind: "error";
			failure: ProactiveFeedbackFailureKind;
			message: string;
			currentRevision?: number;
	  };

export function createDefaultProactiveFeedbackPolicy(): ProactiveFeedbackPolicy {
	return { ...DEFAULT_PROACTIVE_FEEDBACK_POLICY };
}

export function isProactiveFeedbackPolicy(
	value: unknown,
): value is ProactiveFeedbackPolicy {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["enabled", "retention"]) &&
		typeof value.enabled === "boolean" &&
		isProactiveFeedbackRetention(value.retention)
	);
}

export function isProactiveFeedbackPolicySnapshot(
	value: unknown,
): value is ProactiveFeedbackPolicySnapshot {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["policy", "revision", "updatedAtMs"]) &&
		isProactiveFeedbackPolicy(value.policy) &&
		isNonNegativeSafeInteger(value.revision) &&
		(value.updatedAtMs === null || isNonNegativeSafeInteger(value.updatedAtMs))
	);
}

export function isSetProactiveFeedbackPolicyRequest(
	value: unknown,
): value is SetProactiveFeedbackPolicyRequest {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["policy", "expectedRevision"]) &&
		isProactiveFeedbackPolicy(value.policy) &&
		isNonNegativeSafeInteger(value.expectedRevision)
	);
}

export function isListProactiveFeedbackRequest(
	value: unknown,
): value is ListProactiveFeedbackRequest {
	if (!isRecord(value)) return false;
	if (!hasOnlyKeys(value, ["cursor", "limit"])) return false;
	if (
		value.limit !== undefined &&
		(!isNonNegativeSafeInteger(value.limit) ||
			value.limit < 1 ||
			value.limit > PROACTIVE_FEEDBACK_HISTORY_MAX_LIMIT)
	) {
		return false;
	}
	return (
		value.cursor === undefined || isProactiveFeedbackHistoryCursor(value.cursor)
	);
}

export function isProactiveFeedbackPage(
	value: unknown,
): value is ProactiveFeedbackPage {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["items", "nextCursor"]) ||
		!Array.isArray(value.items)
	)
		return false;
	if (value.items.length > PROACTIVE_FEEDBACK_HISTORY_MAX_LIMIT) return false;
	if (!value.items.every(isProactiveFeedbackItem)) return false;
	const seen = new Set<string>();
	for (let index = 0; index < value.items.length; index += 1) {
		const item = value.items[index];
		if (!item || seen.has(item.id)) return false;
		seen.add(item.id);
		const previous = value.items[index - 1];
		if (previous && compareHistoryPosition(previous, item) >= 0) return false;
	}
	if (
		!(
			value.nextCursor === null ||
			isProactiveFeedbackHistoryCursor(value.nextCursor)
		)
	)
		return false;
	if (value.nextCursor === null) return true;
	const last = value.items.at(-1);
	return (
		last !== undefined &&
		last.generatedAtMs === value.nextCursor.generatedAtMs &&
		last.id === value.nextCursor.id
	);
}

export function isClearProactiveFeedbackResult(
	value: unknown,
): value is ClearProactiveFeedbackResult {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["clearedAtMs"]) &&
		isNonNegativeSafeInteger(value.clearedAtMs)
	);
}

export function isProactiveFeedbackAvailable(
	value: unknown,
): value is ProactiveFeedbackAvailable {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["id", "generatedAtMs"]) &&
		isOpaqueId(value.id) &&
		isNonNegativeSafeInteger(value.generatedAtMs)
	);
}

function isProactiveFeedbackRetention(
	value: unknown,
): value is ProactiveFeedbackRetention {
	return value === 7 || value === 30 || value === 90 || value === "forever";
}

export function isProactiveFeedbackHistoryCursor(
	value: unknown,
): value is ProactiveFeedbackHistoryCursor {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["generatedAtMs", "id"]) &&
		isNonNegativeSafeInteger(value.generatedAtMs) &&
		isOpaqueId(value.id)
	);
}

export function isProactiveFeedbackItem(
	value: unknown,
): value is ProactiveFeedbackItem {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["id", "generatedAtMs", "message"]) &&
		isOpaqueId(value.id) &&
		isNonNegativeSafeInteger(value.generatedAtMs) &&
		typeof value.message === "string" &&
		value.message.length > 0 &&
		value.message.length <= PROACTIVE_FEEDBACK_MESSAGE_MAX_CHARACTERS &&
		utf8ByteLength(value.message) <= PROACTIVE_FEEDBACK_MESSAGE_MAX_BYTES &&
		!containsDisallowedControlCharacter(value.message)
	);
}

function compareHistoryPosition(
	left: ProactiveFeedbackHistoryCursor,
	right: ProactiveFeedbackHistoryCursor,
): number {
	if (left.generatedAtMs !== right.generatedAtMs) {
		return right.generatedAtMs - left.generatedAtMs;
	}
	if (left.id === right.id) return 0;
	return right.id < left.id ? -1 : 1;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function containsDisallowedControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) continue;
		if (
			codePoint <= 0x08 ||
			(codePoint >= 0x0b && codePoint <= 0x1f) ||
			(codePoint >= 0x7f && codePoint <= 0x9f)
		) {
			return true;
		}
	}
	return false;
}

function isOpaqueId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}
