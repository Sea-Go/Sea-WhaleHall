export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const LOCAL_CONTROL_TIMEOUT_MS = 5000;
export const LOCAL_TOOL_TIMEOUT_MS = 30_000;

export type LocalMethod = "runtime.health" | "tool.list" | "tool.call" | "tool.cancel";

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

export type LocalMessage = LocalResponse | LocalToolEvent;

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

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
