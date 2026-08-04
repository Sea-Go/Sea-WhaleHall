import { isRecord } from "../local-protocol";

export type OllamaModelLock = {
	schemaVersion: "ollama-model-lock.v1";
	baseUrl: string;
	model: string;
	digest: string;
	parameterSize: string;
	quantizationLevel: string;
	ollamaVersion: string;
	numCtx: number;
};

export const WHALEHALL_TEACHER_MODEL_LOCK = {
	schemaVersion: "ollama-model-lock.v1",
	baseUrl: "http://127.0.0.1:11434",
	model: "qwen3:4b",
	digest: "359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7",
	parameterSize: "4.0B",
	quantizationLevel: "Q4_K_M",
	ollamaVersion: "0.24.0",
	numCtx: 4096,
} as const satisfies OllamaModelLock;

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type VerifiedOllamaRuntime = {
	version: string;
	model: string;
	digest: string;
	parameterSize: string;
	quantizationLevel: string;
};

export type VerifyOllamaModelLockOptions = {
	fetch?: FetchLike;
	timeoutMs?: number;
	/** Exact HTTPS origins allowed for an authenticated remote Ollama server. */
	allowedRemoteOrigins?: readonly string[];
	/** Environment-only Bearer token for the remote gateway. */
	authorizationToken?: string;
};

export class OllamaModelLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OllamaModelLockError";
	}
}

/**
 * Fails closed when the teacher runtime differs from the reviewed lock. It
 * reads only Ollama metadata endpoints and never sends user data.
 */
export async function verifyOllamaModelLock(
	lock: OllamaModelLock = WHALEHALL_TEACHER_MODEL_LOCK,
	options: VerifyOllamaModelLockOptions = {},
): Promise<VerifiedOllamaRuntime> {
	const base = normalizeOllamaBaseUrl(
		lock.baseUrl,
		options.allowedRemoteOrigins ?? [],
	);
	const headers = authorizationHeaders(options.authorizationToken);
	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? 3_000;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const fetchImpl = options.fetch ?? fetch;
		const [versionResponse, tagsResponse] = await Promise.all([
			fetchImpl(`${base}/api/version`, {
				headers,
				signal: controller.signal,
			}),
			fetchImpl(`${base}/api/tags`, {
				headers,
				signal: controller.signal,
			}),
		]);
		if (!versionResponse.ok || !tagsResponse.ok) {
			throw new OllamaModelLockError(
				`Ollama metadata check failed (${versionResponse.status}/${tagsResponse.status}).`,
			);
		}
		const versionValue: unknown = await versionResponse.json();
		const tagsValue: unknown = await tagsResponse.json();
		if (!isRecord(versionValue) || typeof versionValue.version !== "string") {
			throw new OllamaModelLockError("Ollama returned an invalid version payload.");
		}
		if (versionValue.version !== lock.ollamaVersion) {
			throw new OllamaModelLockError(
				`Ollama version mismatch: expected ${lock.ollamaVersion}, received ${versionValue.version}.`,
			);
		}
		if (!isRecord(tagsValue) || !Array.isArray(tagsValue.models)) {
			throw new OllamaModelLockError("Ollama returned an invalid model catalog.");
		}
		const model = tagsValue.models.find(
			(candidate) => isRecord(candidate) && candidate.name === lock.model,
		);
		if (
			!isRecord(model) ||
			typeof model.digest !== "string" ||
			!isRecord(model.details) ||
			typeof model.details.parameter_size !== "string" ||
			typeof model.details.quantization_level !== "string"
		) {
			throw new OllamaModelLockError(
				`Pinned Ollama model ${lock.model} is not installed or has invalid metadata.`,
			);
		}
		const mismatches = [
			model.digest === lock.digest ? null : `digest ${model.digest}`,
			model.details.parameter_size === lock.parameterSize
				? null
				: `parameter size ${model.details.parameter_size}`,
			model.details.quantization_level === lock.quantizationLevel
				? null
				: `quantization ${model.details.quantization_level}`,
		].filter((value): value is string => value !== null);
		if (mismatches.length > 0) {
			throw new OllamaModelLockError(
				`Pinned Ollama model ${lock.model} mismatch: ${mismatches.join(", ")}.`,
			);
		}
		return {
			version: versionValue.version,
			model: lock.model,
			digest: model.digest,
			parameterSize: model.details.parameter_size,
			quantizationLevel: model.details.quantization_level,
		};
	} catch (error) {
		if (controller.signal.aborted) {
			throw new OllamaModelLockError(
				`Ollama metadata check timed out after ${timeoutMs} ms.`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function normalizeOllamaBaseUrl(
	value: string,
	allowedRemoteOrigins: readonly string[],
): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new OllamaModelLockError("Ollama base URL is invalid.");
	}
	if (
		url.username !== "" ||
		url.password !== "" ||
		(url.pathname !== "/" && url.pathname !== "") ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new OllamaModelLockError(
			"Ollama model lock URL contains disallowed URL components.",
		);
	}
	if (isLoopbackHostname(url.hostname)) {
		if (url.protocol !== "http:") {
			throw new OllamaModelLockError(
				"Ollama loopback model lock must use an HTTP origin.",
			);
		}
		return url.origin;
	}
	if (
		url.protocol !== "https:" ||
		!allowedRemoteOrigins.includes(url.origin)
	) {
		throw new OllamaModelLockError(
			"Remote Ollama model lock requires an allowlisted HTTPS origin.",
		);
	}
	return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
	return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);
}

function authorizationHeaders(
	authorizationToken: string | undefined,
): Readonly<Record<string, string>> {
	if (authorizationToken === undefined) return {};
	if (
		authorizationToken.length < 1 ||
		authorizationToken.length > 4_096 ||
		/[\u0000-\u001f\u007f]/u.test(authorizationToken)
	) {
		throw new OllamaModelLockError("Ollama authorization token is invalid.");
	}
	return { authorization: `Bearer ${authorizationToken}` };
}
