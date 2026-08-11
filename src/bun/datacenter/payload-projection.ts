/**
 * Client-side mirror of the DataCenter desktop-event metadata allowlist.
 * Local metadata payloads are projected to exactly the allowed keys before
 * upload; extra sensitive fields (windowTitle, url, title, text,
 * relativePath, ...) are never uploaded.
 */

export type MetadataKindSchema = {
	required: readonly string[];
	optional: readonly string[];
};

const METADATA_KIND_SCHEMA: Readonly<Record<string, MetadataKindSchema>> = {
	"application.processObservedBatch": {
		required: ["started", "exited"],
		optional: [],
	},
	"application.foregroundChanged": {
		required: ["appId", "appName"],
		optional: [],
	},
	"browser.tabOpened": { required: ["browserId", "tabId"], optional: [] },
	"browser.tabNavigated": { required: ["browserId", "tabId"], optional: [] },
	"browser.tabClosed": { required: ["browserId", "tabId"], optional: [] },
	"accessibility.focusChanged": {
		required: ["appId", "role"],
		optional: [],
	},
	"accessibility.valueChanged": {
		required: ["appId", "role"],
		optional: [],
	},
	"accessibility.documentChanged": {
		required: ["appId", "insertedChars", "deletedChars"],
		optional: ["documentId"],
	},
	"editor.documentChanged": {
		required: [
			"editorId",
			"documentId",
			"insertedChars",
			"deletedChars",
			"burstStartedAtMs",
			"burstEndedAtMs",
		],
		optional: ["language"],
	},
	"input.activityAggregated": {
		required: [
			"bucketStartedAtMs",
			"bucketEndedAtMs",
			"keyCount",
			"clickCount",
			"scrollDelta",
			"mouseDistance",
		],
		optional: [],
	},
	"presence.afkStarted": { required: ["idleForMs"], optional: [] },
	"presence.afkEnded": { required: ["idleForMs"], optional: [] },
	"presence.locked": { required: [], optional: [] },
	"presence.unlocked": { required: [], optional: [] },
	"presence.sleep": { required: [], optional: [] },
	"presence.wake": { required: [], optional: [] },
	"authorization.revoked": { required: ["permissions"], optional: [] },
	"authorization.granted": { required: ["permissions"], optional: [] },
	"reflection.completed": { required: ["windowId"], optional: [] },
	"reflection.failed": { required: ["windowId", "code"], optional: [] },
	"tool.started": { required: ["callId"], optional: ["name"] },
	"tool.completed": { required: ["callId"], optional: ["name"] },
	"tool.progress": { required: ["callId"], optional: ["progress"] },
	"tool.failed": { required: ["callId"], optional: ["code"] },
	"tool.cancelled": { required: ["callId"], optional: [] },
	"system.heartbeat": { required: [], optional: [] },
};

export type MetadataProjectionResult =
	| { ok: true; payload: Record<string, unknown> }
	| { ok: false; reason: string };

export function projectMetadataPayload(
	kind: string,
	payload: unknown,
): MetadataProjectionResult {
	const schema = METADATA_KIND_SCHEMA[kind];
	if (schema === undefined) {
		return { ok: false, reason: `kind not uploadable as metadata: ${kind}` };
	}
	if (!isRecord(payload)) {
		return { ok: false, reason: "metadata payload must be an object" };
	}

	const projected: Record<string, unknown> = {};
	for (const key of [...schema.required, ...schema.optional]) {
		if (Object.prototype.hasOwnProperty.call(payload, key)) {
			projected[key] = payload[key];
		}
	}

	for (const key of schema.required) {
		if (!Object.prototype.hasOwnProperty.call(projected, key)) {
			return { ok: false, reason: `metadata payload missing required field: ${key}` };
		}
		if (!isValidField(kind, key, projected[key])) {
			return { ok: false, reason: `metadata payload field is invalid: ${key}` };
		}
	}

	// Optional fields that are present but invalid are dropped rather than
	// failing the whole event (the server treats them as absent).
	for (const key of schema.optional) {
		if (
			Object.prototype.hasOwnProperty.call(projected, key) &&
			!isValidField(kind, key, projected[key])
		) {
			delete projected[key];
		}
	}

	const orderingError = validateOrdering(kind, projected);
	if (orderingError !== null) {
		return { ok: false, reason: orderingError };
	}

	return { ok: true, payload: projected };
}

function validateOrdering(
	kind: string,
	payload: Record<string, unknown>,
): string | null {
	if (kind === "editor.documentChanged") {
		const started = payload.burstStartedAtMs;
		const ended = payload.burstEndedAtMs;
		if (
			typeof started === "number" &&
			typeof ended === "number" &&
			ended < started
		) {
			return "burstEndedAtMs must not be before burstStartedAtMs";
		}
	}
	if (kind === "input.activityAggregated") {
		const started = payload.bucketStartedAtMs;
		const ended = payload.bucketEndedAtMs;
		if (
			typeof started === "number" &&
			typeof ended === "number" &&
			ended < started
		) {
			return "bucketEndedAtMs must not be before bucketStartedAtMs";
		}
	}
	return null;
}

export function hasMetadataSchema(kind: string): boolean {
	return kind in METADATA_KIND_SCHEMA;
}

function isValidField(kind: string, key: string, value: unknown): boolean {
	switch (key) {
		case "started":
		case "exited":
			return isValidProcessList(value);
		case "appId":
		case "appName":
		case "role":
		case "documentId":
			return isBoundedString(value, 512);
		case "editorId":
			return isBoundedString(value, 256);
		case "browserId":
		case "tabId":
			return isBoundedString(value, 256);
		case "language":
			return isBoundedString(value, 128);
		case "insertedChars":
		case "deletedChars":
		case "idleForMs":
		case "keyCount":
		case "clickCount":
			return isNonNegativeInteger(value);
		case "burstStartedAtMs":
		case "burstEndedAtMs":
		case "bucketStartedAtMs":
		case "bucketEndedAtMs":
			return isNonNegativeInteger(value);
		case "scrollDelta":
			return isFiniteNumber(value);
		case "mouseDistance":
			return isNonNegativeNumber(value);
		case "permissions":
			return isStringArray(value);
		case "windowId":
			return isBoundedString(value, 200);
		case "code":
			return isBoundedString(value, 128);
		case "callId":
			return isBoundedString(value, 200);
		case "name":
			return isBoundedString(value, 200);
		case "progress":
			return (
				typeof value === "number" &&
				Number.isFinite(value) &&
				value >= 0 &&
				value <= 100
			);
		default:
			return true;
	}
}

function isValidProcessList(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	return value.every(
		(item) =>
			isRecord(item) &&
			typeof item.processId === "number" &&
			Number.isInteger(item.processId) &&
			isBoundedString(item.appId, 512) &&
			isBoundedString(item.appName, 512),
	);
}

function isStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBoundedString(value: unknown, maximum: number): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum
	);
}

function isNonNegativeInteger(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0
	);
}

function isNonNegativeNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses an ec1_<16 hex> desktop cursor into its sequence number. */
export function parseDesktopCursor(cursor: string): number | null {
	const match = /^ec1_([0-9a-f]{16})$/u.exec(cursor);
	if (match === null) return null;
	const sequence = Number.parseInt(match[1] ?? "", 16);
	return Number.isSafeInteger(sequence) ? sequence : null;
}

export function isContiguousCursors(cursors: readonly string[]): boolean {
	for (let index = 1; index < cursors.length; index += 1) {
		const previous = parseDesktopCursor(cursors[index - 1] ?? "");
		const current = parseDesktopCursor(cursors[index] ?? "");
		if (previous === null || current === null || current !== previous + 1) {
			return false;
		}
	}
	return true;
}

export function formatDesktopCursor(sequence: number): string {
	return "ec1_" + sequence.toString(16).padStart(16, "0");
}
