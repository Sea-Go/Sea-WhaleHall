import { MAX_ACTIVE_GOAL_TEXT_LENGTH } from "../../shared/goal-context";
import {
	SEMANTIC_EVENT_KINDS,
	SEMANTIC_EVENT_V2_SCHEMA_VERSION,
	type CoverageLevel,
	type JsonValue,
	type SemanticCountClass,
	type SemanticEventKind,
	type SemanticEventV2,
} from "./types";

const EVENT_KIND_SET = new Set<string>(SEMANTIC_EVENT_KINDS);
const COVERAGE_LEVELS = new Set<CoverageLevel>([
	"content",
	"metadata",
	"redacted",
	"denied",
	"unavailable",
]);
const FORBIDDEN_FIELDS = new Set([
	"key",
	"key_name",
	"keycode",
	"key_code",
	"raw_key",
	"password",
	"passcode",
	"otp",
	"clipboard",
	"absolute_x",
	"absolute_y",
	"screen_x",
	"screen_y",
	"mouse_x",
	"mouse_y",
]);
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PAYLOAD_DEPTH = 8;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_OBJECT_KEYS = 1_024;
const MAX_STRING_LENGTH = 16_384;

export function isSemanticEventV2(value: unknown): value is SemanticEventV2 {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schemaVersion",
			"eventId",
			"cursor",
			"deviceId",
			"sessionId",
			"kind",
			"source",
			"occurredAtMs",
			"observedAtMs",
			"goalVersion",
			"countClass",
			"reliability",
			"coverage",
			"contentState",
			"sourceObservationIds",
			"taxonomyVersion",
			"projectorVersion",
			"payload",
		]) ||
		value.schemaVersion !== SEMANTIC_EVENT_V2_SCHEMA_VERSION ||
		!isBoundedIdentifier(value.eventId, 256) ||
		!isSemanticCursorV2(value.cursor) ||
		!isBoundedIdentifier(value.deviceId, 256) ||
		!isBoundedIdentifier(value.sessionId, 256) ||
		typeof value.kind !== "string" ||
		!EVENT_KIND_SET.has(value.kind) ||
		!isBoundedIdentifier(value.source, 256) ||
		!isNonNegativeSafeInteger(value.occurredAtMs) ||
		!isNonNegativeSafeInteger(value.observedAtMs) ||
		(value.observedAtMs as number) < (value.occurredAtMs as number) ||
		(value.goalVersion !== null &&
			!isNonNegativeSafeInteger(value.goalVersion)) ||
		!isCountClass(value.countClass) ||
		value.countClass !== expectedCountClass(value.kind as SemanticEventKind) ||
		(value.reliability !== "high" &&
			value.reliability !== "medium" &&
			value.reliability !== "low") ||
		!isCoverage(value.coverage) ||
		(value.contentState !== "available" &&
			value.contentState !== "redacted" &&
			value.contentState !== "expired" &&
			value.contentState !== "unavailable") ||
		!isIdentifierList(value.sourceObservationIds, 64) ||
		!isBoundedIdentifier(value.taxonomyVersion, 160) ||
		!isBoundedIdentifier(value.projectorVersion, 160) ||
		!isRecord(value.payload) ||
		!isJsonRecord(value.payload, 0) ||
		containsForbiddenField(value.payload)
	) {
		return false;
	}

	let serialized: string;
	try {
		serialized = JSON.stringify(value.payload);
	} catch {
		return false;
	}
	if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
		return false;
	}

	return payloadMatchesKind(
		value.kind as SemanticEventKind,
		value.payload as Record<string, JsonValue>,
	);
}

export function isSemanticCursorV2(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^sec2_[0-7][0-9a-f]{15}$/u.test(value)
	);
}

export function expectedCountClass(kind: SemanticEventKind): SemanticCountClass {
	switch (kind) {
		case "presence.changed":
		case "goal.changed":
			return "boundary";
		case "application.processObservedBatch":
		case "coverage.gap":
			return "ignored";
		case "application.foregroundChanged":
		case "application.visibleContentChanged":
		case "application.textValueChanged":
		case "browser.visiblePageChanged":
		case "ui.focusChanged":
		case "ui.controlActivated":
		case "input.activityBucket":
			return "effective";
	}
}

function payloadMatchesKind(
	kind: SemanticEventKind,
	payload: Record<string, JsonValue>,
): boolean {
	switch (kind) {
		case "application.foregroundChanged":
			return (
				hasRequiredAndOnlyKnownKeys(
					payload,
					["appId", "appName"],
					["opaqueWindowId", "windowTitle"],
				) &&
				isStringField(payload, "appId", 512) &&
				isStringField(payload, "appName", 512) &&
				optionalStringField(payload, "opaqueWindowId", 512) &&
				optionalStringField(payload, "windowTitle", 2_048)
			);
		case "application.visibleContentChanged":
			return (
				hasRequiredAndOnlyKnownKeys(
					payload,
					["appId", "appName", "contentHash"],
					["opaqueWindowId", "windowTitle", "visibleText"],
				) &&
				isStringField(payload, "appId", 512) &&
				isStringField(payload, "appName", 512) &&
				optionalStringField(payload, "opaqueWindowId", 512) &&
				optionalStringField(payload, "windowTitle", 2_048) &&
				optionalStringField(payload, "visibleText", 16_384) &&
				isStringField(payload, "contentHash", 256)
			);
		case "application.textValueChanged":
			return (
				hasRequiredAndOnlyKnownKeys(
					payload,
					[
						"appId",
						"appName",
						"role",
						"insertedChars",
						"deletedChars",
						"inputMethod",
					],
					[
						"opaqueWindowId",
						"opaqueControlId",
						"label",
						"addedText",
						"finalValue",
					],
				) &&
				isStringField(payload, "appId", 512) &&
				isStringField(payload, "appName", 512) &&
				optionalStringField(payload, "opaqueWindowId", 512) &&
				optionalStringField(payload, "opaqueControlId", 512) &&
				isStringField(payload, "role", 256) &&
				optionalStringField(payload, "label", 2_048) &&
				optionalStringField(payload, "addedText", 16_384) &&
				optionalStringField(payload, "finalValue", 16_384) &&
				isNonNegativeIntegerField(payload, "insertedChars") &&
				isNonNegativeIntegerField(payload, "deletedChars") &&
				payload.inputMethod === "unknown"
			);
		case "browser.visiblePageChanged":
			return (
				hasRequiredAndOnlyKnownKeys(
					payload,
					["appId", "appName", "contentHash", "changeKind"],
					[
						"opaqueWindowId",
						"domain",
						"url",
						"title",
						"visibleText",
					],
				) &&
				isStringField(payload, "appId", 512) &&
				isStringField(payload, "appName", 512) &&
				optionalStringField(payload, "opaqueWindowId", 512) &&
				optionalStringField(payload, "domain", 512) &&
				optionalStringField(payload, "url", 16_384) &&
				optionalStringField(payload, "title", 2_048) &&
				optionalStringField(payload, "visibleText", 16_384) &&
				isStringField(payload, "contentHash", 256) &&
				(payload.changeKind === "opened" ||
					payload.changeKind === "navigated" ||
					payload.changeKind === "content_changed")
			);
		case "ui.focusChanged":
			return (
				hasRequiredAndOnlyKnownKeys(
					payload,
					["appId", "appName", "role"],
					["opaqueWindowId", "opaqueControlId", "label"],
				) &&
				isStringField(payload, "appId", 512) &&
				isStringField(payload, "appName", 512) &&
				optionalStringField(payload, "opaqueWindowId", 512) &&
				optionalStringField(payload, "opaqueControlId", 512) &&
				isStringField(payload, "role", 256) &&
				optionalStringField(payload, "label", 2_048)
			);
		case "ui.controlActivated":
			return (
				hasRequiredAndOnlyKnownKeys(
					payload,
					["appId", "appName", "role", "action"],
					["opaqueWindowId", "opaqueControlId", "label"],
				) &&
				isStringField(payload, "appId", 512) &&
				isStringField(payload, "appName", 512) &&
				optionalStringField(payload, "opaqueWindowId", 512) &&
				optionalStringField(payload, "opaqueControlId", 512) &&
				isStringField(payload, "role", 256) &&
				isStringField(payload, "action", 256) &&
				optionalStringField(payload, "label", 2_048)
			);
		case "input.activityBucket":
			{
				const coalescedBucketCount =
					payload.coalescedBucketCount === undefined
						? 1
						: payload.coalescedBucketCount;
			return (
				hasRequiredAndOnlyKnownKeys(
					payload,
					[
						"bucketStartedAtMs",
						"bucketEndedAtMs",
						"keyCount",
						"clickCount",
						"scrollDelta",
						"mouseDistance",
					],
					["coalescedBucketCount"],
				) &&
				isNonNegativeIntegerField(payload, "bucketStartedAtMs") &&
				isNonNegativeIntegerField(payload, "bucketEndedAtMs") &&
				(payload.coalescedBucketCount === undefined ||
					(isNonNegativeIntegerField(payload, "coalescedBucketCount") &&
						(coalescedBucketCount as number) >= 2 &&
						(coalescedBucketCount as number) <= 256)) &&
				(payload.bucketEndedAtMs as number) -
					(payload.bucketStartedAtMs as number) ===
					(coalescedBucketCount as number) * 5_000 &&
				isNonNegativeIntegerField(payload, "keyCount") &&
				isNonNegativeIntegerField(payload, "clickCount") &&
				isFiniteNumberField(payload, "scrollDelta", -1e12, 1e12) &&
				isFiniteNumberField(payload, "mouseDistance", 0, 1e12)
			);
			}
		case "presence.changed":
			return (
				hasRequiredAndOnlyKnownKeys(
					payload,
					["state"],
					["idleForMs"],
				) &&
				isStringField(payload, "state", 64) &&
				[
					"afk_started",
					"afk_ended",
					"locked",
					"unlocked",
					"sleep",
					"wake",
				].includes(payload.state as string) &&
				optionalNonNegativeInteger(payload, "idleForMs") &&
				(payload.idleForMs === undefined ||
					payload.state === "afk_started" ||
					payload.state === "afk_ended")
			);
		case "goal.changed":
			return (
				Object.keys(payload).length === 0 ||
				(hasRequiredAndOnlyKnownKeys(payload, ["previous", "next"], []) &&
					isGoalOrNull(payload.previous) &&
					isGoalOrNull(payload.next))
			);
		case "application.processObservedBatch":
			return (
				hasRequiredAndOnlyKnownKeys(payload, ["started", "exited"], []) &&
				Array.isArray(payload.started) &&
				Array.isArray(payload.exited) &&
				payload.started.length <= MAX_ARRAY_ITEMS &&
				payload.exited.length <= MAX_ARRAY_ITEMS &&
				payload.started.every(isProcessObservation) &&
				payload.exited.every(isProcessObservation)
			);
		case "coverage.gap":
			return Object.keys(payload).length === 0;
	}
}

function isProcessObservation(value: JsonValue): boolean {
	return (
		isRecord(value) &&
		hasRequiredAndOnlyKnownKeys(
			value,
			["processId", "appId", "appName"],
			[],
		) &&
		isNonNegativeSafeInteger(value.processId) &&
		(value.processId as number) <= 0xffff_ffff &&
		isBoundedIdentifier(value.appId, 512) &&
		isBoundedIdentifier(value.appName, 512)
	);
}

function isGoalOrNull(value: JsonValue | undefined): boolean {
	if (value === null) return true;
	return (
		isRecord(value) &&
		hasRequiredAndOnlyKnownKeys(
			value,
			["goalId", "planId", "version", "text", "activatedAtMs"],
			[],
		) &&
		isBoundedIdentifier(value.goalId, 200) &&
		(value.planId === null || isBoundedIdentifier(value.planId, 200)) &&
		isNonNegativeSafeInteger(value.version) &&
		typeof value.text === "string" &&
		Array.from(value.text).length >= 1 &&
		Array.from(value.text).length <= MAX_ACTIVE_GOAL_TEXT_LENGTH &&
		!value.text.includes("\u0000") &&
		isNonNegativeSafeInteger(value.activatedAtMs)
	);
}

function isJsonRecord(value: Record<string, unknown>, depth: number): boolean {
	if (depth > MAX_PAYLOAD_DEPTH || Object.keys(value).length > MAX_OBJECT_KEYS) {
		return false;
	}
	return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}

function isJsonValue(value: unknown, depth: number): value is JsonValue {
	if (depth > MAX_PAYLOAD_DEPTH) return false;
	if (
		value === null ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return true;
	}
	if (typeof value === "string") {
		return value.length <= MAX_STRING_LENGTH && !value.includes("\u0000");
	}
	if (Array.isArray(value)) {
		return (
			value.length <= MAX_ARRAY_ITEMS &&
			value.every((entry) => isJsonValue(entry, depth + 1))
		);
	}
	return isRecord(value) && isJsonRecord(value, depth);
}

function containsForbiddenField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsForbiddenField);
	if (!isRecord(value)) return false;
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_FIELDS.has(toSnakeCase(key))) return true;
		if (containsForbiddenField(child)) return true;
	}
	return false;
}

function isCoverage(value: unknown): value is CoverageLevel[] {
	return (
		Array.isArray(value) &&
		value.length >= 1 &&
		value.length <= COVERAGE_LEVELS.size &&
		value.every(
			(entry) =>
				typeof entry === "string" &&
				COVERAGE_LEVELS.has(entry as CoverageLevel),
		) &&
		new Set(value).size === value.length
	);
}

function isIdentifierList(value: unknown, maximumItems: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length >= 1 &&
		value.length <= maximumItems &&
		value.every((entry) => isBoundedIdentifier(entry, 256)) &&
		new Set(value).size === value.length
	);
}

function isCountClass(value: unknown): value is SemanticCountClass {
	return (
		value === "effective" ||
		value === "boundary" ||
		value === "context" ||
		value === "ignored"
	);
}

function optionalStringField(
	payload: Record<string, JsonValue>,
	field: string,
	maximum: number,
): boolean {
	return (
		payload[field] === undefined ||
		(typeof payload[field] === "string" &&
			(payload[field] as string).length <= maximum &&
			!(payload[field] as string).includes("\u0000"))
	);
}

function isStringField(
	payload: Record<string, JsonValue>,
	field: string,
	maximum: number,
): boolean {
	const value = payload[field];
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maximum &&
		!value.includes("\u0000")
	);
}

function optionalNonNegativeInteger(
	payload: Record<string, JsonValue>,
	field: string,
): boolean {
	return payload[field] === undefined || isNonNegativeSafeInteger(payload[field]);
}

function isNonNegativeIntegerField(
	payload: Record<string, JsonValue>,
	field: string,
): boolean {
	return isNonNegativeSafeInteger(payload[field]);
}

function isFiniteNumberField(
	payload: Record<string, JsonValue>,
	field: string,
	minimum: number,
	maximum: number,
): boolean {
	const value = payload[field];
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= minimum &&
		value <= maximum
	);
}

function isNonNegativeSafeInteger(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedIdentifier(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maximum &&
		!value.includes("\u0000")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function hasRequiredAndOnlyKnownKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return (
		required.every((key) => key in value) &&
		Object.keys(value).every((key) => allowed.has(key))
	);
}

function toSnakeCase(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.replace(/[-\s]+/gu, "_")
		.toLowerCase();
}
