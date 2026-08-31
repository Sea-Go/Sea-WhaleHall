import { MAX_ACTIVE_GOAL_TEXT_LENGTH } from "../shared/goal-context";
import type {
	ActiveGoalContextV1,
	DesktopEventKind,
	DesktopEventV1,
} from "./reflection/types";
import { isSemanticEventV2 } from "./timeline-v2/contract";
import type { CoverageLevel, SemanticEventV2 } from "./timeline-v2/types";

export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
/** Count bound per byte-bounded native calendar page. */
export const LOCAL_PLANNING_CALENDAR_PAGE_LIMIT = 100;
export const LOCAL_CONTROL_TIMEOUT_MS = 5000;
export const LOCAL_PERMISSION_REFRESH_TIMEOUT_MS = 32_000;
export const LOCAL_KEY_MIGRATION_TIMEOUT_MS = 120_000;
export const LOCAL_TOOL_TIMEOUT_MS = 30_000;

const localProtocolUtf8Encoder = new TextEncoder();

/** Matches SQLite BINARY ordering for the UTF-8 planning identifiers on disk. */
export function compareLocalUtf8Binary(left: string, right: string): number {
	const leftBytes = localProtocolUtf8Encoder.encode(left);
	const rightBytes = localProtocolUtf8Encoder.encode(right);
	const sharedLength = Math.min(leftBytes.length, rightBytes.length);
	for (let index = 0; index < sharedLength; index += 1) {
		const leftByte = leftBytes[index];
		const rightByte = rightBytes[index];
		if (leftByte === undefined || rightByte === undefined) break;
		const difference = leftByte - rightByte;
		if (difference !== 0) return difference;
	}
	return leftBytes.length - rightBytes.length;
}

export type LocalMethod =
	| "runtime.health"
	| "tool.list"
	| "tool.call"
	| "tool.cancel"
	| "event.query"
	| "event.tailCursor"
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
	| "vault.deleteBatch"
	| "vault.listRecords"
	| "vault.status"
	| "vault.migrateLegacyKey"
	| "planning.list"
	| "planning.get"
	| "planning.operation.get"
	| "planning.upsert"
	| "planning.mutate"
	| "planning.vaultReferences"
	| "calendar.list"
	| "calendar.get"
	| "calendar.mutate"
	| "planning.outbox.list"
	| "planning.outbox.ack";

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
	details?: Record<string, unknown>;
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

export type LocalEventTailCursorResult = {
	cursor: string;
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
	tapReady: boolean;
	lastCallbackAtMs: number | null;
	lastBucketAtMs: number | null;
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

export type LocalVaultDeleteBatch = {
	namespace: string;
	recordIds: string[];
};

export type LocalVaultDeleteResultRecord = {
	recordId: string;
	deleted: boolean;
};

export type LocalVaultDeleteBatchResult = {
	records: LocalVaultDeleteResultRecord[];
};

export type LocalVaultListRecords = {
	namespace: string;
	createdBeforeMs: number;
	cursor?: string | null;
	limit?: number;
};

export type LocalVaultInventoryRecord = {
	recordId: string;
	schemaVersion: string;
	contentRef: string;
	createdAtMs: number;
	expiresAtMs: number | null;
};

export type LocalVaultListRecordsResult = {
	records: LocalVaultInventoryRecord[];
	nextCursor: string | null;
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

/**
 * Versioned aggregate stored by whalehall-local. The native protocol validates
 * every product field; Bun keeps this boundary open to forward-compatible
 * aggregate additions while still validating identity and version metadata.
 */
export type LocalPlanningPlanSnapshot = Record<string, unknown> & {
	schemaVersion: "planning.v1";
	planId: string;
	version: number;
};

export type LocalPlanningList = {
	statuses?: Array<
		| "draft"
		| "awaiting-confirmation"
		| "active"
		| "paused"
		| "completed"
		| "archived"
	>;
	limit?: number;
};

export type LocalPlanningListResult = {
	plans: LocalPlanningPlanSnapshot[];
};

export type LocalPlanningVaultReferences = {
	cursor?: string | null;
	limit?: number;
};

export type LocalPlanningVaultReference = {
	source: "current" | "history" | "operation";
	planId: string;
	version: number;
	sealedContentRef: string;
	manifestRecordId: string | null;
};

export type LocalPlanningVaultReferencesResult = {
	references: LocalPlanningVaultReference[];
	nextCursor: string | null;
};

export type LocalPlanningGetResult = {
	plan: LocalPlanningPlanSnapshot | null;
};

export type LocalPlanningOperationGetResult = {
	operationId: string;
	method:
		| "planning.upsert"
		| "planning.mutate"
		| "calendar.mutate"
		| "planning.outbox.ack"
		| null;
	plan: LocalPlanningPlanSnapshot | null;
	result: Record<string, unknown> | null;
};

export type LocalPlanningOutboxDraft = {
	entryId: string;
	kind: "plan-changed" | "calendar-changed" | "notification";
	aggregateId: string;
	payload: Record<string, unknown>;
	createdAtMs: number;
};

export type LocalPlanningCalendarSchedule =
	| { allDay: false; start: string; end: string; timeZone: string }
	| { allDay: true; startDate: string; endDateExclusive: string };

export const LOCAL_REDACTED_PLAN_CALENDAR_TITLE = "计划任务";

export type LocalPlanningCalendarEvent = {
	schemaVersion: "calendar.v1";
	eventId: string;
	title: string;
	sealedContentRef: string | null;
	redactedContent: boolean;
	kind: "plan" | "manual-block" | "external" | "break";
	state: "proposed" | "committed";
	schedule: LocalPlanningCalendarSchedule;
	recurrence: {
		seriesId: string;
		rrule: string;
		timeZone: string;
		exceptionDates: string[];
	} | null;
	occurrenceId: string | null;
	sourcePlanId: string | null;
	sourceTaskId: string | null;
	scheduleOrigin: "model" | "user" | null;
	userLocked: boolean;
	editable: boolean;
	version: number;
};

export type LocalPlanningOutboxEntry = LocalPlanningOutboxDraft & {
	status: "pending" | "delivered";
	deliveredAtMs: number | null;
};

export type LocalPlanningMutationParams = {
	operationId: string;
	expectedVersion?: number | null;
	plan: LocalPlanningPlanSnapshot;
	calendarEvents?: LocalPlanningCalendarEvent[] | null;
	outbox?: LocalPlanningOutboxDraft[];
};

export type LocalPlanningMutationResult = {
	plan: LocalPlanningPlanSnapshot;
	calendarEvents: LocalPlanningCalendarEvent[];
	outbox: LocalPlanningOutboxEntry[];
};

export type LocalPlanningCalendarList = {
	sourcePlanId?: string;
	sourceTaskId?: string;
	fromDate?: string;
	toDateExclusive?: string;
	cursor?: string;
	limit?: number;
};

export type LocalPlanningCalendarListResult = {
	events: LocalPlanningCalendarEvent[];
	nextCursor: string | null;
};

export type LocalPlanningCalendarMutation =
	| {
			action: "upsert";
			expectedVersion?: number | null;
			event: LocalPlanningCalendarEvent;
	  }
	| { action: "delete"; eventId: string; expectedVersion: number };

export type LocalPlanningCalendarMutate = {
	operationId: string;
	actor?: "user" | "planning-runtime";
	mutations: LocalPlanningCalendarMutation[];
	outbox?: LocalPlanningOutboxDraft[];
};

export type LocalPlanningCalendarMutationResult = {
	outcomes: Array<{
		eventId: string;
		event: LocalPlanningCalendarEvent | null;
	}>;
	outbox: LocalPlanningOutboxEntry[];
};

export type LocalPlanningOutboxList = {
	status?: "pending" | "delivered";
	limit?: number;
};

export type LocalPlanningOutboxListResult = {
	entries: LocalPlanningOutboxEntry[];
};

export type LocalPlanningOutboxAck = {
	operationId: string;
	entryIds: string[];
	deliveredAtMs: number;
};

export type LocalPlanningOutboxAckResult = {
	entries: LocalPlanningOutboxEntry[];
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
	if (!isRecord(value))
		throw new Error("Local protocol message must be an object.");

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
		typeof value.error.message !== "string" ||
		("details" in value.error && !isRecord(value.error.details))
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
		(query === undefined || (fromMs === query.fromMs && toMs === query.toMs)) &&
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
		(value.expiresAtMs === null || isNonNegativeSafeInteger(value.expiresAtMs))
	);
}

export function isLocalVaultDeleteResultRecord(
	value: unknown,
): value is LocalVaultDeleteResultRecord {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["recordId", "deleted"]) &&
		isProtocolIdentifier(value.recordId, 256) &&
		typeof value.deleted === "boolean"
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

export function isLocalPlanningPlanSnapshot(
	value: unknown,
): value is LocalPlanningPlanSnapshot {
	return (
		isRecord(value) &&
		value.schemaVersion === "planning.v1" &&
		isProtocolIdentifier(value.planId, 256) &&
		isPositiveSafeInteger(value.version)
	);
}

export function isLocalPlanningCalendarEvent(
	value: unknown,
): value is LocalPlanningCalendarEvent {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schemaVersion",
			"eventId",
			"title",
			"sealedContentRef",
			"redactedContent",
			"kind",
			"state",
			"schedule",
			"recurrence",
			"occurrenceId",
			"sourcePlanId",
			"sourceTaskId",
			"scheduleOrigin",
			"userLocked",
			"editable",
			"version",
		]) ||
		value.schemaVersion !== "calendar.v1" ||
		!isProtocolIdentifier(value.eventId, 256) ||
		!isBoundedString(value.title, 100_000) ||
		!isNullableProtocolIdentifier(value.sealedContentRef, 256) ||
		typeof value.redactedContent !== "boolean" ||
		!(
			value.kind === "plan" ||
			value.kind === "manual-block" ||
			value.kind === "external" ||
			value.kind === "break"
		) ||
		!(value.state === "proposed" || value.state === "committed") ||
		!isRecord(value.schedule) ||
		typeof value.schedule.allDay !== "boolean" ||
		!isLocalPlanningCalendarRecurrence(value.recurrence) ||
		!isNullableProtocolIdentifier(value.occurrenceId, 256) ||
		!isNullableProtocolIdentifier(value.sourcePlanId, 256) ||
		!isNullableProtocolIdentifier(value.sourceTaskId, 256) ||
		!(
			value.scheduleOrigin === null ||
			value.scheduleOrigin === "model" ||
			value.scheduleOrigin === "user"
		) ||
		typeof value.userLocked !== "boolean" ||
		typeof value.editable !== "boolean" ||
		!isPositiveSafeInteger(value.version)
	) {
		return false;
	}
	const contentIsProtected =
		value.sealedContentRef !== null || value.redactedContent;
	if (
		(contentIsProtected &&
			value.title !== LOCAL_REDACTED_PLAN_CALENDAR_TITLE) ||
		(value.scheduleOrigin === "model" && !contentIsProtected) ||
		(value.sourceTaskId !== null && value.sourcePlanId === null) ||
		(value.occurrenceId !== null && value.recurrence === null) ||
		(value.kind === "external" && value.editable) ||
		(value.kind === "plan"
			? value.sourcePlanId === null ||
				value.sourceTaskId === null ||
				value.scheduleOrigin === null
			: value.sourcePlanId !== null ||
				value.sourceTaskId !== null ||
				value.scheduleOrigin !== null ||
				value.userLocked)
	) {
		return false;
	}
	if (value.schedule.allDay) {
		return (
			hasExactKeys(value.schedule, [
				"allDay",
				"startDate",
				"endDateExclusive",
			]) &&
			isCanonicalProtocolDate(value.schedule.startDate) &&
			isCanonicalProtocolDate(value.schedule.endDateExclusive) &&
			value.schedule.startDate < value.schedule.endDateExclusive
		);
	}
	return (
		hasExactKeys(value.schedule, ["allDay", "start", "end", "timeZone"]) &&
		isBoundedString(value.schedule.start, 80) &&
		isBoundedString(value.schedule.end, 80) &&
		isBoundedString(value.schedule.timeZone, 128) &&
		validOrderedProtocolInstants(value.schedule.start, value.schedule.end)
	);
}

export function isLocalPlanningOutboxEntry(
	value: unknown,
): value is LocalPlanningOutboxEntry {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"entryId",
			"kind",
			"aggregateId",
			"payload",
			"status",
			"createdAtMs",
			"deliveredAtMs",
		]) ||
		!isProtocolIdentifier(value.entryId, 256) ||
		!(
			value.kind === "plan-changed" ||
			value.kind === "calendar-changed" ||
			value.kind === "notification"
		) ||
		!isProtocolIdentifier(value.aggregateId, 256) ||
		!isRecord(value.payload) ||
		!isLocalPlanningOutboxPayload(
			value.kind,
			value.aggregateId,
			value.payload,
		) ||
		!(value.status === "pending" || value.status === "delivered") ||
		!isNonNegativeSafeInteger(value.createdAtMs) ||
		!(
			value.deliveredAtMs === null ||
			isNonNegativeSafeInteger(value.deliveredAtMs)
		) ||
		(value.status === "pending"
			? value.deliveredAtMs !== null
			: value.deliveredAtMs === null)
	) {
		return false;
	}
	return true;
}

function isLocalPlanningCalendarRecurrence(value: unknown): boolean {
	return (
		value === null ||
		(isRecord(value) &&
			hasExactKeys(value, [
				"seriesId",
				"rrule",
				"timeZone",
				"exceptionDates",
			]) &&
			isProtocolIdentifier(value.seriesId, 256) &&
			isBoundedString(value.rrule, 8_192) &&
			isBoundedString(value.timeZone, 128) &&
			Array.isArray(value.exceptionDates) &&
			value.exceptionDates.length <= 10_000 &&
			value.exceptionDates.every(isCanonicalProtocolDate))
	);
}

function isLocalPlanningOutboxPayload(
	kind: LocalPlanningOutboxEntry["kind"],
	aggregateId: string,
	payload: Record<string, unknown>,
): boolean {
	if (kind === "plan-changed") {
		return (
			hasExactKeys(payload, ["planId", "version"]) &&
			payload.planId === aggregateId &&
			isPositiveSafeInteger(payload.version)
		);
	}
	if (kind === "calendar-changed") {
		if (hasExactKeys(payload, ["changeSetId", "planId"])) {
			return (
				isProtocolIdentifier(payload.changeSetId, 256) &&
				payload.planId === aggregateId
			);
		}
		return (
			hasExactKeys(payload, [
				"batchId",
				"mutationCount",
				"planIds",
				"requiresPlanningReestimate",
			]) &&
			isProtocolIdentifier(payload.batchId, 256) &&
			isPositiveSafeInteger(payload.mutationCount) &&
			Array.isArray(payload.planIds) &&
			payload.planIds.length <= 10_000 &&
			payload.planIds.every((planId) => isProtocolIdentifier(planId, 256)) &&
			typeof payload.requiresPlanningReestimate === "boolean"
		);
	}
	const allowed = new Set([
		"code",
		"planId",
		"version",
		"adjustmentId",
		"added",
		"moved",
		"cancelled",
		"unscheduled",
		"etaChanged",
	]);
	return (
		Object.keys(payload).length > 0 &&
		Object.keys(payload).every((key) => allowed.has(key)) &&
		isProtocolIdentifier(payload.code, 256) &&
		(payload.planId === undefined ||
			isProtocolIdentifier(payload.planId, 256)) &&
		(payload.adjustmentId === undefined ||
			isProtocolIdentifier(payload.adjustmentId, 256)) &&
		["version", "added", "moved", "cancelled", "unscheduled"].every(
			(key) =>
				payload[key] === undefined || isNonNegativeSafeInteger(payload[key]),
		) &&
		(payload.etaChanged === undefined ||
			typeof payload.etaChanged === "boolean")
	);
}

function validOrderedProtocolInstants(start: string, end: string): boolean {
	const rfc3339 =
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
	if (!rfc3339.test(start) || !rfc3339.test(end)) return false;
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < endMs;
}

function isCanonicalProtocolDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
		return false;
	}
	const parsed = new Date(`${value}T00:00:00Z`);
	return (
		Number.isFinite(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}

function isNullableProtocolIdentifier(
	value: unknown,
	maximumLength: number,
): boolean {
	return value === null || isProtocolIdentifier(value, maximumLength);
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
			"tapReady",
			"lastCallbackAtMs",
			"lastBucketAtMs",
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
		new Set(value.excludedBundleIds).size !== value.excludedBundleIds.length ||
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
		typeof value.tapReady !== "boolean" ||
		!isNullableHealthTimestamp(
			value.lastCallbackAtMs,
			value.lastHeartbeatAtMs,
		) ||
		!isNullableHealthTimestamp(value.lastBucketAtMs, value.lastHeartbeatAtMs) ||
		(value.tapReady &&
			(value.state !== "running" ||
				value.helperPid === null ||
				value.bootId === null)) ||
		!isMonitoringPermissions(value.permissions) ||
		!isMonitoringPermissionCheckState(value.permissionCheckState) ||
		!isNullableNonNegativeSafeInteger(value.permissionsCheckedAtMs) ||
		typeof value.permissionSetupAvailable !== "boolean" ||
		typeof value.permissionSetupAttempted !== "boolean" ||
		(value.permissionSetupAttempted && !value.permissionSetupAvailable) ||
		(value.permissionCheckState === "unchecked" &&
			value.permissionsCheckedAtMs !== null) ||
		(value.permissionCheckState === "current" &&
			value.permissionsCheckedAtMs === null) ||
		!Array.isArray(value.coverage) ||
		value.coverage.length > 5 ||
		!value.coverage.every(isCoverageLevel) ||
		new Set(value.coverage).size !== value.coverage.length ||
		!(value.lastError === null || isBoundedString(value.lastError, 2_048))
	) {
		return false;
	}
	return true;
}

function isNullableHealthTimestamp(
	value: unknown,
	frameTimestamp: unknown,
): boolean {
	if (value === null) return true;
	return (
		isNonNegativeSafeInteger(value) &&
		isNonNegativeSafeInteger(frameTimestamp) &&
		(value as number) <= (frameTimestamp as number)
	);
}

export function isLocalMonitoringConfigure(
	value: unknown,
): value is LocalMonitoringConfigure {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["enabled", "captureContent", "excludedBundleIds"]) &&
		typeof value.enabled === "boolean" &&
		typeof value.captureContent === "boolean" &&
		Array.isArray(value.excludedBundleIds) &&
		value.excludedBundleIds.length <= 256 &&
		value.excludedBundleIds.every(isMonitoringBundleId) &&
		new Set(value.excludedBundleIds).size === value.excludedBundleIds.length
	);
}

export function isLocalToolDescriptor(
	value: unknown,
): value is LocalToolDescriptor {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		isRecord(value.inputSchema) &&
		(value.risk === "read" ||
			value.risk === "write" ||
			value.risk === "control") &&
		Array.isArray(value.requiredPermissions) &&
		value.requiredPermissions.every(
			(permission) => typeof permission === "string",
		) &&
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
	// Retained so journals created by the retired VS Code bridge remain readable.
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
	"authorization.changed",
	"reflection.completed",
	"reflection.failed",
	"tool.started",
	"tool.progress",
	"tool.completed",
	"tool.failed",
	"tool.cancelled",
	"system.heartbeat",
	"system.cursorCheckpoint",
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

function containsMatchingField(
	value: unknown,
	fields: ReadonlySet<string>,
): boolean {
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
		case "input.activityAggregated": {
			const coalescedBucketCount =
				payload.coalescedBucketCount === undefined
					? 1
					: payload.coalescedBucketCount;
			return (
				sensitivity === "metadata" &&
				hasRequiredAndOptionalKeys(
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
				isNonNegativeSafeInteger(payload.bucketStartedAtMs) &&
				isNonNegativeSafeInteger(payload.bucketEndedAtMs) &&
				(payload.coalescedBucketCount === undefined ||
					(isNonNegativeSafeInteger(payload.coalescedBucketCount) &&
						(payload.coalescedBucketCount as number) >= 2 &&
						(payload.coalescedBucketCount as number) <= 256)) &&
				(payload.bucketEndedAtMs as number) -
					(payload.bucketStartedAtMs as number) ===
					(coalescedBucketCount as number) * 5_000 &&
				isNonNegativeSafeInteger(payload.keyCount) &&
				isNonNegativeSafeInteger(payload.clickCount) &&
				isBoundedFiniteNumber(payload.scrollDelta, -1e12, 1e12) &&
				isBoundedFiniteNumber(payload.mouseDistance, 0, 1e12)
			);
		}
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
		case "authorization.changed":
		case "system.cursorCheckpoint":
			return sensitivity === "metadata" && hasExactKeys(payload, []);
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
		: ["documentId", "text", "textChangeObserved"];
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
			!isBoundedString(payload.documentId, 512)) ||
		(payload.textChangeObserved !== undefined &&
			typeof payload.textChangeObserved !== "boolean")
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
				(permission === "*" || /^[a-z][a-z0-9.-]{0,127}$/u.test(permission)),
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

function isPositiveSafeInteger(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) > 0;
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
