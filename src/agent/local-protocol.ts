import type {
	ActiveGoalContextV1,
	DesktopEventKind,
	DesktopEventV1,
} from "./reflection/types";
import { MAX_ACTIVE_GOAL_TEXT_LENGTH } from "../shared/goal-context";

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const LOCAL_CONTROL_TIMEOUT_MS = 5000;
export const LOCAL_TOOL_TIMEOUT_MS = 30_000;

export type LocalMethod =
	| "runtime.health"
	| "tool.list"
	| "tool.call"
	| "tool.cancel"
	| "event.query"
	| "event.commit"
	| "event.goal.change";

export type LocalRequest = {
	id: string;
	method: LocalMethod;
	params: Record<string, unknown>;
};

export type LocalProtocolErrorCode =
	| "INVALID_REQUEST"
	| "METHOD_NOT_FOUND"
	| "TOOL_NOT_FOUND"
	| "INVALID_ARGUMENTS"
	| "PERMISSION_DENIED"
	| "CANCELLED"
	| "BUSY"
	| "INVALID_CURSOR"
	| "CURSOR_EXPIRED"
	| "CURSOR_REGRESSION"
	| "INTERNAL_ERROR";

export type LocalErrorPayload = {
	code: LocalProtocolErrorCode;
	message: string;
};

export type LocalSuccessResponse = {
	id: string;
	ok: true;
	result: unknown;
};

export type LocalFailureResponse = {
	id: string | null;
	ok: false;
	error: LocalErrorPayload;
};

export type LocalResponse = LocalSuccessResponse | LocalFailureResponse;

export type ToolRisk = "read" | "write" | "control";

export type LocalToolDescriptor = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	risk: ToolRisk;
	requiredPermissions: string[];
	supportsCancellation: boolean;
};

export type LocalRuntimeHealth = {
	service: "whalehall-local";
	version: string;
	pid: number;
	status: "ok";
};

export type LocalToolListResult = {
	tools: LocalToolDescriptor[];
};

export type LocalToolCall = {
	callId: string;
	name: string;
	arguments: Record<string, unknown>;
};

export type LocalToolCallResult = {
	callId: string;
	output: unknown;
};

export type LocalToolCancelResult = {
	callId: string;
	cancelled: boolean;
};

export type LocalToolEventKind =
	| "tool.started"
	| "tool.progress"
	| "tool.completed"
	| "tool.failed"
	| "tool.cancelled";

export type LocalToolEvent = {
	event: LocalToolEventKind;
	callId: string;
	data: Record<string, unknown>;
};

export type LocalDesktopEventFrame = {
	event: "desktop.event";
	data: DesktopEventV1;
};

export type LocalEventQuery = {
	afterCursor?: string;
	consumerId?: string;
	limit?: number;
};

export type LocalEventQueryResult = {
	events: DesktopEventV1[];
	nextCursor: string | null;
	hasMore: boolean;
};

export type LocalEventCommitResult = {
	consumerId: string;
	cursor: string;
	advanced: boolean;
};

export type LocalEventGoalChange = {
	previous: ActiveGoalContextV1 | null;
	next: ActiveGoalContextV1 | null;
	occurredAtMs: number;
	deduplicationKey: string;
};

export type LocalEventGoalChangeResult = {
	event: DesktopEventV1;
	inserted: boolean;
};

export type LocalMessage = LocalResponse | LocalToolEvent | LocalDesktopEventFrame;

export type LocalRuntimeState = "starting" | "ready" | "degraded" | "stopped";

export type LocalRuntimeStatus = {
	state: LocalRuntimeState;
	pid: number | null;
	activeCalls: number;
	lastError: string | null;
};

const EVENT_KINDS = new Set<LocalToolEventKind>([
	"tool.started",
	"tool.progress",
	"tool.completed",
	"tool.failed",
	"tool.cancelled",
]);
const ERROR_CODES = new Set<LocalProtocolErrorCode>([
	"INVALID_REQUEST",
	"METHOD_NOT_FOUND",
	"TOOL_NOT_FOUND",
	"INVALID_ARGUMENTS",
	"PERMISSION_DENIED",
	"CANCELLED",
	"BUSY",
	"INVALID_CURSOR",
	"CURSOR_EXPIRED",
	"CURSOR_REGRESSION",
	"INTERNAL_ERROR",
]);

export function parseLocalMessage(line: string): LocalMessage {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error(`whalehall-local emitted invalid JSON: ${String(error)}`);
	}
	if (!isRecord(value)) throw new Error("Local protocol message must be an object.");

	if (value.event === "desktop.event") {
		if (!isDesktopEvent(value.data)) {
			throw new Error("Desktop event frame has an invalid shape.");
		}
		return value as LocalDesktopEventFrame;
	}

	if (typeof value.event === "string") {
		if (
			!EVENT_KINDS.has(value.event as LocalToolEventKind) ||
			typeof value.callId !== "string" ||
			!isRecord(value.data)
		) {
			throw new Error("Local tool event has an invalid shape.");
		}
		return value as LocalToolEvent;
	}

	if (typeof value.ok !== "boolean") {
		throw new Error("Local response must include a boolean 'ok' field.");
	}
	if (value.ok) {
		if (typeof value.id !== "string" || !("result" in value)) {
			throw new Error("Successful local response is missing 'id' or 'result'.");
		}
		return value as LocalSuccessResponse;
	}
	if (
		(value.id !== null && typeof value.id !== "string") ||
		!isRecord(value.error) ||
		typeof value.error.code !== "string" ||
		!ERROR_CODES.has(value.error.code as LocalProtocolErrorCode) ||
		typeof value.error.message !== "string"
	) {
		throw new Error("Failed local response has an invalid error payload.");
	}
	return value as LocalFailureResponse;
}

export function isLocalToolDescriptor(value: unknown): value is LocalToolDescriptor {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		isRecord(value.inputSchema) &&
		(value.risk === "read" || value.risk === "write" || value.risk === "control") &&
		Array.isArray(value.requiredPermissions) &&
		value.requiredPermissions.every((permission) => typeof permission === "string") &&
		typeof value.supportsCancellation === "boolean"
	);
}

const DESKTOP_EVENT_KINDS = new Set<DesktopEventKind>([
	"application.processObservedBatch",
	"application.foregroundChanged",
	"browser.tabOpened",
	"browser.tabNavigated",
	"browser.tabClosed",
	"accessibility.focusChanged",
	"accessibility.valueChanged",
	"accessibility.documentChanged",
	"editor.documentChanged",
	"input.activityAggregated",
	"presence.afkStarted",
	"presence.afkEnded",
	"presence.locked",
	"presence.unlocked",
	"presence.sleep",
	"presence.wake",
	"goal.contextChanged",
	"authorization.revoked",
	"authorization.granted",
	"reflection.completed",
	"reflection.failed",
	"tool.started",
	"tool.progress",
	"tool.completed",
	"tool.failed",
	"tool.cancelled",
	"system.heartbeat",
]);

export function isDesktopEvent(value: unknown): value is DesktopEventV1 {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
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
			"sensitivity",
			"payload",
		]) &&
		value.schemaVersion === "desktop-event.v1" &&
		isBoundedString(value.eventId, 200) &&
		isBoundedString(value.cursor, 128) &&
		isBoundedString(value.deviceId, 200) &&
		isBoundedString(value.sessionId, 200) &&
		typeof value.kind === "string" &&
		DESKTOP_EVENT_KINDS.has(value.kind as DesktopEventKind) &&
		isBoundedString(value.source, 200) &&
		Number.isSafeInteger(value.occurredAtMs) &&
		(value.occurredAtMs as number) >= 0 &&
		Number.isSafeInteger(value.observedAtMs) &&
		(value.observedAtMs as number) >= (value.occurredAtMs as number) &&
		(value.goalVersion === null ||
			(Number.isSafeInteger(value.goalVersion) &&
				(value.goalVersion as number) >= 0)) &&
		(value.sensitivity === "metadata" || value.sensitivity === "content") &&
		isRecord(value.payload) &&
		!containsForbiddenDesktopField(value.payload) &&
		(value.sensitivity === "content" ||
			!containsContentOnlyDesktopField(value.payload)) &&
		isDesktopEventPayload(
			value.kind as DesktopEventKind,
			value.payload,
			value.sensitivity,
		)
	);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FORBIDDEN_DESKTOP_FIELDS = new Set([
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
]);

const CONTENT_ONLY_DESKTOP_FIELDS = new Set([
	"text",
	"value",
	"document_text",
	"url",
	"title",
	"window_title",
	"search_term",
	"target_path",
]);

function containsForbiddenDesktopField(value: unknown): boolean {
	return containsMatchingField(value, FORBIDDEN_DESKTOP_FIELDS);
}

function containsContentOnlyDesktopField(value: unknown): boolean {
	return containsMatchingField(value, CONTENT_ONLY_DESKTOP_FIELDS);
}

function containsMatchingField(value: unknown, fields: ReadonlySet<string>): boolean {
	if (Array.isArray(value)) {
		return value.some((child) => containsMatchingField(child, fields));
	}
	if (!isRecord(value)) return false;
	for (const [key, child] of Object.entries(value)) {
		if (fields.has(toSnakeCase(key))) return true;
		if (containsMatchingField(child, fields)) return true;
	}
	return false;
}

function toSnakeCase(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.replace(/[-\s]+/gu, "_")
		.toLowerCase();
}

function isDesktopEventPayload(
	kind: DesktopEventKind,
	payload: Record<string, unknown>,
	sensitivity: unknown,
): boolean {
	switch (kind) {
		case "application.processObservedBatch":
			return (
				sensitivity === "metadata" &&
				hasExactKeys(payload, ["started", "exited"]) &&
				isProcessList(payload.started) &&
				isProcessList(payload.exited)
			);
		case "application.foregroundChanged":
			return optionalContentPayload(
				payload,
				sensitivity,
				["appId", "appName"],
				"windowTitle",
				2_048,
			);
		case "browser.tabOpened":
		case "browser.tabNavigated":
			return (
				hasRequiredAndOptionalKeys(
					payload,
					["browserId", "tabId"],
					["title", "url"],
				) &&
				isBoundedString(payload.browserId, 256) &&
				isBoundedString(payload.tabId, 256) &&
				(payload.title === undefined ||
					(sensitivity === "content" &&
						isBoundedString(payload.title, 2_048))) &&
				(payload.url === undefined ||
					(sensitivity === "content" &&
						isBoundedString(payload.url, 16_384))) &&
				(sensitivity === "metadata"
					? payload.title === undefined && payload.url === undefined
					: sensitivity === "content")
			);
		case "browser.tabClosed":
			return (
				sensitivity === "metadata" &&
				hasExactKeys(payload, ["browserId", "tabId"]) &&
				isBoundedString(payload.browserId, 256) &&
				isBoundedString(payload.tabId, 256)
			);
		case "accessibility.focusChanged":
			return optionalContentPayload(
				payload,
				sensitivity,
				["appId", "role"],
				"label",
				2_048,
			);
		case "accessibility.valueChanged":
			return optionalContentPayload(
				payload,
				sensitivity,
				["appId", "role"],
				"value",
				4_096,
			);
		case "accessibility.documentChanged":
			return isDocumentChangePayload(payload, sensitivity, false);
		case "editor.documentChanged":
			return isDocumentChangePayload(payload, sensitivity, true);
		case "input.activityAggregated":
			return (
				sensitivity === "metadata" &&
				hasExactKeys(payload, [
					"bucketStartedAtMs",
					"bucketEndedAtMs",
					"keyCount",
					"clickCount",
					"scrollDelta",
					"mouseDistance",
				]) &&
				isNonNegativeSafeInteger(payload.bucketStartedAtMs) &&
				isNonNegativeSafeInteger(payload.bucketEndedAtMs) &&
				(payload.bucketEndedAtMs as number) -
					(payload.bucketStartedAtMs as number) ===
					5_000 &&
				isNonNegativeSafeInteger(payload.keyCount) &&
				isNonNegativeSafeInteger(payload.clickCount) &&
				isBoundedFiniteNumber(payload.scrollDelta, -1e12, 1e12) &&
				isBoundedFiniteNumber(payload.mouseDistance, 0, 1e12)
			);
		case "presence.afkStarted":
		case "presence.afkEnded":
			return (
				sensitivity === "metadata" &&
				hasExactKeys(payload, ["idleForMs"]) &&
				isNonNegativeSafeInteger(payload.idleForMs)
			);
		case "presence.locked":
		case "presence.unlocked":
		case "presence.sleep":
		case "presence.wake":
		case "system.heartbeat":
			return sensitivity === "metadata" && hasExactKeys(payload, []);
		case "goal.contextChanged":
			return (
				sensitivity === "content" &&
				hasExactKeys(payload, ["previous", "next"]) &&
				isActiveGoalOrNull(payload.previous) &&
				isActiveGoalOrNull(payload.next)
			);
		case "authorization.revoked":
		case "authorization.granted":
			return (
				sensitivity === "metadata" &&
				hasExactKeys(payload, ["permissions"]) &&
				isPermissionList(payload.permissions)
			);
		case "reflection.completed":
			return (
				sensitivity === "metadata" &&
				hasExactKeys(payload, ["windowId"]) &&
				isBoundedString(payload.windowId, 200)
			);
		case "reflection.failed":
			return (
				sensitivity === "metadata" &&
				hasExactKeys(payload, ["windowId", "code"]) &&
				isBoundedString(payload.windowId, 200) &&
				isBoundedString(payload.code, 128)
			);
		case "tool.started":
		case "tool.completed":
			return (
				sensitivity === "metadata" &&
				hasRequiredAndOptionalKeys(payload, ["callId"], ["name"]) &&
				isBoundedString(payload.callId, 200) &&
				(payload.name === undefined || isBoundedString(payload.name, 200))
			);
		case "tool.progress":
			return (
				sensitivity === "metadata" &&
				hasRequiredAndOptionalKeys(payload, ["callId"], ["progress"]) &&
				isBoundedString(payload.callId, 200) &&
				(payload.progress === undefined ||
					isBoundedFiniteNumber(payload.progress, 0, 100))
			);
		case "tool.failed":
			return (
				sensitivity === "metadata" &&
				hasRequiredAndOptionalKeys(payload, ["callId"], ["code"]) &&
				isBoundedString(payload.callId, 200) &&
				(payload.code === undefined || isBoundedString(payload.code, 128))
			);
		case "tool.cancelled":
			return (
				sensitivity === "metadata" &&
				hasExactKeys(payload, ["callId"]) &&
				isBoundedString(payload.callId, 200)
			);
	}
}

function optionalContentPayload(
	payload: Record<string, unknown>,
	sensitivity: unknown,
	required: readonly string[],
	contentKey: string,
	contentLimit: number,
): boolean {
	if (
		!hasRequiredAndOptionalKeys(payload, required, [contentKey]) ||
		!required.every((key) => isBoundedString(payload[key], 512))
	) {
		return false;
	}
	const content = payload[contentKey];
	if (sensitivity === "metadata") return content === undefined;
	return (
		sensitivity === "content" &&
		(content === undefined || isBoundedString(content, contentLimit))
	);
}

function isDocumentChangePayload(
	payload: Record<string, unknown>,
	sensitivity: unknown,
	editor: boolean,
): boolean {
	const required = editor
		? [
				"editorId",
				"documentId",
				"insertedChars",
				"deletedChars",
				"burstStartedAtMs",
				"burstEndedAtMs",
			]
		: ["appId", "insertedChars", "deletedChars"];
	const optional = editor
		? ["relativePath", "language", "text"]
		: ["documentId", "text"];
	if (
		!hasRequiredAndOptionalKeys(payload, required, optional) ||
		!isNonNegativeSafeInteger(payload.insertedChars) ||
		!isNonNegativeSafeInteger(payload.deletedChars)
	) {
		return false;
	}
	if (editor) {
		if (
			!isBoundedString(payload.editorId, 256) ||
			!isBoundedString(payload.documentId, 512) ||
			!isNonNegativeSafeInteger(payload.burstStartedAtMs) ||
			!isNonNegativeSafeInteger(payload.burstEndedAtMs) ||
			(payload.burstEndedAtMs as number) <
				(payload.burstStartedAtMs as number) ||
			(payload.burstEndedAtMs as number) -
				(payload.burstStartedAtMs as number) >
				10_000 ||
			(payload.relativePath !== undefined &&
				!isSafeRelativePath(payload.relativePath)) ||
			(payload.language !== undefined &&
				!isBoundedString(payload.language, 128))
		) {
			return false;
		}
	} else if (
		!isBoundedString(payload.appId, 512) ||
		(payload.documentId !== undefined &&
			!isBoundedString(payload.documentId, 512))
	) {
		return false;
	}
	if (sensitivity === "metadata") return payload.text === undefined;
	return (
		sensitivity === "content" &&
		(payload.text === undefined || isBoundedString(payload.text, 4_096))
	);
}

function isProcessList(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= 10_000 &&
		value.every(
			(process) =>
				isRecord(process) &&
				hasExactKeys(process, ["processId", "appId", "appName"]) &&
				isNonNegativeSafeInteger(process.processId) &&
				(process.processId as number) <= 0xffff_ffff &&
				isBoundedString(process.appId, 512) &&
				isBoundedString(process.appName, 512),
		)
	);
}

function isActiveGoalOrNull(value: unknown): boolean {
	return (
		value === null ||
		(isRecord(value) &&
			hasExactKeys(value, [
				"goalId",
				"planId",
				"version",
				"text",
				"activatedAtMs",
			]) &&
			isBoundedString(value.goalId, 200) &&
			(value.planId === null || isBoundedString(value.planId, 200)) &&
			isNonNegativeSafeInteger(value.version) &&
			isBoundedString(value.text, MAX_ACTIVE_GOAL_TEXT_LENGTH) &&
			isNonNegativeSafeInteger(value.activatedAtMs))
	);
}

function isPermissionList(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length >= 1 &&
		value.length <= 32 &&
		value.every(
			(permission) =>
				typeof permission === "string" &&
				(permission === "*" ||
					/^[a-z][a-z0-9.-]{0,127}$/u.test(permission)),
		)
	);
}

function isSafeRelativePath(value: unknown): boolean {
	return (
		isBoundedString(value, 1_024) &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		!value.split("/").some((segment) => segment === "" || segment === "..")
	);
}

function isNonNegativeSafeInteger(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedFiniteNumber(
	value: unknown,
	minimum: number,
	maximum: number,
): boolean {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= minimum &&
		value <= maximum
	);
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maximum &&
		!value.includes("\u0000")
	);
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function hasRequiredAndOptionalKeys(
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
