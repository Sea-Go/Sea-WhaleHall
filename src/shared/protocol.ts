export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export const MAX_ECHO_CHARACTERS = 4096;
export const RUST_REQUEST_TIMEOUT_MS = 5000;

export type RustMethod = "health.check" | "echo";

export type RustRequest = {
	id: string;
	method: RustMethod;
	params: Record<string, unknown>;
};

export type RustErrorPayload = {
	code: string;
	message: string;
};

export type RustSuccessResponse<T = unknown> = {
	id: string;
	ok: true;
	result: T;
};

export type RustFailureResponse = {
	id: string | null;
	ok: false;
	error: RustErrorPayload;
};

export type RustResponse<T = unknown> = RustSuccessResponse<T> | RustFailureResponse;

export type HealthResult = {
	service: "whalehall-core";
	version: string;
	pid: number;
	status: "ok";
};

export type EchoResult = {
	message: string;
	handledBy: "whalehall-core";
	pid: number;
};

export function parseRustResponse(line: string): RustResponse {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error(`Rust emitted invalid JSON: ${String(error)}`);
	}

	if (!isRecord(value) || typeof value.ok !== "boolean") {
		throw new Error("Rust response must be an object with a boolean 'ok' field.");
	}

	if (value.ok) {
		if (typeof value.id !== "string" || !("result" in value)) {
			throw new Error("Successful Rust response is missing 'id' or 'result'.");
		}
		return value as RustSuccessResponse;
	}

	if (
		(value.id !== null && typeof value.id !== "string") ||
		!isRecord(value.error) ||
		typeof value.error.code !== "string" ||
		typeof value.error.message !== "string"
	) {
		throw new Error("Failed Rust response has an invalid error payload.");
	}
	return value as RustFailureResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
