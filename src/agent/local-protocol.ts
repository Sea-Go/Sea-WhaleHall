import type {
	ActiveGoalContextV1,
	DesktopEventKind,
	DesktopEventV1,
} from "./reflection/types";
import { MAX_ACTIVE_GOAL_TEXT_LENGTH } from "../shared/goal-context";
import { isSemanticEventV2 } from "./timeline-v2/contract";
import type {
	CoverageLevel,
	SemanticEventV2,
} from "./timeline-v2/types";

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const LOCAL_CONTROL_TIMEOUT_MS = 5000;
export const LOCAL_PERMISSION_REFRESH_TIMEOUT_MS = 32_000;
export const LOCAL_KEY_MIGRATION_TIMEOUT_MS = 120_000;
export const LOCAL_TOOL_TIMEOUT_MS = 30_000;

export type LocalMethod =
	| "runtime.health"
	| "tool.list"
	| "tool.call"
	| "tool.cancel"
	| "event.query"
	| "event.commit"
	| "event.goal.change"
	| "monitoring.status"
	| "monitoring.configure"
	| "monitoring.pause"
	| "monitoring.resume"
	| "monitoring.refreshPermissions"
	| "monitoring.setupPermissions"
	| "semantic.query"
	| "semantic.commit"
	| "audit.queryFiveMinutes"
	| "vault.sealBatch"
	| "vault.openBatch"
	| "vault.status"
	| "vault.migrateLegacyKey";

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

export type LocalSemanticEventFrame = {
	event: "semantic.event";
	data: SemanticEventV2;
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

export type LocalMonitoringState =
	| "disabled"
	| "starting"
	| "running"
	| "paused"
	| "degraded"
	| "stopped";

export type LocalMonitoringPermissionState =
	| "unknown"
	| "granted"
	| "denied"
	| "not_determined"
	| "unsupported";

export type LocalMonitoringPermissionCheckState =
	| "unchecked"
	| "checking"
	| "current"
	| "failed";

export type LocalMonitoringPermissions = {
	accessibility: LocalMonitoringPermissionState;
	screenRecording: LocalMonitoringPermissionState;
	inputMonitoring: LocalMonitoringPermissionState;
	automation: LocalMonitoringPermissionState;
};

export type LocalMonitoringStatus = {
	state: LocalMonitoringState;
	enabled: boolean;
	captureContent: boolean;
	excludedBundleIds: string[];
	helperPid: number | null;
	helperPathAvailable: boolean;
	bootId: string | null;
	lastSequence: number | null;
	lastAckedSequence: number | null;
	lastHeartbeatAtMs: number | null;
	permissions: LocalMonitoringPermissions;
	permissionCheckState: LocalMonitoringPermissionCheckState;
	permissionsCheckedAtMs: number | null;
	permissionSetupAvailable: boolean;
	permissionSetupAttempted: boolean;
	coverage: CoverageLevel[];
	lastError: string | null;
};

export type LocalMonitoringConfigure = {
	enabled: boolean;
	captureContent: boolean;
	excludedBundleIds: string[];
};

export type LocalSemanticQuery = {
	afterCursor?: string;
	consumerId?: string;
	limit?: number;
	includeContent?: boolean;
};

export type LocalSemanticQueryResult = {
	events: SemanticEventV2[];
	nextCursor: string | null;
	hasMore: boolean;
};

export type LocalSemanticCommitResult = {
	consumerId: string;
	cursor: string;
	advanced: boolean;
};

export type LocalAuditFiveMinutesQuery = {
	fromMs: number;
	toMs: number;
	includeDecryptedContent?: boolean;
};

export type LocalAuditFiveMinutesResult = {
	fromMs: number;
	toMs: number;
	permissions: LocalMonitoringPermissions;
	coverage: CoverageLevel[];
	rawObservations: unknown[];
	semanticEvents: SemanticEventV2[];
};

export type LocalVaultSealRecord = {
	recordId: string;
	schemaVersion: string;
	content: unknown;
	expiresAtMs?: number | null;
};

export type LocalVaultSealBatch = {
	namespace: string;
	records: LocalVaultSealRecord[];
};

export type LocalVaultSealResultRecord = {
	recordId: string;
	contentRef: string;
	contentHash: string;
	keyVersion: string;
	inserted: boolean;
};

export type LocalVaultSealBatchResult = {
	records: LocalVaultSealResultRecord[];
};

export type LocalVaultOpenBatch = {
	namespace: string;
	contentRefs: string[];
};

export type LocalVaultOpenResultRecord = {
	recordId: string;
	schemaVersion: string;
	contentRef: string;
	contentHash: string;
	content: unknown;
	createdAtMs: number;
	expiresAtMs: number | null;
};

export type LocalVaultOpenBatchResult = {
	records: LocalVaultOpenResultRecord[];
};

export type LocalVaultKeyAvailability =
	| "available"
	| "migration_required"
	| "unavailable";

export type LocalVaultKeyStorageMode =
	| "data_protection_keychain"
	| "local_login_keychain"
	| "legacy_development_keychain"
	| "custom";

export type LocalVaultKeyStatus = {
	availability: LocalVaultKeyAvailability;
	storageMode: LocalVaultKeyStorageMode | null;
	keyVersion: string | null;
	interactiveMigrationAvailable: boolean;
};

export type LocalVaultLegacyMigrationResult = {
	migrated: boolean;
	status: LocalVaultKeyStatus;
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

export type LocalMessage =
	| LocalResponse
	| LocalToolEvent
	| LocalDesktopEventFrame
	| LocalSemanticEventFrame;

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

	if (value.event === "semantic.event") {
		if (!isSemanticEventV2(value.data)) {
			throw new Error("Semantic event frame has an invalid shape.");
		}
		return value as LocalSemanticEventFrame;
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

export function isLocalAuditFiveMinutesResult(
	value: unknown,
	query?: LocalAuditFiveMinutesQuery,
): value is LocalAuditFiveMinutesResult {
	if (!isRecord(value)) return false;
	const fromMs = value.fromMs;
	const toMs = value.toMs;
	return (
		typeof fromMs === "number" &&
		Number.isSafeInteger(fromMs) &&
		fromMs >= 0 &&
		typeof toMs === "number" &&
		Number.isSafeInteger(toMs) &&
		toMs >= 0 &&
		toMs - fromMs === 300_000 &&
		(query === undefined ||
			(fromMs === query.fromMs && toMs === query.toMs)) &&
		isMonitoringPermissions(value.permissions) &&
		Array.isArray(value.coverage) &&
		value.coverage.every(isCoverageLevel) &&
		Array.isArray(value.rawObservations) &&
		Array.isArray(value.semanticEvents) &&
		value.semanticEvents.every(isSemanticEventV2)
	);
}

export function isLocalVaultSealResultRecord(
	value: unknown,
): value is LocalVaultSealResultRecord {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"recordId",
			"contentRef",
			"contentHash",
			"keyVersion",
			"inserted",
		]) &&
		isProtocolIdentifier(value.recordId, 256) &&
		isProtocolIdentifier(value.contentRef, 512) &&
		isProtocolIdentifier(value.contentHash, 256) &&
		isProtocolIdentifier(value.keyVersion, 128) &&
		typeof value.inserted === "boolean"
	);
}

export function isLocalVaultOpenResultRecord(
	value: unknown,
): value is LocalVaultOpenResultRecord {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"recordId",
			"schemaVersion",
			"contentRef",
			"contentHash",
			"content",
			"createdAtMs",
			"expiresAtMs",
		]) &&
		isProtocolIdentifier(value.recordId, 256) &&
		isProtocolIdentifier(value.schemaVersion, 160) &&
		isProtocolIdentifier(value.contentRef, 512) &&
		isProtocolIdentifier(value.contentHash, 256) &&
		isNonNegativeSafeInteger(value.createdAtMs) &&
		(value.expiresAtMs === null ||
			isNonNegativeSafeInteger(value.expiresAtMs))
	);
}

export function isLocalVaultKeyStatus(
	value: unknown,
): value is LocalVaultKeyStatus {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"availability",
			"storageMode",
			"keyVersion",
			"interactiveMigrationAvailable",
		]) &&
		(value.availability === "available" ||
			value.availability === "migration_required" ||
			value.availability === "unavailable") &&
		(value.storageMode === null ||
			value.storageMode === "data_protection_keychain" ||
			value.storageMode === "local_login_keychain" ||
			value.storageMode === "legacy_development_keychain" ||
			value.storageMode === "custom") &&
		(value.keyVersion === null ||
			isProtocolIdentifier(value.keyVersion, 128)) &&
		typeof value.interactiveMigrationAvailable === "boolean" &&
		(value.availability !== "available" ||
			(value.storageMode !== null && value.keyVersion !== null))
	);
}

export function isLocalVaultLegacyMigrationResult(
	value: unknown,
): value is LocalVaultLegacyMigrationResult {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["migrated", "status"]) &&
		typeof value.migrated === "boolean" &&
		isLocalVaultKeyStatus(value.status)
	);
}

export function isLocalMonitoringStatus(
	value: unknown,
): value is LocalMonitoringStatus {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"state",
			"enabled",
			"captureContent",
			"excludedBundleIds",
			"helperPid",
			"helperPathAvailable",
			"bootId",
			"lastSequence",
			"lastAckedSequence",
			"lastHeartbeatAtMs",
			"permissions",
			"permissionCheckState",
			"permissionsCheckedAtMs",
			"permissionSetupAvailable",
			"permissionSetupAttempted",
			"coverage",
			"lastError",
		]) ||
		!isMonitoringState(value.state) ||
		typeof value.enabled !== "boolean" ||
		typeof value.captureContent !== "boolean" ||
		!Array.isArray(value.excludedBundleIds) ||
		value.excludedBundleIds.length > 256 ||
		!value.excludedBundleIds.every(isMonitoringBundleId) ||
		new Set(value.excludedBundleIds).size !==
			value.excludedBundleIds.length ||
		!(
			value.helperPid === null ||
			(isNonNegativeSafeInteger(value.helperPid) &&
				(value.helperPid as number) >= 1 &&
				(value.helperPid as number) <= 0xffff_ffff)
		) ||
		typeof value.helperPathAvailable !== "boolean" ||
		!(
			value.bootId === null ||
			(typeof value.bootId === "string" &&
				/^[A-Za-z0-9-]{1,128}$/u.test(value.bootId))
		) ||
		!isNullableNonNegativeSafeInteger(value.lastSequence) ||
		!isNullableNonNegativeSafeInteger(value.lastAckedSequence) ||
		!isNullableNonNegativeSafeInteger(value.lastHeartbeatAtMs) ||
		!isMonitoringPermissions(value.permissions) ||
		!isMonitoringPermissionCheckState(value.permissionCheckState) ||
		!isNullableNonNegativeSafeInteger(value.permissionsCheckedAtMs) ||
		typeof value.permissionSetupAvailable !== "boolean" ||
		typeof value.permissionSetupAttempted !== "boolean" ||
		(value.permissionSetupAttempted &&
			!value.permissionSetupAvailable) ||
		(value.permissionCheckState === "unchecked" &&
			value.permissionsCheckedAtMs !== null) ||
		(value.permissionCheckState === "current" &&
			value.permissionsCheckedAtMs === null) ||
		!Array.isArray(value.coverage) ||
		value.coverage.length > 5 ||
		!value.coverage.every(isCoverageLevel) ||
		new Set(value.coverage).size !== value.coverage.length ||
		!(
			value.lastError === null ||
			isBoundedString(value.lastError, 2_048)
		)
	) {
		return false;
	}
	return true;
}

export function isLocalMonitoringConfigure(
	value: unknown,
): value is LocalMonitoringConfigure {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"enabled",
			"captureContent",
			"excludedBundleIds",
		]) &&
		typeof value.enabled === "boolean" &&
		typeof value.captureContent === "boolean" &&
		Array.isArray(value.excludedBundleIds) &&
		value.excludedBundleIds.length <= 256 &&
		value.excludedBundleIds.every(isMonitoringBundleId) &&
		new Set(value.excludedBundleIds).size ===
			value.excludedBundleIds.length
	);
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

function isMonitoringState(value: unknown): value is LocalMonitoringState {
	return (
		value === "disabled" ||
		value === "starting" ||
		value === "running" ||
		value === "paused" ||
		value === "degraded" ||
		value === "stopped"
	);
}

function isMonitoringPermissionState(
	value: unknown,
): value is LocalMonitoringPermissionState {
	return (
		value === "unknown" ||
		value === "granted" ||
		value === "denied" ||
		value === "not_determined" ||
		value === "unsupported"
	);
}

function isMonitoringPermissionCheckState(
	value: unknown,
): value is LocalMonitoringPermissionCheckState {
	return (
		value === "unchecked" ||
		value === "checking" ||
		value === "current" ||
		value === "failed"
	);
}

function isMonitoringPermissions(
	value: unknown,
): value is LocalMonitoringPermissions {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"accessibility",
			"screenRecording",
			"inputMonitoring",
			"automation",
		]) &&
		isMonitoringPermissionState(value.accessibility) &&
		isMonitoringPermissionState(value.screenRecording) &&
		isMonitoringPermissionState(value.inputMonitoring) &&
		isMonitoringPermissionState(value.automation)
	);
}

function isMonitoringBundleId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		new TextEncoder().encode(value).byteLength <= 256 &&
		/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(value)
	);
}

function isCoverageLevel(value: unknown): value is CoverageLevel {
	return (
		value === "content" ||
		value === "metadata" ||
		value === "redacted" ||
		value === "denied" ||
		value === "unavailable"
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

function isNullableNonNegativeSafeInteger(value: unknown): boolean {
	return value === null || isNonNegativeSafeInteger(value);
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

function isProtocolIdentifier(
	value: unknown,
	maximum: number,
): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maximum &&
		/^[A-Za-z0-9._:@/-]+$/u.test(value)
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
